//! Release intents, buyer approval, direct testnet release and pre-submit exits
//! (FR-05, FR-11, INV-03, INV-06, INV-09, INV-10, INV-12, INV-15).
//!
//! One live release intent per trade owns the exact value lock: creating it moves every funder's
//! AVAILABLE slice into `reserved` and records those slices. The intent id is chosen by the
//! buyer's client (random), is independent of quotes, revisions and attempts, and an exact
//! duplicate request joins the existing intent while any other reuse of the id fails closed.
//!
//! Release is a conjunction the contract recomputes at execution time from its own state:
//! current revision, funding, contract-accepted manifest, current inspector PASS, no ACTIVE or
//! EXPIRED_UNRESOLVED hold, the buyer approval bound to all of those facts, destination, profile
//! and reservation. `release_blockers` enumerates every missing term; any one of them rejects.
//!
//! Only pre-submit intents (`VALUE_LOCKED`, `DIRECT_TESTNET_AUTHORIZED`,
//! `FUNDED_AUTHORIZATION_REQUIRED`, `FUNDED_AUTHORIZED`) may exit: CANCEL needs both party
//! consents over one canonical payload, ABANDON needs one designated party after the objective
//! trigger plus the profile's grace period, and supersession happens only through destination
//! activation (see `destination`). Each exit restores or transfers the exact reservation in the
//! same call. `SUBMITTING`, `PROCESSING`, `UNKNOWN`, `REVIEW`, `RECONCILING` and `ADJUDICATION`
//! keep the lock and reject every competing action.

use crate::domains;
use crate::error::{ensure, err, Error, R};
use crate::ledger::Bucket;
use crate::trade::{digest_hex, Ctx, TradeRecord};
use crate::typed::{decode, hex_encode, is_id, is_nonce, Obj};
use alloc::collections::BTreeMap;
use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;
use borsh::{BorshDeserialize, BorshSerialize};
use dockside_canonical::Value;
use serde_json::Value as J;

pub const DAY_MS: u64 = 24 * 3600_000;
pub const PROFILE_DIRECT: &str = "DIRECT_TESTNET";
pub const PROFILE_FUNDED: &str = "FUNDED_1CLICK";
pub const MAX_INTENT_LIFETIME_MS: u64 = 14 * DAY_MS;
pub const MAX_APPROVAL_LIFETIME_MS: u64 = 7 * DAY_MS;
pub const MAX_EXIT_LIFETIME_MS: u64 = DAY_MS;
/// Abandonment policy bound by the signed `dockside-direct-testnet-v1` profile (ADR-0006).
pub const ABANDON_POLICY_ID: &str = "dockside-abandon-v1";
pub const ABANDON_POLICY_REVISION: u64 = 1;
pub const ABANDON_GRACE_MS: u64 = DAY_MS;

#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntentState {
    ValueLocked,
    DirectTestnetAuthorized,
    FundedAuthorizationRequired,
    FundedAuthorized,
    Submitting,
    Processing,
    Unknown,
    Review,
    Reconciling,
    Adjudication,
    Paid,
    Refunded,
    Failed,
    CancelledPreSubmit,
    AbandonedPreSubmit,
    SupersededPreSubmit,
}

pub const ALL_STATES: [IntentState; 16] = [
    IntentState::ValueLocked,
    IntentState::DirectTestnetAuthorized,
    IntentState::FundedAuthorizationRequired,
    IntentState::FundedAuthorized,
    IntentState::Submitting,
    IntentState::Processing,
    IntentState::Unknown,
    IntentState::Review,
    IntentState::Reconciling,
    IntentState::Adjudication,
    IntentState::Paid,
    IntentState::Refunded,
    IntentState::Failed,
    IntentState::CancelledPreSubmit,
    IntentState::AbandonedPreSubmit,
    IntentState::SupersededPreSubmit,
];

impl IntentState {
    pub fn as_str(&self) -> &'static str {
        match self {
            IntentState::ValueLocked => "VALUE_LOCKED",
            IntentState::DirectTestnetAuthorized => "DIRECT_TESTNET_AUTHORIZED",
            IntentState::FundedAuthorizationRequired => "FUNDED_AUTHORIZATION_REQUIRED",
            IntentState::FundedAuthorized => "FUNDED_AUTHORIZED",
            IntentState::Submitting => "SUBMITTING",
            IntentState::Processing => "PROCESSING",
            IntentState::Unknown => "UNKNOWN",
            IntentState::Review => "REVIEW",
            IntentState::Reconciling => "RECONCILING",
            IntentState::Adjudication => "ADJUDICATION",
            IntentState::Paid => "PAID",
            IntentState::Refunded => "REFUNDED",
            IntentState::Failed => "FAILED",
            IntentState::CancelledPreSubmit => "CANCELLED_PRE_SUBMIT",
            IntentState::AbandonedPreSubmit => "ABANDONED_PRE_SUBMIT",
            IntentState::SupersededPreSubmit => "SUPERSEDED_PRE_SUBMIT",
        }
    }
    pub fn is_pre_submit(&self) -> bool {
        matches!(
            self,
            IntentState::ValueLocked | IntentState::DirectTestnetAuthorized | IntentState::FundedAuthorizationRequired | IntentState::FundedAuthorized
        )
    }
    /// Submitted and not yet authoritatively resolved: the value lock is frozen.
    pub fn is_unresolved(&self) -> bool {
        matches!(
            self,
            IntentState::Submitting | IntentState::Processing | IntentState::Unknown | IntentState::Review | IntentState::Reconciling | IntentState::Adjudication
        )
    }
    pub fn is_live(&self) -> bool {
        self.is_pre_submit() || self.is_unresolved()
    }
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct Slice {
    pub funder: String,
    pub amount: u128,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct Approval {
    pub digest: String,
    pub approved_at: u64,
    pub expires_at: u64,
    pub manifest_revision: u64,
    pub manifest_digest: String,
    pub attestation_digest: String,
    pub inspection_digest: String,
    pub holds_view_digest: String,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct CancelConsent {
    pub role: String,
    pub nonce: String,
    pub expires_at: u64,
    pub digest: String,
    pub recorded_at: u64,
    pub revoked: bool,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct PendingCancel {
    pub digest: String,
    pub request_nonce: String,
    pub reason_code: String,
    pub expires_at: u64,
    pub consents: Vec<CancelConsent>,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct ReleaseIntent {
    pub id: String,
    pub trade_revision: u64,
    pub terms_digest: String,
    pub request_digest: String,
    pub amount: u128,
    pub slices: Vec<Slice>,
    pub source_bucket: Bucket,
    pub destination: String,
    pub profile: String,
    pub state: IntentState,
    pub version: u64,
    pub created_at: u64,
    pub expires_at: u64,
    pub approval: Option<Approval>,
    pub cancel: Option<PendingCancel>,
    pub exit_digest: Option<String>,
    pub predecessor: Option<String>,
    pub successor: Option<String>,
    pub attempts: Vec<String>,
    pub consumed_manifest: Option<String>,
    pub history: Vec<(String, u64)>,
}

impl ReleaseIntent {
    pub fn to(&mut self, s: IntentState, now: u64) {
        self.state = s;
        self.version += 1;
        self.history.push((s.as_str().into(), now));
    }
    pub fn slice_pairs(&self) -> Vec<(String, u128)> {
        self.slices.iter().map(|s| (s.funder.clone(), s.amount)).collect()
    }
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct ReleaseState {
    pub intents: BTreeMap<String, ReleaseIntent>,
    /// The one intent that currently owns the value lock.
    pub live: Option<String>,
}

fn s(x: &str) -> Value {
    Value::Str(x.into())
}

fn code_ok(x: &str) -> bool {
    !x.is_empty() && x.len() <= 64 && x.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
}

/// `dockside/destination-snapshot` digest of a NEAR payout destination.
pub fn destination_digest(network: &str, destination: &str) -> R<String> {
    let v = Value::Struct(alloc::vec![
        ("network".into(), s(network)),
        ("recipientType".into(), s("NEAR_ACCOUNT")),
        ("destination".into(), s(destination)),
    ]);
    Ok(digest_hex(domains::DESTINATION_SNAPSHOT, &v)?.0)
}

/// `dockside/reservation-source` digest of the exact per-funder slices and their source bucket.
pub fn source_bucket_digest(slices: &[(String, u128)]) -> R<String> {
    let list = slices
        .iter()
        .map(|(f, a)| Value::Struct(alloc::vec![("funder".into(), s(f)), ("amountYocto".into(), Value::U128(*a))]))
        .collect();
    let v = Value::Struct(alloc::vec![("sourceBucket".into(), s("AVAILABLE")), ("slices".into(), Value::List(list))]);
    Ok(digest_hex(domains::RESERVATION_SOURCE, &v)?.0)
}

fn state_err(st: IntentState) -> Error {
    if st.is_unresolved() {
        Error { code: "VALUE_LOCKED", message: format!("release intent is {}: the value lock admits no competing action", st.as_str()) }
    } else {
        Error { code: "INVALID_STATE", message: format!("release intent is {}", st.as_str()) }
    }
}

impl TradeRecord {
    pub fn live_intent(&self) -> Option<&ReleaseIntent> {
        self.release.live.as_ref().and_then(|id| self.release.intents.get(id))
    }

    /// A submitted intent whose outcome is not authoritatively known freezes all competing actions.
    pub fn release_unresolved(&self) -> bool {
        self.live_intent().is_some_and(|i| i.state.is_unresolved())
    }

    pub fn released(&self) -> bool {
        self.release.intents.values().any(|i| i.state == IntentState::Paid)
    }

    pub fn require_no_unresolved_release(&self) -> R<()> {
        match self.live_intent() {
            Some(i) if i.state.is_unresolved() => Err(state_err(i.state)),
            _ => Ok(()),
        }
    }

    /// `dockside/holds-view` digest: every HoldRecord of the trade with its status at `now`.
    pub fn holds_view_digest(&self, now_ms: u64) -> R<String> {
        let list = self
            .holds
            .values()
            .map(|h| {
                Value::Struct(alloc::vec![
                    ("holdId".into(), s(&h.id)),
                    ("status".into(), s(h.status(now_ms))),
                    ("setDigest".into(), s(&h.set_digest)),
                    ("resolutionDigest".into(), h.resolution.as_ref().map(|r| s(&r.digest)).unwrap_or(Value::Null)),
                ])
            })
            .collect();
        let v = Value::Struct(alloc::vec![
            ("tradeId".into(), s(&self.terms.trade_id)),
            ("tradeRevision".into(), Value::U64(self.terms.revision)),
            ("holds".into(), Value::List(list)),
        ]);
        Ok(digest_hex(domains::HOLDS_VIEW, &v)?.0)
    }

    fn current_inspection_pass(&self, now_ms: u64) -> Option<&crate::evidence::InspectionRecord> {
        self.evidence.current_inspection(now_ms).filter(|i| i.decision == "PASS")
    }

    /// Every missing term of the release conjunction for the live intent, in a stable order.
    /// Empty means the exact complete conjunction holds right now.
    pub fn release_blockers(&self, now_ms: u64) -> Vec<&'static str> {
        let mut out = Vec::new();
        if now_ms >= self.terms.expires_at {
            out.push("TRADE_EXPIRED");
        }
        if !self.ledger.fully_funded() {
            out.push("NOT_FULLY_FUNDED");
        }
        let manifest = self.evidence.usable(now_ms);
        match manifest {
            None => out.push("MANIFEST_NOT_CURRENT"),
            Some(m) if m.consumed => out.push("MANIFEST_CONSUMED"),
            _ => {}
        }
        let inspection = self.current_inspection_pass(now_ms);
        if inspection.is_none() {
            out.push("INSPECTION_NOT_PASS");
        }
        if self.blocking_holds() > 0 {
            out.push("HOLD_ACTIVE");
        }
        if self.live_refunds().any(|r| r.source_bucket != Bucket::Quarantined) {
            out.push("REFUND_UNRESOLVED");
        }
        let Some(i) = self.live_intent() else {
            out.push("NO_RELEASE_INTENT");
            return out;
        };
        if i.state.is_unresolved() {
            out.push("VALUE_LOCKED");
            return out;
        }
        if i.trade_revision != self.terms.revision || i.terms_digest != self.terms_digest {
            out.push("STALE_REVISION");
        }
        if now_ms >= i.expires_at {
            out.push("INTENT_EXPIRED");
        }
        if i.profile != PROFILE_DIRECT {
            out.push("PROFILE_MISMATCH");
        }
        if i.destination != self.terms.payout_destination {
            out.push("DESTINATION_MISMATCH");
        }
        if i.amount != self.terms.amount_yocto || !self.ledger.reservation_matches(&i.slice_pairs()) {
            out.push("VALUE_NOT_LOCKED");
        }
        match (&i.approval, i.state) {
            (Some(a), IntentState::DirectTestnetAuthorized) => {
                if now_ms >= a.expires_at {
                    out.push("APPROVAL_EXPIRED");
                }
                let manifest_ok = manifest.is_some_and(|m| m.digest == a.manifest_digest && m.attestation_digest == a.attestation_digest && m.revision == a.manifest_revision);
                let inspection_ok = inspection.is_some_and(|x| x.digest == a.inspection_digest);
                let holds_ok = self.holds_view_digest(now_ms).is_ok_and(|h| h == a.holds_view_digest);
                if !(manifest_ok && inspection_ok && holds_ok) {
                    out.push("APPROVAL_STALE");
                }
            }
            _ => out.push("APPROVAL_MISSING"),
        }
        out
    }

    /// Buyer-signed `dockside/release-intent`: lock the exact trade value under a stable id.
    /// Returns `(releaseIntentId, joined)`; `joined` is true for an exact duplicate.
    pub fn create_release_intent(&mut self, ctx: &Ctx<'_>, payload: &J, buyer_signature: &str) -> R<(String, bool)> {
        let v = decode(payload)?;
        let o = Obj::exact(
            &v,
            &[
                "contractId", "tradeId", "tradeRevision", "tradeDigest", "network", "releaseIntentId", "amountYocto", "executionProfile",
                "destination", "destinationDigest", "sourceBucketDigest", "intentExpiresAt", "signerRole", "issuedAt", "expiresAt", "nonce",
            ],
            "release intent",
        )?;
        let id = o.str("releaseIntentId")?;
        ensure(is_id(&id, "rli"), "VALIDATION_FAILED", "releaseIntentId malformed")?;
        let (hex, d) = digest_hex(domains::RELEASE_INTENT, &v)?;
        if let Some(existing) = self.release.intents.get(&id) {
            ensure(existing.request_digest == hex, "IDEMPOTENCY_CONFLICT", "releaseIntentId was already used for different material")?;
            return Ok((id, true));
        }
        self.check_header(&o, ctx)?;
        o.expect_str("network", ctx.network, "WRONG_NETWORK")?;
        o.expect_str("signerRole", "BUYER_APPROVER", "FORBIDDEN")?;
        self.check_window(&o, ctx, DAY_MS)?;
        match o.str("executionProfile")?.as_str() {
            PROFILE_DIRECT => {}
            PROFILE_FUNDED => return err("FUNDED_RAIL_BLOCKED", "the funded payout profile is not enabled"),
            _ => return err("UNSUPPORTED_VERSION", "unknown execution profile"),
        }
        if let Some(l) = self.live_intent() {
            return err("VALUE_LOCKED", format!("release intent {} ({}) already owns the value lock", l.id, l.state.as_str()));
        }
        ensure(!self.released(), "INVALID_STATE", "the trade value has already been released")?;
        ensure(ctx.now_ms < self.terms.expires_at, "EXPIRED", "trade has expired")?;
        ensure(!self.live_refunds().any(|r| r.source_bucket != Bucket::Quarantined), "VALUE_LOCKED", "a live refund intent locks accepted value")?;
        ensure(self.ledger.fully_funded(), "NOT_FULLY_FUNDED", "the trade is not fully funded")?;
        let amount = o.u128("amountYocto")?;
        ensure(amount == self.terms.amount_yocto, "INVALID_AMOUNT", "an intent locks exactly the trade amount")?;
        let slices = self.ledger.available_slices();
        let total = slices.iter().map(|(_, a)| *a).fold(0u128, |a, b| a.saturating_add(b));
        ensure(total == amount, "STALE_LEDGER", "available value differs from the trade amount")?;
        let dest = o.str("destination")?;
        ensure(dest == self.terms.payout_destination, "DESTINATION_MISMATCH", "intent destination is not the revision-bound destination")?;
        o.expect_str("destinationDigest", &destination_digest(ctx.network, &dest)?, "DESTINATION_MISMATCH")?;
        o.expect_str("sourceBucketDigest", &source_bucket_digest(&slices)?, "STALE_LEDGER")?;
        let expires = o.u64("intentExpiresAt")?;
        ensure(
            expires > ctx.now_ms && expires <= self.terms.expires_at && expires - ctx.now_ms <= MAX_INTENT_LIFETIME_MS,
            "VALIDATION_FAILED",
            "intentExpiresAt must be in the future, within the trade and the intent lifetime",
        )?;
        let nonce = o.str("nonce")?;
        ensure(!self.nonce_used(domains::RELEASE_INTENT, &nonce), "NONCE_REPLAYED", "nonce already consumed")?;
        self.verify_role(ctx, "buyer", &d, buyer_signature)?;
        self.consume_nonce(domains::RELEASE_INTENT, &nonce)?;
        let reserved = self.ledger.reserve_available()?;
        ensure(reserved == slices, "CONSERVATION_VIOLATION", "reservation differs from the computed slices")?;
        let intent = ReleaseIntent {
            id: id.clone(),
            trade_revision: self.terms.revision,
            terms_digest: self.terms_digest.clone(),
            request_digest: hex,
            amount,
            slices: slices.into_iter().map(|(funder, amount)| Slice { funder, amount }).collect(),
            source_bucket: Bucket::Available,
            destination: dest,
            profile: PROFILE_DIRECT.into(),
            state: IntentState::ValueLocked,
            version: 1,
            created_at: ctx.now_ms,
            expires_at: expires,
            approval: None,
            cancel: None,
            exit_digest: None,
            predecessor: None,
            successor: None,
            attempts: Vec::new(),
            consumed_manifest: None,
            history: alloc::vec![("RELEASE_INTENT_CREATED".into(), ctx.now_ms), ("VALUE_LOCKED".into(), ctx.now_ms)],
        };
        self.release.intents.insert(id.clone(), intent);
        self.release.live = Some(id.clone());
        Ok((id, false))
    }

    fn live_by_id(&self, id: &str) -> R<&ReleaseIntent> {
        let i = self.release.intents.get(id).ok_or_else(|| Error { code: "NOT_FOUND", message: "release intent not found".into() })?;
        if self.release.live.as_deref() != Some(id) {
            return Err(state_err(i.state));
        }
        Ok(i)
    }

    /// Buyer approval of one exact intent, bound to the manifest, inspection and holds it saw.
    pub fn approve_release(&mut self, ctx: &Ctx<'_>, payload: &J, signature: &str) -> R<String> {
        let v = decode(payload)?;
        let o = Obj::exact(
            &v,
            &[
                "contractId", "tradeId", "tradeRevision", "tradeDigest", "releaseIntentId", "intentStateVersion", "amountYocto",
                "executionProfile", "destination", "destinationDigest", "manifestRevision", "manifestDigest", "attestationDigest",
                "inspectionDigest", "holdsViewDigest", "signerRole", "issuedAt", "expiresAt", "nonce",
            ],
            "buyer approval",
        )?;
        self.check_header(&o, ctx)?;
        o.expect_str("signerRole", "BUYER_APPROVER", "FORBIDDEN")?;
        let (_, expires) = self.check_window(&o, ctx, MAX_APPROVAL_LIFETIME_MS)?;
        let id = o.str("releaseIntentId")?;
        let i = self.live_by_id(&id)?.clone();
        if i.state != IntentState::ValueLocked {
            return Err(state_err(i.state));
        }
        ensure(o.u64("intentStateVersion")? == i.version, "VERSION_CONFLICT", "approval binds another intent state version")?;
        ensure(i.trade_revision == self.terms.revision && i.terms_digest == self.terms_digest, "STALE_REVISION", "intent belongs to another revision")?;
        ensure(ctx.now_ms < i.expires_at, "INTENT_EXPIRED", "release intent has expired")?;
        ensure(expires <= i.expires_at, "VALIDATION_FAILED", "approval cannot outlive its intent")?;
        ensure(o.u128("amountYocto")? == i.amount, "INVALID_AMOUNT", "approval amount differs from the locked value")?;
        o.expect_str("executionProfile", &i.profile, "PROFILE_MISMATCH")?;
        o.expect_str("destination", &i.destination, "DESTINATION_MISMATCH")?;
        ensure(i.destination == self.terms.payout_destination, "DESTINATION_MISMATCH", "intent destination is no longer bound")?;
        o.expect_str("destinationDigest", &destination_digest(ctx.network, &i.destination)?, "DESTINATION_MISMATCH")?;
        let m = self.evidence.usable(ctx.now_ms).ok_or_else(|| Error { code: "MANIFEST_NOT_CURRENT", message: "no current, complete, unexpired contract-accepted manifest".into() })?;
        ensure(!m.consumed, "MANIFEST_CONSUMED", "manifest attestation already consumed by a release")?;
        ensure(o.u64("manifestRevision")? == m.revision, "STALE_MANIFEST", "approval binds another manifest revision")?;
        o.expect_str("manifestDigest", &m.digest, "STALE_MANIFEST")?;
        o.expect_str("attestationDigest", &m.attestation_digest, "STALE_MANIFEST")?;
        let (m_rev, m_digest, m_att) = (m.revision, m.digest.clone(), m.attestation_digest.clone());
        let ins = self.current_inspection_pass(ctx.now_ms).ok_or_else(|| Error { code: "INSPECTION_NOT_PASS", message: "no current inspector PASS for the current manifest".into() })?;
        o.expect_str("inspectionDigest", &ins.digest, "STALE_MANIFEST")?;
        let ins_digest = ins.digest.clone();
        ensure(self.blocking_holds() == 0, "HOLD_ACTIVE", "an ACTIVE or EXPIRED_UNRESOLVED hold blocks approval")?;
        let holds = self.holds_view_digest(ctx.now_ms)?;
        o.expect_str("holdsViewDigest", &holds, "STALE_HOLDS")?;
        let nonce = o.str("nonce")?;
        ensure(!self.nonce_used(domains::BUYER_APPROVAL, &nonce), "NONCE_REPLAYED", "nonce already consumed")?;
        let (hex, d) = digest_hex(domains::BUYER_APPROVAL, &v)?;
        self.verify_role(ctx, "buyer", &d, signature)?;
        self.consume_nonce(domains::BUYER_APPROVAL, &nonce)?;
        let it = self.release.intents.get_mut(&id).expect("live");
        it.approval = Some(Approval {
            digest: hex.clone(),
            approved_at: ctx.now_ms,
            expires_at: expires,
            manifest_revision: m_rev,
            manifest_digest: m_digest,
            attestation_digest: m_att,
            inspection_digest: ins_digest,
            holds_view_digest: holds,
        });
        it.to(IntentState::DirectTestnetAuthorized, ctx.now_ms);
        Ok(hex)
    }

    /// Recheck the whole conjunction, consume the manifest attestation and enter SUBMITTING.
    /// Returns the transfer the host must perform: (bound destination, amount, attempt id).
    pub fn execute_release(&mut self, ctx: &Ctx<'_>, id: &str) -> R<(String, u128, String)> {
        let i = self.live_by_id(id)?;
        if !i.state.is_pre_submit() {
            return Err(state_err(i.state));
        }
        let blockers = self.release_blockers(ctx.now_ms);
        if let Some(first) = blockers.first() {
            return err(first, format!("release conjunction incomplete: {}", blockers.join(",")));
        }
        let attempt_value = Value::Struct(alloc::vec![
            ("releaseIntentId".into(), s(id)),
            ("attempt".into(), Value::U64(i.attempts.len() as u64 + 1)),
        ]);
        let (_, ad) = digest_hex(domains::RELEASE_INTENT_SUCCESSOR, &attempt_value)?;
        let attempt = format!("rla_{}", &hex_encode(&ad)[..32]);
        let digest = {
            let m = self.evidence.current.as_mut().ok_or_else(|| Error { code: "INTERNAL", message: "manifest vanished".into() })?;
            m.consumed = true;
            m.digest.clone()
        };
        let it = self.release.intents.get_mut(id).expect("live");
        it.attempts.push(attempt.clone());
        it.consumed_manifest = Some(digest);
        it.to(IntentState::Submitting, ctx.now_ms);
        Ok((it.destination.clone(), it.amount, attempt))
    }

    /// Transfer receipt for the release attempt. Success is PAID (reserved -> released); a failed
    /// native transfer returned by the runtime is the authoritative no-transfer proof for FAILED
    /// (reserved -> available). Either way the intent stops owning the lock.
    pub fn complete_release(&mut self, ctx: &Ctx<'_>, id: &str, attempt: &str, transferred: bool) -> R<()> {
        let i = self.live_by_id(id)?.clone();
        ensure(
            matches!(i.state, IntentState::Submitting | IntentState::Processing | IntentState::Unknown | IntentState::Reconciling),
            "INVALID_STATE",
            "no release outcome is pending",
        )?;
        ensure(i.attempts.last().map(String::as_str) == Some(attempt), "VALIDATION_FAILED", "receipt is for another attempt")?;
        if transferred {
            self.ledger.settle_release(&i.slice_pairs())?;
        } else {
            self.ledger.restore_reserved(&i.slice_pairs())?;
        }
        let it = self.release.intents.get_mut(id).expect("live");
        it.to(if transferred { IntentState::Paid } else { IntentState::Failed }, ctx.now_ms);
        self.release.live = None;
        Ok(())
    }

    /// Fields shared by CANCEL and ABANDON payloads: the exact intent, state, value and buckets.
    fn check_exit_binding(&self, o: &Obj<'_>, ctx: &Ctx<'_>) -> R<String> {
        self.check_header(o, ctx)?;
        o.expect_str("network", ctx.network, "WRONG_NETWORK")?;
        o.expect_str("organizationId", &self.terms.buyer.organization_id, "SCOPE_MISMATCH")?;
        let id = o.str("releaseIntentId")?;
        let i = self.live_by_id(&id)?;
        if !i.state.is_pre_submit() {
            return Err(state_err(i.state));
        }
        o.expect_str("expectedState", i.state.as_str(), "VERSION_CONFLICT")?;
        ensure(o.u64("stateVersion")? == i.version, "VERSION_CONFLICT", "exit binds another intent state version")?;
        ensure(o.u128("amountYocto")? == i.amount, "STALE_LEDGER", "exit binds another locked amount")?;
        o.expect_str("destinationDigest", &destination_digest(ctx.network, &i.destination)?, "DESTINATION_MISMATCH")?;
        let slices = i.slice_pairs();
        o.expect_str("sourceBucketDigest", &source_bucket_digest(&slices)?, "STALE_LEDGER")?;
        ensure(self.ledger.reservation_matches(&slices), "STALE_LEDGER", "reservation no longer matches the intent")?;
        Ok(id)
    }

    fn party_signer(&self, role: &str) -> R<(&'static str, String)> {
        match role {
            "BUYER_APPROVER" => Ok(("buyer", self.terms.buyer.key_version_id.clone())),
            "SUPPLIER_SIGNER" => Ok(("supplier", self.terms.supplier.key_version_id.clone())),
            _ => err("FORBIDDEN", "only the designated buyer approver or supplier signer has exit authority"),
        }
    }

    /// Pre-submit exit: restore the exact reservation to AVAILABLE and retire the intent.
    fn exit_to_source(&mut self, id: &str, to: IntentState, exit_digest: String, now: u64) -> R<()> {
        let slices = self.release.intents.get(id).expect("live").slice_pairs();
        self.ledger.restore_reserved(&slices)?;
        let it = self.release.intents.get_mut(id).expect("live");
        it.exit_digest = Some(exit_digest);
        it.to(to, now);
        self.release.live = None;
        Ok(())
    }

    /// One party's `dockside/cancel-consent` over a `dockside/cancel-release-intent` payload. The
    /// first consent records the pending payload; the matching second consent executes CANCEL in
    /// the same call. Returns `PENDING` or `CANCELLED`.
    pub fn submit_cancel_consent(&mut self, ctx: &Ctx<'_>, cancel: &J, consent: &J, signature: &str) -> R<&'static str> {
        let cv = decode(cancel)?;
        let co = Obj::exact(
            &cv,
            &[
                "contractId", "tradeId", "tradeRevision", "tradeDigest", "network", "organizationId", "releaseIntentId", "expectedState",
                "stateVersion", "amountYocto", "destinationDigest", "sourceBucketDigest", "reasonCode", "issuedAt", "expiresAt", "nonce",
            ],
            "cancel release intent",
        )?;
        let id = self.check_exit_binding(&co, ctx)?;
        let reason = co.str("reasonCode")?;
        ensure(code_ok(&reason), "VALIDATION_FAILED", "reasonCode malformed")?;
        let (_, cancel_expires) = self.check_window(&co, ctx, MAX_EXIT_LIFETIME_MS)?;
        let request_nonce = co.str("nonce")?;
        ensure(is_nonce(&request_nonce), "VALIDATION_FAILED", "nonce malformed")?;
        let (cancel_hex, _) = digest_hex(domains::CANCEL_RELEASE_INTENT, &cv)?;
        let pending = self.release.intents.get(&id).expect("live").cancel.clone();
        let fresh = match &pending {
            Some(p) if p.digest == cancel_hex => false,
            Some(p) => {
                let open = ctx.now_ms < p.expires_at && p.consents.iter().any(|c| !c.revoked && ctx.now_ms < c.expires_at);
                ensure(!open, "CANCEL_DISAGREEMENT", "a different cancel payload is pending; disagreement changes nothing")?;
                true
            }
            None => true,
        };
        if fresh {
            ensure(!self.nonce_used(domains::CANCEL_RELEASE_INTENT, &request_nonce), "NONCE_REPLAYED", "cancel request nonce already consumed")?;
        }

        let kv = decode(consent)?;
        let ko = Obj::exact(
            &kv,
            &["contractId", "tradeId", "tradeRevision", "tradeDigest", "cancelDigest", "signerRole", "capability", "keyVersionId", "issuedAt", "expiresAt", "nonce"],
            "cancel consent",
        )?;
        self.check_header(&ko, ctx)?;
        ko.expect_str("cancelDigest", &cancel_hex, "CANCEL_DISAGREEMENT")?;
        let role = ko.str("signerRole")?;
        let (key_role, key_version) = self.party_signer(&role)?;
        ko.expect_str("capability", &role, "SCOPE_MISMATCH")?;
        ko.expect_str("keyVersionId", &key_version, "KEY_NOT_BOUND")?;
        let (_, consent_expires) = self.check_window(&ko, ctx, MAX_EXIT_LIFETIME_MS)?;
        ensure(consent_expires <= cancel_expires, "VALIDATION_FAILED", "consent cannot outlive the cancel payload")?;
        let consent_nonce = ko.str("nonce")?;
        ensure(is_nonce(&consent_nonce), "VALIDATION_FAILED", "nonce malformed")?;
        ensure(consent_nonce != request_nonce, "VALIDATION_FAILED", "role nonce must differ from the request nonce")?;
        let prior: Vec<CancelConsent> = if fresh { Vec::new() } else { pending.as_ref().map(|p| p.consents.clone()).unwrap_or_default() };
        ensure(prior.iter().all(|c| c.nonce != consent_nonce), "VALIDATION_FAILED", "role nonces must be distinct")?;
        ensure(!self.nonce_used(domains::CANCEL_CONSENT, &consent_nonce), "NONCE_REPLAYED", "consent nonce already consumed")?;
        ensure(
            !prior.iter().any(|c| c.role == role && !c.revoked && ctx.now_ms < c.expires_at),
            "INVALID_STATE",
            "this role already holds a current consent",
        )?;
        let (consent_hex, kd) = digest_hex(domains::CANCEL_CONSENT, &kv)?;
        self.verify_role(ctx, key_role, &kd, signature)?;

        if fresh {
            self.consume_nonce(domains::CANCEL_RELEASE_INTENT, &request_nonce)?;
        }
        self.consume_nonce(domains::CANCEL_CONSENT, &consent_nonce)?;
        let now = ctx.now_ms;
        let it = self.release.intents.get_mut(&id).expect("live");
        if fresh {
            it.cancel = Some(PendingCancel { digest: cancel_hex.clone(), request_nonce, reason_code: reason, expires_at: cancel_expires, consents: Vec::new() });
        }
        let p = it.cancel.as_mut().expect("pending");
        p.consents.push(CancelConsent { role, nonce: consent_nonce, expires_at: consent_expires, digest: consent_hex, recorded_at: now, revoked: false });
        let current = |r: &str| p.consents.iter().any(|c| c.role == r && !c.revoked && now < c.expires_at);
        let complete = current("BUYER_APPROVER") && current("SUPPLIER_SIGNER") && now < p.expires_at;
        if complete && !self.revoked_roles.contains("buyer") && !self.revoked_roles.contains("supplier") {
            self.exit_to_source(&id, IntentState::CancelledPreSubmit, cancel_hex, now)?;
            return Ok("CANCELLED");
        }
        Ok("PENDING")
    }

    /// `dockside/revoke-cancel-consent`: a party withdraws only its own pending consent.
    pub fn revoke_cancel_consent(&mut self, ctx: &Ctx<'_>, payload: &J, signature: &str) -> R<()> {
        let v = decode(payload)?;
        let o = Obj::exact(
            &v,
            &["contractId", "tradeId", "tradeRevision", "tradeDigest", "releaseIntentId", "cancelDigest", "signerRole", "consentNonce", "issuedAt", "expiresAt", "nonce"],
            "revoke cancel consent",
        )?;
        self.check_header(&o, ctx)?;
        self.check_window(&o, ctx, MAX_EXIT_LIFETIME_MS)?;
        let id = o.str("releaseIntentId")?;
        let i = self.live_by_id(&id)?;
        if !i.state.is_pre_submit() {
            return Err(state_err(i.state));
        }
        let p = i.cancel.as_ref().ok_or_else(|| Error { code: "NOT_FOUND", message: "no pending cancel".into() })?;
        o.expect_str("cancelDigest", &p.digest, "CANCEL_DISAGREEMENT")?;
        let role = o.str("signerRole")?;
        let (key_role, _) = self.party_signer(&role)?;
        let consent_nonce = o.str("consentNonce")?;
        let idx = p
            .consents
            .iter()
            .position(|c| c.role == role && c.nonce == consent_nonce)
            .ok_or_else(|| Error { code: "NOT_FOUND", message: "no consent of this role with that nonce".into() })?;
        ensure(!p.consents[idx].revoked, "INVALID_STATE", "consent already revoked")?;
        let nonce = o.str("nonce")?;
        ensure(nonce != consent_nonce && nonce != p.request_nonce, "VALIDATION_FAILED", "revocation nonce must be distinct")?;
        ensure(!self.nonce_used(domains::REVOKE_CANCEL_CONSENT, &nonce), "NONCE_REPLAYED", "nonce already consumed")?;
        let (_, d) = digest_hex(domains::REVOKE_CANCEL_CONSENT, &v)?;
        self.verify_role(ctx, key_role, &d, signature)?;
        self.consume_nonce(domains::REVOKE_CANCEL_CONSENT, &nonce)?;
        let it = self.release.intents.get_mut(&id).expect("live");
        it.cancel.as_mut().expect("pending").consents[idx].revoked = true;
        Ok(())
    }

    /// The objective trigger time the contract derives for an ABANDON request.
    pub fn abandon_trigger_at(&self, i: &ReleaseIntent, trigger: &str) -> R<u64> {
        match trigger {
            "INTENT_EXPIRED" => Ok(i.expires_at),
            "BUYER_APPROVAL_EXPIRED" => match (&i.approval, i.state) {
                (Some(a), IntentState::DirectTestnetAuthorized) => Ok(a.expires_at),
                _ => err("NOT_ELIGIBLE", "the intent carries no buyer approval to expire"),
            },
            "FUNDED_AUTHORIZATION_EXPIRED" => err("NOT_ELIGIBLE", "no funded authorization exists in the direct testnet profile"),
            _ => err("VALIDATION_FAILED", "abandonment accepts only an objective trigger"),
        }
    }

    /// `dockside/abandon-release-intent` by the designated buyer approver or supplier signer once
    /// the objective trigger and the profile's grace period have passed on contract time.
    pub fn abandon_release_intent(&mut self, ctx: &Ctx<'_>, payload: &J, signature: &str) -> R<()> {
        let v = decode(payload)?;
        let o = Obj::exact(
            &v,
            &[
                "contractId", "tradeId", "tradeRevision", "tradeDigest", "network", "organizationId", "releaseIntentId", "expectedState",
                "stateVersion", "amountYocto", "destinationDigest", "sourceBucketDigest", "trigger", "triggerAt", "abandonPolicyId",
                "abandonPolicyRevision", "abandonAfter", "signerRole", "capability", "keyVersionId", "issuedAt", "expiresAt", "nonce",
            ],
            "abandon release intent",
        )?;
        let id = self.check_exit_binding(&o, ctx)?;
        self.check_window(&o, ctx, MAX_EXIT_LIFETIME_MS)?;
        o.expect_str("abandonPolicyId", ABANDON_POLICY_ID, "POLICY_MISMATCH")?;
        ensure(o.u64("abandonPolicyRevision")? == ABANDON_POLICY_REVISION, "POLICY_MISMATCH", "abandonment policy revision mismatch")?;
        let role = o.str("signerRole")?;
        let (key_role, key_version) = self.party_signer(&role)?;
        o.expect_str("capability", &role, "SCOPE_MISMATCH")?;
        o.expect_str("keyVersionId", &key_version, "KEY_NOT_BOUND")?;
        let i = self.release.intents.get(&id).expect("live");
        let trigger_at = self.abandon_trigger_at(i, &o.str("trigger")?)?;
        ensure(o.u64("triggerAt")? == trigger_at, "POLICY_MISMATCH", "triggerAt differs from the contract-recorded trigger time")?;
        let after = trigger_at.saturating_add(ABANDON_GRACE_MS);
        ensure(o.u64("abandonAfter")? == after, "POLICY_MISMATCH", "abandonAfter must equal trigger time plus the policy grace")?;
        ensure(ctx.now_ms >= after, "DELAY_NOT_ELAPSED", "the objective trigger and grace period have not elapsed")?;
        let nonce = o.str("nonce")?;
        ensure(!self.nonce_used(domains::ABANDON_RELEASE_INTENT, &nonce), "NONCE_REPLAYED", "nonce already consumed")?;
        let (hex, d) = digest_hex(domains::ABANDON_RELEASE_INTENT, &v)?;
        self.verify_role(ctx, key_role, &d, signature)?;
        self.consume_nonce(domains::ABANDON_RELEASE_INTENT, &nonce)?;
        self.exit_to_source(&id, IntentState::AbandonedPreSubmit, hex, ctx.now_ms)
    }

    /// Destination activation: the pre-submit intent becomes SUPERSEDED_PRE_SUBMIT and its exact
    /// reservation moves, without touching the ledger, to one successor intent under the new
    /// revision. Returns the successor id. Caller has already checked the intent is pre-submit.
    pub(crate) fn supersede_live(&mut self, now: u64, new_revision: u64, new_digest: &str, new_destination: &str) -> R<Option<String>> {
        let Some(id) = self.release.live.clone() else { return Ok(None) };
        let pred = self.release.intents.get(&id).expect("live").clone();
        if !pred.state.is_pre_submit() {
            return Err(state_err(pred.state));
        }
        let v = Value::Struct(alloc::vec![("predecessor".into(), s(&id)), ("revisionDigest".into(), s(new_digest))]);
        let (_, d) = digest_hex(domains::RELEASE_INTENT_SUCCESSOR, &v)?;
        let sid = format!("rli_{}", &hex_encode(&d)[..32]);
        ensure(!self.release.intents.contains_key(&sid), "INTERNAL", "successor id collision")?;
        let successor = ReleaseIntent {
            id: sid.clone(),
            trade_revision: new_revision,
            terms_digest: new_digest.into(),
            request_digest: hex_encode(&d),
            amount: pred.amount,
            slices: pred.slices.clone(),
            source_bucket: pred.source_bucket,
            destination: new_destination.into(),
            profile: pred.profile.clone(),
            state: IntentState::ValueLocked,
            version: 1,
            created_at: now,
            expires_at: pred.expires_at,
            approval: None,
            cancel: None,
            exit_digest: None,
            predecessor: Some(id.clone()),
            successor: None,
            attempts: Vec::new(),
            consumed_manifest: None,
            history: alloc::vec![("RELEASE_INTENT_CREATED".into(), now), ("VALUE_LOCKED".into(), now)],
        };
        let p = self.release.intents.get_mut(&id).expect("live");
        p.successor = Some(sid.clone());
        p.cancel = None;
        p.to(IntentState::SupersededPreSubmit, now);
        self.release.intents.insert(sid.clone(), successor);
        self.release.live = Some(sid.clone());
        Ok(Some(sid))
    }
}
