//! Dual-signed key-rebinding revision (TDD §4: rotation, revocation and recovery never
//! silently substitute an authority inside an active trade; using a new key version requires an
//! explicit dual-signed trade revision and renewed downstream authority).
//!
//! A key rebinding is a successor trade revision that differs from the active one only in the
//! bound key versions and public keys of existing roles (buyer, supplier, inspector, risk/policy
//! resolver, ManifestAttestor, deterministic-policy setter). Principals, enrollments, scopes,
//! capabilities, accounts, amount, destination and every other field stay exactly as signed.
//!
//! * The contract cannot see the organization directory, so trust in a new key is anchored in a
//!   key it already binds: a rebinding may change **at most one** party key (buyer or supplier).
//!   The party whose key is unchanged signs with its bound, non-revoked key; the party whose key
//!   changes signs with its new key (it accepts the new revision with the key it now holds).
//!   Both parties rotated means two rebinding revisions, each anchored by the other party.
//! * The new key of a rebound party comes from successor terms the counterparty may have written,
//!   so the rebound party's **old** bound key keeps a veto: while it is not revoked on chain it
//!   may revoke the pending rebinding (ADR-0022). Retiring that key on chain (a SELF revocation)
//!   gives up the veto; a trade whose signed delay is zero leaves no veto window, so there a
//!   party key is rebound only after its old key was revoked on chain.
//! * A party that revokes a successor it had consented to withdraws that consent for good: its
//!   signature over the same successor digest is refused afterwards (`NONCE_REPLAYED`).
//! * When a party key changes, the trade's signed `destinationChangeDelayMs` must pass after the
//!   second consent before activation (time to revoke a rebinding nobody intended). A rebinding
//!   of non-party roles only is activatable as soon as both parties consented.
//! * Activation replaces the terms and digest (every payload signed for the old revision fails
//!   `check_header`), moves the accepted manifest and inspection to history, keeps unresolved
//!   holds blocking, supersedes a pre-submit intent into one successor that owns the same
//!   reservation, and clears the on-chain revocation mark of every rebound role.
//! * One pending successor revision at a time: a rebinding and a destination change exclude
//!   each other while either awaits consent or activation.

use crate::crypto::verify;
use crate::destination::{ChangeStatus, CONSENT_WINDOW_MS};
use crate::domains;
use crate::error::{ensure, Error, R};
use crate::terms::{parse_terms, Terms};
use crate::trade::{digest_hex, Ctx, TradeRecord};
use crate::typed::{decode, Obj};
use alloc::string::String;
use alloc::vec::Vec;
use borsh::{BorshDeserialize, BorshSerialize};
use serde_json::Value as J;

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct KeyRebinding {
    pub successor_digest: String,
    pub successor_digest_bytes: [u8; 32],
    pub terms: Terms,
    /// Roles whose key the successor rebinds, in `terms::ROLES` order.
    pub roles: Vec<String>,
    pub proposed_by: String,
    pub proposed_at: u64,
    pub consent_deadline: u64,
    pub buyer_consent_at: Option<u64>,
    pub supplier_consent_at: Option<u64>,
    pub delay_until: Option<u64>,
    pub status: ChangeStatus,
    pub closed_at: Option<u64>,
    pub superseded_intent: Option<String>,
    pub successor_intent: Option<String>,
}

impl KeyRebinding {
    /// Whether the buyer's or the supplier's own key changes (the delay applies).
    pub fn rebinds_party(&self) -> bool {
        self.roles.iter().any(|r| r == "buyer" || r == "supplier")
    }
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct RebindingState {
    pub pending: Option<KeyRebinding>,
    pub history: Vec<KeyRebinding>,
}

fn party_key(role: &str) -> R<&'static str> {
    match role {
        "BUYER" => Ok("buyer"),
        "SUPPLIER" => Ok("supplier"),
        _ => Err(Error { code: "FORBIDDEN", message: "only the buyer and supplier sign a key rebinding".into() }),
    }
}

fn human_change(role: &'static str, old_kid: &str, old_pk: &str, new_kid: &str, new_pk: &str, out: &mut Vec<String>) -> R<()> {
    if old_pk == new_pk {
        ensure(old_kid == new_kid, "VALIDATION_FAILED", "a key version cannot change without a new public key")?;
    } else {
        ensure(old_kid != new_kid, "VALIDATION_FAILED", "a new public key needs a new key version")?;
        out.push(role.into());
    }
    Ok(())
}

fn service_change(role: &'static str, old_v: u64, old_pk: &str, new_v: u64, new_pk: &str, out: &mut Vec<String>) -> R<()> {
    if old_pk == new_pk {
        ensure(old_v == new_v, "VALIDATION_FAILED", "a key version cannot change without a new public key")?;
    } else {
        ensure(new_v > old_v, "VALIDATION_FAILED", "a rebound service key must be a newer key version")?;
        out.push(role.into());
    }
    Ok(())
}

/// The roles a successor rebinds, or the reason it is not a pure key rebinding of `active`.
pub fn rebound_roles(active: &Terms, succ: &Terms) -> R<Vec<String>> {
    let mut expect = active.clone();
    expect.revision = succ.revision;
    expect.predecessor_digest = succ.predecessor_digest.clone();
    expect.buyer.key_version_id = succ.buyer.key_version_id.clone();
    expect.buyer.public_key = succ.buyer.public_key.clone();
    expect.supplier.key_version_id = succ.supplier.key_version_id.clone();
    expect.supplier.public_key = succ.supplier.public_key.clone();
    expect.inspector.key_version_id = succ.inspector.key_version_id.clone();
    expect.inspector.public_key = succ.inspector.public_key.clone();
    expect.risk_resolver.key_version_id = succ.risk_resolver.key_version_id.clone();
    expect.risk_resolver.public_key = succ.risk_resolver.public_key.clone();
    expect.manifest_attestor.key_version = succ.manifest_attestor.key_version;
    expect.manifest_attestor.public_key = succ.manifest_attestor.public_key.clone();
    expect.policy_setter.key_version = succ.policy_setter.key_version;
    expect.policy_setter.public_key = succ.policy_setter.public_key.clone();
    ensure(expect == *succ, "IMMUTABLE_FIELD", "a key rebinding may alter only bound key versions and public keys")?;
    let mut roles = Vec::new();
    human_change("buyer", &active.buyer.key_version_id, &active.buyer.public_key, &succ.buyer.key_version_id, &succ.buyer.public_key, &mut roles)?;
    human_change("supplier", &active.supplier.key_version_id, &active.supplier.public_key, &succ.supplier.key_version_id, &succ.supplier.public_key, &mut roles)?;
    human_change("inspector", &active.inspector.key_version_id, &active.inspector.public_key, &succ.inspector.key_version_id, &succ.inspector.public_key, &mut roles)?;
    human_change(
        "riskResolver",
        &active.risk_resolver.key_version_id,
        &active.risk_resolver.public_key,
        &succ.risk_resolver.key_version_id,
        &succ.risk_resolver.public_key,
        &mut roles,
    )?;
    service_change(
        "manifestAttestor",
        active.manifest_attestor.key_version,
        &active.manifest_attestor.public_key,
        succ.manifest_attestor.key_version,
        &succ.manifest_attestor.public_key,
        &mut roles,
    )?;
    service_change(
        "policySetter",
        active.policy_setter.key_version,
        &active.policy_setter.public_key,
        succ.policy_setter.key_version,
        &succ.policy_setter.public_key,
        &mut roles,
    )?;
    ensure(!roles.is_empty(), "VALIDATION_FAILED", "the successor rebinds no key")?;
    let parties = roles.iter().filter(|r| *r == "buyer" || *r == "supplier").count();
    ensure(
        parties <= 1,
        "SEPARATION_OF_DUTIES",
        "a key rebinding changes at most one party key; the other party's bound key anchors it",
    )?;
    Ok(roles)
}

impl TradeRecord {
    /// A destination change or key rebinding awaiting consent or activation (a stale,
    /// never-countersigned proposal past its consent window does not count).
    pub(crate) fn revision_pending(&self, now_ms: u64) -> Option<&'static str> {
        let live = |status: ChangeStatus, deadline: u64| match status {
            ChangeStatus::Proposed => now_ms < deadline,
            ChangeStatus::Consented => true,
            _ => false,
        };
        if self.destination.pending.as_ref().is_some_and(|p| live(p.status, p.consent_deadline)) {
            return Some("DESTINATION_CHANGE_PENDING");
        }
        if self.rebinding.pending.as_ref().is_some_and(|p| live(p.status, p.consent_deadline)) {
            return Some("KEY_REBINDING_PENDING");
        }
        None
    }

    /// The key a party signs a rebinding with: its new key when the rebinding changes it,
    /// otherwise the key the active revision binds (refused if revoked on chain).
    fn rebinding_signer(&self, succ: &Terms, roles: &[String], party: &str) -> R<[u8; 32]> {
        if roles.iter().any(|r| r == party) {
            return succ.key_of(party);
        }
        ensure(
            !self.revoked_roles.contains(party),
            "KEY_REVOKED",
            "the unchanged party's bound key is revoked; it cannot anchor a rebinding",
        )?;
        self.terms.key_of(party)
    }

    fn close_rebinding(&mut self, status: ChangeStatus, now: u64) {
        if let Some(mut p) = self.rebinding.pending.take() {
            p.status = status;
            p.closed_at = Some(now);
            self.rebinding.history.push(p);
        }
    }

    /// Propose a successor revision that rebinds keys only; the proposer's signature over the
    /// successor digest is its consent. Returns the successor digest.
    pub fn propose_key_rebinding(&mut self, ctx: &Ctx<'_>, successor: &J, proposer_role: &str, signature: &str) -> R<String> {
        let v = decode(successor)?;
        let t = parse_terms(&v, ctx.network, ctx.contract_id)?;
        ensure(t.trade_id == self.terms.trade_id, "SCOPE_MISMATCH", "successor names another trade")?;
        ensure(t.revision == self.terms.revision + 1, "VERSION_CONFLICT", "successor revision must increment by one")?;
        ensure(t.predecessor_digest.as_deref() == Some(self.terms_digest.as_str()), "VERSION_CONFLICT", "successor must bind the active revision digest")?;
        let roles = rebound_roles(&self.terms, &t)?;
        if let Some(code) = self.revision_pending(ctx.now_ms) {
            return Err(Error { code, message: "another successor revision is pending; it must be revoked first".into() });
        }
        ensure(!self.released(), "INVALID_STATE", "the trade value has already been released")?;
        ensure(ctx.now_ms < self.terms.expires_at, "EXPIRED", "trade has expired")?;
        let key = party_key(proposer_role)?;
        let (hex, d) = digest_hex(domains::TRADE_REVISION, &v)?;
        self.ensure_consent_live(&hex, key)?;
        verify(ctx.verifier, &self.rebinding_signer(&t, &roles, key)?, &d, signature)?;
        if self.rebinding.pending.is_some() {
            self.close_rebinding(ChangeStatus::Expired, ctx.now_ms);
        }
        if self.destination.pending.as_ref().is_some_and(|p| p.status == ChangeStatus::Proposed) {
            // A stale, never-countersigned destination proposal cannot outlive a newer revision.
            let mut p = self.destination.pending.take().expect("pending");
            p.status = ChangeStatus::Expired;
            p.closed_at = Some(ctx.now_ms);
            self.destination.history.push(p);
        }
        let now = ctx.now_ms;
        self.rebinding.pending = Some(KeyRebinding {
            successor_digest: hex.clone(),
            successor_digest_bytes: d,
            terms: t,
            roles,
            proposed_by: proposer_role.into(),
            proposed_at: now,
            consent_deadline: now + CONSENT_WINDOW_MS,
            buyer_consent_at: (key == "buyer").then_some(now),
            supplier_consent_at: (key == "supplier").then_some(now),
            delay_until: None,
            status: ChangeStatus::Proposed,
            closed_at: None,
            superseded_intent: None,
            successor_intent: None,
        });
        Ok(hex)
    }

    /// The other party's signature over the identical successor digest. Returns the time from
    /// which activation is possible (now, or now + the signed delay when a party key changes).
    pub fn consent_key_rebinding(&mut self, ctx: &Ctx<'_>, successor_digest: &str, role: &str, signature: &str) -> R<u64> {
        let key = party_key(role)?;
        let p = self.rebinding.pending.as_ref().ok_or_else(|| Error { code: "NOT_FOUND", message: "no pending key rebinding".into() })?;
        ensure(p.status == ChangeStatus::Proposed, "INVALID_STATE", "the rebinding is not awaiting consent")?;
        ensure(p.successor_digest == successor_digest, "DIGEST_MISMATCH", "consent binds another successor digest")?;
        ensure(ctx.now_ms < p.consent_deadline, "EXPIRED", "the consent window has closed")?;
        let already = if key == "buyer" { p.buyer_consent_at.is_some() } else { p.supplier_consent_at.is_some() };
        ensure(!already, "INVALID_STATE", "this party has already consented")?;
        self.ensure_consent_live(&p.successor_digest, key)?;
        let signer = self.rebinding_signer(&p.terms, &p.roles, key)?;
        verify(ctx.verifier, &signer, &p.successor_digest_bytes, signature)?;
        let delay = if p.rebinds_party() { self.terms.destination_change_delay_ms } else { 0 };
        let p = self.rebinding.pending.as_mut().expect("pending");
        if key == "buyer" {
            p.buyer_consent_at = Some(ctx.now_ms);
        } else {
            p.supplier_consent_at = Some(ctx.now_ms);
        }
        let until = ctx.now_ms + delay;
        p.delay_until = Some(until);
        p.status = ChangeStatus::Consented;
        Ok(until)
    }

    /// Either party withdraws the pending rebinding before activation (`dockside/key-rebinding-revoke`).
    pub fn revoke_key_rebinding(&mut self, ctx: &Ctx<'_>, payload: &J, signature: &str) -> R<()> {
        let v = decode(payload)?;
        let o = Obj::exact(
            &v,
            &["contractId", "tradeId", "tradeRevision", "tradeDigest", "successorDigest", "signerRole", "issuedAt", "expiresAt", "nonce"],
            "key rebinding revoke",
        )?;
        self.check_header(&o, ctx)?;
        self.check_window(&o, ctx, 24 * 3600_000)?;
        let p = self.rebinding.pending.as_ref().ok_or_else(|| Error { code: "NOT_FOUND", message: "no pending key rebinding".into() })?;
        ensure(matches!(p.status, ChangeStatus::Proposed | ChangeStatus::Consented), "INVALID_STATE", "the rebinding is closed")?;
        o.expect_str("successorDigest", &p.successor_digest, "DIGEST_MISMATCH")?;
        let key = party_key(&o.str("signerRole")?)?;
        let consented = if key == "buyer" { p.buyer_consent_at.is_some() } else { p.supplier_consent_at.is_some() };
        let digest = p.successor_digest.clone();
        let nonce = o.str("nonce")?;
        ensure(!self.nonce_used(domains::KEY_REBINDING_REVOKE, &nonce), "NONCE_REPLAYED", "nonce already consumed")?;
        let (_, d) = digest_hex(domains::KEY_REBINDING_REVOKE, &v)?;
        let signer = self.rebinding_signer(&p.terms, &p.roles, key)?;
        let by_new_key = verify(ctx.verifier, &signer, &d, signature);
        if by_new_key.is_err() && p.roles.iter().any(|r| r == key) {
            // The rebound party's old bound key (still live on chain) vetoes a rebinding of its
            // own role: the new key comes from successor terms the counterparty may have written.
            self.verify_role(ctx, key, &d, signature)?;
        } else {
            by_new_key?;
        }
        self.consume_nonce(domains::KEY_REBINDING_REVOKE, &nonce)?;
        // A revoking party that had consented withdraws that consent for good.
        if consented {
            self.withdraw_consent(&digest, key);
        }
        self.close_rebinding(ChangeStatus::Revoked, ctx.now_ms);
        Ok(())
    }

    /// Activate a dual-consented rebinding after its delay (permissionless relay). Returns
    /// (new digest, successor intent).
    pub fn activate_key_rebinding(&mut self, ctx: &Ctx<'_>, successor_digest: &str) -> R<(String, Option<String>)> {
        let p = self.rebinding.pending.as_ref().ok_or_else(|| Error { code: "NOT_FOUND", message: "no pending key rebinding".into() })?;
        ensure(p.successor_digest == successor_digest, "DIGEST_MISMATCH", "activation names another successor digest")?;
        ensure(p.status == ChangeStatus::Consented, "INVALID_STATE", "both buyer and supplier consents are required")?;
        ensure(p.delay_until.is_some_and(|u| ctx.now_ms >= u), "DELAY_NOT_ELAPSED", "the key-rebinding delay has not elapsed")?;
        for role in ["buyer", "supplier"] {
            if !p.roles.iter().any(|r| r == role) {
                ensure(!self.revoked_roles.contains(role), "KEY_REVOKED", "the anchoring party key was revoked before activation")?;
            } else if self.terms.destination_change_delay_ms == 0 {
                // A zero signed delay leaves the rebound party's old key no window to veto, so
                // the counterparty alone would choose the party's new key: that old key must be
                // retired on chain first.
                ensure(
                    self.revoked_roles.contains(role),
                    "INVALID_STATE",
                    "with a zero signed delay a party key is rebound only after its old bound key is revoked on chain",
                )?;
            }
        }
        ensure(!self.released(), "INVALID_STATE", "the trade value has already been released")?;
        self.require_no_unresolved_release()?;
        ensure(self.live_refunds().next().is_none(), "VALUE_LOCKED", "a live refund intent blocks key-rebinding activation")?;
        ensure(
            !self.refunds.values().any(|r| r.state == crate::refund::RefundState::Refunded && r.source_bucket != crate::ledger::Bucket::Quarantined),
            "INVALID_STATE",
            "accepted value was already refunded",
        )?;
        ensure(ctx.now_ms < self.terms.expires_at, "EXPIRED", "trade has expired")?;
        let change = p.clone();
        let new_terms = change.terms.clone();
        let new_digest = change.successor_digest.clone();
        let superseded = self.release.live.clone();
        let destination = self.terms.payout_destination.clone();
        let successor = self.supersede_live(ctx.now_ms, new_terms.revision, &new_digest, &destination)?;
        self.terms = new_terms;
        self.terms_digest = new_digest.clone();
        self.revisions.push(crate::destination::RevisionEntry { revision: self.terms.revision, digest: new_digest.clone(), activated_at: ctx.now_ms });
        self.evidence.reset_for_new_revision();
        for r in &change.roles {
            self.revoked_roles.remove(r.as_str());
        }
        let mut done = change;
        done.status = ChangeStatus::Activated;
        done.closed_at = Some(ctx.now_ms);
        done.superseded_intent = if successor.is_some() { superseded } else { None };
        done.successor_intent = successor.clone();
        self.rebinding.pending = None;
        self.rebinding.history.push(done);
        Ok((new_digest, successor))
    }
}
