//! Dockside NEAR escrow contract (near-sdk 5.30.1).
//!
//! A thin host adapter: every authority decision is made by `dockside-escrow-core`, which is
//! also exercised by the host test-suite. This file only supplies the NEAR context (block time,
//! predecessor, `env::ed25519_verify`, the deployment limits), persists `TradeRecord`s and turns
//! release and refund execution into one transfer of the trade asset with a private settlement
//! callback: a native transfer for a NEAR trade, `ft_transfer` on the token contract the signed
//! terms name for a NEP-141 trade. A failed transfer leaves the value with the escrow (the
//! runtime returns native NEAR; a token contract reverts its own receipt), and the callback
//! restores the ledger exactly.

use dockside_escrow_core::assets::{self, UnexpectedAsset};
use dockside_escrow_core::crypto::Verifier;
use dockside_escrow_core::refund::RefundSignatures;
use dockside_escrow_core::terms::Asset;
use dockside_escrow_core::{funding_message, views, Ctx, Error, Limits, TradeRecord, DEFAULT_MIN_DEPOSIT_NEP141, DEFAULT_MIN_DEPOSIT_YOCTO};
use near_sdk::json_types::U128;
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{env, near, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError};
use serde_json::Value as J;

const SETTLE_GAS: Gas = Gas::from_tgas(15);
/// Gas per byte of the trade record a release or refund settlement reads and rewrites, on top of
/// `SETTLE_GAS`. Measured on nearcore 2.14 at about 170 Mgas per byte; this allows 300.
const SETTLE_GAS_PER_BYTE: u64 = 300_000_000;
/// Gas for a NEP-141 `ft_transfer`: the release and refund of a token trade, and the
/// unexpected-asset recovery adapter.
const FT_TRANSFER_GAS: Gas = Gas::from_tgas(20);
/// Gas for the token's `storage_balance_of` view and for the callback that records its answer.
const STORAGE_CHECK_GAS: Gas = Gas::from_tgas(10);
const STORAGE_CALLBACK_GAS: Gas = Gas::from_tgas(10);
/// NEP-141 `ft_transfer` requires exactly one yoctoNEAR attached.
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

/// Whether the one awaited transfer promise succeeded. Only a failed promise is a no-transfer
/// proof: a promise that succeeded has moved the value whatever it returned, so a return value
/// longer than the callback reads still counts as transferred.
fn transfer_succeeded() -> bool {
    env::promise_results_count() == 1 && !matches!(env::promise_result_checked(0, 64), Err(PromiseError::Failed))
}

/// `new` argument: the per-trade caps, in base units of each asset.
#[near(serializers = [json])]
pub struct MaxTradeAmount {
    pub near_yocto: U128,
    pub nep141: U128,
}

/// `new` argument: the one NEP-141 token contract this deployment accepts as a trade asset.
#[near(serializers = [json])]
pub struct TokenConfig {
    pub account_id: AccountId,
    pub decimals: u8,
}

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
    /// Minimum NEP-141 deposit in the token's base units.
    min_deposit_nep141: u128,
    /// Per-trade caps (0 = none, testnet only) and the pinned NEP-141 token, fixed by `new`.
    max_native: u128,
    max_nep141: u128,
    nep141_token: Option<(String, u8)>,
    trades: LookupMap<String, TradeRecord>,
    trade_ids: Vector<String>,
    unexpected: Vector<UnexpectedAsset>,
}

impl Escrow {
    fn with_ctx<T>(&self, f: impl FnOnce(&Ctx<'_>) -> T) -> T {
        let predecessor = env::predecessor_account_id();
        let contract = env::current_account_id();
        let limits = self.limits();
        let ctx = Ctx {
            now_ms: env::block_timestamp_ms(),
            predecessor: predecessor.as_str(),
            contract_id: contract.as_str(),
            network: &self.network,
            verifier: &NearVerifier,
            limits: &limits,
        };
        f(&ctx)
    }

    /// Static gas for the settlement callback of `trade_id`: the floor plus an allowance for the
    /// size of its record, so that whoever relays the execution, and however large the record
    /// has grown, the callback is funded. A caller that attaches less gas makes the execution
    /// itself fail, before anything is transferred or recorded.
    fn settle_gas(&self, trade_id: &str) -> Gas {
        let bytes = near_sdk::borsh::to_vec(self.read(trade_id)).map(|v| v.len() as u64).unwrap_or_else(|_| fail(Error { code: "INTERNAL", message: "record size".into() }));
        Gas::from_gas(SETTLE_GAS.as_gas().saturating_add(bytes.saturating_mul(SETTLE_GAS_PER_BYTE)))
    }

    fn limits(&self) -> Limits {
        Limits { max_native: self.max_native, max_nep141: self.max_nep141, nep141_token: self.nep141_token.clone() }
    }

    /// One transfer of `amount` of the trade asset to `to`: native NEAR, or `ft_transfer` on the
    /// token contract with the one yoctoNEAR the standard requires.
    fn pay(asset: &Asset, to: &str, amount: u128, memo: String) -> Promise {
        let invalid = |what: &str| -> ! { fail(Error { code: "INVALID_ADDRESS", message: format!("{what} account invalid") }) };
        match asset {
            Asset::NearNative => {
                let to: AccountId = to.parse().unwrap_or_else(|_| invalid("recipient"));
                Promise::new(to).transfer(NearToken::from_yoctonear(amount))
            }
            Asset::Nep141 { token_account_id, .. } => {
                let token: AccountId = token_account_id.parse().unwrap_or_else(|_| invalid("token"));
                let args = serde_json::json!({ "receiver_id": to, "amount": amount.to_string(), "memo": memo });
                Promise::new(token).function_call("ft_transfer".to_string(), args.to_string().into_bytes(), ONE_YOCTO, FT_TRANSFER_GAS)
            }
        }
    }

    /// Fund a NEP-141 trade from `ft_on_transfer`. Nothing is stored unless the deposit is
    /// accepted, so a refusal leaves the contract exactly as it was.
    fn fund_token(&mut self, trade_id: &str, terms_digest: &str, sender: &str, amount: u128) -> Result<J, Error> {
        let mut t = match self.trades.get(trade_id) {
            Some(t) => t.clone(),
            None => return Err(Error { code: "NOT_FOUND", message: "trade not found".into() }),
        };
        let min = self.min_deposit_nep141;
        let o = self.with_ctx(|ctx| t.fund_token(ctx, sender, terms_digest, amount, min))?;
        t.ledger.check_conservation()?;
        self.trades.insert(trade_id.to_owned(), t);
        Ok(serde_json::json!({
            "tradeId": trade_id, "funder": sender, "index": o.index, "accepted": o.accepted.to_string(),
            "quarantined": o.quarantined.to_string(), "fullyFunded": o.fully_funded,
        }))
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

    /// Persist one receiver record. The caller has checked [`assets::ensure_capacity`] for the
    /// whole call, so any account calling a receiver directly can add at most
    /// `assets::MAX_UNEXPECTED_ASSETS` records in total.
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
    /// `network` is `near-testnet` or `near-mainnet`. `max_trade_amount` caps the amount a trade
    /// may name and the value it may hold, per asset; `near-mainnet` is accepted only with
    /// non-zero caps (omitted: 5 NEAR and 25 USDC in base units; an explicit zero is refused).
    /// `nep141_token` pins the one token contract NEP-141 trades may name; without it mainnet
    /// accepts no NEP-141 trade. Nothing here can be changed after initialisation.
    #[init]
    pub fn new(
        network: String,
        min_deposit_yocto: Option<U128>,
        max_trade_amount: Option<MaxTradeAmount>,
        nep141_token: Option<TokenConfig>,
        min_deposit_nep141: Option<U128>,
    ) -> Self {
        let limits = ok(Limits::configure(
            &network,
            max_trade_amount.as_ref().map(|m| m.near_yocto.0),
            max_trade_amount.as_ref().map(|m| m.nep141.0),
            nep141_token.map(|t| (t.account_id.to_string(), u64::from(t.decimals))),
        ));
        let min_deposit_nep141 = min_deposit_nep141.map(|x| x.0).unwrap_or(DEFAULT_MIN_DEPOSIT_NEP141);
        if min_deposit_nep141 == 0 {
            fail(Error { code: "INVALID_AMOUNT", message: "the minimum NEP-141 deposit must be positive".into() });
        }
        Self {
            network,
            min_deposit: min_deposit_yocto.map(|x| x.0).unwrap_or(DEFAULT_MIN_DEPOSIT_YOCTO),
            min_deposit_nep141,
            max_native: limits.max_native,
            max_nep141: limits.max_nep141,
            nep141_token: limits.nep141_token,
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

    /// Native NEAR from the caller, recorded per deposit against its original funder. A trade
    /// whose asset is a NEP-141 token refuses it (the token is sent with `ft_transfer_call`).
    /// `terms_digest` is the trade revision digest the funder agreed to; a record whose digest
    /// differs (another registration under the same trade id, or a superseded revision) refuses
    /// the deposit, and the failed call returns it.
    #[payable]
    pub fn fund(&mut self, trade_id: String, terms_digest: String) -> J {
        let amount = env::attached_deposit().as_yoctonear();
        let min = self.min_deposit;
        let o = self.mutate(&trade_id, |t, ctx| t.fund_exact(ctx, &terms_digest, amount, min));
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

    /// NEP-141 trades: ask the trade's token contract whether `account_id` (the active payout
    /// destination, or the destination of a pending change) is storage-registered, and record
    /// the answer. A release intent cannot lock the value for a destination that was not
    /// confirmed here. Anyone may call it; the answer comes from the token contract only.
    pub fn check_payee_storage(&mut self, trade_id: String, account_id: AccountId) -> Promise {
        let token = ok(self.read(&trade_id).payee_check_target(account_id.as_str()));
        let token: AccountId = token
            .parse()
            .unwrap_or_else(|_| fail(Error { code: "INVALID_ADDRESS", message: "token account invalid".into() }));
        let args = serde_json::json!({ "account_id": account_id });
        Promise::new(token)
            .function_call("storage_balance_of".to_string(), args.to_string().into_bytes(), NearToken::from_yoctonear(0), STORAGE_CHECK_GAS)
            .then(Self::ext(env::current_account_id()).with_static_gas(STORAGE_CALLBACK_GAS).on_payee_storage(trade_id, account_id))
    }

    /// The token's `storage_balance_of` answer: a storage balance (an object) means registered
    /// and `null` means not registered. Anything else (a failed view, another value, an answer
    /// too long to be a storage balance) says nothing about the payee, so the call fails and the
    /// recorded confirmations stay as they were.
    #[private]
    pub fn on_payee_storage(&mut self, trade_id: String, account_id: AccountId) -> bool {
        let answer = if env::promise_results_count() == 1 { env::promise_result_checked(0, 256).ok() } else { None };
        let registered = match answer.as_deref().map(serde_json::from_slice::<J>) {
            Some(Ok(J::Object(_))) => true,
            Some(Ok(J::Null)) => false,
            _ => fail(Error { code: "TOKEN_CALL_FAILED", message: "the token contract did not answer storage_balance_of".into() }),
        };
        self.mutate(&trade_id, |t, _ctx| t.record_payee_storage(account_id.as_str(), registered))
    }

    /// Recheck the full release conjunction, enter SUBMITTING and transfer the exact amount of
    /// the trade asset to the revision-bound supplier destination. Anyone may relay; authority is
    /// the recorded state.
    pub fn execute_release(&mut self, trade_id: String, release_intent_id: String) -> Promise {
        let (dest, amount, attempt) = self.mutate(&trade_id, |t, ctx| t.execute_release(ctx, &release_intent_id));
        let asset = self.read(&trade_id).terms.asset.clone();
        let settle = self.settle_gas(&trade_id);
        Self::pay(&asset, &dest, amount, format!("dockside release {release_intent_id}")).then(
            Self::ext(env::current_account_id())
                .with_static_gas(settle)
                .on_release_transfer(trade_id, release_intent_id, attempt),
        )
    }

    /// Settlement callback: a successful transfer is PAID; a failed one (native NEAR returned by
    /// the runtime, or an `ft_transfer` the token contract reverted) is FAILED.
    #[private]
    pub fn on_release_transfer(&mut self, trade_id: String, release_intent_id: String, attempt_id: String) -> bool {
        let transferred = transfer_succeeded();
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

    /// AUTHORIZED -> EXECUTING, then one transfer of the trade asset to the original funder only.
    pub fn execute_refund(&mut self, trade_id: String, refund_intent_id: String) -> Promise {
        let (funder, amount) = self.mutate(&trade_id, |t, ctx| t.begin_refund(ctx, &refund_intent_id));
        let asset = self.read(&trade_id).terms.asset.clone();
        let settle = self.settle_gas(&trade_id);
        Self::pay(&asset, &funder, amount, format!("dockside refund {refund_intent_id}")).then(
            Self::ext(env::current_account_id())
                .with_static_gas(settle)
                .on_refund_transfer(trade_id, refund_intent_id),
        )
    }

    /// Settlement callback. A failed native transfer is refunded to this contract by the runtime
    /// and a failed `ft_transfer` is reverted by the token contract: either is the authoritative
    /// no-transfer proof for FAILED, and the exact source bucket is restored.
    #[private]
    pub fn on_refund_transfer(&mut self, trade_id: String, refund_intent_id: String) -> bool {
        let transferred = transfer_succeeded();
        self.mutate(&trade_id, |t, ctx| t.complete_refund(ctx, &refund_intent_id, transferred));
        transferred
    }

    /// NEP-141 receiver.
    ///
    /// A `msg` of `{"tradeId":"trd_...","termsDigest":"<hex64>"}` funds that trade revision: the
    /// calling contract must be the token the trade's signed terms name, and the deposit is
    /// recorded against `sender_id`. If the funding is refused for any reason (unknown trade,
    /// wrong token, wrong digest, over the cap, expired, frozen, malformed message) nothing is
    /// stored and the whole amount is returned to the sender through the return value.
    ///
    /// Any other `msg` is not a funding request: the tokens are kept and recorded for the
    /// unexpected-asset review, never credited to a trade. Past the record cap that call fails
    /// and the token contract refunds the whole amount.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        let Some(request) = funding_message(&msg) else {
            ok(assets::ensure_capacity(self.unexpected.len() as u64, 1));
            self.record_unexpected("NEP-141", None, amount.0.to_string(), sender_id.as_str(), &msg);
            return U128(0);
        };
        let funded = request.and_then(|m| self.fund_token(&m.trade_id, &m.terms_digest, sender_id.as_str(), amount.0));
        let token = env::predecessor_account_id();
        match funded {
            Ok(data) => {
                env::log_str(&format!("EVENT_JSON:{}", serde_json::json!({
                    "standard": "dockside", "version": "1.0.0", "event": "nep141_funding_accepted", "token": token, "data": data,
                })));
                U128(0)
            }
            Err(e) => {
                env::log_str(&format!("EVENT_JSON:{}", serde_json::json!({
                    "standard": "dockside", "version": "1.0.0", "event": "nep141_funding_returned", "token": token,
                    "data": {"sender": sender_id, "amount": amount.0.to_string(), "code": e.code, "message": e.message},
                })));
                amount
            }
        }
    }

    /// NEP-171: returning false keeps the token; it is recorded for review only.
    pub fn nft_on_transfer(&mut self, sender_id: AccountId, previous_owner_id: AccountId, token_id: String, msg: String) -> bool {
        let _ = previous_owner_id;
        ok(assets::ensure_capacity(self.unexpected.len() as u64, 1));
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
        ok(assets::ensure_capacity(self.unexpected.len() as u64, token_ids.len()));
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
        let transferred = transfer_succeeded();
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
        let limits = views::limits(&self.limits());
        serde_json::json!({
            "network": self.network, "minDepositYocto": self.min_deposit.to_string(),
            "minDepositNep141": self.min_deposit_nep141.to_string(),
            "maxTradeAmount": limits["maxTradeAmount"], "nep141Token": limits["nep141Token"],
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
