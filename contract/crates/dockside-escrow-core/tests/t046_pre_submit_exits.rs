//! T-046: pre-submit release-intent exits. CANCEL needs both designated parties' consents over one
//! canonical payload with distinct request/role/revocation nonces and current expiries; ABANDON
//! needs one designated party after the contract-recomputed objective trigger and grace. Every
//! rejected attempt leaves the value lock exactly as it was; each exit restores the exact slices.

mod common;
use common::evidence::DAY;
use common::release::*;
use common::*;
use dockside_escrow_core::release::{IntentState, ABANDON_GRACE_MS};
use dockside_escrow_core::TradeRecord;

/// Both pre-submit states reachable in the direct profile.
fn pre_submit(approved: bool) -> (World, TradeRecord, String) {
    if approved {
        authorized()
    } else {
        let (w, mut rec) = ready();
        let i = create(&w, &mut rec, "main");
        (w, rec, i)
    }
}

fn assert_locked(rec: &TradeRecord, iid: &str) {
    assert_eq!(rec.release.live.as_deref(), Some(iid));
    assert!(intent(rec, iid).state.is_pre_submit());
    assert_eq!(rec.ledger.funder(BUYER_ACCT).reserved, 6 * NEAR);
    assert_eq!(rec.ledger.funder(OTHER_FUNDER).reserved, 4 * NEAR);
    assert_eq!(rec.ledger.total_available(), 0);
}

fn assert_restored(rec: &TradeRecord, iid: &str, st: IntentState) {
    assert_eq!(intent(rec, iid).state, st);
    assert_eq!(rec.release.live, None);
    assert_eq!(rec.ledger.funder(BUYER_ACCT).available, 6 * NEAR, "exact slice back to AVAILABLE");
    assert_eq!(rec.ledger.funder(OTHER_FUNDER).available, 4 * NEAR, "exact slice back to AVAILABLE");
    assert_eq!(rec.ledger.funder(BUYER_ACCT).reserved, 0);
    rec.ledger.check_conservation().unwrap();
}

#[test]
fn cancel_with_matching_buyer_and_supplier_consents_restores_the_exact_reservation() {
    for approved in [false, true] {
        let (w, mut rec, iid) = pre_submit(approved);
        let c = cancel_payload(&rec, &iid, "PARTIES_AGREE", w.now, "c1");
        assert_eq!(consent(&w, &mut rec, &c, "SUPPLIER_SIGNER", "supplier", "s1").unwrap(), "PENDING");
        assert_locked(&rec, &iid);
        assert_eq!(consent(&w, &mut rec, &c, "BUYER_APPROVER", "buyer", "b1").unwrap(), "CANCELLED");
        assert_restored(&rec, &iid, IntentState::CancelledPreSubmit);
        // Predecessor authority is gone: the approval cannot be executed, the intent cannot be revived.
        assert_eq!(code(rec.execute_release(&w.ctx(), &iid)), "INVALID_STATE");
        // CANCEL does not cancel the trade or authorize a refund: a new intent can lock the value again.
        let j = create(&w, &mut rec, "after-cancel");
        assert_locked(&rec, &j);
    }
}

#[test]
fn one_signature_disagreement_and_unauthorized_roles_change_nothing() {
    let (w, mut rec, iid) = pre_submit(true);
    let c = cancel_payload(&rec, &iid, "PARTIES_AGREE", w.now, "c1");
    // Unauthorized roles and keys.
    for (role, signer, want) in [
        ("BUYER_APPROVER", "supplier", "SIGNATURE_INVALID"),
        ("SUPPLIER_SIGNER", "buyer", "SIGNATURE_INVALID"),
        ("BUYER_APPROVER", "risk", "SIGNATURE_INVALID"),
        ("SUPPLIER_SIGNER", "inspector", "SIGNATURE_INVALID"),
        ("BUYER_APPROVER", "attestor", "SIGNATURE_INVALID"),
        ("SUPPLIER_SIGNER", "policy", "SIGNATURE_INVALID"),
        ("RISK_RESOLVER", "risk", "FORBIDDEN"),
        ("INSPECTOR", "inspector", "FORBIDDEN"),
        ("ORG_SECURITY_ADMIN", "buyer", "FORBIDDEN"),
        ("EXECUTOR", "buyer", "FORBIDDEN"),
        ("MANIFEST_ATTEST", "attestor", "FORBIDDEN"),
        ("DETERMINISTIC_POLICY_SET", "policy", "FORBIDDEN"),
    ] {
        assert_eq!(code(consent(&w, &mut rec, &c, role, signer, &format!("{role}-{signer}"))), want, "{role} by {signer}");
    }
    assert!(intent(&rec, &iid).cancel.is_none(), "no rejected consent recorded anything");
    // One signature only.
    assert_eq!(consent(&w, &mut rec, &c, "BUYER_APPROVER", "buyer", "b1").unwrap(), "PENDING");
    // The same party cannot supply the second consent.
    assert_eq!(code(consent(&w, &mut rec, &c, "BUYER_APPROVER", "buyer", "b2")), "INVALID_STATE");
    // Disagreement: the supplier signs a different payload (other reason) -> nothing changes.
    let other = cancel_payload(&rec, &iid, "SUPPLIER_PREFERS", w.now, "c2");
    assert_eq!(code(consent(&w, &mut rec, &other, "SUPPLIER_SIGNER", "supplier", "s1")), "CANCEL_DISAGREEMENT");
    // A consent whose cancelDigest names another payload.
    let mut k = consent_payload(&rec, &c, "SUPPLIER_SIGNER", w.now, "s2");
    set(&mut k, &["cancelDigest"], s(&digest_hex("dockside/cancel-release-intent", &other)));
    assert_eq!(code(rec.submit_cancel_consent(&w.ctx(), &c, &k, &sign("supplier", "dockside/cancel-consent", &k))), "CANCEL_DISAGREEMENT");
    // Wrong capability / key version binding.
    let mut k = consent_payload(&rec, &c, "SUPPLIER_SIGNER", w.now, "s3");
    set(&mut k, &["capability"], s("BUYER_APPROVER"));
    assert_eq!(code(rec.submit_cancel_consent(&w.ctx(), &c, &k, &sign("supplier", "dockside/cancel-consent", &k))), "SCOPE_MISMATCH");
    let mut k = consent_payload(&rec, &c, "SUPPLIER_SIGNER", w.now, "s4");
    set(&mut k, &["keyVersionId"], s(&id("key", "supplier-2")));
    assert_eq!(code(rec.submit_cancel_consent(&w.ctx(), &c, &k, &sign("supplier", "dockside/cancel-consent", &k))), "KEY_NOT_BOUND");
    assert_locked(&rec, &iid);
    assert_eq!(intent(&rec, &iid).cancel.as_ref().unwrap().consents.len(), 1);
}

#[test]
fn wrong_value_state_destination_bucket_and_window_are_rejected() {
    let (w, mut rec, iid) = pre_submit(true);
    let base = cancel_payload(&rec, &iid, "PARTIES_AGREE", w.now, "c1");
    let cases: Vec<(&[&str], J, &str)> = vec![
        (&["amountYocto"], big(9 * NEAR), "STALE_LEDGER"),
        (&["expectedState"], s("VALUE_LOCKED"), "VERSION_CONFLICT"),
        (&["stateVersion"], u(1), "VERSION_CONFLICT"),
        (&["destinationDigest"], s(&"11".repeat(32)), "DESTINATION_MISMATCH"),
        (&["sourceBucketDigest"], s(&"11".repeat(32)), "STALE_LEDGER"),
        (&["organizationId"], s(&id("org", "supplier-org")), "SCOPE_MISMATCH"),
        (&["releaseIntentId"], s(&id("rli", "nope")), "NOT_FOUND"),
        (&["reasonCode"], s("lowercase"), "VALIDATION_FAILED"),
        (&["expiresAt"], u(w.now + 3 * DAY), "VALIDATION_FAILED"),
        (&["tradeRevision"], u(2), "STALE_REVISION"),
    ];
    for (path, v, want) in cases {
        let mut c = base.clone();
        set(&mut c, path, v);
        assert_eq!(code(consent(&w, &mut rec, &c, "BUYER_APPROVER", "buyer", &format!("{path:?}"))), want, "{path:?}");
    }
    // Expired cancel payload / consent.
    let later = World { now: w.now + 3 * HOUR, caller: w.caller.clone() };
    assert_eq!(code(consent(&later, &mut rec, &base, "BUYER_APPROVER", "buyer", "late")), "EXPIRED");
    assert_locked(&rec, &iid);
}

#[test]
fn nonces_must_be_distinct_and_single_use() {
    let (w, mut rec, iid) = pre_submit(false);
    let c = cancel_payload(&rec, &iid, "PARTIES_AGREE", w.now, "c1");
    // Role nonce equal to the request nonce.
    let mut k = consent_payload(&rec, &c, "BUYER_APPROVER", w.now, "x");
    set(&mut k, &["nonce"], s(&nonce("cancel/c1")));
    assert_eq!(code(rec.submit_cancel_consent(&w.ctx(), &c, &k, &sign("buyer", "dockside/cancel-consent", &k))), "VALIDATION_FAILED");
    assert_eq!(consent(&w, &mut rec, &c, "BUYER_APPROVER", "buyer", "shared").unwrap(), "PENDING");
    // The supplier reusing the buyer's role nonce.
    assert_eq!(code(consent(&w, &mut rec, &c, "SUPPLIER_SIGNER", "supplier", "shared")), "VALIDATION_FAILED");
    // Revocation nonce equal to the consent nonce.
    let mut rv = revoke_consent_payload(&rec, &iid, &c, "BUYER_APPROVER", "shared", w.now, "r1");
    set(&mut rv, &["nonce"], s(&nonce("consent/shared")));
    assert_eq!(code(rec.revoke_cancel_consent(&w.ctx(), &rv, &sign("buyer", "dockside/revoke-cancel-consent", &rv))), "VALIDATION_FAILED");
    // After a completed cancel, a replayed request nonce cannot open a new pending cancel.
    assert_eq!(consent(&w, &mut rec, &c, "SUPPLIER_SIGNER", "supplier", "s1").unwrap(), "CANCELLED");
    let j = create(&w, &mut rec, "next");
    let mut c2 = cancel_payload(&rec, &j, "PARTIES_AGREE", w.now, "c2");
    set(&mut c2, &["nonce"], s(&nonce("cancel/c1")));
    assert_eq!(code(consent(&w, &mut rec, &c2, "BUYER_APPROVER", "buyer", "b9")), "NONCE_REPLAYED");
    let c3 = cancel_payload(&rec, &j, "PARTIES_AGREE", w.now, "c3");
    assert_eq!(code(consent(&w, &mut rec, &c3, "BUYER_APPROVER", "buyer", "shared")), "NONCE_REPLAYED");
    assert_locked(&rec, &j);
}

#[test]
fn a_party_revokes_only_its_own_consent_and_revocation_voids_the_cancel() {
    let (w, mut rec, iid) = pre_submit(true);
    let c = cancel_payload(&rec, &iid, "PARTIES_AGREE", w.now, "c1");
    assert_eq!(consent(&w, &mut rec, &c, "BUYER_APPROVER", "buyer", "b1").unwrap(), "PENDING");
    // The supplier cannot revoke the buyer's consent: not with its key, not by naming the buyer role.
    let rv = revoke_consent_payload(&rec, &iid, &c, "BUYER_APPROVER", "b1", w.now, "r1");
    assert_eq!(code(rec.revoke_cancel_consent(&w.ctx(), &rv, &sign("supplier", "dockside/revoke-cancel-consent", &rv))), "SIGNATURE_INVALID");
    let rv2 = revoke_consent_payload(&rec, &iid, &c, "SUPPLIER_SIGNER", "b1", w.now, "r2");
    assert_eq!(code(rec.revoke_cancel_consent(&w.ctx(), &rv2, &sign("supplier", "dockside/revoke-cancel-consent", &rv2))), "NOT_FOUND");
    // The buyer revokes its own consent.
    rec.revoke_cancel_consent(&w.ctx(), &rv, &sign("buyer", "dockside/revoke-cancel-consent", &rv)).unwrap();
    assert_eq!(code(rec.revoke_cancel_consent(&w.ctx(), &rv, &sign("buyer", "dockside/revoke-cancel-consent", &rv))), "INVALID_STATE");
    // The supplier's consent alone no longer completes the cancel.
    assert_eq!(consent(&w, &mut rec, &c, "SUPPLIER_SIGNER", "supplier", "s1").unwrap(), "PENDING");
    assert_locked(&rec, &iid);
    // The buyer can consent again with a fresh nonce; then it executes.
    assert_eq!(consent(&w, &mut rec, &c, "BUYER_APPROVER", "buyer", "b2").unwrap(), "CANCELLED");
    assert_restored(&rec, &iid, IntentState::CancelledPreSubmit);
}

#[test]
fn revoked_party_keys_and_expired_consents_never_complete_a_cancel() {
    let (mut w, mut rec, iid) = pre_submit(true);
    let c = cancel_payload(&rec, &iid, "PARTIES_AGREE", w.now, "c1");
    assert_eq!(consent(&w, &mut rec, &c, "BUYER_APPROVER", "buyer", "b1").unwrap(), "PENDING");
    // Supplier key revoked (by itself) after the buyer consented.
    let rk = with_header(
        &rec,
        vec![
            ("role", s("supplier")),
            ("publicKey", s(&rec.terms.supplier.public_key)),
            ("signerRole", s("SELF")),
            ("reasonCode", s("KEY_COMPROMISE")),
            ("issuedAt", u(w.now)),
            ("expiresAt", u(w.now + HOUR)),
            ("nonce", s(&nonce("rk-s"))),
        ],
    );
    rec.revoke_key(&w.ctx(), &rk, &sign("supplier", "dockside/bound-key-revocation", &rk)).unwrap();
    assert_eq!(code(consent(&w, &mut rec, &c, "SUPPLIER_SIGNER", "supplier", "s1")), "KEY_REVOKED");
    assert_locked(&rec, &iid);
    // Expired consent: the buyer's consent lapses (1h) before the supplier signs on a fresh trade.
    let (w2, mut rec2, iid2) = pre_submit(false);
    let c2 = cancel_payload(&rec2, &iid2, "PARTIES_AGREE", w2.now, "c1");
    assert_eq!(consent(&w2, &mut rec2, &c2, "BUYER_APPROVER", "buyer", "b1").unwrap(), "PENDING");
    w = World { now: w2.now + HOUR + 1, caller: w2.caller.clone() };
    let mut k = consent_payload(&rec2, &c2, "SUPPLIER_SIGNER", w.now, "s1");
    set(&mut k, &["expiresAt"], u(w2.now + 2 * HOUR));
    let st = rec2.submit_cancel_consent(&w.ctx(), &c2, &k, &sign("supplier", "dockside/cancel-consent", &k)).unwrap();
    assert_eq!(st, "PENDING", "an expired consent does not count");
    assert_locked(&rec2, &iid2);
}

/* --------------------------------- ABANDON --------------------------------- */

fn abandon(w: &World, rec: &mut TradeRecord, iid: &str, trigger: &str, at: u64, role: &str, signer: &str, n: &str) -> &'static str {
    let p = abandon_payload(rec, iid, trigger, at, role, w.now, n);
    code(rec.abandon_release_intent(&w.ctx(), &p, &sign(signer, "dockside/abandon-release-intent", &p)))
}

#[test]
fn abandon_after_the_objective_trigger_and_grace_by_one_designated_party() {
    for (role, signer) in [("BUYER_APPROVER", "buyer"), ("SUPPLIER_SIGNER", "supplier")] {
        let (w, mut rec, iid) = pre_submit(false);
        let trig = intent(&rec, &iid).expires_at;
        let early = World { now: trig + ABANDON_GRACE_MS - 1, caller: w.caller.clone() };
        assert_eq!(abandon(&early, &mut rec, &iid, "INTENT_EXPIRED", trig, role, signer, "early"), "DELAY_NOT_ELAPSED");
        let at_trigger = World { now: trig, caller: w.caller.clone() };
        assert_eq!(abandon(&at_trigger, &mut rec, &iid, "INTENT_EXPIRED", trig, role, signer, "trig"), "DELAY_NOT_ELAPSED");
        assert_locked(&rec, &iid);
        let late = World { now: trig + ABANDON_GRACE_MS, caller: w.caller.clone() };
        assert_eq!(abandon(&late, &mut rec, &iid, "INTENT_EXPIRED", trig, role, signer, "ok"), "OK");
        assert_restored(&rec, &iid, IntentState::AbandonedPreSubmit);
    }
    // Buyer approval expiry is its own objective trigger.
    let (w, mut rec, iid) = pre_submit(true);
    let trig = intent(&rec, &iid).approval.as_ref().unwrap().expires_at;
    let late = World { now: trig + ABANDON_GRACE_MS, caller: w.caller.clone() };
    assert_eq!(abandon(&late, &mut rec, &iid, "BUYER_APPROVAL_EXPIRED", trig, "SUPPLIER_SIGNER", "supplier", "ap"), "OK");
    assert_restored(&rec, &iid, IntentState::AbandonedPreSubmit);
}

#[test]
fn abandon_rejects_non_designated_roles_subjective_wrong_policy_replay_and_revoked_keys() {
    let (w, mut rec, iid) = pre_submit(true);
    let trig = intent(&rec, &iid).expires_at;
    let late = World { now: trig + ABANDON_GRACE_MS + HOUR, caller: w.caller.clone() };
    for (role, signer, want) in [
        ("RISK_RESOLVER", "risk", "FORBIDDEN"),
        ("INSPECTOR", "inspector", "FORBIDDEN"),
        ("ORG_SECURITY_ADMIN", "buyer", "FORBIDDEN"),
        ("EXECUTOR", "supplier", "FORBIDDEN"),
        ("SCHEDULER", "policy", "FORBIDDEN"),
        ("MANIFEST_ATTEST", "attestor", "FORBIDDEN"),
        ("DETERMINISTIC_POLICY_SET", "policy", "FORBIDDEN"),
        ("BUYER_APPROVER", "risk", "SIGNATURE_INVALID"),
        ("SUPPLIER_SIGNER", "inspector", "SIGNATURE_INVALID"),
        ("SUPPLIER_SIGNER", "policy", "SIGNATURE_INVALID"),
    ] {
        assert_eq!(abandon(&late, &mut rec, &iid, "INTENT_EXPIRED", trig, role, signer, &format!("{role}-{signer}")), want, "{role}/{signer}");
    }
    // Subjective or unsupported triggers.
    assert_eq!(abandon(&late, &mut rec, &iid, "BUYER_CHANGED_MIND", trig, "BUYER_APPROVER", "buyer", "subj"), "VALIDATION_FAILED");
    assert_eq!(abandon(&late, &mut rec, &iid, "FUNDED_AUTHORIZATION_EXPIRED", trig, "BUYER_APPROVER", "buyer", "fa"), "NOT_ELIGIBLE");
    // Caller-chosen trigger time or grace.
    assert_eq!(abandon(&late, &mut rec, &iid, "INTENT_EXPIRED", trig - DAY, "BUYER_APPROVER", "buyer", "tt"), "POLICY_MISMATCH");
    let mut p = abandon_payload(&rec, &iid, "INTENT_EXPIRED", trig, "BUYER_APPROVER", late.now, "grace");
    set(&mut p, &["abandonAfter"], u(trig));
    assert_eq!(code(rec.abandon_release_intent(&late.ctx(), &p, &sign("buyer", "dockside/abandon-release-intent", &p))), "POLICY_MISMATCH");
    // Wrong policy id / revision / scope.
    for (path, v, want) in [
        (&["abandonPolicyId"][..], s("dockside-abandon-v2"), "POLICY_MISMATCH"),
        (&["abandonPolicyRevision"][..], u(2), "POLICY_MISMATCH"),
        (&["organizationId"][..], s(&id("org", "supplier-org")), "SCOPE_MISMATCH"),
        (&["tradeDigest"][..], s(&"00".repeat(32)), "STALE_REVISION"),
    ] {
        let mut p = abandon_payload(&rec, &iid, "INTENT_EXPIRED", trig, "BUYER_APPROVER", late.now, &format!("{path:?}"));
        set(&mut p, path, v);
        assert_eq!(code(rec.abandon_release_intent(&late.ctx(), &p, &sign("buyer", "dockside/abandon-release-intent", &p))), want, "{path:?}");
    }
    assert_locked(&rec, &iid);
    // Revoked buyer key cannot abandon; the supplier still can.
    let rk = with_header(
        &rec,
        vec![
            ("role", s("buyer")),
            ("publicKey", s(&rec.terms.buyer.public_key)),
            ("signerRole", s("SELF")),
            ("reasonCode", s("KEY_COMPROMISE")),
            ("issuedAt", u(late.now)),
            ("expiresAt", u(late.now + HOUR)),
            ("nonce", s(&nonce("rk-b"))),
        ],
    );
    rec.revoke_key(&late.ctx(), &rk, &sign("buyer", "dockside/bound-key-revocation", &rk)).unwrap();
    assert_eq!(abandon(&late, &mut rec, &iid, "INTENT_EXPIRED", trig, "BUYER_APPROVER", "buyer", "rv"), "KEY_REVOKED");
    let p = abandon_payload(&rec, &iid, "INTENT_EXPIRED", trig, "SUPPLIER_SIGNER", late.now, "final");
    let sig = sign("supplier", "dockside/abandon-release-intent", &p);
    rec.abandon_release_intent(&late.ctx(), &p, &sig).unwrap();
    assert_restored(&rec, &iid, IntentState::AbandonedPreSubmit);
    // Replay after the exit.
    assert_eq!(code(rec.abandon_release_intent(&late.ctx(), &p, &sig)), "INVALID_STATE");
}

/* ---------------------------------- races ---------------------------------- */

#[test]
fn exit_and_submit_race_has_exactly_one_winner_in_either_order() {
    // Submit first: the later CANCEL second consent sees SUBMITTING and changes nothing.
    let (w, mut rec, iid) = pre_submit(true);
    let c = cancel_payload(&rec, &iid, "PARTIES_AGREE", w.now, "c1");
    assert_eq!(consent(&w, &mut rec, &c, "BUYER_APPROVER", "buyer", "b1").unwrap(), "PENDING");
    rec.execute_release(&w.ctx(), &iid).unwrap();
    assert_eq!(code(consent(&w, &mut rec, &c, "SUPPLIER_SIGNER", "supplier", "s1")), "VALUE_LOCKED");
    assert_eq!(intent(&rec, &iid).state, IntentState::Submitting);
    assert_eq!(rec.ledger.funder(BUYER_ACCT).reserved, 6 * NEAR);
    // Cancel first: the later submit finds no live intent and transfers nothing.
    let (w, mut rec, iid) = pre_submit(true);
    let c = cancel_payload(&rec, &iid, "PARTIES_AGREE", w.now, "c1");
    consent(&w, &mut rec, &c, "BUYER_APPROVER", "buyer", "b1").unwrap();
    assert_eq!(consent(&w, &mut rec, &c, "SUPPLIER_SIGNER", "supplier", "s1").unwrap(), "CANCELLED");
    assert_eq!(code(rec.execute_release(&w.ctx(), &iid)), "INVALID_STATE");
    assert_restored(&rec, &iid, IntentState::CancelledPreSubmit);
    // Abandon vs submit: after the trigger the release conjunction already fails (intent expired).
    let (w, mut rec, iid) = pre_submit(true);
    let trig = intent(&rec, &iid).expires_at;
    let late = World { now: trig + ABANDON_GRACE_MS, caller: w.caller.clone() };
    assert_ne!(code(rec.execute_release(&late.ctx(), &iid)), "OK");
    assert_eq!(abandon(&late, &mut rec, &iid, "INTENT_EXPIRED", trig, "BUYER_APPROVER", "buyer", "a"), "OK");
    assert_eq!(code(rec.execute_release(&late.ctx(), &iid)), "INVALID_STATE");
}

#[test]
fn exit_and_supersession_race_never_exposes_value_twice() {
    // Supersession first: the pending cancel over the predecessor is void.
    let (mut w, mut rec, iid) = pre_submit(true);
    let c = cancel_payload(&rec, &iid, "PARTIES_AGREE", w.now, "c1");
    consent(&w, &mut rec, &c, "BUYER_APPROVER", "buyer", "b1").unwrap();
    let d = dual_consented(&mut w, &mut rec, ALT_DEST);
    let (_, succ) = rec.activate_destination_change(&w.ctx(), &d).unwrap();
    let succ = succ.unwrap();
    assert_eq!(intent(&rec, &iid).state, IntentState::SupersededPreSubmit);
    assert_eq!(code(consent(&w, &mut rec, &c, "SUPPLIER_SIGNER", "supplier", "s1")), "STALE_REVISION");
    assert_locked(&rec, &succ);
    // Cancel first: activation then has no intent to supersede and the value stays AVAILABLE once.
    let (mut w, mut rec, iid) = pre_submit(true);
    let d = propose(&w, &mut rec, ALT_DEST, "SUPPLIER", "supplier").unwrap();
    consent_dest(&w, &mut rec, ALT_DEST, "BUYER", "buyer").unwrap();
    let c = cancel_payload(&rec, &iid, "PARTIES_AGREE", w.now, "c1");
    consent(&w, &mut rec, &c, "BUYER_APPROVER", "buyer", "b1").unwrap();
    consent(&w, &mut rec, &c, "SUPPLIER_SIGNER", "supplier", "s1").unwrap();
    w.now += rec.terms.destination_change_delay_ms;
    let (_, succ) = rec.activate_destination_change(&w.ctx(), &d).unwrap();
    assert_eq!(succ, None);
    assert_restored(&rec, &iid, IntentState::CancelledPreSubmit);
}
