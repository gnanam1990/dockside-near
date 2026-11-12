//! Dockside NEAR escrow contract (near-sdk 5.30.1).
//!
//! A thin host adapter: every authority decision is made by `dockside-escrow-core`, which is
//! also exercised by the host test-suite. This file only supplies the NEAR context (block time,
//! predecessor, `env::ed25519_verify`), persists `TradeRecord`s and turns refund execution into
//! a native transfer to the recorded original funder with a private settlement callback.

use dockside_escrow_core::assets::{self, UnexpectedAsset};
use dockside_escrow_core::crypto::Verifier;
use dockside_escrow_core::refund::RefundSignatures;
use dockside_escrow_core::{views, Ctx, Error, TradeRecord, DEFAULT_MIN_DEPOSIT_YOCTO};
use near_sdk::json_types::U128;
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{env, near, AccountId, Gas, NearToken, PanicOnDefault, Promise};
use serde_json::Value as J;

const SETTLE_GAS: Gas = Gas::from_tgas(15);
/// Gas for the NEP-141 adapter call (`ft_transfer` on the observed token contract).
const FT_TRANSFER_GAS: Gas = Gas::from_tgas(20);

struct NearVerifier;

impl Verifier for NearVerifier {
    fn ed25519_verify(&self, signature: &[u8; 64], message: &[u8; 32], public_key: &[u8; 32]) -> bool {
        env::ed25519_verify(signature, message, public_key)
    }
}

fn fail(e: Error) -> ! {
    env::panic_str(&e.to_string())
}

fn ok<T>(r: Result<T, Error>) -> T {
    r.unwrap_or_else(|e| fail(e))
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Escrow {
    network: String,
    min_deposit: u128,
    trades: LookupMap<String, TradeRecord>,
    trade_ids: Vector<String>,
    unexpected: Vector<UnexpectedAsset>,
}

impl Escrow {
    fn with_ctx<T>(&self, f: impl FnOnce(&Ctx<'_>) -> T) -> T {
        let predecessor = env::predecessor_account_id();
        let contract = env::current_account_id();
        let ctx = Ctx {
            now_ms: env::block_timestamp_ms(),
            predecessor: predecessor.as_str(),
            contract_id: contract.as_str(),
            network: &self.network,
            verifier: &NearVerifier,
        };
        f(&ctx)
    }

    fn mutate<T>(&mut self, trade_id: &str, f: impl FnOnce(&mut TradeRecord, &Ctx<'_>) -> Result<T, Error>) -> T {
        let mut t = match self.trades.get(trade_id) {
            Some(t) => t.clone(),
            None => fail(Error { code: "NOT_FOUND", message: "trade not found".into() }),
        };
        let out = ok(self.with_ctx(|ctx| f(&mut t, ctx)));
        ok(t.ledger.check_conservation());
        self.trades.insert(trade_id.to_owned(), t);
        out
    }

    fn read(&self, trade_id: &str) -> &TradeRecord {
        self.trades
            .get(trade_id)
            .unwrap_or_else(|| fail(Error { code: "NOT_FOUND", message: "trade not found".into() }))
    }

    fn asset(&self, index: u64) -> UnexpectedAsset {
        u32::try_from(index)
            .ok()
            .and_then(|i| self.unexpected.get(i).cloned())
            .unwrap_or_else(|| fail(Error { code: "NOT_FOUND", message: "unexpected asset not found".into() }))
    }

    fn store_asset(&mut self, a: UnexpectedAsset) {
        let i = u32::try_from(a.index).unwrap_or_else(|_| fail(Error { code: "NOT_FOUND", message: "index".into() }));
        self.unexpected.replace(i, a);
    }

    /// Run an asset-recovery step that needs the governing trade's authority (bound keys, nonces).
    /// The trade's native ledger is rechecked for conservation and is never changed by recovery.
    fn govern<T>(
        &mut self,
        asset_index: u64,
        trade_id: &str,
        f: impl FnOnce(&mut UnexpectedAsset, &mut TradeRecord, &Ctx<'_>) -> Result<T, Error>,
    ) -> T {
        let mut a = self.asset(asset_index);
        let mut t = match self.trades.get(trade_id) {
            Some(t) => t.clone(),
            None => fail(Error { code: "NOT_FOUND", message: "trade not found".into() }),
        };
        let ledger = t.ledger.clone();
        let out = ok(self.with_ctx(|ctx| f(&mut a, &mut t, ctx)));
        if t.ledger != ledger {
            fail(Error { code: "INTERNAL", message: "asset recovery must not change native value".into() });
        }
        ok(t.ledger.check_conservation());
        self.trades.insert(trade_id.to_owned(), t);
        self.store_asset(a);
        out
    }

    fn record_unexpected(&mut self, standard: &str, token_id: Option<String>, amount: String, sender: &str, msg: &str) {
        let index = self.unexpected.len() as u64;
        let a = ok(assets::record(
            index,
            standard,
            env::predecessor_account_id().as_str(),
            token_id,
            amount,
            sender,
            msg,
            env::block_timestamp_ms(),
        ));
        env::log_str(&format!("EVENT_JSON:{}", views::unexpected(&a)));
        self.unexpected.push(a);
    }
}

#[near]
impl Escrow {
    /// The working corridor is native NEAR on testnet only; mainnet stays BLOCKED.
    #[init]
    pub fn new(network: String, min_deposit_yocto: Option<U128>) -> Self {
        if network != "near-testnet" {
            fail(Error { code: "FUNDED_RAIL_BLOCKED", message: "only near-testnet is enabled".into() });
        }
        Self {
            network,
            min_deposit: min_deposit_yocto.map(|x| x.0).unwrap_or(DEFAULT_MIN_DEPOSIT_YOCTO),
            trades: LookupMap::new(b"t"),
            trade_ids: Vector::new(b"i"),
            unexpected: Vector::new(b"u"),
        }
    }

    /// Register revision 1: exact canonical terms plus both party signatures over its digest.
    pub fn register_trade(&mut self, terms: J, buyer_signature: String, supplier_signature: String) -> String {
        let t = ok(self.with_ctx(|ctx| dockside_escrow_core::register(ctx, &terms, &buyer_signature, &supplier_signature)));
        let id = t.terms.trade_id.clone();
        if self.trades.contains_key(&id) {
            fail(Error { code: "INVALID_STATE", message: "trade already registered".into() });
        }
        let digest = t.terms_digest.clone();
        self.trades.insert(id.clone(), t);
        self.trade_ids.push(id);
        digest
    }

    /// Native testnet NEAR from the caller, recorded per deposit against its original funder.
    #[payable]
    pub fn fund(&mut self, trade_id: String) -> J {
        let amount = env::attached_deposit().as_yoctonear();
        let min = self.min_deposit;
        let o = self.mutate(&trade_id, |t, ctx| t.fund(ctx, amount, min));
        serde_json::json!({
            "index": o.index, "accepted": o.accepted.to_string(),
            "quarantined": o.quarantined.to_string(), "fullyFunded": o.fully_funded,
        })
    }

    /// Store the EvidencePolicy whose digest the registered trade revision binds.
    pub fn register_evidence_policy(&mut self, trade_id: String, policy: J) -> String {
        self.mutate(&trade_id, |t, _ctx| t.register_evidence_policy(&policy))
    }

    /// ManifestAttestation by the exact bound attestor; the contract derives completeness.
    pub fn submit_manifest_attestation(&mut self, trade_id: String, payload: J, signature: String) -> String {
        self.mutate(&trade_id, |t, ctx| t.submit_manifest_attestation(ctx, &payload, &signature))
    }

    /// Independent inspector decision over the current contract-accepted manifest.
    pub fn submit_inspection(&mut self, trade_id: String, payload: J, signature: String) -> String {
        self.mutate(&trade_id, |t, ctx| t.submit_inspection(ctx, &payload, &signature))
    }

    pub fn set_hold(&mut self, trade_id: String, payload: J, signature: String) -> String {
        self.mutate(&trade_id, |t, ctx| t.set_hold(ctx, &payload, &signature))
    }

    pub fn resolve_hold(&mut self, trade_id: String, payload: J, signature: String) -> String {
        self.mutate(&trade_id, |t, ctx| t.resolve_hold(ctx, &payload, &signature))
    }

    pub fn revoke_bound_key(&mut self, trade_id: String, payload: J, signature: String) -> String {
        self.mutate(&trade_id, |t, ctx| t.revoke_key(ctx, &payload, &signature))
    }

    pub fn request_refund(
        &mut self,
        trade_id: String,
        payload: J,
        buyer_signature: Option<String>,
        supplier_signature: Option<String>,
        risk_signature: Option<String>,
    ) -> String {
        self.mutate(&trade_id, |t, ctx| {
            t.request_refund(
                ctx,
                &payload,
                RefundSignatures {
                    buyer: buyer_signature.as_deref(),
                    supplier: supplier_signature.as_deref(),
                    risk: risk_signature.as_deref(),
                },
            )
        })
    }

    /// INSPECTION_FAIL authorization signed by the separate risk/policy principal.
    pub fn authorize_refund_signed(&mut self, trade_id: String, payload: J, signature: String) {
        self.mutate(&trade_id, |t, ctx| t.authorize_refund_signed(ctx, &payload, &signature))
    }

    /* ------------------------- release intents ------------------------- */

    /// Buyer-signed release intent: locks the exact trade value. Exact duplicates join.
    pub fn create_release_intent(&mut self, trade_id: String, payload: J, buyer_signature: String) -> J {
        let (id, joined) = self.mutate(&trade_id, |t, ctx| t.create_release_intent(ctx, &payload, &buyer_signature));
        serde_json::json!({ "releaseIntentId": id, "joined": joined })
    }

    /// Buyer approval bound to the intent, current manifest, inspector PASS and holds view.
    pub fn approve_release(&mut self, trade_id: String, payload: J, signature: String) -> String {
        self.mutate(&trade_id, |t, ctx| t.approve_release(ctx, &payload, &signature))
    }

    /// Recheck the full release conjunction, enter SUBMITTING and transfer the exact amount to the
    /// revision-bound supplier destination. Anyone may relay; authority is the recorded state.
    pub fn execute_release(&mut self, trade_id: String, release_intent_id: String) -> Promise {
        let (dest, amount, attempt) = self.mutate(&trade_id, |t, ctx| t.execute_release(ctx, &release_intent_id));
        let to: AccountId = dest
            .parse()
            .unwrap_or_else(|_| fail(Error { code: "INVALID_ADDRESS", message: "destination account invalid".into() }));
        Promise::new(to).transfer(NearToken::from_yoctonear(amount)).then(
            Self::ext(env::current_account_id())
                .with_static_gas(SETTLE_GAS)
                .on_release_transfer(trade_id, release_intent_id, attempt),
        )
    }

    /// Settlement callback: a successful transfer is PAID; a runtime-refunded failure is FAILED.
    #[private]
    pub fn on_release_transfer(&mut self, trade_id: String, release_intent_id: String, attempt_id: String) -> bool {
        let transferred = env::promise_results_count() == 1 && env::promise_result_checked(0, 64).is_ok();
        self.mutate(&trade_id, |t, ctx| t.complete_release(ctx, &release_intent_id, &attempt_id, transferred));
        transferred
    }

    /// One party's CANCEL consent; the matching second consent executes the cancel atomically.
    pub fn submit_cancel_consent(&mut self, trade_id: String, cancel: J, consent: J, signature: String) -> String {
        self.mutate(&trade_id, |t, ctx| t.submit_cancel_consent(ctx, &cancel, &consent, &signature)).to_owned()
    }

    pub fn revoke_cancel_consent(&mut self, trade_id: String, payload: J, signature: String) {
        self.mutate(&trade_id, |t, ctx| t.revoke_cancel_consent(ctx, &payload, &signature))
    }

    pub fn abandon_release_intent(&mut self, trade_id: String, payload: J, signature: String) {
        self.mutate(&trade_id, |t, ctx| t.abandon_release_intent(ctx, &payload, &signature))
    }

    /* ------------------------ destination change ----------------------- */

    pub fn propose_destination_change(&mut self, trade_id: String, successor_terms: J, proposer_role: String, signature: String) -> String {
        self.mutate(&trade_id, |t, ctx| t.propose_destination_change(ctx, &successor_terms, &proposer_role, &signature))
    }

    /// Returns the time (ms) at which activation becomes possible.
    pub fn consent_destination_change(&mut self, trade_id: String, successor_digest: String, role: String, signature: String) -> u64 {
        self.mutate(&trade_id, |t, ctx| t.consent_destination_change(ctx, &successor_digest, &role, &signature))
    }

    pub fn revoke_destination_change(&mut self, trade_id: String, payload: J, signature: String) {
        self.mutate(&trade_id, |t, ctx| t.revoke_destination_change(ctx, &payload, &signature))
    }

    pub fn activate_destination_change(&mut self, trade_id: String, successor_digest: String) -> J {
        let (digest, successor) = self.mutate(&trade_id, |t, ctx| t.activate_destination_change(ctx, &successor_digest));
        serde_json::json!({ "termsDigest": digest, "successorIntent": successor })
    }

    /* -------------------------- key rebinding -------------------------- */

    pub fn propose_key_rebinding(&mut self, trade_id: String, successor_terms: J, proposer_role: String, signature: String) -> String {
        self.mutate(&trade_id, |t, ctx| t.propose_key_rebinding(ctx, &successor_terms, &proposer_role, &signature))
    }

    /// Returns the time (ms) at which activation becomes possible.
    pub fn consent_key_rebinding(&mut self, trade_id: String, successor_digest: String, role: String, signature: String) -> u64 {
        self.mutate(&trade_id, |t, ctx| t.consent_key_rebinding(ctx, &successor_digest, &role, &signature))
    }

    pub fn revoke_key_rebinding(&mut self, trade_id: String, payload: J, signature: String) {
        self.mutate(&trade_id, |t, ctx| t.revoke_key_rebinding(ctx, &payload, &signature))
    }

    pub fn activate_key_rebinding(&mut self, trade_id: String, successor_digest: String) -> J {
        let (digest, successor) = self.mutate(&trade_id, |t, ctx| t.activate_key_rebinding(ctx, &successor_digest));
        serde_json::json!({ "termsDigest": digest, "successorIntent": successor })
    }

    pub fn cosign_refund(&mut self, trade_id: String, refund_intent_id: String, role: String, signature: String) {
        self.mutate(&trade_id, |t, ctx| t.cosign_refund(ctx, &refund_intent_id, &role, &signature))
    }

    pub fn revoke_refund(&mut self, trade_id: String, payload: J, signature: Option<String>) {
        self.mutate(&trade_id, |t, ctx| t.revoke_refund(ctx, &payload, signature.as_deref()))
    }

    pub fn dispute_refund(&mut self, trade_id: String, payload: J, signature: String) {
        self.mutate(&trade_id, |t, ctx| t.dispute_refund(ctx, &payload, &signature))
    }

    pub fn authorize_refund(&mut self, trade_id: String, refund_intent_id: String) {
        self.mutate(&trade_id, |t, ctx| t.authorize_refund(ctx, &refund_intent_id))
    }

    /// AUTHORIZED -> EXECUTING, then a native transfer to the original funder only.
    pub fn execute_refund(&mut self, trade_id: String, refund_intent_id: String) -> Promise {
        let (funder, amount) = self.mutate(&trade_id, |t, ctx| t.begin_refund(ctx, &refund_intent_id));
        let to: AccountId = funder
            .parse()
            .unwrap_or_else(|_| fail(Error { code: "INVALID_ADDRESS", message: "funder account invalid".into() }));
        Promise::new(to).transfer(NearToken::from_yoctonear(amount)).then(
            Self::ext(env::current_account_id())
                .with_static_gas(SETTLE_GAS)
                .on_refund_transfer(trade_id, refund_intent_id),
        )
    }

    /// Settlement callback. A failed native transfer is refunded to this contract by the runtime,
    /// which is the authoritative no-transfer proof for FAILED.
    #[private]
    pub fn on_refund_transfer(&mut self, trade_id: String, refund_intent_id: String) -> bool {
        let transferred = env::promise_results_count() == 1 && env::promise_result_checked(0, 64).is_ok();
        self.mutate(&trade_id, |t, ctx| t.complete_refund(ctx, &refund_intent_id, transferred));
        transferred
    }

    /// NEP-141: tokens are never credited to native-NEAR funding. Keep and record for review.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        self.record_unexpected("NEP-141", None, amount.0.to_string(), sender_id.as_str(), &msg);
        U128(0)
    }

    /// NEP-171: returning false keeps the token; it is recorded for review only.
    pub fn nft_on_transfer(&mut self, sender_id: AccountId, previous_owner_id: AccountId, token_id: String, msg: String) -> bool {
        let _ = previous_owner_id;
        self.record_unexpected("NEP-171", Some(token_id), "1".into(), sender_id.as_str(), &msg);
        false
    }

    /// NEP-245: every token amount is recorded separately; nothing is credited or returned.
    pub fn mt_on_transfer(
        &mut self,
        sender_id: AccountId,
        previous_owner_ids: Vec<AccountId>,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        msg: String,
    ) -> Vec<U128> {
        let _ = previous_owner_ids;
        if token_ids.len() != amounts.len() || token_ids.len() > 32 {
            fail(Error { code: "VALIDATION_FAILED", message: "token ids and amounts must align".into() });
        }
        for (id, a) in token_ids.iter().zip(amounts.iter()) {
            self.record_unexpected("NEP-245", Some(id.clone()), a.0.to_string(), sender_id.as_str(), &msg);
        }
        amounts.iter().map(|_| U128(0)).collect()
    }

    /* ------------------- unexpected-asset recovery ------------------- */

    /// UNEXPECTED_ASSET_RECOVERY step 1. The transaction signer must be the claimed sender.
    pub fn request_asset_recovery(&mut self, asset_index: u64, trade_id: String, payload: J) -> String {
        self.govern(asset_index, &trade_id, |a, t, ctx| assets::request_recovery(a, t, ctx, &payload))
    }

    /// Risk/policy approval of the governing trade; returns the end of the 72-hour challenge.
    pub fn approve_asset_recovery(&mut self, asset_index: u64, trade_id: String, payload: J, signature: String) -> u64 {
        self.govern(asset_index, &trade_id, |a, t, ctx| assets::approve_recovery(a, t, ctx, &payload, &signature))
    }

    pub fn challenge_asset_recovery(&mut self, asset_index: u64, trade_id: String, payload: J, signature: Option<String>) {
        self.govern(asset_index, &trade_id, |a, t, ctx| assets::challenge_recovery(a, t, ctx, &payload, signature.as_deref()))
    }

    pub fn revoke_asset_recovery(&mut self, asset_index: u64, trade_id: String, payload: J, signature: Option<String>) {
        self.govern(asset_index, &trade_id, |a, t, ctx| assets::revoke_recovery(a, t, ctx, &payload, signature.as_deref()))
    }

    /// After the unchallenged window, anyone may execute through the NEP-141 adapter, attaching
    /// exactly one yoctoNEAR (the adapter deposit). The asset is locked until the outcome settles.
    #[payable]
    pub fn execute_asset_recovery(&mut self, asset_index: u64, recovery_id: String) -> Promise {
        let mut a = self.asset(asset_index);
        let attached = env::attached_deposit().as_yoctonear();
        let (token, to, amount) = ok(self.with_ctx(|ctx| assets::begin_recovery(&mut a, ctx, &recovery_id, attached)));
        self.store_asset(a);
        let token: AccountId = token
            .parse()
            .unwrap_or_else(|_| fail(Error { code: "INVALID_ADDRESS", message: "asset contract invalid".into() }));
        let args = serde_json::json!({
            "receiver_id": to,
            "amount": amount.to_string(),
            "memo": format!("dockside asset recovery {recovery_id}"),
        });
        Promise::new(token)
            .function_call(
                "ft_transfer".to_string(),
                args.to_string().into_bytes(),
                NearToken::from_yoctonear(assets::ADAPTER_DEPOSIT_YOCTO),
                FT_TRANSFER_GAS,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(SETTLE_GAS)
                    .on_asset_recovery_transfer(asset_index, recovery_id),
            )
    }

    /// Adapter outcome. A failed `ft_transfer` is reverted by the token contract (authoritative
    /// no-transfer): the asset returns to review and the executor gets its deposit back.
    #[private]
    pub fn on_asset_recovery_transfer(&mut self, asset_index: u64, recovery_id: String) -> bool {
        let transferred = env::promise_results_count() == 1 && env::promise_result_checked(0, 64).is_ok();
        let mut a = self.asset(asset_index);
        let executor = ok(self.with_ctx(|ctx| assets::complete_recovery(&mut a, ctx, &recovery_id, transferred)));
        self.store_asset(a);
        if !transferred {
            if let Ok(to) = executor.parse::<AccountId>() {
                let _ = Promise::new(to).transfer(NearToken::from_yoctonear(assets::ADAPTER_DEPOSIT_YOCTO));
            }
        }
        transferred
    }

    /* ----------------------------- views ----------------------------- */

    pub fn get_config(&self) -> J {
        serde_json::json!({
            "network": self.network, "minDepositYocto": self.min_deposit.to_string(),
            "trades": self.trade_ids.len(), "unexpectedAssets": self.unexpected.len(),
            "refundPolicy": {"id": "dockside-refund-v1", "revision": 1},
        })
    }

    pub fn get_trade(&self, trade_id: String) -> J {
        views::trade(self.read(&trade_id), env::block_timestamp_ms())
    }

    pub fn get_ledger(&self, trade_id: String) -> J {
        views::ledger(self.read(&trade_id))
    }

    pub fn get_refunds(&self, trade_id: String) -> J {
        views::refunds(self.read(&trade_id))
    }

    pub fn get_evidence(&self, trade_id: String) -> J {
        views::evidence(self.read(&trade_id), env::block_timestamp_ms())
    }

    pub fn get_release(&self, trade_id: String) -> J {
        views::release(self.read(&trade_id), env::block_timestamp_ms())
    }

    pub fn get_holds(&self, trade_id: String) -> J {
        views::holds(self.read(&trade_id), env::block_timestamp_ms())
    }

    pub fn get_unexpected_asset(&self, asset_index: u64) -> J {
        views::unexpected(&self.asset(asset_index))
    }

    pub fn get_unexpected_assets(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<J> {
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(50).min(100);
        (from..self.unexpected.len().min(from.saturating_add(limit)))
            .filter_map(|i| self.unexpected.get(i).map(views::unexpected))
            .collect()
    }
}
