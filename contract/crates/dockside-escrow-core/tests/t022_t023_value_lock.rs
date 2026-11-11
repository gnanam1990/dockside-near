//! T-022 (stable release intent locks exact value) and T-023 (an unresolved release intent blocks
//! every competing action) at the contract boundary.
//!
//! SUBMITTING is reached through the real `execute_release`. PROCESSING, UNKNOWN, REVIEW,
//! RECONCILING and ADJUDICATION are reconciler outcomes (M05, not built yet); `force_unresolved`
//! assigns them on the record after a real submit so the denials they must cause are exercised.

mod common;
use common::evidence::DAY;
use common::release::*;
use common::*;
use dockside_escrow_core::refund::{RefundSignatures, RefundState};
use dockside_escrow_core::release::IntentState;

#[test]
fn t022_intent_id_is_caller_random_and_independent_of_revision_quote_and_attempt() {
    let (w, mut rec) = ready();
    let id1 = id("rli", "random-a");
    let p = intent_payload(&rec, &id1, w.now, "a");
    let (got, joined) = rec.create_release_intent(&w.ctx(), &p, &sign("buyer", "dockside/release-intent", &p)).unwrap();
    assert_eq!((got.as_str(), joined), (id1.as_str(), false));
    let i = intent(&rec, &id1).clone();
    assert_eq!(i.amount, 10 * NEAR);
    assert_eq!(i.slice_pairs(), vec![(BUYER_ACCT.to_string(), 6 * NEAR), (OTHER_FUNDER.to_string(), 4 * NEAR)]);
    assert_eq!(i.history.iter().map(|(s, _)| s.as_str()).collect::<Vec<_>>(), vec!["RELEASE_INTENT_CREATED", "VALUE_LOCKED"]);
    assert_eq!(rec.ledger.funder(BUYER_ACCT).reserved, 6 * NEAR);
    assert_eq!(rec.ledger.funder(OTHER_FUNDER).reserved, 4 * NEAR);
    assert_eq!(rec.ledger.total_available(), 0);
    rec.ledger.check_conservation().unwrap();
    // The id is not derived from revision, digest or attempt: any well-formed random id works,
    // and the attempt is a child identity recorded under it.
    assert!(!id1.contains(&rec.terms_digest[..8]));
    assert_eq!(approve(&w, &mut rec, &id1, "a"), "OK");
    let (_, _, attempt) = rec.execute_release(&w.ctx(), &id1).unwrap();
    assert_ne!(attempt, id1);
    assert_eq!(intent(&rec, &id1).attempts, vec![attempt]);
}

#[test]
fn t022_exact_duplicates_join_and_conflicting_reuse_fails_closed() {
    let (w, mut rec) = ready();
    let iid = id("rli", "dup");
    let p = intent_payload(&rec, &iid, w.now, "dup");
    let sig = sign("buyer", "dockside/release-intent", &p);
    rec.create_release_intent(&w.ctx(), &p, &sig).unwrap();
    let ledger = rec.ledger.clone();
    // Exact duplicate delivery joins the existing intent and changes nothing.
    assert_eq!(rec.create_release_intent(&w.ctx(), &p, &sig).unwrap(), (iid.clone(), true));
    assert_eq!(rec.ledger, ledger);
    assert_eq!(intent(&rec, &iid).version, 1);
    // Same id, different material: conflict.
    let mut q = p.clone();
    set(&mut q, &["intentExpiresAt"], u(w.now + 2 * DAY));
    assert_eq!(code(rec.create_release_intent(&w.ctx(), &q, &sign("buyer", "dockside/release-intent", &q))), "IDEMPOTENCY_CONFLICT");
    // A second intent while the first owns the lock: no double exposure.
    let r = intent_payload(&rec, &id("rli", "second"), w.now, "second");
    assert_eq!(code(rec.create_release_intent(&w.ctx(), &r, &sign("buyer", "dockside/release-intent", &r))), "VALUE_LOCKED");
    assert_eq!(rec.release.intents.len(), 1);
    assert_eq!(rec.ledger, ledger);
}

#[test]
fn t022_new_deposits_after_the_lock_are_excess_not_a_second_value_source() {
    let (mut w, mut rec) = ready();
    let iid = create(&w, &mut rec, "lock");
    rec.fund(&w.as_caller("late-funder.testnet").ctx(), 3 * NEAR, 1).unwrap();
    assert_eq!(rec.ledger.funder("late-funder.testnet").quarantined, 3 * NEAR);
    assert_eq!(rec.ledger.total_available(), 0);
    assert!(rec.ledger.reservation_matches(&intent(&rec, &iid).slice_pairs()));
}

fn denials(w: &mut World, rec: &mut dockside_escrow_core::TradeRecord, iid: &str, st: IntentState) {
    let tag = st.as_str();
    let ledger = rec.ledger.clone();
    // New intent / quote renewal under a fresh id.
    let p = intent_payload(rec, &id("rli", &format!("new-{tag}")), w.now, &format!("new-{tag}"));
    assert_eq!(code(rec.create_release_intent(&w.ctx(), &p, &sign("buyer", "dockside/release-intent", &p))), "VALUE_LOCKED", "{tag} new intent");
    // Second submit.
    assert_eq!(code(rec.execute_release(&w.ctx(), iid)), "VALUE_LOCKED", "{tag} second submit");
    // Re-approval.
    assert_eq!(approve(w, rec, iid, &format!("re-{tag}")), "VALUE_LOCKED", "{tag} re-approval");
    // CANCEL (either consent) and its revocation.
    let c = cancel_payload(rec, iid, "PARTIES_AGREE", w.now, &format!("c-{tag}"));
    assert_eq!(code(consent(w, rec, &c, "BUYER_APPROVER", "buyer", &format!("cb-{tag}"))), "VALUE_LOCKED", "{tag} cancel");
    assert_eq!(code(consent(w, rec, &c, "SUPPLIER_SIGNER", "supplier", &format!("cs-{tag}"))), "VALUE_LOCKED", "{tag} cancel");
    // ABANDON even after the objective trigger.
    let trig = intent(rec, iid).expires_at;
    let later = World { now: trig + 2 * DAY, caller: w.caller.clone() };
    let a = abandon_payload(rec, iid, "INTENT_EXPIRED", trig, "SUPPLIER_SIGNER", later.now, &format!("a-{tag}"));
    assert_eq!(code(rec.abandon_release_intent(&later.ctx(), &a, &sign("supplier", "dockside/abandon-release-intent", &a))), "VALUE_LOCKED", "{tag} abandon");
    // Destination activation (supersession).
    let d = dual_consented(w, rec, ALT_DEST);
    assert_eq!(code(rec.activate_destination_change(&w.ctx(), &d)), "VALUE_LOCKED", "{tag} activation");
    // Refunds of every party row.
    for (reason, initiator, signer) in [("MUTUAL_CANCEL", "BUYER", "buyer"), ("TRADE_EXPIRY", "SUPPLIER", "supplier")] {
        let r = refund_req(rec, &format!("{reason}-{tag}"), reason, BUYER_ACCT, 6 * NEAR, "AVAILABLE", initiator, later.now);
        let sig = sign(signer, "dockside/refund-request", &r);
        let sigs = if signer == "buyer" { RefundSignatures { buyer: Some(&sig), supplier: None, risk: None } } else { RefundSignatures { buyer: None, supplier: Some(&sig), risk: None } };
        assert_eq!(code(rec.request_refund(&later.ctx(), &r, sigs)), "VALUE_LOCKED", "{tag} {reason}");
    }
    assert_eq!(rec.ledger, ledger, "{tag}: the lock is unchanged");
    assert!(rec.ledger.reservation_matches(&intent(rec, iid).slice_pairs()));
    assert_eq!(intent(rec, iid).state, st);
    // Revoke the destination proposal so the next state starts clean.
    let rv = with_header(
        rec,
        vec![
            ("successorDigest", s(&d)),
            ("signerRole", s("BUYER")),
            ("issuedAt", u(w.now)),
            ("expiresAt", u(w.now + HOUR)),
            ("nonce", s(&nonce(&format!("drv-{tag}")))),
        ],
    );
    rec.revoke_destination_change(&w.ctx(), &rv, &sign("buyer", "dockside/destination-change-revoke", &rv)).unwrap();
}

#[test]
fn t023_every_unresolved_state_rejects_every_competing_action() {
    for st in unresolved_states() {
        let (mut w, mut rec, iid) = authorized();
        force_unresolved(&w, &mut rec, &iid, st);
        denials(&mut w, &mut rec, &iid, st);
    }
}

#[test]
fn t023_excess_and_partial_refund_rows_also_wait_for_an_unresolved_release() {
    for st in unresolved_states() {
        let (mut w, mut rec, iid) = authorized();
        rec.fund(&w.as_caller(OTHER_FUNDER).ctx(), 2 * NEAR, 1).unwrap();
        let p = refund_req(&rec, &format!("ex-{}", st.as_str()), "EXCESS_FUNDING_RETURN", OTHER_FUNDER, 2 * NEAR, "QUARANTINED", "FUNDER", w.now);
        // Requested before submit, executed after: still rejected while unresolved.
        let rid = rec.request_refund(&w.as_caller(OTHER_FUNDER).ctx(), &p, RefundSignatures { buyer: None, supplier: None, risk: None }).unwrap();
        force_unresolved(&w, &mut rec, &iid, st);
        w.now += HOUR;
        assert_eq!(code(rec.authorize_refund(&w.ctx(), &rid)), "VALUE_LOCKED", "{}", st.as_str());
        let q = refund_req(&rec, &format!("ex2-{}", st.as_str()), "EXCESS_FUNDING_RETURN", OTHER_FUNDER, 2 * NEAR, "QUARANTINED", "FUNDER", w.now);
        assert_eq!(code(rec.request_refund(&w.as_caller(OTHER_FUNDER).ctx(), &q, RefundSignatures { buyer: None, supplier: None, risk: None })), "VALUE_LOCKED");
        assert_eq!(rec.refunds[&rid].state, RefundState::Timelocked);
    }
}

#[test]
fn t023_late_receipt_resolves_the_original_intent_only() {
    for st in [IntentState::Unknown, IntentState::Reconciling, IntentState::Processing] {
        let (w, mut rec, iid) = authorized();
        force_unresolved(&w, &mut rec, &iid, st);
        let attempt = intent(&rec, &iid).attempts[0].clone();
        rec.complete_release(&w.ctx(), &iid, &attempt, true).unwrap();
        assert_eq!(intent(&rec, &iid).state, IntentState::Paid);
        assert_eq!(rec.ledger.funder(BUYER_ACCT).released, 6 * NEAR);
        assert_eq!(code(rec.complete_release(&w.ctx(), &iid, &attempt, true)), "INVALID_STATE", "a duplicate receipt cannot pay twice");
        rec.ledger.check_conservation().unwrap();
    }
    // REVIEW and ADJUDICATION never accept a terminal outcome directly.
    for st in [IntentState::Review, IntentState::Adjudication] {
        let (w, mut rec, iid) = authorized();
        force_unresolved(&w, &mut rec, &iid, st);
        let attempt = intent(&rec, &iid).attempts[0].clone();
        assert_eq!(code(rec.complete_release(&w.ctx(), &iid, &attempt, false)), "INVALID_STATE");
        assert_eq!(rec.ledger.funder(BUYER_ACCT).reserved, 6 * NEAR);
    }
}
