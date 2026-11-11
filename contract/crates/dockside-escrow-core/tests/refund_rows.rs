//! dockside-refund-v1 revision 1, lower-layer rows (FR-14, INV-12; feeds T-008/T-009/T-050).
//! Exercises initiator, signer, clock origin/duration, eligible amount computed by the
//! contract, original-funder recipient, exact source bucket, revocation phase, dispute/REVIEW
//! locking and execution outcomes. INSPECTION_FAIL / PERMANENT_HOLD are M04.

mod common;
use common::*;
use dockside_escrow_core::refund::{RefundSignatures, RefundState};
use dockside_escrow_core::TradeRecord;

const NONE: RefundSignatures<'static> = RefundSignatures { buyer: None, supplier: None };

fn req(rec: &TradeRecord, id_label: &str, reason: &str, funder: &str, amount: u128, bucket: &str, initiator: &str, now: u64) -> J {
    with_header(
        rec,
        vec![
            ("refundIntentId", s(&id("rfd", id_label))),
            ("policyId", s("dockside-refund-v1")),
            ("policyRevision", u(1)),
            ("reason", s(reason)),
            ("funder", s(funder)),
            ("amountYocto", big(amount)),
            ("sourceBucket", s(bucket)),
            ("initiatorRole", s(initiator)),
            ("issuedAt", u(now)),
            ("expiresAt", u(now + 24 * HOUR)),
            ("nonce", s(&nonce(id_label))),
        ],
    )
}

fn revoke(rec: &TradeRecord, intent: &str, role: &str, now: u64, n: &str) -> J {
    let r = &rec.refunds[intent];
    with_header(
        rec,
        vec![
            ("refundIntentId", s(intent)),
            ("requestDigest", s(&r.request_digest)),
            ("revokerRole", s(role)),
            ("issuedAt", u(now)),
            ("expiresAt", u(now + HOUR)),
            ("nonce", s(&nonce(n))),
        ],
    )
}

fn dispute(rec: &TradeRecord, intent: &str, role: &str, now: u64, n: &str) -> J {
    let r = &rec.refunds[intent];
    with_header(
        rec,
        vec![
            ("refundIntentId", s(intent)),
            ("requestDigest", s(&r.request_digest)),
            ("disputantRole", s(role)),
            ("reasonCode", s("ACCOUNTING_DISPUTE")),
            ("evidenceDigest", s(&"cd".repeat(32))),
            ("issuedAt", u(now)),
            ("expiresAt", u(now + HOUR)),
            ("nonce", s(&nonce(n))),
        ],
    )
}

fn funded_partial() -> (World, TradeRecord) {
    let (mut w, mut rec) = registered();
    rec.fund(&w.as_caller(BUYER_ACCT).ctx(), 4 * NEAR, 1).unwrap();
    (w, rec)
}

#[test]
fn partial_funding_return_goes_only_to_the_original_funder_after_cooling() {
    let (mut w, mut rec) = funded_partial();
    let p = req(&rec, "p1", "PARTIAL_FUNDING_RETURN", BUYER_ACCT, 4 * NEAR, "PARTIAL", "FUNDER", w.now);
    // Someone else cannot ask for the buyer's slice, even with the right payload.
    assert_eq!(code(rec.request_refund(&w.as_caller(OTHER_FUNDER).ctx(), &p, NONE)), "FORBIDDEN");
    // Caller-chosen amount or bucket has no authority.
    let wrong_amt = req(&rec, "p1", "PARTIAL_FUNDING_RETURN", BUYER_ACCT, 5 * NEAR, "PARTIAL", "FUNDER", w.now);
    assert_eq!(code(rec.request_refund(&w.as_caller(BUYER_ACCT).ctx(), &wrong_amt, NONE)), "STALE_LEDGER");
    let wrong_bucket = req(&rec, "p1", "PARTIAL_FUNDING_RETURN", BUYER_ACCT, 4 * NEAR, "AVAILABLE", "FUNDER", w.now);
    assert_eq!(code(rec.request_refund(&w.ctx(), &wrong_bucket, NONE)), "STALE_LEDGER");

    let id = rec.request_refund(&w.as_caller(BUYER_ACCT).ctx(), &p, NONE).unwrap();
    let f = rec.ledger.funder(BUYER_ACCT);
    assert_eq!((f.partial, f.refund_locked), (0, 4 * NEAR));
    assert_eq!(rec.refunds[&id].state, RefundState::Timelocked);
    assert_eq!(rec.refunds[&id].deadline, Some(T0 + HOUR));
    // Replay of the same request is rejected.
    assert_eq!(code(rec.request_refund(&w.ctx(), &p, NONE)), "INVALID_STATE");
    // New funding is frozen while accepted value is being refunded.
    assert_eq!(code(rec.fund(&w.as_caller(OTHER_FUNDER).ctx(), NEAR, 1)), "FUNDING_FROZEN");
    assert_eq!(code(rec.authorize_refund(&w.ctx(), &id)), "DELAY_NOT_ELAPSED");
    w.now += HOUR;
    rec.authorize_refund(&w.ctx(), &id).unwrap();
    let (to, amount) = rec.begin_refund(&w.ctx(), &id).unwrap();
    assert_eq!((to.as_str(), amount), (BUYER_ACCT, 4 * NEAR));
    // EXECUTING keeps the value locked; no revocation, second refund or new funding.
    let rv = revoke(&rec, &id, "FUNDER", w.now, "rv1");
    assert_eq!(code(rec.revoke_refund(&w.as_caller(BUYER_ACCT).ctx(), &rv, None)), "INVALID_STATE");
    rec.complete_refund(&w.ctx(), &id, true).unwrap();
    let f = rec.ledger.funder(BUYER_ACCT);
    assert_eq!((f.refund_locked, f.refunded, f.funded), (0, 4 * NEAR, 4 * NEAR));
    assert_eq!(rec.refunds[&id].state, RefundState::Refunded);
    rec.ledger.check_conservation().unwrap();
    // Terminal: the same intent cannot complete again.
    assert_eq!(code(rec.complete_refund(&w.ctx(), &id, true)), "INVALID_STATE");
}

#[test]
fn excess_return_revocation_restores_quarantined_exactly() {
    let (mut w, mut rec) = registered();
    rec.fund(&w.as_caller(BUYER_ACCT).ctx(), 10 * NEAR, 1).unwrap();
    w.now += 5;
    rec.fund(&w.as_caller(OTHER_FUNDER).ctx(), 2 * NEAR, 1).unwrap();
    let detected = w.now;
    w.now += 10 * 60_000;
    let p = req(&rec, "x1", "EXCESS_FUNDING_RETURN", OTHER_FUNDER, 2 * NEAR, "QUARANTINED", "FUNDER", w.now);
    let id = rec.request_refund(&w.as_caller(OTHER_FUNDER).ctx(), &p, NONE).unwrap();
    assert_eq!(rec.refunds[&id].clock_origin, Some(detected), "clock origin is the excess detection time");
    assert_eq!(rec.refunds[&id].deadline, Some(detected + HOUR));
    // Excess refunds do not freeze funding of the trade itself.
    assert_eq!(rec.ledger.funder(OTHER_FUNDER).quarantined, 0);
    let rv = revoke(&rec, &id, "FUNDER", w.now, "rvx");
    assert_eq!(code(rec.revoke_refund(&w.as_caller(BUYER_ACCT).ctx(), &rv, None)), "FORBIDDEN");
    rec.revoke_refund(&w.as_caller(OTHER_FUNDER).ctx(), &rv, None).unwrap();
    let f = rec.ledger.funder(OTHER_FUNDER);
    assert_eq!((f.quarantined, f.available, f.refund_locked), (2 * NEAR, 0, 0), "revoked excess returns to QUARANTINED, never AVAILABLE");
    assert_eq!(rec.refunds[&id].state, RefundState::Revoked);
    assert_eq!(code(rec.revoke_refund(&w.ctx(), &rv, None)), "INVALID_STATE");
    rec.ledger.check_conservation().unwrap();
}

#[test]
fn failed_transfer_restores_the_exact_source_bucket_and_needs_a_new_intent() {
    let (mut w, mut rec) = registered();
    rec.fund(&w.as_caller(BUYER_ACCT).ctx(), 10 * NEAR, 1).unwrap();
    rec.fund(&w.as_caller(OTHER_FUNDER).ctx(), NEAR, 1).unwrap();
    let p = req(&rec, "x2", "EXCESS_FUNDING_RETURN", OTHER_FUNDER, NEAR, "QUARANTINED", "FUNDER", w.now);
    let id = rec.request_refund(&w.as_caller(OTHER_FUNDER).ctx(), &p, NONE).unwrap();
    w.now += HOUR;
    rec.authorize_refund(&w.ctx(), &id).unwrap();
    rec.begin_refund(&w.ctx(), &id).unwrap();
    rec.complete_refund(&w.ctx(), &id, false).unwrap();
    assert_eq!(rec.refunds[&id].state, RefundState::Failed);
    assert_eq!(rec.ledger.funder(OTHER_FUNDER).quarantined, NEAR);
    assert_eq!(code(rec.authorize_refund(&w.ctx(), &id)), "INVALID_STATE");
    let p2 = req(&rec, "x3", "EXCESS_FUNDING_RETURN", OTHER_FUNDER, NEAR, "QUARANTINED", "FUNDER", w.now);
    rec.request_refund(&w.as_caller(OTHER_FUNDER).ctx(), &p2, NONE).unwrap();
}

#[test]
fn trade_expiry_requires_expiry_initiator_signature_and_24h_challenge() {
    let (mut w, mut rec) = registered();
    rec.fund(&w.as_caller(BUYER_ACCT).ctx(), 10 * NEAR, 1).unwrap();
    let early = req(&rec, "e0", "TRADE_EXPIRY", BUYER_ACCT, 10 * NEAR, "AVAILABLE", "BUYER", w.now);
    let sig = sign("buyer", "dockside/refund-request", &early);
    assert_eq!(code(rec.request_refund(&w.ctx(), &early, RefundSignatures { buyer: Some(&sig), supplier: None })), "NOT_ELIGIBLE");
    w.now = rec.terms.expires_at + 1;
    let p = req(&rec, "e1", "TRADE_EXPIRY", BUYER_ACCT, 10 * NEAR, "AVAILABLE", "BUYER", w.now);
    let buyer = sign("buyer", "dockside/refund-request", &p);
    // Wrong signer for the named initiator, inspector posing as buyer, and missing signature.
    let supplier = sign("supplier", "dockside/refund-request", &p);
    assert_eq!(code(rec.request_refund(&w.ctx(), &p, RefundSignatures { buyer: Some(&supplier), supplier: None })), "SIGNATURE_INVALID");
    assert_eq!(code(rec.request_refund(&w.ctx(), &p, RefundSignatures { buyer: Some(&sign("inspector", "dockside/refund-request", &p)), supplier: None })), "SIGNATURE_INVALID");
    assert_eq!(code(rec.request_refund(&w.ctx(), &p, NONE)), "SIGNATURE_INVALID");
    let mut risk = p.clone();
    set(&mut risk, &["initiatorRole"], s("RISK_RESOLVER"));
    assert_eq!(code(rec.request_refund(&w.ctx(), &risk, RefundSignatures { buyer: None, supplier: None })), "FORBIDDEN");
    // A caller cannot redirect: the recipient is always the recorded original funder.
    let id = rec.request_refund(&w.as_caller("anyone.testnet").ctx(), &p, RefundSignatures { buyer: Some(&buyer), supplier: None }).unwrap();
    let r = &rec.refunds[&id];
    assert_eq!((r.clock_origin, r.deadline), (Some(rec.terms.expires_at), Some(rec.terms.expires_at + 24 * HOUR)));
    w.now += HOUR;
    assert_eq!(code(rec.authorize_refund(&w.ctx(), &id)), "DELAY_NOT_ELAPSED");
    // Supplier disputes before the deadline: REVIEW keeps the value locked.
    let d = dispute(&rec, &id, "SUPPLIER", w.now, "d1");
    assert_eq!(code(rec.dispute_refund(&w.ctx(), &d, &sign("buyer", "dockside/refund-dispute", &d))), "SIGNATURE_INVALID");
    rec.dispute_refund(&w.ctx(), &d, &sign("supplier", "dockside/refund-dispute", &d)).unwrap();
    assert_eq!(rec.refunds[&id].state, RefundState::Review);
    w.now += 48 * HOUR;
    assert_eq!(code(rec.authorize_refund(&w.ctx(), &id)), "INVALID_STATE");
    assert_eq!(code(rec.begin_refund(&w.ctx(), &id)), "INVALID_STATE");
    let rv = revoke(&rec, &id, "BUYER", w.now, "rv-e1");
    assert_eq!(code(rec.revoke_refund(&w.ctx(), &rv, Some(&sign("buyer", "dockside/refund-revoke", &rv)))), "INVALID_STATE");
    assert_eq!(rec.ledger.funder(BUYER_ACCT).refund_locked, 10 * NEAR);
    rec.ledger.check_conservation().unwrap();
}

#[test]
fn trade_expiry_undisputed_executes_to_the_original_funder() {
    let (mut w, mut rec) = registered();
    rec.fund(&w.as_caller(OTHER_FUNDER).ctx(), 10 * NEAR, 1).unwrap();
    w.now = rec.terms.expires_at;
    let p = req(&rec, "e2", "TRADE_EXPIRY", OTHER_FUNDER, 10 * NEAR, "AVAILABLE", "SUPPLIER", w.now);
    let sig = sign("supplier", "dockside/refund-request", &p);
    let id = rec.request_refund(&w.ctx(), &p, RefundSignatures { buyer: None, supplier: Some(&sig) }).unwrap();
    w.now += 24 * HOUR;
    let late = dispute(&rec, &id, "BUYER", w.now, "late");
    assert_eq!(code(rec.dispute_refund(&w.ctx(), &late, &sign("buyer", "dockside/refund-dispute", &late))), "INVALID_STATE");
    rec.authorize_refund(&w.ctx(), &id).unwrap();
    let (to, amt) = rec.begin_refund(&w.ctx(), &id).unwrap();
    assert_eq!((to.as_str(), amt), (OTHER_FUNDER, 10 * NEAR), "recipient is the original funder, not the buyer");
    rec.complete_refund(&w.ctx(), &id, true).unwrap();
    let f = rec.ledger.funder(OTHER_FUNDER);
    assert_eq!((f.refunded, f.available, f.partial), (10 * NEAR, 0, 0));
}

#[test]
fn mutual_cancel_needs_identical_dual_consent_and_one_hour_revocation_window() {
    let (mut w, mut rec) = registered();
    rec.fund(&w.as_caller(BUYER_ACCT).ctx(), 10 * NEAR, 1).unwrap();
    let p = req(&rec, "m1", "MUTUAL_CANCEL", BUYER_ACCT, 10 * NEAR, "AVAILABLE", "BUYER", w.now);
    let b = sign("buyer", "dockside/refund-request", &p);
    let id = rec.request_refund(&w.ctx(), &p, RefundSignatures { buyer: Some(&b), supplier: None }).unwrap();
    assert_eq!(rec.refunds[&id].state, RefundState::Requested, "one consent is not dual consent");
    w.now += 3 * HOUR;
    assert_eq!(code(rec.authorize_refund(&w.ctx(), &id)), "INVALID_STATE");
    // Second consent must be the supplier's signature over the identical digest.
    let mut other = p.clone();
    set(&mut other, &["amountYocto"], big(NEAR));
    assert_eq!(code(rec.cosign_refund(&w.ctx(), &id, "SUPPLIER", &sign("supplier", "dockside/refund-request", &other))), "SIGNATURE_INVALID");
    assert_eq!(code(rec.cosign_refund(&w.ctx(), &id, "BUYER", &b)), "INVALID_STATE");
    rec.cosign_refund(&w.ctx(), &id, "SUPPLIER", &sign("supplier", "dockside/refund-request", &p)).unwrap();
    assert_eq!(rec.refunds[&id].deadline, Some(w.now + HOUR), "clock starts at the second signature");
    assert_eq!(code(rec.dispute_refund(&w.ctx(), &dispute(&rec, &id, "BUYER", w.now, "md"), "ed25519:1")), "DISPUTE_NOT_ALLOWED");
    // Either signer may revoke before authorization; the AVAILABLE slice is restored exactly.
    let rv = revoke(&rec, &id, "SUPPLIER", w.now, "rv-m1");
    rec.revoke_refund(&w.ctx(), &rv, Some(&sign("supplier", "dockside/refund-revoke", &rv))).unwrap();
    assert_eq!(rec.ledger.funder(BUYER_ACCT).available, 10 * NEAR);
    // Replayed revocation nonce is refused even on a new intent.
    let p2 = req(&rec, "m2", "MUTUAL_CANCEL", BUYER_ACCT, 10 * NEAR, "AVAILABLE", "SUPPLIER", w.now);
    let id2 = rec
        .request_refund(&w.ctx(), &p2, RefundSignatures { buyer: Some(&sign("buyer", "dockside/refund-request", &p2)), supplier: Some(&sign("supplier", "dockside/refund-request", &p2)) })
        .unwrap();
    assert_eq!(rec.refunds[&id2].state, RefundState::Timelocked);
    w.now += HOUR;
    rec.authorize_refund(&w.ctx(), &id2).unwrap();
    let rv2 = revoke(&rec, &id2, "BUYER", w.now, "rv-m2");
    assert_eq!(code(rec.revoke_refund(&w.ctx(), &rv2, Some(&sign("buyer", "dockside/refund-revoke", &rv2)))), "INVALID_STATE", "no revocation after authorization");
}

#[test]
fn key_loss_inspection_fail_and_unknown_rows_never_submit() {
    let (mut w, mut rec) = registered();
    rec.fund(&w.as_caller(BUYER_ACCT).ctx(), 10 * NEAR, 1).unwrap();
    for (reason, expected) in [
        ("BUYER_KEY_LOSS", "NO_REFUND_SUBMIT"),
        ("SUPPLIER_KEY_LOSS", "NO_REFUND_SUBMIT"),
        ("INSPECTOR_KEY_LOSS", "NO_REFUND_SUBMIT"),
        ("INSPECTION_FAIL", "REASON_NOT_ENABLED"),
        ("PERMANENT_HOLD", "REASON_NOT_ENABLED"),
        ("UNEXPECTED_ASSET_RECOVERY", "NOT_NATIVE_REFUND"),
        ("ADMIN_OVERRIDE", "VALIDATION_FAILED"),
    ] {
        let p = req(&rec, reason, reason, BUYER_ACCT, 10 * NEAR, "AVAILABLE", "BUYER", w.now);
        let sig = sign("buyer", "dockside/refund-request", &p);
        assert_eq!(code(rec.request_refund(&w.ctx(), &p, RefundSignatures { buyer: Some(&sig), supplier: None })), expected, "{reason}");
    }
    assert_eq!(rec.ledger.funder(BUYER_ACCT).available, 10 * NEAR);
}

#[test]
fn policy_revision_replay_and_header_mutations_fail() {
    let (mut w, mut rec) = funded_partial();
    let base = req(&rec, "h1", "PARTIAL_FUNDING_RETURN", BUYER_ACCT, 4 * NEAR, "PARTIAL", "FUNDER", w.now);
    let mutations: Vec<(&[&str], J, &str)> = vec![
        (&["policyRevision"], u(2), "POLICY_MISMATCH"),
        (&["policyId"], s("dockside-refund-v2"), "POLICY_MISMATCH"),
        (&["contractId"], s("other.testnet"), "WRONG_CONTRACT"),
        (&["tradeRevision"], u(2), "STALE_REVISION"),
        (&["tradeDigest"], s(&"00".repeat(32)), "STALE_REVISION"),
        (&["expiresAt"], u(T0 + 30 * 24 * HOUR), "VALIDATION_FAILED"),
        (&["issuedAt"], u(T0 + HOUR), "NOT_YET_VALID"),
        (&["nonce"], s("xyz"), "VALIDATION_FAILED"),
        (&["eligible"], json!({"bool": true}), "UNKNOWN_FIELD"),
    ];
    for (path, val, expected) in mutations {
        let mut m = base.clone();
        set(&mut m, path, val);
        assert_eq!(code(rec.request_refund(&w.as_caller(BUYER_ACCT).ctx(), &m, NONE)), expected, "{path:?}");
    }
    w.now += 25 * HOUR;
    assert_eq!(code(rec.request_refund(&w.ctx(), &base, NONE)), "EXPIRED");
    // Nonce replay across a fresh intent id.
    let (mut w, mut rec) = funded_partial();
    rec.fund(&w.as_caller(OTHER_FUNDER).ctx(), NEAR, 1).unwrap();
    let a = req(&rec, "n1", "PARTIAL_FUNDING_RETURN", BUYER_ACCT, 4 * NEAR, "PARTIAL", "FUNDER", w.now);
    rec.request_refund(&w.as_caller(BUYER_ACCT).ctx(), &a, NONE).unwrap();
    let mut b = req(&rec, "n2", "PARTIAL_FUNDING_RETURN", OTHER_FUNDER, NEAR, "PARTIAL", "FUNDER", w.now);
    set(&mut b, &["nonce"], s(&nonce("n1")));
    assert_eq!(code(rec.request_refund(&w.as_caller(OTHER_FUNDER).ctx(), &b, NONE)), "NONCE_REPLAYED");
}

#[test]
fn refunded_available_value_demotes_remaining_value_to_partial() {
    let (mut w, mut rec) = registered();
    rec.fund(&w.as_caller(BUYER_ACCT).ctx(), 6 * NEAR, 1).unwrap();
    rec.fund(&w.as_caller(OTHER_FUNDER).ctx(), 4 * NEAR, 1).unwrap();
    assert!(rec.ledger.fully_funded());
    let p = req(&rec, "c1", "MUTUAL_CANCEL", OTHER_FUNDER, 4 * NEAR, "AVAILABLE", "BUYER", w.now);
    let id = rec
        .request_refund(&w.ctx(), &p, RefundSignatures { buyer: Some(&sign("buyer", "dockside/refund-request", &p)), supplier: Some(&sign("supplier", "dockside/refund-request", &p)) })
        .unwrap();
    assert!(!rec.ledger.fully_funded(), "locked value no longer counts toward the trade amount");
    w.now += HOUR;
    rec.authorize_refund(&w.ctx(), &id).unwrap();
    rec.begin_refund(&w.ctx(), &id).unwrap();
    rec.complete_refund(&w.ctx(), &id, true).unwrap();
    assert_eq!(rec.ledger.total_available(), 0);
    assert_eq!(rec.ledger.funder(BUYER_ACCT).partial, 6 * NEAR);
    rec.ledger.check_conservation().unwrap();
}
