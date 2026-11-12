//! Dual-consent delayed destination change (FR-06, INV-05, INV-15).
//!
//! A destination change is a successor trade revision that differs from the active one only in
//! `payout.destination` (plus `revision` and `predecessorDigest`). Buyer and supplier each sign
//! the successor's `dockside/trade-revision` digest with their bound keys; the delay of the
//! *active* revision starts only after the second consent; activation is permissionless once the
//! delay has passed and every predicate still holds. Until activation the current destination
//! stays effective. Activation:
//!
//! * is refused while a release intent is SUBMITTING/PROCESSING/UNKNOWN/REVIEW/RECONCILING/
//!   ADJUDICATION, after the value was released, and while any refund intent is live;
//! * replaces the terms and digest, so every payload signed for the old revision (approvals,
//!   attestations, inspections, hold mutations, refund and exit requests) fails `check_header`;
//! * moves the accepted manifest and inspection to history (a new attestation, inspection and
//!   buyer approval are required for the new revision); unresolved holds keep blocking;
//! * supersedes a pre-submit intent and transfers its reservation to one successor intent.
//!
//! A party that revokes a change it had consented to withdraws that consent for good: its
//! signature over the same successor digest is refused afterwards (`NONCE_REPLAYED`, TDD §7
//! step 10). Rejecting a proposal the party never signed leaves it free to consent later.
//!
//! There is no single-party, administrator, executor or database path to the destination.

use crate::domains;
use crate::error::{ensure, err, Error, R};
use crate::terms::{parse_terms, Terms};
use crate::trade::{digest_hex, Ctx, TradeRecord};
use crate::typed::{decode, Obj};
use alloc::string::String;
use alloc::vec::Vec;
use borsh::{BorshDeserialize, BorshSerialize};
use serde_json::Value as J;

/// Consents must be collected within this window after the proposal.
pub const CONSENT_WINDOW_MS: u64 = 7 * 24 * 3600_000;

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct RevisionEntry {
    pub revision: u64,
    pub digest: String,
    pub activated_at: u64,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChangeStatus {
    Proposed,
    Consented,
    Activated,
    Revoked,
    Expired,
}

impl ChangeStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            ChangeStatus::Proposed => "PROPOSED",
            ChangeStatus::Consented => "CONSENTED",
            ChangeStatus::Activated => "ACTIVATED",
            ChangeStatus::Revoked => "REVOKED",
            ChangeStatus::Expired => "EXPIRED",
        }
    }
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct DestinationChange {
    pub successor_digest: String,
    pub successor_digest_bytes: [u8; 32],
    pub terms: Terms,
    pub from_destination: String,
    pub to_destination: String,
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

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct DestinationState {
    pub pending: Option<DestinationChange>,
    pub history: Vec<DestinationChange>,
}

fn party_key(role: &str) -> R<&'static str> {
    match role {
        "BUYER" => Ok("buyer"),
        "SUPPLIER" => Ok("supplier"),
        _ => err("FORBIDDEN", "only the buyer and supplier consent to a destination change"),
    }
}

impl TradeRecord {
    fn close_pending(&mut self, status: ChangeStatus, now: u64) {
        if let Some(mut p) = self.destination.pending.take() {
            p.status = status;
            p.closed_at = Some(now);
            self.destination.history.push(p);
        }
    }

    /// Propose a successor revision that changes only the destination; the proposer's signature
    /// over the successor digest is its consent. Returns the successor digest.
    pub fn propose_destination_change(&mut self, ctx: &Ctx<'_>, successor: &J, proposer_role: &str, signature: &str) -> R<String> {
        let v = decode(successor)?;
        let t = parse_terms(&v, ctx.network, ctx.contract_id)?;
        ensure(t.trade_id == self.terms.trade_id, "SCOPE_MISMATCH", "successor names another trade")?;
        ensure(t.revision == self.terms.revision + 1, "VERSION_CONFLICT", "successor revision must increment by one")?;
        ensure(t.predecessor_digest.as_deref() == Some(self.terms_digest.as_str()), "VERSION_CONFLICT", "successor must bind the active revision digest")?;
        let mut expect = self.terms.clone();
        expect.revision = t.revision;
        expect.predecessor_digest = t.predecessor_digest.clone();
        expect.payout_destination = t.payout_destination.clone();
        ensure(expect == t, "IMMUTABLE_FIELD", "a destination change may alter only payout.destination")?;
        ensure(t.payout_destination != self.terms.payout_destination, "VALIDATION_FAILED", "successor destination equals the active destination")?;
        if let Some(p) = &self.destination.pending {
            let stale = p.status == ChangeStatus::Proposed && ctx.now_ms >= p.consent_deadline;
            ensure(stale, "DESTINATION_CHANGE_PENDING", "another destination change is pending; it must be revoked first")?;
        }
        ensure(
            self.revision_pending(ctx.now_ms) != Some("KEY_REBINDING_PENDING"),
            "KEY_REBINDING_PENDING",
            "a key rebinding is pending; it must be revoked or activated first",
        )?;
        ensure(!self.released(), "INVALID_STATE", "the trade value has already been released")?;
        ensure(ctx.now_ms < self.terms.expires_at, "EXPIRED", "trade has expired")?;
        let key = party_key(proposer_role)?;
        let (hex, d) = digest_hex(domains::TRADE_REVISION, &v)?;
        self.ensure_consent_live(&hex, key)?;
        self.verify_role(ctx, key, &d, signature)?;
        if self.destination.pending.is_some() {
            self.close_pending(ChangeStatus::Expired, ctx.now_ms);
        }
        if self.rebinding.pending.as_ref().is_some_and(|p| p.status == ChangeStatus::Proposed) {
            // A stale, never-countersigned key rebinding cannot outlive a newer revision.
            let mut p = self.rebinding.pending.take().expect("pending");
            p.status = ChangeStatus::Expired;
            p.closed_at = Some(ctx.now_ms);
            self.rebinding.history.push(p);
        }
        let now = ctx.now_ms;
        self.destination.pending = Some(DestinationChange {
            successor_digest: hex.clone(),
            successor_digest_bytes: d,
            from_destination: self.terms.payout_destination.clone(),
            to_destination: t.payout_destination.clone(),
            terms: t,
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

    /// The other party's signature over the identical successor digest; the delay starts now.
    pub fn consent_destination_change(&mut self, ctx: &Ctx<'_>, successor_digest: &str, role: &str, signature: &str) -> R<u64> {
        let key = party_key(role)?;
        let p = self.destination.pending.as_ref().ok_or_else(|| Error { code: "NOT_FOUND", message: "no pending destination change".into() })?;
        ensure(p.status == ChangeStatus::Proposed, "INVALID_STATE", "the change is not awaiting consent")?;
        ensure(p.successor_digest == successor_digest, "DIGEST_MISMATCH", "consent binds another successor digest")?;
        ensure(ctx.now_ms < p.consent_deadline, "EXPIRED", "the consent window has closed")?;
        let already = if key == "buyer" { p.buyer_consent_at.is_some() } else { p.supplier_consent_at.is_some() };
        ensure(!already, "INVALID_STATE", "this party has already consented")?;
        self.ensure_consent_live(&p.successor_digest, key)?;
        let d = p.successor_digest_bytes;
        self.verify_role(ctx, key, &d, signature)?;
        let delay = self.terms.destination_change_delay_ms;
        let p = self.destination.pending.as_mut().expect("pending");
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

    /// Either party withdraws the pending change before activation (`dockside/destination-change-revoke`).
    pub fn revoke_destination_change(&mut self, ctx: &Ctx<'_>, payload: &J, signature: &str) -> R<()> {
        let v = decode(payload)?;
        let o = Obj::exact(
            &v,
            &["contractId", "tradeId", "tradeRevision", "tradeDigest", "successorDigest", "signerRole", "issuedAt", "expiresAt", "nonce"],
            "destination change revoke",
        )?;
        self.check_header(&o, ctx)?;
        self.check_window(&o, ctx, 24 * 3600_000)?;
        let p = self.destination.pending.as_ref().ok_or_else(|| Error { code: "NOT_FOUND", message: "no pending destination change".into() })?;
        o.expect_str("successorDigest", &p.successor_digest, "DIGEST_MISMATCH")?;
        let key = party_key(&o.str("signerRole")?)?;
        let consented = if key == "buyer" { p.buyer_consent_at.is_some() } else { p.supplier_consent_at.is_some() };
        let digest = p.successor_digest.clone();
        let nonce = o.str("nonce")?;
        ensure(!self.nonce_used(domains::DESTINATION_CHANGE_REVOKE, &nonce), "NONCE_REPLAYED", "nonce already consumed")?;
        let (_, d) = digest_hex(domains::DESTINATION_CHANGE_REVOKE, &v)?;
        self.verify_role(ctx, key, &d, signature)?;
        self.consume_nonce(domains::DESTINATION_CHANGE_REVOKE, &nonce)?;
        // A revoking party that had consented withdraws that consent for good.
        if consented {
            self.withdraw_consent(&digest, key);
        }
        self.close_pending(ChangeStatus::Revoked, ctx.now_ms);
        Ok(())
    }

    /// Activate a dual-consented change after its delay. Returns (new digest, successor intent).
    pub fn activate_destination_change(&mut self, ctx: &Ctx<'_>, successor_digest: &str) -> R<(String, Option<String>)> {
        let p = self.destination.pending.as_ref().ok_or_else(|| Error { code: "NOT_FOUND", message: "no pending destination change".into() })?;
        ensure(p.successor_digest == successor_digest, "DIGEST_MISMATCH", "activation names another successor digest")?;
        ensure(p.status == ChangeStatus::Consented, "INVALID_STATE", "both buyer and supplier consents are required")?;
        ensure(p.delay_until.is_some_and(|u| ctx.now_ms >= u), "DELAY_NOT_ELAPSED", "the destination-change delay has not elapsed")?;
        for role in ["buyer", "supplier"] {
            ensure(!self.revoked_roles.contains(role), "KEY_REVOKED", "a consenting party key was revoked before activation")?;
        }
        ensure(!self.released(), "INVALID_STATE", "the trade value has already been released")?;
        self.require_no_unresolved_release()?;
        ensure(self.live_refunds().next().is_none(), "VALUE_LOCKED", "a live refund intent blocks destination activation")?;
        ensure(
            !self.refunds.values().any(|r| r.state == crate::refund::RefundState::Refunded && r.source_bucket != crate::ledger::Bucket::Quarantined),
            "INVALID_STATE",
            "accepted value was already refunded",
        )?;
        let change = p.clone();
        let new_terms = change.terms.clone();
        let new_digest = change.successor_digest.clone();
        let superseded = self.release.live.clone();
        let successor = self.supersede_live(ctx.now_ms, new_terms.revision, &new_digest, &new_terms.payout_destination)?;
        self.terms = new_terms;
        self.terms_digest = new_digest.clone();
        self.revisions.push(RevisionEntry { revision: self.terms.revision, digest: new_digest.clone(), activated_at: ctx.now_ms });
        self.evidence.reset_for_new_revision();
        let mut done = change;
        done.status = ChangeStatus::Activated;
        done.closed_at = Some(ctx.now_ms);
        done.superseded_intent = if successor.is_some() { superseded } else { None };
        done.successor_intent = successor.clone();
        self.destination.pending = None;
        self.destination.history.push(done);
        Ok((new_digest, successor))
    }
}
