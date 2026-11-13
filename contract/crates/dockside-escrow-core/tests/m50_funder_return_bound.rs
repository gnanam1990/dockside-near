//! Audit of M50: a funder-initiated return (PARTIAL_FUNDING_RETURN, EXCESS_FUNDING_RETURN) that
//! ends without paying (REVOKED, or FAILED because the transfer failed) leaves its refund intent
//! and nonce in the trade record for good. Any account can become a funder of any trade with one
//! minimum deposit, and with a NEP-141 trade asset it can also make its own refunds fail (by
//! leaving the token's storage registration). Without a bound such a stranger grows another
//! party's trade record without limit, at no storage cost to itself: every later call on that
//! trade reads and rewrites the whole record, and the settlement callbacks have a fixed gas floor.
//!
//! The bound: a funder may end at most `MAX_ENDED_FUNDER_RETURNS` of its own returns without
//! payment per trade; a further return request from it is refused with CAPACITY_EXCEEDED.
//! Nobody else's refunds are affected.

mod common;
use common::*;
use dockside_escrow_core::refund::{RefundSignatures, RefundState, MAX_ENDED_FUNDER_RETURNS};
use dockside_escrow_core::TradeRecord;

const NONE: RefundSignatures<'static> = RefundSignatures { buyer: None, supplier: None, risk: None };

fn excess_req(rec: &TradeRecord, label: &str, funder: &str, amount: u128, now: u64) -> J {
    with_header(
        rec,
        vec![
            ("refundIntentId", s(&id("rfd", label))),
            ("policyId", s("dockside-refund-v1")),
            ("policyRevision", u(1)),
            ("reason", s("EXCESS_FUNDING_RETURN")),
            ("funder", s(funder)),
            ("amountYocto", big(amount)),
            ("sourceBucket", s("QUARANTINED")),
            ("initiatorRole", s("FUNDER")),
            ("issuedAt", u(now)),
            ("expiresAt", u(now + 24 * HOUR)),
            ("nonce", s(&nonce(label))),
        ],
    )
}

fn revoke(rec: &TradeRecord, intent: &str, now: u64, n: &str) -> J {
    let r = &rec.refunds[intent];
    with_header(
        rec,
        vec![
            ("refundIntentId", s(intent)),
            ("requestDigest", s(&r.request_digest)),
            ("revokerRole", s("FUNDER")),
            ("issuedAt", u(now)),
            ("expiresAt", u(now + HOUR)),
            ("nonce", s(&nonce(n))),
        ],
    )
}

fn size(rec: &TradeRecord) -> usize {
    borsh::to_vec(rec).expect("borsh").len()
}

/// Buyer funds the trade; the stranger then deposits 2 NEAR, all of it quarantined excess.
fn with_stranger_excess() -> (World, TradeRecord) {
    let (mut w, mut rec) = registered();
    rec.fund(&w.as_caller(BUYER_ACCT).ctx(), 10 * NEAR, 1).unwrap();
    w.now += 5;
    rec.fund(&w.as_caller(OTHER_FUNDER).ctx(), 2 * NEAR, 1).unwrap();
    (w, rec)
}

#[test]
fn a_stranger_funder_cannot_grow_another_trade_by_revoking_its_own_returns_forever() {
    let (mut w, mut rec) = with_stranger_excess();
    let start = size(&rec);
    let mut i = 0;
    loop {
        w.now += 1_000;
        let p = excess_req(&rec, &format!("x{i}"), OTHER_FUNDER, 2 * NEAR, w.now);
        match rec.request_refund(&w.as_caller(OTHER_FUNDER).ctx(), &p, NONE) {
            Ok(id) => {
                let rv = revoke(&rec, &id, w.now, &format!("rv{i}"));
                rec.revoke_refund(&w.as_caller(OTHER_FUNDER).ctx(), &rv, None).unwrap();
            }
            Err(e) => {
                assert_eq!(e.code, "CAPACITY_EXCEEDED");
                break;
            }
        }
        i += 1;
        assert!(i <= MAX_ENDED_FUNDER_RETURNS, "the loop must stop at the bound");
    }
    assert_eq!(i, MAX_ENDED_FUNDER_RETURNS);
    let grown = size(&rec) - start;
    assert!(grown < 4_000, "the stranger added {grown} bytes");
    // The stranger's excess is still its own, quarantined, never available to the trade.
    let f = rec.ledger.funder(OTHER_FUNDER);
    assert_eq!((f.quarantined, f.available, f.refund_locked), (2 * NEAR, 0, 0));
    rec.ledger.check_conservation().unwrap();
    // Only that funder is bounded: the buyer's own excess return still goes through.
    w.now += 1_000;
    rec.fund(&w.as_caller(BUYER_ACCT).ctx(), NEAR, 1).unwrap();
    w.now += 1_000;
    let p = excess_req(&rec, "buyer-x", BUYER_ACCT, NEAR, w.now);
    rec.request_refund(&w.as_caller(BUYER_ACCT).ctx(), &p, NONE).unwrap();
}

#[test]
fn failed_returns_count_toward_the_bound() {
    let (mut w, mut rec) = with_stranger_excess();
    for i in 0..MAX_ENDED_FUNDER_RETURNS {
        w.now += 2 * HOUR;
        let p = excess_req(&rec, &format!("f{i}"), OTHER_FUNDER, 2 * NEAR, w.now);
        let id = rec.request_refund(&w.as_caller(OTHER_FUNDER).ctx(), &p, NONE).unwrap();
        rec.authorize_refund(&w.as_caller("relayer.testnet").ctx(), &id).unwrap();
        rec.begin_refund(&w.ctx(), &id).unwrap();
        // The transfer failed (for a token: the funder left the token's storage registration).
        rec.complete_refund(&w.ctx(), &id, false).unwrap();
        assert_eq!(rec.refunds[&id].state, RefundState::Failed);
    }
    w.now += 2 * HOUR;
    let p = excess_req(&rec, "f-over", OTHER_FUNDER, 2 * NEAR, w.now);
    assert_eq!(code(rec.request_refund(&w.as_caller(OTHER_FUNDER).ctx(), &p, NONE)), "CAPACITY_EXCEEDED");
    let f = rec.ledger.funder(OTHER_FUNDER);
    assert_eq!((f.quarantined, f.refund_locked, f.refunded), (2 * NEAR, 0, 0), "the failed transfers restored the exact bucket");
    rec.ledger.check_conservation().unwrap();
}

#[test]
fn a_return_that_paid_does_not_count() {
    let (mut w, mut rec) = with_stranger_excess();
    for i in 0..(MAX_ENDED_FUNDER_RETURNS + 2) {
        w.now += 2 * HOUR;
        rec.fund(&w.as_caller(OTHER_FUNDER).ctx(), NEAR, 1).unwrap();
        w.now += 2 * HOUR;
        let q = rec.ledger.funder(OTHER_FUNDER).quarantined;
        let p = excess_req(&rec, &format!("p{i}"), OTHER_FUNDER, q, w.now);
        let id = rec.request_refund(&w.as_caller(OTHER_FUNDER).ctx(), &p, NONE).unwrap();
        rec.authorize_refund(&w.as_caller("relayer.testnet").ctx(), &id).unwrap();
        rec.begin_refund(&w.ctx(), &id).unwrap();
        rec.complete_refund(&w.ctx(), &id, true).unwrap();
        assert_eq!(rec.refunds[&id].state, RefundState::Refunded);
    }
}
