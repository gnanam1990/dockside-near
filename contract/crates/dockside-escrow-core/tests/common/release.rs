//! Release fixtures: a funded trade with a contract-accepted manifest and an inspector decision,
//! and builders for every M04 payload (intent, approval, CANCEL, ABANDON, destination change),
//! all signed with the bound Ed25519 keys over the digest the contract recomputes.
#![allow(dead_code)]

use super::evidence::*;
use super::*;
use dockside_escrow_core::destination::ChangeStatus;
use dockside_escrow_core::release::{destination_digest, source_bucket_digest, IntentState, ABANDON_GRACE_MS};
use dockside_escrow_core::TradeRecord;

pub const ALT_DEST: &str = "harbor-payouts.testnet";

/// Terms with the real policy digest (what `evidence_trade` registers).
pub fn evidence_terms() -> J {
    let mut t = terms();
    set(&mut t, &["evidencePolicy", "digest"], s(&policy_digest()));
    t
}

pub fn fund_full(w: &mut World, rec: &mut TradeRecord) {
    let who = w.caller.clone();
    rec.fund(&w.as_caller(BUYER_ACCT).ctx(), 6 * NEAR, 1).unwrap();
    rec.fund(&w.as_caller(OTHER_FUNDER).ctx(), 4 * NEAR, 1).unwrap();
    w.caller = who;
}

/// Accept a complete manifest at `rev` and record an inspector `decision` over it.
pub fn attest_and_inspect(w: &World, rec: &mut TradeRecord, rev: u64, decision: &str, n: &str) -> String {
    let (inv, rep, img) = (invoice(&format!("inv-{n}")), report(&format!("rep-{n}")), photo(&format!("img-{n}")));
    let att = attestation(rec, rev, complete_slots(rec, &inv, &rep, &[&img], rev), w.now, &format!("att-{n}"));
    let digest = rec.submit_manifest_attestation(&w.ctx(), &att, &sign("attestor", "dockside/manifest-attestation", &att)).expect("attestation");
    let ins = inspection(rec, rev, &digest, decision, w.now, &format!("ins-{n}"));
    rec.submit_inspection(&w.ctx(), &ins, &sign("inspector", "dockside/inspection-attestation", &ins)).expect("inspection");
    digest
}

/// Funded trade (6 NEAR buyer + 4 NEAR treasury), manifest accepted, inspector PASS.
pub fn ready() -> (World, TradeRecord) {
    let (mut w, mut rec) = evidence_trade();
    fund_full(&mut w, &mut rec);
    attest_and_inspect(&w, &mut rec, 1, "PASS", "r1");
    (w, rec)
}

pub fn slices(rec: &TradeRecord) -> Vec<(String, u128)> {
    rec.ledger.available_slices()
}

pub fn intent_payload(rec: &TradeRecord, intent: &str, now: u64, n: &str) -> J {
    with_header(
        rec,
        vec![
            ("network", s(NETWORK)),
            ("releaseIntentId", s(intent)),
            ("amountYocto", big(rec.terms.amount_yocto)),
            ("executionProfile", s("DIRECT_TESTNET")),
            ("destination", s(&rec.terms.payout_destination)),
            ("destinationDigest", s(&destination_digest(NETWORK, &rec.terms.payout_destination).unwrap())),
            ("sourceBucketDigest", s(&source_bucket_digest(&slices(rec)).unwrap())),
            ("intentExpiresAt", u(now + 3 * DAY)),
            ("signerRole", s("BUYER_APPROVER")),
            ("issuedAt", u(now)),
            ("expiresAt", u(now + HOUR)),
            ("nonce", s(&nonce(&format!("intent/{n}")))),
        ],
    )
}

pub fn create(w: &World, rec: &mut TradeRecord, label: &str) -> String {
    let p = intent_payload(rec, &id("rli", label), w.now, label);
    rec.create_release_intent(&w.ctx(), &p, &sign("buyer", "dockside/release-intent", &p)).expect("intent").0
}

pub fn intent<'a>(rec: &'a TradeRecord, intent: &str) -> &'a dockside_escrow_core::release::ReleaseIntent {
    &rec.release.intents[intent]
}

pub fn approval_payload(rec: &TradeRecord, intent_id: &str, now: u64, n: &str) -> J {
    let i = intent(rec, intent_id);
    let m = rec.evidence.current.as_ref();
    let ins = rec.evidence.inspection.as_ref();
    with_header(
        rec,
        vec![
            ("releaseIntentId", s(intent_id)),
            ("intentStateVersion", u(i.version)),
            ("amountYocto", big(i.amount)),
            ("executionProfile", s(&i.profile)),
            ("destination", s(&i.destination)),
            ("destinationDigest", s(&destination_digest(NETWORK, &i.destination).unwrap())),
            ("manifestRevision", u(m.map(|m| m.revision).unwrap_or(0))),
            ("manifestDigest", s(&m.map(|m| m.digest.clone()).unwrap_or_else(|| "00".repeat(32)))),
            ("attestationDigest", s(&m.map(|m| m.attestation_digest.clone()).unwrap_or_else(|| "00".repeat(32)))),
            ("inspectionDigest", s(&ins.map(|i| i.digest.clone()).unwrap_or_else(|| "00".repeat(32)))),
            ("holdsViewDigest", s(&rec.holds_view_digest(now).unwrap())),
            ("signerRole", s("BUYER_APPROVER")),
            ("issuedAt", u(now)),
            ("expiresAt", u(now + DAY)),
            ("nonce", s(&nonce(&format!("approval/{n}")))),
        ],
    )
}

pub fn approve(w: &World, rec: &mut TradeRecord, intent_id: &str, n: &str) -> &'static str {
    let p = approval_payload(rec, intent_id, w.now, n);
    code(rec.approve_release(&w.ctx(), &p, &sign("buyer", "dockside/buyer-approval", &p)))
}

/// Ready trade with an approved (DIRECT_TESTNET_AUTHORIZED) intent.
pub fn authorized() -> (World, TradeRecord, String) {
    let (w, mut rec) = ready();
    let i = create(&w, &mut rec, "main");
    assert_eq!(approve(&w, &mut rec, &i, "main"), "OK");
    (w, rec, i)
}

fn exit_binding(rec: &TradeRecord, intent_id: &str) -> Vec<(&'static str, J)> {
    let i = intent(rec, intent_id);
    let pairs = i.slice_pairs();
    vec![
        ("network", s(NETWORK)),
        ("organizationId", s(&rec.terms.buyer.organization_id)),
        ("releaseIntentId", s(intent_id)),
        ("expectedState", s(i.state.as_str())),
        ("stateVersion", u(i.version)),
        ("amountYocto", big(i.amount)),
        ("destinationDigest", s(&destination_digest(NETWORK, &i.destination).unwrap())),
        ("sourceBucketDigest", s(&source_bucket_digest(&pairs).unwrap())),
    ]
}

pub fn cancel_payload(rec: &TradeRecord, intent_id: &str, reason: &str, now: u64, n: &str) -> J {
    let mut f = exit_binding(rec, intent_id);
    f.push(("reasonCode", s(reason)));
    f.push(("issuedAt", u(now)));
    f.push(("expiresAt", u(now + 2 * HOUR)));
    f.push(("nonce", s(&nonce(&format!("cancel/{n}")))));
    with_header(rec, f)
}

pub fn role_key(role: &str) -> (&'static str, String) {
    match role {
        "BUYER_APPROVER" => ("buyer", id("key", "buyer-1")),
        "SUPPLIER_SIGNER" => ("supplier", id("key", "supplier-1")),
        _ => ("risk", id("key", "risk-1")),
    }
}

pub fn consent_payload(rec: &TradeRecord, cancel: &J, role: &str, now: u64, n: &str) -> J {
    with_header(
        rec,
        vec![
            ("cancelDigest", s(&digest_hex("dockside/cancel-release-intent", cancel))),
            ("signerRole", s(role)),
            ("capability", s(role)),
            ("keyVersionId", s(&role_key(role).1)),
            ("issuedAt", u(now)),
            ("expiresAt", u(now + HOUR)),
            ("nonce", s(&nonce(&format!("consent/{n}")))),
        ],
    )
}

pub fn consent(w: &World, rec: &mut TradeRecord, cancel: &J, role: &str, signer: &str, n: &str) -> Result<&'static str, dockside_escrow_core::Error> {
    let k = consent_payload(rec, cancel, role, w.now, n);
    rec.submit_cancel_consent(&w.ctx(), cancel, &k, &sign(signer, "dockside/cancel-consent", &k))
}

pub fn revoke_consent_payload(rec: &TradeRecord, intent_id: &str, cancel: &J, role: &str, consent_label: &str, now: u64, n: &str) -> J {
    with_header(
        rec,
        vec![
            ("releaseIntentId", s(intent_id)),
            ("cancelDigest", s(&digest_hex("dockside/cancel-release-intent", cancel))),
            ("signerRole", s(role)),
            ("consentNonce", s(&nonce(&format!("consent/{consent_label}")))),
            ("issuedAt", u(now)),
            ("expiresAt", u(now + HOUR)),
            ("nonce", s(&nonce(&format!("revoke/{n}")))),
        ],
    )
}

pub fn abandon_payload(rec: &TradeRecord, intent_id: &str, trigger: &str, trigger_at: u64, role: &str, now: u64, n: &str) -> J {
    let mut f = exit_binding(rec, intent_id);
    f.extend(vec![
        ("trigger", s(trigger)),
        ("triggerAt", u(trigger_at)),
        ("abandonPolicyId", s("dockside-abandon-v1")),
        ("abandonPolicyRevision", u(1)),
        ("abandonAfter", u(trigger_at + ABANDON_GRACE_MS)),
        ("signerRole", s(role)),
        ("capability", s(role)),
        ("keyVersionId", s(&role_key(role).1)),
        ("issuedAt", u(now)),
        ("expiresAt", u(now + HOUR)),
        ("nonce", s(&nonce(&format!("abandon/{n}")))),
    ]);
    with_header(rec, f)
}

/// The typed terms of the active revision, rebuilt from revision 1 and the activated changes.
pub fn active_terms(rec: &TradeRecord) -> J {
    let mut t = evidence_terms();
    for ch in rec.destination.history.iter().filter(|c| c.status == ChangeStatus::Activated) {
        let d = digest_hex("dockside/trade-revision", &t);
        set(&mut t, &["revision"], u(ch.terms.revision));
        set(&mut t, &["predecessorDigest"], s(&d));
        set(&mut t, &["payout", "destination"], s(&ch.to_destination));
    }
    assert_eq!(digest_hex("dockside/trade-revision", &t), rec.terms_digest, "fixture rebuilds the active revision");
    t
}

/// Successor revision of the active terms that changes only the payout destination.
pub fn successor_terms(rec: &TradeRecord, dest: &str) -> J {
    let mut t = active_terms(rec);
    set(&mut t, &["revision"], u(rec.terms.revision + 1));
    set(&mut t, &["predecessorDigest"], s(&rec.terms_digest));
    set(&mut t, &["payout", "destination"], s(dest));
    t
}

pub fn propose(w: &World, rec: &mut TradeRecord, dest: &str, role: &str, signer: &str) -> Result<String, dockside_escrow_core::Error> {
    let t = successor_terms(rec, dest);
    rec.propose_destination_change(&w.ctx(), &t, role, &sign(signer, "dockside/trade-revision", &t))
}

pub fn consent_dest(w: &World, rec: &mut TradeRecord, dest: &str, role: &str, signer: &str) -> Result<u64, dockside_escrow_core::Error> {
    let t = successor_terms(rec, dest);
    let d = digest_hex("dockside/trade-revision", &t);
    rec.consent_destination_change(&w.ctx(), &d, role, &sign(signer, "dockside/trade-revision", &t))
}

/// Propose (supplier) + consent (buyer) + wait the delay; returns the successor digest.
pub fn dual_consented(w: &mut World, rec: &mut TradeRecord, dest: &str) -> String {
    let d = propose(w, rec, dest, "SUPPLIER", "supplier").expect("propose");
    consent_dest(w, rec, dest, "BUYER", "buyer").expect("consent");
    w.now += rec.terms.destination_change_delay_ms;
    d
}

pub fn unresolved_states() -> [IntentState; 6] {
    [IntentState::Submitting, IntentState::Processing, IntentState::Unknown, IntentState::Review, IntentState::Reconciling, IntentState::Adjudication]
}

/// Put the live intent into a post-submit unresolved state. SUBMITTING is reached through the real
/// `execute_release`; the later reconciliation states belong to the M05 reconciler, which is not
/// built yet, so they are assigned directly on the record to exercise the denials they must cause.
pub fn force_unresolved(w: &World, rec: &mut TradeRecord, intent_id: &str, st: IntentState) {
    rec.execute_release(&w.ctx(), intent_id).expect("submit");
    if st != IntentState::Submitting {
        rec.release.intents.get_mut(intent_id).unwrap().to(st, w.now);
    }
}

/* ------------------------------ holds and refunds ------------------------------ */

pub fn hold_set(rec: &TradeRecord, hold: &str, issuer: &str, now: u64, ttl: u64) -> J {
    with_header(
        rec,
        vec![
            ("holdId", s(&id("hld", hold))),
            ("manifestDigest", opt(rec.current_manifest_digest(now).as_deref())),
            ("reasonCode", s("DOC_MISMATCH")),
            ("issuerRole", s(issuer)),
            ("ruleId", if issuer == "POLICY_SETTER" { s("doc-mismatch@1") } else { null() }),
            ("schema", s("dockside/hold-set@1")),
            ("issuedAt", u(now)),
            ("expiresAt", u(now + ttl)),
            ("nonce", s(&nonce(&format!("hold/{hold}")))),
        ],
    )
}

pub fn set_hold(w: &World, rec: &mut TradeRecord, hold: &str, issuer: &str, ttl: u64) {
    let signer = if issuer == "POLICY_SETTER" { "policy" } else { "risk" };
    let p = hold_set(rec, hold, issuer, w.now, ttl);
    rec.set_hold(&w.ctx(), &p, &sign(signer, "dockside/hold-set", &p)).expect("hold set");
}

pub fn resolve(w: &World, rec: &mut TradeRecord, hold: &str, code_: &str, n: &str) -> &'static str {
    let p = with_header(
        rec,
        vec![
            ("holdId", s(&id("hld", hold))),
            ("holdReasonCode", s("DOC_MISMATCH")),
            ("manifestDigest", opt(rec.current_manifest_digest(w.now).as_deref())),
            ("resolutionCode", s(code_)),
            ("evidenceDigest", s(&"ab".repeat(32))),
            ("resolverRole", s("RISK_RESOLVER")),
            ("schema", s("dockside/hold-resolve@1")),
            ("issuedAt", u(w.now)),
            ("expiresAt", u(w.now + HOUR)),
            ("nonce", s(&nonce(&format!("resolve/{n}")))),
        ],
    );
    code(rec.resolve_hold(&w.ctx(), &p, &sign("risk", "dockside/hold-resolve", &p)))
}

pub fn refund_req(rec: &TradeRecord, label: &str, reason: &str, funder: &str, amount: u128, bucket: &str, initiator: &str, now: u64) -> J {
    with_header(
        rec,
        vec![
            ("refundIntentId", s(&id("rfd", label))),
            ("policyId", s("dockside-refund-v1")),
            ("policyRevision", u(1)),
            ("reason", s(reason)),
            ("funder", s(funder)),
            ("amountYocto", big(amount)),
            ("sourceBucket", s(bucket)),
            ("initiatorRole", s(initiator)),
            ("issuedAt", u(now)),
            ("expiresAt", u(now + 24 * HOUR)),
            ("nonce", s(&nonce(&format!("refund/{label}")))),
        ],
    )
}

pub fn refund_intent_payload(rec: &TradeRecord, intent: &str, role_field: &'static str, role: &str, now: u64, n: &str) -> J {
    let r = &rec.refunds[intent];
    with_header(
        rec,
        vec![
            ("refundIntentId", s(intent)),
            ("requestDigest", s(&r.request_digest)),
            (role_field, s(role)),
            ("issuedAt", u(now)),
            ("expiresAt", u(now + HOUR)),
            ("nonce", s(&nonce(&format!("rfdop/{n}")))),
        ],
    )
}
