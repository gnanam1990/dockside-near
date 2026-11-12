//! Trade record and the signed-payload checks shared by every authority entry point.

use crate::crypto::{verify, Verifier};
use crate::domains;
use crate::error::{ensure, err, R};
use crate::holds::Hold;
use crate::ledger::Ledger;
use crate::refund::RefundIntent;
use crate::terms::{parse_terms, Terms};
use crate::typed::{decode, hex_encode, is_nonce, Obj};
use alloc::collections::{BTreeMap, BTreeSet};
use alloc::format;
use alloc::string::String;
use borsh::{BorshDeserialize, BorshSerialize};
use dockside_canonical::{digest, Value};
use serde_json::Value as J;

/// Tolerated clock skew for `issuedAt` in the future.
pub const MAX_SKEW_MS: u64 = 5 * 60_000;

/// Per-call execution context supplied by the host.
pub struct Ctx<'a> {
    pub now_ms: u64,
    pub predecessor: &'a str,
    pub contract_id: &'a str,
    pub network: &'a str,
    pub verifier: &'a dyn Verifier,
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
    /// it may be signed by the key itself or, for non-party roles, by either trade party.
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
