//! Trade record and the signed-payload checks shared by every authority entry point.

use crate::crypto::{verify, Verifier};
use crate::domains;
use crate::error::{ensure, err, R};
use crate::holds::Hold;
use crate::ledger::Ledger;
use crate::refund::RefundIntent;
use crate::terms::{parse_terms, valid_account, Asset, Terms, MAX_TOKEN_DECIMALS, NETWORK_MAINNET, NETWORK_TESTNET};
use crate::typed::{decode, hex_encode, is_nonce, Obj};
use alloc::collections::{BTreeMap, BTreeSet};
use alloc::format;
use alloc::string::String;
use borsh::{BorshDeserialize, BorshSerialize};
use dockside_canonical::{digest, Value};
use serde_json::Value as J;

/// Tolerated clock skew for `issuedAt` in the future.
pub const MAX_SKEW_MS: u64 = 5 * 60_000;

/// Mainnet default cap on native NEAR per trade (5 NEAR).
pub const MAINNET_DEFAULT_MAX_NATIVE: u128 = 5_000_000_000_000_000_000_000_000;
/// Mainnet default cap on a NEP-141 trade, in the token's base units (25 USDC at 6 decimals).
pub const MAINNET_DEFAULT_MAX_NEP141: u128 = 25_000_000;

/// Deployment limits fixed by `new` and never changed afterwards.
///
/// A cap bounds both the trade amount a registration may name and the value one trade may hold in
/// escrow at any time (deposits minus what was released or refunded), so excess deposits count.
/// Zero means no cap, which only `near-testnet` accepts.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Limits {
    /// Cap per native-NEAR trade in yoctoNEAR; 0 = none.
    pub max_native: u128,
    /// Cap per NEP-141 trade in the token's base units; 0 = none.
    pub max_nep141: u128,
    /// When set, the only NEP-141 contract (and its decimals) a trade may name.
    pub nep141_token: Option<(String, u8)>,
}

impl Limits {
    /// Validate the limits `new` was given for `network` and apply the mainnet defaults.
    /// `near-mainnet` is accepted only with non-zero caps: an omitted cap takes its default, an
    /// explicit zero is refused.
    pub fn configure(network: &str, max_native: Option<u128>, max_nep141: Option<u128>, token: Option<(String, u64)>) -> R<Limits> {
        let mainnet = match network {
            NETWORK_TESTNET => false,
            NETWORK_MAINNET => true,
            _ => return err("FUNDED_RAIL_BLOCKED", "only near-testnet and near-mainnet are enabled"),
        };
        let (max_native, max_nep141) = if mainnet {
            (max_native.unwrap_or(MAINNET_DEFAULT_MAX_NATIVE), max_nep141.unwrap_or(MAINNET_DEFAULT_MAX_NEP141))
        } else {
            (max_native.unwrap_or(0), max_nep141.unwrap_or(0))
        };
        ensure(!mainnet || (max_native > 0 && max_nep141 > 0), "CAP_REQUIRED", "near-mainnet needs a non-zero cap for every asset")?;
        let nep141_token = match token {
            None => None,
            Some((id, decimals)) => {
                ensure(valid_account(&id, network, false), "INVALID_ADDRESS", "token account id invalid for network")?;
                ensure(decimals <= MAX_TOKEN_DECIMALS, "VALIDATION_FAILED", "token decimals out of range")?;
                Some((id, decimals as u8))
            }
        };
        Ok(Limits { max_native, max_nep141, nep141_token })
    }

    /// The cap that applies to `asset`; 0 = none.
    pub fn cap_for(&self, asset: &Asset) -> u128 {
        match asset {
            Asset::NearNative => self.max_native,
            Asset::Nep141 { .. } => self.max_nep141,
        }
    }

    /// Registration-time checks: the asset is one this deployment accepts and the trade amount is
    /// within the cap. On mainnet a NEP-141 trade needs the token `new` pinned.
    pub fn check_terms(&self, network: &str, t: &Terms) -> R<()> {
        if let Asset::Nep141 { token_account_id, decimals } = &t.asset {
            match &self.nep141_token {
                Some((id, dec)) => ensure(
                    id == token_account_id && dec == decimals,
                    "UNSUPPORTED_ASSET",
                    "this deployment accepts one NEP-141 token and the terms name another token or other decimals",
                )?,
                None => ensure(network != NETWORK_MAINNET, "UNSUPPORTED_ASSET", "no NEP-141 token is enabled on this deployment")?,
            }
        }
        let cap = self.cap_for(&t.asset);
        ensure(cap == 0 || t.amount_yocto <= cap, "CAP_EXCEEDED", "trade amount exceeds the deployment cap")
    }
}

/// Per-call execution context supplied by the host.
pub struct Ctx<'a> {
    pub now_ms: u64,
    pub predecessor: &'a str,
    pub contract_id: &'a str,
    pub network: &'a str,
    pub verifier: &'a dyn Verifier,
    pub limits: &'a Limits,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct TradeRecord {
    pub terms: Terms,
    pub terms_digest: String,
    pub registered_at: u64,
    pub ledger: Ledger,
    pub refunds: BTreeMap<String, RefundIntent>,
    pub holds: BTreeMap<String, Hold>,
    /// Bound roles whose key was revoked on chain for this revision (blocks new signatures).
    pub revoked_roles: BTreeSet<String>,
    /// Consumed `<domain>|<nonce>` pairs.
    pub nonces: BTreeSet<String>,
    pub evidence: crate::evidence::EvidenceState,
    /// Release intents, buyer approvals and pre-submit exits (M04).
    pub release: crate::release::ReleaseState,
    /// Every activated revision of this trade, oldest first.
    pub revisions: alloc::vec::Vec<crate::destination::RevisionEntry>,
    /// Pending and historical dual-consent destination changes.
    pub destination: crate::destination::DestinationState,
    /// Pending and historical dual-signed key-rebinding revisions.
    pub rebinding: crate::rebinding::RebindingState,
    /// NEP-141 trades only: destinations the token contract reported as storage-registered
    /// (`storage_balance_of`). At most the active and the pending destination are kept. A release
    /// intent cannot lock the value for a destination that is not in this set.
    pub payee_storage: BTreeSet<String>,
}

pub fn digest_hex(domain: &str, v: &Value) -> R<(String, [u8; 32])> {
    let d = digest(domain, domains::VERSION, v).map_err(|e| crate::error::Error {
        code: "NON_CANONICAL",
        message: format!("payload cannot be canonically encoded: {e:?}"),
    })?;
    Ok((hex_encode(&d), d))
}

/// Register revision 1 of a trade: exact schema, contract/network binding, both party signatures.
pub fn register(ctx: &Ctx<'_>, terms_typed: &J, buyer_signature: &str, supplier_signature: &str) -> R<TradeRecord> {
    let v = decode(terms_typed)?;
    let terms = parse_terms(&v, ctx.network, ctx.contract_id)?;
    if terms.revision != 1 {
        return err("NOT_SUPPORTED", "successor revisions are activated only through the destination-change or key-rebinding protocol");
    }
    ensure(terms.expires_at > ctx.now_ms, "EXPIRED", "trade has already expired")?;
    ctx.limits.check_terms(ctx.network, &terms)?;
    let (hex, d) = digest_hex(domains::TRADE_REVISION, &v)?;
    verify(ctx.verifier, &terms.key_of("buyer")?, &d, buyer_signature)?;
    verify(ctx.verifier, &terms.key_of("supplier")?, &d, supplier_signature)?;
    Ok(TradeRecord {
        ledger: Ledger::new(terms.amount_yocto),
        terms,
        terms_digest: hex.clone(),
        registered_at: ctx.now_ms,
        refunds: BTreeMap::new(),
        holds: BTreeMap::new(),
        revoked_roles: BTreeSet::new(),
        nonces: BTreeSet::new(),
        evidence: Default::default(),
        release: Default::default(),
        revisions: alloc::vec![crate::destination::RevisionEntry { revision: 1, digest: hex.clone(), activated_at: ctx.now_ms }],
        destination: Default::default(),
        rebinding: Default::default(),
        payee_storage: BTreeSet::new(),
    })
}

impl TradeRecord {
    /// Header binding every signed trade payload: contract, trade, exact revision and digest.
    pub fn check_header(&self, o: &Obj<'_>, ctx: &Ctx<'_>) -> R<()> {
        o.expect_str("contractId", ctx.contract_id, "WRONG_CONTRACT")?;
        o.expect_str("tradeId", &self.terms.trade_id, "SCOPE_MISMATCH")?;
        ensure(o.u64("tradeRevision")? == self.terms.revision, "STALE_REVISION", "payload binds another trade revision")?;
        o.expect_str("tradeDigest", &self.terms_digest, "STALE_REVISION")
    }

    pub fn check_window(&self, o: &Obj<'_>, ctx: &Ctx<'_>, max_lifetime_ms: u64) -> R<(u64, u64)> {
        let issued = o.u64("issuedAt")?;
        let expires = o.u64("expiresAt")?;
        ensure(expires > issued, "VALIDATION_FAILED", "expiresAt must be after issuedAt")?;
        ensure(expires - issued <= max_lifetime_ms, "VALIDATION_FAILED", "validity window exceeds policy lifetime")?;
        ensure(issued <= ctx.now_ms.saturating_add(MAX_SKEW_MS), "NOT_YET_VALID", "issuedAt is in the future")?;
        ensure(ctx.now_ms < expires, "EXPIRED", "signature has expired")?;
        Ok((issued, expires))
    }

    pub fn consume_nonce(&mut self, domain: &str, nonce: &str) -> R<()> {
        ensure(is_nonce(nonce), "VALIDATION_FAILED", "nonce must be 16..32 bytes of lowercase hex")?;
        let k = format!("{domain}|{nonce}");
        ensure(!self.nonces.contains(&k), "NONCE_REPLAYED", "nonce already consumed")?;
        self.nonces.insert(k);
        Ok(())
    }

    /// The token contract to ask whether `account` is storage-registered: the trade asset must be
    /// NEP-141 and `account` the active payout destination or the destination of a pending change.
    pub fn payee_check_target(&self, account: &str) -> R<String> {
        let token = self.terms.asset.token().ok_or_else(|| crate::error::Error {
            code: "ASSET_MISMATCH",
            message: "a native NEAR payout needs no storage registration".into(),
        })?;
        let pending = self.destination.pending.as_ref().map(|p| p.to_destination.as_str());
        ensure(
            account == self.terms.payout_destination || pending == Some(account),
            "DESTINATION_MISMATCH",
            "only the active or the pending payout destination can be checked",
        )?;
        Ok(token.into())
    }

    /// Record the token contract's answer for `account` (the host calls this from its private
    /// callback only). `registered = false` removes an earlier confirmation.
    pub fn record_payee_storage(&mut self, account: &str, registered: bool) -> R<bool> {
        self.payee_check_target(account)?;
        let active = self.terms.payout_destination.clone();
        let pending = self.destination.pending.as_ref().map(|p| p.to_destination.clone());
        self.payee_storage.retain(|a| *a == active || Some(a) == pending.as_ref());
        if registered {
            self.payee_storage.insert(account.into());
        } else {
            self.payee_storage.remove(account);
        }
        Ok(registered)
    }

    /// NEP-141 trades: `destination` must be confirmed storage-registered before value is locked
    /// for it. Native trades pass.
    pub fn require_payee_storage(&self, destination: &str) -> R<()> {
        ensure(
            self.terms.asset.is_native() || self.payee_storage.contains(destination),
            "PAYEE_NOT_REGISTERED",
            "the payout destination is not confirmed as registered with the token contract; call check_payee_storage first",
        )
    }

    pub fn nonce_used(&self, domain: &str, nonce: &str) -> bool {
        self.nonces.contains(&format!("{domain}|{nonce}"))
    }

    /// A successor-revision consent carries no nonce of its own (it is a signature over the
    /// successor digest), so a party's withdrawal of it is recorded in the same replay set: once
    /// `party` revokes a successor it had consented to, its signature over that digest never
    /// counts again (TDD §7 step 10, "revoked consent fails closed").
    pub(crate) fn withdraw_consent(&mut self, successor_digest: &str, party: &str) {
        self.nonces.insert(format!("{}|withdrawn|{party}|{successor_digest}", domains::TRADE_REVISION));
    }

    pub(crate) fn ensure_consent_live(&self, successor_digest: &str, party: &str) -> R<()> {
        ensure(
            !self.nonces.contains(&format!("{}|withdrawn|{party}|{successor_digest}", domains::TRADE_REVISION)),
            "NONCE_REPLAYED",
            "this party revoked its consent to this successor revision; it cannot be replayed",
        )
    }

    /// Verify a signature by the key the signed terms bind to `role`, unless revoked on chain.
    pub fn verify_role(&self, ctx: &Ctx<'_>, role: &str, d: &[u8; 32], signature: &str) -> R<()> {
        if self.revoked_roles.contains(role) {
            return err("KEY_REVOKED", format!("the {role} key bound by this revision is revoked"));
        }
        verify(ctx.verifier, &self.terms.key_of(role)?, d, signature)
    }

    pub fn current_manifest_digest(&self, now_ms: u64) -> Option<String> {
        self.evidence.current_digest(now_ms, &self.revoked_roles)
    }

    /// Any hold that is ACTIVE or EXPIRED_UNRESOLVED blocks release, funded authorization and cancellation.
    pub fn blocking_holds(&self) -> usize {
        self.holds.values().filter(|h| h.resolution.is_none()).count()
    }

    pub fn live_refunds(&self) -> impl Iterator<Item = &RefundIntent> {
        self.refunds.values().filter(|r| r.state.is_live())
    }

    /// Revoke the key bound to `role` for this revision. Revocation only removes authority, so
    /// it may be signed by the key itself or, for non-party roles other than the risk resolver,
    /// by either trade party. The risk resolver is the only principal that can RESOLVE a hold
    /// (and authorize the hold-dependent refunds), so one party alone revoking it could strand
    /// the escrow behind an unresolved hold; replacing it takes a dual-consented key rebinding.
    pub fn revoke_key(&mut self, ctx: &Ctx<'_>, payload: &J, signature: &str) -> R<String> {
        let v = decode(payload)?;
        let o = Obj::exact(
            &v,
            &["contractId", "tradeId", "tradeRevision", "tradeDigest", "role", "publicKey", "signerRole", "reasonCode", "issuedAt", "expiresAt", "nonce"],
            "key revocation",
        )?;
        self.check_header(&o, ctx)?;
        self.check_window(&o, ctx, 24 * 3600_000)?;
        let role = o.str("role")?;
        ensure(crate::terms::ROLES.contains(&role.as_str()), "VALIDATION_FAILED", "unknown role")?;
        let bound = self.terms.all_keys().into_iter().find(|(r, _)| *r == role).map(|(_, k)| String::from(k)).unwrap_or_default();
        o.expect_str("publicKey", &bound, "KEY_NOT_BOUND")?;
        let signer = o.str("signerRole")?;
        let signer_role = match signer.as_str() {
            "SELF" => role.clone(),
            "BUYER" => "buyer".into(),
            "SUPPLIER" => "supplier".into(),
            _ => return err("FORBIDDEN", "signerRole must be SELF, BUYER or SUPPLIER"),
        };
        if signer != "SELF" {
            ensure(role != "buyer" && role != "supplier", "FORBIDDEN", "a party cannot revoke the other party's key")?;
            ensure(role != "riskResolver", "FORBIDDEN", "a party alone cannot revoke the risk resolver key; rebind it with both parties' consent")?;
        }
        let reason = o.str("reasonCode")?;
        ensure(!reason.is_empty() && reason.len() <= 64, "VALIDATION_FAILED", "reasonCode required")?;
        ensure(!self.revoked_roles.contains(&role), "INVALID_STATE", "key already revoked")?;
        let (hex, d) = digest_hex(domains::BOUND_KEY_REVOCATION, &v)?;
        self.verify_role(ctx, &signer_role, &d, signature)?;
        self.consume_nonce(domains::BOUND_KEY_REVOCATION, &o.str("nonce")?)?;
        self.revoked_roles.insert(role.clone());
        if role == "manifestAttestor" || role == "inspector" {
            self.evidence.invalidate_unconsumed(&role, ctx.now_ms);
        }
        Ok(hex)
    }
}
