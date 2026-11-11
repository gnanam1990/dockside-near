//! dockside-refund-v1 r1 at the integrated release boundary: T-009 (refund and cancellation paths
//! bind the original funder, including INSPECTION_FAIL and PERMANENT_HOLD from M03 facts), T-010
//! (release, refund, destination activation and cancellation serialize on one economic lock with
//! per-funder conservation) and T-050 (the reason matrix is enforced per row, and every row is
//! rejected throughout SUBMITTING, PROCESSING, UNKNOWN, REVIEW, RECONCILING and ADJUDICATION).

mod common;
use common::evidence::*;
use common::release::*;
use common::*;
use dockside_escrow_core::refund::{RefundSignatures, RefundState};
use dockside_escrow_core::release::IntentState;
use dockside_escrow_core::TradeRecord;

const H48: u64 = 48 * HOUR;

fn sigs<'a>(buyer: Option<&'a str>, supplier: Option<&'a str>, risk: Option<&'a str>) -> RefundSignatures<'a> {
    RefundSignatures { buyer, supplier, risk }
}

fn inspection_failed() -> (World, TradeRecord) {
    let (mut w, mut rec) = evidence_trade();
    fund_full(&mut w, &mut rec);
    attest_and_inspect(&w, &mut rec, 1, "FAIL", "f1");
    (w, rec)
}

fn request_if(w: &World, rec: &mut TradeRecord, label: &str, funder: &str, amount: u128, initiator: &str, signer: &str) -> Result<String, dockside_escrow_core::Error> {
    let p = refund_req(rec, label, "INSPECTION_FAIL", funder, amount, "AVAILABLE", initiator, w.now);
    let sg = sign(signer, "dockside/refund-request", &p);
    let s = if initiator == "BUYER" { sigs(Some(&sg), None, None) } else { sigs(None, Some(&sg), None) };
    rec.request_refund(&w.ctx(), &p, s)
}

fn risk_authorize(w: &World, rec: &mut TradeRecord, rid: &str, signer: &str, n: &str) -> &'static str {
    let p = refund_intent_payload(rec, rid, "authorizerRole", "RISK_RESOLVER", w.now, n);
    code(rec.authorize_refund_signed(&w.ctx(), &p, &sign(signer, "dockside/refund-authorize", &p)))
}

fn conserve(rec: &TradeRecord) {
    rec.ledger.check_conservation().unwrap();
    let total: u128 = rec.ledger.funders.values().map(|f| f.funded).sum();
    let deposits: u128 = rec.ledger.deposits.iter().map(|d| d.amount).sum();
    assert_eq!(total, deposits);
}

/* ---------------------------------- T-009 ---------------------------------- */

#[test]
fn t009_inspection_fail_refunds_each_original_funder_after_appeal_window_and_risk_authorization() {
    let (mut w, mut rec) = inspection_failed();
    let recorded = rec.evidence.inspection.as_ref().unwrap().recorded_at;
    let b = request_if(&w, &mut rec, "if-b", BUYER_ACCT, 6 * NEAR, "BUYER", "buyer").unwrap();
    let t = request_if(&w, &mut rec, "if-t", OTHER_FUNDER, 4 * NEAR, "SUPPLIER", "supplier").unwrap();
    for rid in [&b, &t] {
        let r = &rec.refunds[rid];
        assert_eq!((r.state, r.clock_origin, r.deadline), (RefundState::Timelocked, Some(recorded), Some(recorded + H48)));
        assert_eq!(r.basis.as_deref(), Some(rec.evidence.inspection.as_ref().unwrap().digest.as_str()));
    }
    // Permissionless authorization has no authority for this row; the risk key is required.
    w.now = recorded + H48;
    assert_eq!(code(rec.authorize_refund(&w.ctx(), &b)), "FORBIDDEN");
    for signer in ["buyer", "supplier", "inspector", "policy", "attestor"] {
        assert_eq!(risk_authorize(&w, &mut rec, &b, signer, &format!("a-{signer}")), "SIGNATURE_INVALID", "{signer}");
    }
    let early = World { now: recorded + H48 - 1, caller: w.caller.clone() };
    assert_eq!(risk_authorize(&early, &mut rec, &b, "risk", "early"), "DELAY_NOT_ELAPSED");
    assert_eq!(risk_authorize(&w, &mut rec, &b, "risk", "ok-b"), "OK");
    assert_eq!(risk_authorize(&w, &mut rec, &t, "risk", "ok-t"), "OK");
    for (rid, funder, amount) in [(&b, BUYER_ACCT, 6 * NEAR), (&t, OTHER_FUNDER, 4 * NEAR)] {
        let (to, amt) = rec.begin_refund(&w.ctx(), rid).unwrap();
        assert_eq!((to.as_str(), amt), (funder, amount), "only the original funder, only its slice");
        rec.complete_refund(&w.ctx(), rid, true).unwrap();
    }
    assert_eq!(rec.ledger.funder(BUYER_ACCT).refunded, 6 * NEAR);
    assert_eq!(rec.ledger.funder(OTHER_FUNDER).refunded, 4 * NEAR);
    conserve(&rec);
}

#[test]
fn t009_supplier_appeal_superseding_inspection_and_risk_revocation() {
    // Appeal before the deadline pauses the refund in REVIEW.
    let (w, mut rec) = inspection_failed();
    let rid = request_if(&w, &mut rec, "ap", BUYER_ACCT, 6 * NEAR, "BUYER", "buyer").unwrap();
    let ap = with_header(
        &rec,
        vec![
            ("refundIntentId", s(&rid)),
            ("requestDigest", s(&rec.refunds[&rid].request_digest)),
            ("disputantRole", s("BUYER")),
            ("reasonCode", s("APPEAL")),
            ("evidenceDigest", s(&"cd".repeat(32))),
            ("issuedAt", u(w.now)),
            ("expiresAt", u(w.now + HOUR)),
            ("nonce", s(&nonce("ap-b"))),
        ],
    );
    assert_eq!(code(rec.dispute_refund(&w.ctx(), &ap, &sign("buyer", "dockside/refund-dispute", &ap))), "FORBIDDEN", "only the supplier appeals");
    let mut ap2 = ap.clone();
    set(&mut ap2, &["disputantRole"], s("SUPPLIER"));
    rec.dispute_refund(&w.ctx(), &ap2, &sign("supplier", "dockside/refund-dispute", &ap2)).unwrap();
    assert_eq!(rec.refunds[&rid].state, RefundState::Review);
    // A superseding inspection after the window invalidates the basis.
    let (mut w, mut rec) = inspection_failed();
    let rid = request_if(&w, &mut rec, "sup", BUYER_ACCT, 6 * NEAR, "BUYER", "buyer").unwrap();
    attest_and_inspect(&w, &mut rec, 2, "FAIL", "f2");
    w.now += H48;
    assert_eq!(risk_authorize(&w, &mut rec, &rid, "risk", "sup"), "NOT_ELIGIBLE");
    // Risk/policy revocation before execution restores the exact bucket; supplier cannot revoke.
    let (w, mut rec) = inspection_failed();
    let rid = request_if(&w, &mut rec, "rv", BUYER_ACCT, 6 * NEAR, "BUYER", "buyer").unwrap();
    let rv = refund_intent_payload(&rec, &rid, "revokerRole", "SUPPLIER", w.now, "rv-s");
    assert_eq!(code(rec.revoke_refund(&w.ctx(), &rv, Some(&sign("supplier", "dockside/refund-revoke", &rv)))), "FORBIDDEN");
    let rv = refund_intent_payload(&rec, &rid, "revokerRole", "RISK_RESOLVER", w.now, "rv-r");
    rec.revoke_refund(&w.ctx(), &rv, Some(&sign("risk", "dockside/refund-revoke", &rv))).unwrap();
    assert_eq!(rec.refunds[&rid].state, RefundState::Revoked);
    assert_eq!(rec.ledger.funder(BUYER_ACCT).available, 6 * NEAR);
    conserve(&rec);
}

fn permanent_hold_trade() -> (World, TradeRecord) {
    let (mut w, mut rec) = evidence_trade();
    fund_full(&mut w, &mut rec);
    attest_and_inspect(&w, &mut rec, 1, "PASS", "ph");
    set_hold(&w, &mut rec, "perm", "POLICY_SETTER", 30 * DAY);
    assert_eq!(resolve(&w, &mut rec, "perm", "RESOLVE_TO_REFUND", "perm"), "OK");
    (w, rec)
}

fn ph_request(w: &World, rec: &mut TradeRecord, label: &str, funder: &str, amount: u128, with_supplier: bool) -> Result<String, dockside_escrow_core::Error> {
    ph_request_from(w, rec, label, funder, amount, "AVAILABLE", with_supplier)
}

fn ph_request_from(w: &World, rec: &mut TradeRecord, label: &str, funder: &str, amount: u128, bucket: &str, with_supplier: bool) -> Result<String, dockside_escrow_core::Error> {
    let p = refund_req(rec, label, "PERMANENT_HOLD", funder, amount, bucket, "RISK_RESOLVER", w.now);
    let r = sign("risk", "dockside/refund-request", &p);
    let sp = sign("supplier", "dockside/refund-request", &p);
    rec.request_refund(&w.ctx(), &p, sigs(None, if with_supplier { Some(&sp) } else { None }, Some(&r)))
}

#[test]
fn t009_permanent_hold_refund_needs_risk_resolution_supplier_consent_and_cooling() {
    let (mut w, mut rec) = permanent_hold_trade();
    let rid = ph_request(&w, &mut rec, "ph-b", BUYER_ACCT, 6 * NEAR, false).unwrap();
    assert_eq!(rec.refunds[&rid].state, RefundState::Requested, "waits for the supplier signature");
    assert_eq!(code(rec.authorize_refund(&w.ctx(), &rid)), "INVALID_STATE");
    w.now += 2 * HOUR;
    let digest = rec.refunds[&rid].request_digest_bytes;
    assert_eq!(code(rec.cosign_refund(&w.ctx(), &rid, "BUYER", &sign_digest("buyer", &digest))), "INVALID_STATE", "the buyer is not a signer");
    rec.cosign_refund(&w.ctx(), &rid, "SUPPLIER", &sign_digest("supplier", &digest)).unwrap();
    let r = &rec.refunds[&rid];
    assert_eq!((r.state, r.clock_origin, r.deadline), (RefundState::Timelocked, Some(w.now), Some(w.now + H48)));
    w.now += H48 - 1;
    assert_eq!(code(rec.authorize_refund(&w.ctx(), &rid)), "DELAY_NOT_ELAPSED");
    w.now += 1;
    rec.authorize_refund(&w.ctx(), &rid).unwrap();
    assert_eq!(rec.begin_refund(&w.ctx(), &rid).unwrap(), (BUYER_ACCT.to_string(), 6 * NEAR));
    rec.complete_refund(&w.ctx(), &rid, true).unwrap();
    // The trade is now below its amount, so the other funder's slice is PARTIAL (M02 rule); it uses
    // its own intent, and both signatures at once start the cooling period at once.
    assert_eq!(code(ph_request(&w, &mut rec, "ph-t0", OTHER_FUNDER, 4 * NEAR, true)), "STALE_LEDGER");
    let rid2 = ph_request_from(&w, &mut rec, "ph-t", OTHER_FUNDER, 4 * NEAR, "PARTIAL", true).unwrap();
    assert_eq!(rec.refunds[&rid2].deadline, Some(w.now + H48));
    conserve(&rec);
}

#[test]
fn t009_permanent_hold_wrong_initiator_signer_basis_and_revocation() {
    let (w, mut rec) = permanent_hold_trade();
    let p = refund_req(&rec, "x", "PERMANENT_HOLD", BUYER_ACCT, 6 * NEAR, "AVAILABLE", "SUPPLIER", w.now);
    let sp = sign("supplier", "dockside/refund-request", &p);
    assert_eq!(code(rec.request_refund(&w.ctx(), &p, sigs(None, Some(&sp), None))), "FORBIDDEN");
    let p = refund_req(&rec, "y", "PERMANENT_HOLD", BUYER_ACCT, 6 * NEAR, "AVAILABLE", "RISK_RESOLVER", w.now);
    for signer in ["policy", "buyer", "inspector"] {
        let bad = sign(signer, "dockside/refund-request", &p);
        assert_eq!(code(rec.request_refund(&w.ctx(), &p, sigs(None, None, Some(&bad)))), "SIGNATURE_INVALID", "{signer}");
    }
    let r = sign("risk", "dockside/refund-request", &p);
    let b = sign("buyer", "dockside/refund-request", &p);
    assert_eq!(code(rec.request_refund(&w.ctx(), &p, sigs(Some(&b), None, Some(&r)))), "VALIDATION_FAILED");
    assert_eq!(code(rec.request_refund(&w.ctx(), &p, sigs(None, None, None))), "SIGNATURE_INVALID");
    // Basis must be RESOLVE_TO_REFUND as the latest resolution.
    let (w2, mut rec2) = ready();
    set_hold(&w2, &mut rec2, "rel", "RISK_RESOLVER", DAY);
    assert_eq!(resolve(&w2, &mut rec2, "rel", "RELEASE_HOLD", "rel"), "OK");
    assert_eq!(code(ph_request(&w2, &mut rec2, "z", BUYER_ACCT, 6 * NEAR, true)), "NOT_ELIGIBLE");
    // Either required signer may revoke during cooling; afterwards nobody can.
    let rid = ph_request(&w, &mut rec, "rv", BUYER_ACCT, 6 * NEAR, true).unwrap();
    let rv = refund_intent_payload(&rec, &rid, "revokerRole", "BUYER", w.now, "rv-b");
    assert_eq!(code(rec.revoke_refund(&w.ctx(), &rv, Some(&sign("buyer", "dockside/refund-revoke", &rv)))), "FORBIDDEN");
    let rv = refund_intent_payload(&rec, &rid, "revokerRole", "SUPPLIER", w.now, "rv-s");
    rec.revoke_refund(&w.ctx(), &rv, Some(&sign("supplier", "dockside/refund-revoke", &rv))).unwrap();
    assert_eq!(rec.ledger.funder(BUYER_ACCT).available, 6 * NEAR, "exact source bucket restored");
    // A new hold during cooling blocks authorization.
    let (mut w, mut rec) = permanent_hold_trade();
    let rid = ph_request(&w, &mut rec, "cool", BUYER_ACCT, 6 * NEAR, true).unwrap();
    set_hold(&w, &mut rec, "late", "RISK_RESOLVER", 30 * DAY);
    w.now += H48;
    assert_eq!(code(rec.authorize_refund(&w.ctx(), &rid)), "HOLD_ACTIVE");
    let rv = refund_intent_payload(&rec, &rid, "revokerRole", "RISK_RESOLVER", w.now, "rv-late");
    assert_eq!(code(rec.revoke_refund(&w.ctx(), &rv, Some(&sign("risk", "dockside/refund-revoke", &rv)))), "OK");
}

#[test]
fn t009_mutual_cancel_refund_requires_the_release_intent_to_exit_first() {
    let (w, mut rec) = ready();
    let iid = create(&w, &mut rec, "pre");
    let p = refund_req(&rec, "mc", "MUTUAL_CANCEL", BUYER_ACCT, 6 * NEAR, "AVAILABLE", "BUYER", w.now);
    let (bs, ss) = (sign("buyer", "dockside/refund-request", &p), sign("supplier", "dockside/refund-request", &p));
    assert_eq!(code(rec.request_refund(&w.ctx(), &p, sigs(Some(&bs), Some(&ss), None))), "VALUE_LOCKED");
    let c = cancel_payload(&rec, &iid, "PARTIES_AGREE", w.now, "c");
    consent(&w, &mut rec, &c, "BUYER_APPROVER", "buyer", "b").unwrap();
    assert_eq!(consent(&w, &mut rec, &c, "SUPPLIER_SIGNER", "supplier", "s").unwrap(), "CANCELLED");
    let rid = rec.request_refund(&w.ctx(), &p, sigs(Some(&bs), Some(&ss), None)).unwrap();
    assert_eq!(rec.refunds[&rid].funder, BUYER_ACCT);
    assert_eq!(rec.refunds[&rid].source_bucket.as_str(), "AVAILABLE");
    // While the refund locks accepted value no release intent can be created.
    let q = intent_payload(&rec, &id("rli", "blocked"), w.now, "blocked");
    assert_eq!(code(rec.create_release_intent(&w.ctx(), &q, &sign("buyer", "dockside/release-intent", &q))), "VALUE_LOCKED");
    conserve(&rec);
}

/* ---------------------------------- T-010 ---------------------------------- */

#[test]
fn t010_release_and_refund_serialize_on_one_lock_in_either_order() {
    // Release first, then every refund attempt fails while the release is unresolved and the
    // value never becomes refundable after PAID.
    let (mut w, mut rec, iid) = authorized();
    rec.fund(&w.as_caller(OTHER_FUNDER).ctx(), NEAR, 1).unwrap();
    let ex = refund_req(&rec, "ex", "EXCESS_FUNDING_RETURN", OTHER_FUNDER, NEAR, "QUARANTINED", "FUNDER", w.now);
    let xid = rec.request_refund(&w.as_caller(OTHER_FUNDER).ctx(), &ex, sigs(None, None, None)).unwrap();
    let (_, _, attempt) = rec.execute_release(&w.ctx(), &iid).unwrap();
    w.now += HOUR;
    assert_eq!(code(rec.authorize_refund(&w.ctx(), &xid)), "VALUE_LOCKED");
    rec.complete_release(&w.ctx(), &iid, &attempt, true).unwrap();
    rec.authorize_refund(&w.ctx(), &xid).unwrap();
    assert_eq!(rec.begin_refund(&w.ctx(), &xid).unwrap(), (OTHER_FUNDER.to_string(), NEAR), "only the quarantined excess");
    rec.complete_refund(&w.ctx(), &xid, true).unwrap();
    let f = rec.ledger.funder(OTHER_FUNDER);
    assert_eq!((f.released, f.refunded, f.funded), (4 * NEAR, NEAR, 5 * NEAR));
    let p = refund_req(&rec, "after", "MUTUAL_CANCEL", BUYER_ACCT, 6 * NEAR, "AVAILABLE", "BUYER", w.now);
    let (bs, ss) = (sign("buyer", "dockside/refund-request", &p), sign("supplier", "dockside/refund-request", &p));
    assert_eq!(code(rec.request_refund(&w.ctx(), &p, sigs(Some(&bs), Some(&ss), None))), "NOTHING_ELIGIBLE", "released value is not refundable");
    conserve(&rec);
    // Refund first: the release conjunction fails and no intent can lock the refunding slice.
    let (w, mut rec) = inspection_failed();
    request_if(&w, &mut rec, "first", BUYER_ACCT, 6 * NEAR, "BUYER", "buyer").unwrap();
    let q = intent_payload(&rec, &id("rli", "late"), w.now, "late");
    assert_eq!(code(rec.create_release_intent(&w.ctx(), &q, &sign("buyer", "dockside/release-intent", &q))), "VALUE_LOCKED");
    assert_eq!(rec.ledger.funder(BUYER_ACCT).refund_locked, 6 * NEAR);
    assert_eq!(rec.ledger.funder(BUYER_ACCT).reserved, 0);
    conserve(&rec);
}

#[test]
fn t010_destination_activation_and_cancellation_against_refund_and_release() {
    // Cancellation first, then refund, then activation is blocked by the live refund.
    let (mut w, mut rec, iid) = authorized();
    let d = propose(&w, &mut rec, ALT_DEST, "BUYER", "buyer").unwrap();
    consent_dest(&w, &mut rec, ALT_DEST, "SUPPLIER", "supplier").unwrap();
    let c = cancel_payload(&rec, &iid, "PARTIES_AGREE", w.now, "c");
    consent(&w, &mut rec, &c, "BUYER_APPROVER", "buyer", "b").unwrap();
    consent(&w, &mut rec, &c, "SUPPLIER_SIGNER", "supplier", "s").unwrap();
    let p = refund_req(&rec, "mc", "MUTUAL_CANCEL", OTHER_FUNDER, 4 * NEAR, "AVAILABLE", "SUPPLIER", w.now);
    let (bs, ss) = (sign("buyer", "dockside/refund-request", &p), sign("supplier", "dockside/refund-request", &p));
    rec.request_refund(&w.ctx(), &p, sigs(Some(&bs), Some(&ss), None)).unwrap();
    w.now += DAY;
    assert_eq!(code(rec.activate_destination_change(&w.ctx(), &d)), "VALUE_LOCKED");
    assert_eq!(rec.terms.payout_destination, SUPPLIER_ACCT);
    conserve(&rec);
    // Activation first: the successor intent holds the value; a refund request finds it reserved.
    let (mut w, mut rec, _) = authorized();
    let d = dual_consented(&mut w, &mut rec, ALT_DEST);
    rec.activate_destination_change(&w.ctx(), &d).unwrap();
    let p = refund_req(&rec, "mc2", "MUTUAL_CANCEL", BUYER_ACCT, 6 * NEAR, "AVAILABLE", "BUYER", w.now);
    let (bs, ss) = (sign("buyer", "dockside/refund-request", &p), sign("supplier", "dockside/refund-request", &p));
    assert_eq!(code(rec.request_refund(&w.ctx(), &p, sigs(Some(&bs), Some(&ss), None))), "VALUE_LOCKED");
    assert_eq!(rec.ledger.funder(BUYER_ACCT).reserved, 6 * NEAR);
    conserve(&rec);
}

/* ---------------------------------- T-050 ---------------------------------- */

#[test]
fn t050_every_reason_row_is_rejected_in_every_unresolved_release_state() {
    let rows: [(&str, &str, &str, u128, &str); 9] = [
        ("TRADE_EXPIRY", "BUYER", BUYER_ACCT, 6 * NEAR, "AVAILABLE"),
        ("INSPECTION_FAIL", "BUYER", BUYER_ACCT, 6 * NEAR, "AVAILABLE"),
        ("PERMANENT_HOLD", "RISK_RESOLVER", BUYER_ACCT, 6 * NEAR, "AVAILABLE"),
        ("MUTUAL_CANCEL", "BUYER", BUYER_ACCT, 6 * NEAR, "AVAILABLE"),
        ("PARTIAL_FUNDING_RETURN", "FUNDER", BUYER_ACCT, 6 * NEAR, "PARTIAL"),
        ("EXCESS_FUNDING_RETURN", "FUNDER", OTHER_FUNDER, NEAR, "QUARANTINED"),
        ("BUYER_KEY_LOSS", "BUYER", BUYER_ACCT, 6 * NEAR, "AVAILABLE"),
        ("SUPPLIER_KEY_LOSS", "SUPPLIER", BUYER_ACCT, 6 * NEAR, "AVAILABLE"),
        ("INSPECTOR_KEY_LOSS", "BUYER", BUYER_ACCT, 6 * NEAR, "AVAILABLE"),
    ];
    for st in unresolved_states() {
        let (mut w, mut rec, iid) = authorized();
        rec.fund(&w.as_caller(OTHER_FUNDER).ctx(), NEAR, 1).unwrap();
        force_unresolved(&w, &mut rec, &iid, st);
        let ledger = rec.ledger.clone();
        for (reason, initiator, funder, amount, bucket) in rows {
            let p = refund_req(&rec, &format!("{reason}-{}", st.as_str()), reason, funder, amount, bucket, initiator, w.now);
            let (b, sp, r) = (sign("buyer", "dockside/refund-request", &p), sign("supplier", "dockside/refund-request", &p), sign("risk", "dockside/refund-request", &p));
            let sg = match initiator {
                "FUNDER" => sigs(None, None, None),
                "RISK_RESOLVER" => sigs(None, Some(&sp), Some(&r)),
                "SUPPLIER" => sigs(None, Some(&sp), None),
                _ => sigs(Some(&b), Some(&sp), None),
            };
            let caller = World { now: w.now, caller: funder.to_string() };
            assert_eq!(code(rec.request_refund(&caller.ctx(), &p, sg)), "VALUE_LOCKED", "{reason} in {}", st.as_str());
        }
        assert_eq!(rec.ledger, ledger, "{}", st.as_str());
        w.now += HOUR;
    }
}

#[test]
fn t050_authorized_refund_cannot_execute_while_a_release_is_unresolved() {
    for st in unresolved_states() {
        let (mut w, mut rec, iid) = authorized();
        rec.fund(&w.as_caller(OTHER_FUNDER).ctx(), NEAR, 1).unwrap();
        let ex = refund_req(&rec, "ex", "EXCESS_FUNDING_RETURN", OTHER_FUNDER, NEAR, "QUARANTINED", "FUNDER", w.now);
        let xid = rec.request_refund(&w.as_caller(OTHER_FUNDER).ctx(), &ex, sigs(None, None, None)).unwrap();
        let later = World { now: w.now + HOUR, caller: w.caller.clone() };
        rec.authorize_refund(&later.ctx(), &xid).unwrap();
        force_unresolved(&w, &mut rec, &iid, st);
        w.now = later.now;
        assert_eq!(code(rec.begin_refund(&w.ctx(), &xid)), "VALUE_LOCKED", "{}", st.as_str());
        assert_eq!(rec.refunds[&xid].state, RefundState::Authorized);
        assert_eq!(intent(&rec, &iid).state, st);
    }
}

#[test]
fn t050_inspection_fail_row_mutations() {
    let (w, mut rec) = inspection_failed();
    let base = refund_req(&rec, "m", "INSPECTION_FAIL", BUYER_ACCT, 6 * NEAR, "AVAILABLE", "BUYER", w.now);
    let cases: Vec<(&[&str], J, &str)> = vec![
        (&["reason"], s("INSPECTION_PASS"), "VALIDATION_FAILED"),
        (&["policyRevision"], u(2), "POLICY_MISMATCH"),
        (&["policyId"], s("dockside-refund-v2"), "POLICY_MISMATCH"),
        (&["initiatorRole"], s("RISK_RESOLVER"), "FORBIDDEN"),
        (&["initiatorRole"], s("FUNDER"), "FORBIDDEN"),
        (&["amountYocto"], big(10 * NEAR), "STALE_LEDGER"),
        (&["sourceBucket"], s("PARTIAL"), "STALE_LEDGER"),
        (&["funder"], s("mallory.testnet"), "NOTHING_ELIGIBLE"),
        (&["tradeRevision"], u(2), "STALE_REVISION"),
    ];
    for (path, v, want) in cases {
        let mut p = base.clone();
        set(&mut p, path, v);
        let b = sign("buyer", "dockside/refund-request", &p);
        assert_eq!(code(rec.request_refund(&w.ctx(), &p, sigs(Some(&b), None, None))), want, "{path:?}");
    }
    let b = sign("buyer", "dockside/refund-request", &base);
    let sp = sign("supplier", "dockside/refund-request", &base);
    let r = sign("risk", "dockside/refund-request", &base);
    assert_eq!(code(rec.request_refund(&w.ctx(), &base, sigs(Some(&sp), None, None))), "SIGNATURE_INVALID", "wrong signer capability");
    assert_eq!(code(rec.request_refund(&w.ctx(), &base, sigs(Some(&b), Some(&sp), None))), "VALIDATION_FAILED");
    assert_eq!(code(rec.request_refund(&w.ctx(), &base, sigs(Some(&b), None, Some(&r)))), "VALIDATION_FAILED");
    // PASS inspection: no FAIL evidence.
    let (w2, mut rec2) = ready();
    let p = refund_req(&rec2, "pass", "INSPECTION_FAIL", BUYER_ACCT, 6 * NEAR, "AVAILABLE", "BUYER", w2.now);
    let b2 = sign("buyer", "dockside/refund-request", &p);
    assert_eq!(code(rec2.request_refund(&w2.ctx(), &p, sigs(Some(&b2), None, None))), "NOT_ELIGIBLE");
    // Revocation phase: after EXECUTING no revocation exists.
    let rid = rec.request_refund(&w.ctx(), &base, sigs(Some(&b), None, None)).unwrap();
    let later = World { now: rec.refunds[&rid].deadline.unwrap(), caller: w.caller.clone() };
    assert_eq!(code(rec.begin_refund(&later.ctx(), &rid)), "INVALID_STATE", "no execution during the challenge");
    assert_eq!(risk_authorize(&later, &mut rec, &rid, "risk", "x"), "OK");
    rec.begin_refund(&later.ctx(), &rid).unwrap();
    let rv = refund_intent_payload(&rec, &rid, "revokerRole", "RISK_RESOLVER", later.now, "late");
    assert_eq!(code(rec.revoke_refund(&later.ctx(), &rv, Some(&sign("risk", "dockside/refund-revoke", &rv)))), "INVALID_STATE");
    assert_eq!(rec.refunds[&rid].state, RefundState::Executing);
    assert_eq!(rec.ledger.funder(BUYER_ACCT).refund_locked, 6 * NEAR);
    // Authoritative failed transfer restores the exact bucket.
    rec.complete_refund(&later.ctx(), &rid, false).unwrap();
    assert_eq!(rec.ledger.funder(BUYER_ACCT).available, 6 * NEAR);
    conserve(&rec);
    let _ = IntentState::ValueLocked;
}
