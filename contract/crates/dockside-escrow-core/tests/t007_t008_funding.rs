//! T-007 (lower layer) and T-008: trade registration binds both party signatures; exact native
//! funding is accepted per original funder; partial stays unavailable; excess is quarantined by
//! funder; conservation holds after every step. The real testnet deployment half of T-007 is
//! BLOCKED (see scripts/testnet-deploy) and the release half belongs to M04.

mod common;
use common::*;
use dockside_escrow_core::register;

#[test]
fn registration_verifies_both_parties_over_the_recomputed_digest() {
    let t = terms();
    let (w, rec) = registered_with(&t);
    assert_eq!(rec.terms_digest, digest_hex("dockside/trade-revision", &t));
    assert_eq!(rec.terms.buyer.account_id, BUYER_ACCT);
    assert_eq!(rec.terms.payout_destination, SUPPLIER_ACCT);

    let bs = sign("buyer", "dockside/trade-revision", &t);
    let ss = sign("supplier", "dockside/trade-revision", &t);
    // Supplier signature swapped for an unrelated key, or both by the buyer.
    assert_eq!(code(register(&w.ctx(), &t, &bs, &sign("inspector", "dockside/trade-revision", &t))), "SIGNATURE_INVALID");
    assert_eq!(code(register(&w.ctx(), &t, &bs, &bs)), "SIGNATURE_INVALID");
    // Signature for another domain does not verify as a trade revision.
    assert_eq!(code(register(&w.ctx(), &t, &sign("buyer", "dockside/hold-set", &t), &ss)), "SIGNATURE_INVALID");
    // Any material change after signing breaks the digest.
    let mut m = t.clone();
    set(&mut m, &["payout", "destination"], s("attacker.testnet"));
    assert_eq!(code(register(&w.ctx(), &m, &bs, &ss)), "SIGNATURE_INVALID");
    let mut m = t.clone();
    set(&mut m, &["amountYocto"], big(9 * NEAR));
    assert_eq!(code(register(&w.ctx(), &m, &bs, &ss)), "SIGNATURE_INVALID");
}

#[test]
fn registration_fails_closed_on_schema_contract_and_network() {
    let w = World::new();
    let reg = |t: &J| register(&w.ctx(), t, &sign("buyer", "dockside/trade-revision", t), &sign("supplier", "dockside/trade-revision", t));
    let mut x = terms();
    set(&mut x, &["escrowContractId"], s("other-escrow.testnet"));
    assert_eq!(code(reg(&x)), "WRONG_CONTRACT");
    let mut x = terms();
    set(&mut x, &["network"], s("near-mainnet"));
    assert_eq!(code(reg(&x)), "WRONG_NETWORK");
    let mut x = terms();
    set(&mut x, &["asset", "kind"], s("NEP245"));
    assert_eq!(code(reg(&x)), "UNSUPPORTED_ASSET");
    // A NEP-141 asset needs its token account and decimals (M50); the bare kind is malformed.
    let mut x = terms();
    set(&mut x, &["asset", "kind"], s("NEP141"));
    assert_eq!(code(reg(&x)), "VALIDATION_FAILED");
    let mut x = terms();
    set(&mut x, &["complete"], json!({"bool": true}));
    assert_eq!(code(reg(&x)), "UNKNOWN_FIELD");
    let mut x = terms();
    remove(&mut x, "expiresAt");
    assert_eq!(code(reg(&x)), "VALIDATION_FAILED");
    let mut x = terms();
    set(&mut x, &["refundPolicy", "revision"], u(2));
    assert_eq!(code(reg(&x)), "POLICY_MISMATCH");
    let mut x = terms();
    set(&mut x, &["inspector", "publicKey"], s(&pk("buyer")));
    assert_eq!(code(reg(&x)), "SEPARATION_OF_DUTIES");
    let mut x = terms();
    set(&mut x, &["payout", "destination"], s("bad..testnet"));
    assert_eq!(code(reg(&x)), "INVALID_ADDRESS");
    let mut x = terms();
    set(&mut x, &["amountYocto"], u(5));
    assert_eq!(code(reg(&x)), "VALIDATION_FAILED", "u64 where u128 is required is a type error");
    let x = terms_with(NEAR, T0 - 1);
    assert_eq!(code(reg(&x)), "EXPIRED");
}

#[test]
fn exact_funding_is_accepted_and_recorded_per_original_funder() {
    let (mut w, mut rec) = registered();
    let o = rec.fund(&w.as_caller(BUYER_ACCT).ctx(), 10 * NEAR, 1).unwrap();
    assert_eq!((o.accepted, o.quarantined, o.fully_funded), (10 * NEAR, 0, true));
    let f = rec.ledger.funder(BUYER_ACCT);
    assert_eq!((f.funded, f.available, f.partial, f.quarantined), (10 * NEAR, 10 * NEAR, 0, 0));
    assert_eq!(rec.ledger.deposits.len(), 1);
    assert_eq!(rec.ledger.deposits[0].funder, BUYER_ACCT);
    rec.ledger.check_conservation().unwrap();
    let view = dockside_escrow_core::views::ledger(&rec);
    assert_eq!(view["fullyFunded"], json!(true));
    assert_eq!(view["totals"]["available"], json!((10 * NEAR).to_string()));
    assert_eq!(view["conservation"], json!(true));
}

#[test]
fn partial_funding_stays_unavailable_until_complete() {
    let (mut w, mut rec) = registered();
    rec.fund(&w.as_caller(BUYER_ACCT).ctx(), 4 * NEAR, 1).unwrap();
    rec.fund(&w.as_caller(OTHER_FUNDER).ctx(), 3 * NEAR, 1).unwrap();
    assert!(!rec.ledger.fully_funded());
    assert_eq!(rec.ledger.total_available(), 0, "partial funding is never releasable");
    assert_eq!(rec.ledger.funder(BUYER_ACCT).partial, 4 * NEAR);
    assert_eq!(rec.ledger.funder(OTHER_FUNDER).partial, 3 * NEAR);
    // The completing deposit promotes every partial slice for its own funder.
    let o = rec.fund(&w.as_caller(BUYER_ACCT).ctx(), 3 * NEAR, 1).unwrap();
    assert!(o.fully_funded);
    assert_eq!(rec.ledger.funder(BUYER_ACCT).available, 7 * NEAR);
    assert_eq!(rec.ledger.funder(OTHER_FUNDER).available, 3 * NEAR);
    assert_eq!(rec.ledger.total_available(), 10 * NEAR);
    rec.ledger.check_conservation().unwrap();
}

#[test]
fn excess_is_quarantined_by_original_funder() {
    let (mut w, mut rec) = registered();
    rec.fund(&w.as_caller(BUYER_ACCT).ctx(), 8 * NEAR, 1).unwrap();
    w.now += 10;
    let o = rec.fund(&w.as_caller(OTHER_FUNDER).ctx(), 5 * NEAR, 1).unwrap();
    assert_eq!((o.accepted, o.quarantined), (2 * NEAR, 3 * NEAR));
    let other = rec.ledger.funder(OTHER_FUNDER);
    assert_eq!((other.available, other.quarantined, other.excess_detected_at), (2 * NEAR, 3 * NEAR, Some(T0 + 10)));
    assert_eq!(rec.ledger.funder(BUYER_ACCT).quarantined, 0, "excess is attributed only to its own funder");
    // Any later deposit to a fully funded trade is wholly quarantined.
    let o = rec.fund(&w.as_caller(BUYER_ACCT).ctx(), NEAR, 1).unwrap();
    assert_eq!((o.accepted, o.quarantined), (0, NEAR));
    assert_eq!(rec.ledger.total_available(), 10 * NEAR, "quarantine never becomes available");
    assert_eq!(rec.ledger.committed(), 10 * NEAR);
    rec.ledger.check_conservation().unwrap();
}

#[test]
fn funding_rejects_dust_and_expired_trades() {
    let (mut w, mut rec) = registered();
    assert_eq!(code(rec.fund(&w.ctx(), 10, 1_000)), "INVALID_AMOUNT");
    assert_eq!(code(rec.fund(&w.ctx(), 0, 0)), "INVALID_AMOUNT");
    w.now = rec.terms.expires_at;
    assert_eq!(code(rec.fund(&w.ctx(), NEAR, 1)), "EXPIRED");
    assert!(rec.ledger.deposits.is_empty());
}

#[test]
fn conservation_property_over_random_deposit_sequences() {
    // Deterministic pseudo-random walk (xorshift) across funders and amounts.
    let funders = [BUYER_ACCT, OTHER_FUNDER, "third-party.testnet"];
    let mut x: u64 = 0x9e3779b97f4a7c15;
    for _round in 0..60 {
        let (mut w, mut rec) = registered();
        let mut total = 0u128;
        for _ in 0..8 {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            let who = funders[(x % 3) as usize];
            let amt = ((x >> 8) % (6 * NEAR as u64 / 1_000_000)) as u128 * 1_000_000 + 1;
            rec.fund(&w.as_caller(who).ctx(), amt, 1).unwrap();
            total += amt;
            rec.ledger.check_conservation().unwrap();
            let committed = rec.ledger.committed();
            assert!(committed <= rec.ledger.required);
            let q: u128 = rec.ledger.funders.values().map(|f| f.quarantined).sum();
            assert_eq!(committed + q, total);
            if !rec.ledger.fully_funded() {
                assert_eq!(rec.ledger.total_available(), 0);
            }
        }
    }
}
