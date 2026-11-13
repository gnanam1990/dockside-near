//! M50: the NEP-141 rail and the network guard, on the host.
//!
//! A trade names its asset in the signed terms: native NEAR, or one NEP-141 token contract with
//! its decimals. These tests drive the same core the wasm contract runs and check that
//!
//! * the token and its decimals are bound by the revision digest and by the exact field set,
//! * only the named token contract can credit a trade, for the active revision digest, and a
//!   wrong token, wrong digest, wrong asset kind or over-cap deposit changes nothing,
//! * buckets, holds, refunds and the destination change behave the same for both assets,
//! * a release cannot lock value for a payee the token has not reported as registered,
//! * `near-mainnet` is accepted only with non-zero caps and its own signed profile.

mod common;
use common::release::*;
use common::*;
use dockside_escrow_core::refund::{RefundSignatures, RefundState};
use dockside_escrow_core::release::IntentState;
use dockside_escrow_core::terms::Asset;
use dockside_escrow_core::trade::{MAINNET_DEFAULT_MAX_NATIVE, MAINNET_DEFAULT_MAX_NEP141};
use dockside_escrow_core::{funding_message, views, Ctx, Limits, TradeRecord, DEFAULT_MIN_DEPOSIT_NEP141};

const TOKEN: &str = "usdc.fakes.testnet";
const OTHER_TOKEN: &str = "other-token.testnet";
const USDC: u128 = 1_000_000;
const MIN: u128 = DEFAULT_MIN_DEPOSIT_NEP141;
const DAY: u64 = 24 * HOUR;
const NONE: RefundSignatures<'static> = RefundSignatures { buyer: None, supplier: None, risk: None };

fn nep141(token: &str, decimals: u64) -> J {
    st(vec![("kind", s("NEP141")), ("network", s(NETWORK)), ("tokenAccountId", s(token)), ("decimals", u(decimals))])
}

/// Terms for `amount` base units of `TOKEN` (6 decimals), with the real evidence policy digest.
fn token_terms(amount: u128) -> J {
    let mut t = evidence_terms();
    set(&mut t, &["asset"], nep141(TOKEN, 6));
    set(&mut t, &["amountYocto"], big(amount));
    t
}

fn reg(w: &World, t: &J) -> Result<TradeRecord, dockside_escrow_core::Error> {
    dockside_escrow_core::register(&w.ctx(), t, &sign("buyer", "dockside/trade-revision", t), &sign("supplier", "dockside/trade-revision", t))
}

fn token_trade(amount: u128) -> (World, TradeRecord) {
    let (w, mut rec) = registered_with(&token_terms(amount));
    rec.register_evidence_policy(&common::evidence::policy()).expect("policy registers");
    (w, rec)
}

/// `ft_on_transfer` as the token contract delivers it: the predecessor is the token.
fn pay_in(w: &mut World, rec: &mut TradeRecord, token: &str, sender: &str, amount: u128) -> Result<dockside_escrow_core::ledger::DepositOutcome, dockside_escrow_core::Error> {
    let who = w.caller.clone();
    let digest = rec.terms_digest.clone();
    let r = rec.fund_token(&w.as_caller(token).ctx(), sender, &digest, amount, MIN);
    w.caller = who;
    r
}

/// Fully funded (3 + 2 USDC from two funders), manifest accepted, inspector PASS.
fn token_ready() -> (World, TradeRecord) {
    let (mut w, mut rec) = token_trade(5 * USDC);
    pay_in(&mut w, &mut rec, TOKEN, BUYER_ACCT, 3 * USDC).unwrap();
    pay_in(&mut w, &mut rec, TOKEN, OTHER_FUNDER, 2 * USDC).unwrap();
    attest_and_inspect(&w, &mut rec, 1, "PASS", "r1");
    (w, rec)
}

fn successor(rec: &TradeRecord, base: &J, dest: &str) -> J {
    let mut t = base.clone();
    set(&mut t, &["revision"], u(rec.terms.revision + 1));
    set(&mut t, &["predecessorDigest"], s(&rec.terms_digest));
    set(&mut t, &["payout", "destination"], s(dest));
    t
}

/* ------------------------------- signed terms ------------------------------- */

#[test]
fn nep141_asset_is_part_of_the_signed_terms() {
    let t = token_terms(5 * USDC);
    let (w, rec) = registered_with(&t);
    assert_eq!(rec.terms.asset, Asset::Nep141 { token_account_id: TOKEN.into(), decimals: 6 });
    assert_eq!(rec.terms.amount_yocto, 5 * USDC);
    assert_eq!(rec.ledger.required, 5 * USDC);
    let v = views::ledger(&rec);
    assert_eq!(v["asset"], json!({"kind": "NEP141", "network": NETWORK, "tokenAccountId": TOKEN, "decimals": 6}));
    assert_eq!(views::trade(&rec, w.now)["asset"]["tokenAccountId"], TOKEN);

    // The token and its decimals are covered by the revision digest both parties signed.
    let (bs, ss) = (sign("buyer", "dockside/trade-revision", &t), sign("supplier", "dockside/trade-revision", &t));
    for (path, value) in [(["asset", "tokenAccountId"], s(OTHER_TOKEN)), (["asset", "decimals"], u(18)), (["asset", "kind"], s("NEAR_NATIVE"))] {
        let mut m = t.clone();
        set(&mut m, &path, value);
        let r = dockside_escrow_core::register(&w.ctx(), &m, &bs, &ss);
        assert!(matches!(code(r), "SIGNATURE_INVALID" | "UNKNOWN_FIELD"), "{path:?}");
    }
    // A native trade is unchanged: same view, no token.
    let (_, native) = registered();
    assert_eq!(native.terms.asset, Asset::NearNative);
    assert_eq!(views::ledger(&native)["asset"], json!({"kind": "NEAR_NATIVE", "network": NETWORK}));
}

#[test]
fn asset_schema_is_exact_per_kind_and_fails_closed() {
    let w = World::new();
    let with = |asset: J| {
        let mut t = token_terms(5 * USDC);
        set(&mut t, &["asset"], asset);
        code(reg(&w, &t))
    };
    // NEP-141 without a token or decimals, or a native asset that smuggles a token.
    assert_eq!(with(st(vec![("kind", s("NEP141")), ("network", s(NETWORK))])), "VALIDATION_FAILED");
    assert_eq!(with(st(vec![("kind", s("NEP141")), ("network", s(NETWORK)), ("tokenAccountId", s(TOKEN))])), "VALIDATION_FAILED");
    assert_eq!(
        with(st(vec![("kind", s("NEAR_NATIVE")), ("network", s(NETWORK)), ("tokenAccountId", s(TOKEN)), ("decimals", u(6))])),
        "UNKNOWN_FIELD"
    );
    assert_eq!(with(st(vec![("kind", s("NEP245")), ("network", s(NETWORK))])), "UNSUPPORTED_ASSET");
    assert_eq!(with(st(vec![("network", s(NETWORK))])), "VALIDATION_FAILED");
    assert_eq!(with(s("NEP141")), "VALIDATION_FAILED");
    // Wrong network, bad token ids, the escrow itself as its own asset, absurd decimals.
    assert_eq!(with(st(vec![("kind", s("NEP141")), ("network", s("near-mainnet")), ("tokenAccountId", s(TOKEN)), ("decimals", u(6))])), "WRONG_NETWORK");
    assert_eq!(with(nep141("usdc.near", 6)), "INVALID_ADDRESS");
    assert_eq!(with(nep141("Bad..Token", 6)), "INVALID_ADDRESS");
    assert_eq!(with(nep141(CONTRACT, 6)), "INVALID_ADDRESS");
    assert_eq!(with(nep141(TOKEN, 25)), "VALIDATION_FAILED");
    // An implicit (64 hex) token account is a valid NEP-141 id, as Circle's USDC is.
    assert_eq!(with(nep141(&"3e".repeat(32), 6)), "OK");
    assert_eq!(with(nep141(TOKEN, 6)), "OK");
}

/* ---------------------------------- funding ---------------------------------- */

#[test]
fn only_the_named_token_contract_credits_the_trade() {
    let (mut w, mut rec) = token_trade(5 * USDC);
    let before = rec.clone();
    // Another token contract, or any account calling `ft_on_transfer` directly.
    assert_eq!(code(pay_in(&mut w, &mut rec, OTHER_TOKEN, BUYER_ACCT, 5 * USDC)), "ASSET_MISMATCH");
    assert_eq!(code(pay_in(&mut w, &mut rec, BUYER_ACCT, BUYER_ACCT, 5 * USDC)), "ASSET_MISMATCH");
    // Native NEAR never funds a token trade.
    assert_eq!(code(rec.fund(&w.as_caller(BUYER_ACCT).ctx(), 5 * NEAR, 1)), "ASSET_MISMATCH");
    let digest = rec.terms_digest.clone();
    assert_eq!(code(rec.fund_exact(&w.ctx(), &digest, 5 * NEAR, 1)), "ASSET_MISMATCH");
    // A stale or foreign revision digest, a malformed one, dust.
    w.as_caller(TOKEN);
    assert_eq!(code(rec.fund_token(&w.ctx(), BUYER_ACCT, &"ab".repeat(32), 5 * USDC, MIN)), "STALE_REVISION");
    assert_eq!(code(rec.fund_token(&w.ctx(), BUYER_ACCT, "nope", 5 * USDC, MIN)), "VALIDATION_FAILED");
    assert_eq!(code(rec.fund_token(&w.ctx(), BUYER_ACCT, &digest, MIN - 1, MIN)), "INVALID_AMOUNT");
    assert_eq!(rec, before, "a refused deposit changes nothing");

    // The named token credits the sender it reports, not itself.
    let o = rec.fund_token(&w.ctx(), BUYER_ACCT, &digest, 5 * USDC, MIN).unwrap();
    assert!(o.fully_funded && o.accepted == 5 * USDC && o.quarantined == 0);
    assert_eq!(rec.ledger.funder(BUYER_ACCT).available, 5 * USDC);
    assert_eq!(rec.ledger.funder(TOKEN).funded, 0);
    assert_eq!(rec.ledger.deposits[0].funder, BUYER_ACCT);

    // A native trade refuses tokens from any contract.
    let (mut w, mut native) = registered();
    let d = native.terms_digest.clone();
    assert_eq!(code(native.fund_token(&w.as_caller(TOKEN).ctx(), BUYER_ACCT, &d, 5 * USDC, MIN)), "ASSET_MISMATCH");
    assert!(native.ledger.deposits.is_empty());
}

#[test]
fn funding_message_decides_between_funding_and_an_unexpected_asset() {
    let trade = id("trd", "trade-1");
    let digest = "ab".repeat(32);
    let ok = funding_message(&format!(r#"{{"tradeId":"{trade}","termsDigest":"{digest}"}}"#)).unwrap().unwrap();
    assert_eq!((ok.trade_id.as_str(), ok.terms_digest.as_str()), (trade.as_str(), digest.as_str()));
    // Not a funding message: recorded as an unexpected asset by the receiver, never credited.
    for msg in ["", "hello", "[]", "42", "{}", r#"{"memo":"invoice 7"}"#, r#"{"termsDigest":"ab"}"#] {
        assert!(funding_message(msg).is_none(), "{msg}");
    }
    // A funding message that is malformed is refused (the receiver returns the whole amount).
    for msg in [
        format!(r#"{{"tradeId":"{trade}"}}"#),
        format!(r#"{{"tradeId":"{trade}","termsDigest":"{digest}","extra":1}}"#),
        format!(r#"{{"tradeId":"{trade}","termsDigest":"AB"}}"#),
        format!(r#"{{"tradeId":"trade-1","termsDigest":"{digest}"}}"#),
        format!(r#"{{"tradeId":7,"termsDigest":"{digest}"}}"#),
    ] {
        assert_eq!(code(funding_message(&msg).expect("a funding message")), "VALIDATION_FAILED", "{msg}");
    }
}

#[test]
fn token_buckets_follow_the_native_rules() {
    // The same deposit sequence on a native and a token trade gives the same ledger.
    let (mut wn, mut native) = registered_with(&{
        let mut t = evidence_terms();
        set(&mut t, &["amountYocto"], big(5 * USDC));
        t
    });
    let (mut wt, mut token) = token_trade(5 * USDC);
    for (who, amount) in [(BUYER_ACCT, 2 * USDC), (OTHER_FUNDER, USDC), (BUYER_ACCT, 3 * USDC), (OTHER_FUNDER, USDC)] {
        let a = native.fund(&wn.as_caller(who).ctx(), amount, MIN).unwrap();
        let b = pay_in(&mut wt, &mut token, TOKEN, who, amount).unwrap();
        assert_eq!(a, b);
        token.ledger.check_conservation().unwrap();
    }
    assert_eq!(native.ledger, token.ledger);
    let b = token.ledger.funder(BUYER_ACCT);
    // 2 partial, then the completing deposit: 2 of its 3 accepted, 1 quarantined for the same funder.
    assert_eq!((b.available, b.quarantined, b.funded), (4 * USDC, USDC, 5 * USDC));
    let o = token.ledger.funder(OTHER_FUNDER);
    assert_eq!((o.available, o.quarantined, o.funded), (USDC, USDC, 2 * USDC));
    assert!(token.ledger.fully_funded());
    assert_eq!(token.ledger.held(), 7 * USDC);
}

/* ------------------------------ payee registration ------------------------------ */

#[test]
fn release_cannot_lock_value_for_an_unregistered_payee() {
    let (w, mut rec) = token_ready();
    let before = rec.clone();
    let p = intent_payload(&rec, &id("rli", "main"), w.now, "main");
    let sig = sign("buyer", "dockside/release-intent", &p);
    assert_eq!(code(rec.create_release_intent(&w.ctx(), &p, &sig)), "PAYEE_NOT_REGISTERED");
    assert_eq!(rec, before, "nothing was locked and the nonce was not consumed");

    // Only the active (or pending) destination can be checked, and only on a token trade.
    assert_eq!(code(rec.payee_check_target("attacker.testnet")), "DESTINATION_MISMATCH");
    assert_eq!(code(rec.payee_check_target(BUYER_ACCT)), "DESTINATION_MISMATCH");
    assert_eq!(rec.payee_check_target(SUPPLIER_ACCT).unwrap(), TOKEN);
    assert_eq!(code(rec.record_payee_storage("attacker.testnet", true)), "DESTINATION_MISMATCH");
    // The token says "not registered": still refused.
    assert_eq!(rec.record_payee_storage(SUPPLIER_ACCT, false), Ok(false));
    assert_eq!(code(rec.create_release_intent(&w.ctx(), &p, &sig)), "PAYEE_NOT_REGISTERED");

    assert_eq!(rec.record_payee_storage(SUPPLIER_ACCT, true), Ok(true));
    assert_eq!(views::trade(&rec, w.now)["payeeStorage"], json!([SUPPLIER_ACCT]));
    let (intent_id, joined) = rec.create_release_intent(&w.ctx(), &p, &sig).unwrap();
    assert!(!joined);
    assert_eq!(rec.ledger.funder(BUYER_ACCT).reserved, 3 * USDC);
    assert_eq!(rec.ledger.funder(OTHER_FUNDER).reserved, 2 * USDC);
    assert_eq!(intent(&rec, &intent_id).state, IntentState::ValueLocked);

    // A later "not registered" answer withdraws the confirmation for the next intent.
    assert_eq!(rec.record_payee_storage(SUPPLIER_ACCT, false), Ok(false));
    assert!(rec.payee_storage.is_empty());

    // Native payouts need no registration and have nothing to check.
    let (w, mut native) = ready();
    assert_eq!(code(native.payee_check_target(SUPPLIER_ACCT)), "ASSET_MISMATCH");
    create(&w, &mut native, "native");
}

#[test]
fn token_release_settles_or_rolls_back_exactly() {
    let (w, mut rec) = token_ready();
    rec.record_payee_storage(SUPPLIER_ACCT, true).unwrap();
    let i = create(&w, &mut rec, "main");
    assert_eq!(approve(&w, &mut rec, &i, "main"), "OK");
    let locked = rec.ledger.clone();

    // A failed ft_transfer (payee unregistered meanwhile): FAILED, reserved -> available, exact slices.
    let (to, amount, attempt) = rec.execute_release(&w.ctx(), &i).unwrap();
    assert_eq!((to.as_str(), amount), (SUPPLIER_ACCT, 5 * USDC));
    rec.complete_release(&w.ctx(), &i, &attempt, false).unwrap();
    assert_eq!(intent(&rec, &i).state, IntentState::Failed);
    let b = rec.ledger.funder(BUYER_ACCT);
    assert_eq!((b.available, b.reserved, b.released), (3 * USDC, 0, 0));
    assert_eq!(rec.ledger.funder(OTHER_FUNDER).available, 2 * USDC);
    assert_eq!(rec.ledger.held(), 5 * USDC);
    rec.ledger.check_conservation().unwrap();

    // A new attestation, intent and approval: PAID, reserved -> released.
    attest_and_inspect(&w, &mut rec, 2, "PASS", "r2");
    let j = create(&w, &mut rec, "second");
    assert_eq!(rec.ledger.funder(BUYER_ACCT).reserved, locked.funder(BUYER_ACCT).reserved);
    assert_eq!(approve(&w, &mut rec, &j, "second"), "OK");
    let (_, amount, attempt) = rec.execute_release(&w.ctx(), &j).unwrap();
    assert_eq!(amount, 5 * USDC);
    // A receipt for another attempt is not accepted.
    assert_eq!(code(rec.complete_release(&w.ctx(), &j, "rla_00000000000000000000000000000000", true)), "VALIDATION_FAILED");
    rec.complete_release(&w.ctx(), &j, &attempt, true).unwrap();
    assert_eq!(intent(&rec, &j).state, IntentState::Paid);
    assert_eq!(rec.ledger.funder(BUYER_ACCT).released, 3 * USDC);
    assert_eq!(rec.ledger.funder(OTHER_FUNDER).released, 2 * USDC);
    assert_eq!(rec.ledger.held(), 0);
    // Paid once: nothing can be executed or completed again.
    assert_ne!(code(rec.execute_release(&w.ctx(), &j)), "OK");
    assert_ne!(code(rec.complete_release(&w.ctx(), &j, &attempt, true)), "OK");
}

#[test]
fn hold_blocks_a_token_release_until_the_risk_principal_resolves_it() {
    let (w, mut rec) = token_ready();
    rec.record_payee_storage(SUPPLIER_ACCT, true).unwrap();
    set_hold(&w, &mut rec, "h1", "POLICY_SETTER", 7 * DAY);
    let i = create(&w, &mut rec, "main");
    assert!(rec.release_blockers(w.now).contains(&"HOLD_ACTIVE"));
    assert_eq!(code(rec.execute_release(&w.ctx(), &i)), "HOLD_ACTIVE");
    assert_eq!(resolve(&w, &mut rec, "h1", "RELEASE_HOLD", "h1"), "OK");
    assert_eq!(approve(&w, &mut rec, &i, "main"), "OK");
    let (_, amount, attempt) = rec.execute_release(&w.ctx(), &i).unwrap();
    rec.complete_release(&w.ctx(), &i, &attempt, true).unwrap();
    assert_eq!((amount, rec.ledger.held()), (5 * USDC, 0));
}

/* ----------------------------------- refunds ----------------------------------- */

#[test]
fn token_refunds_return_to_the_original_funder_and_a_failed_transfer_rolls_back() {
    let (mut w, mut rec) = token_trade(5 * USDC);
    // The buyer sends 6 USDC: 5 accepted, 1 quarantined.
    pay_in(&mut w, &mut rec, TOKEN, BUYER_ACCT, 6 * USDC).unwrap();
    let cancel = refund_req(&rec, "cancel", "MUTUAL_CANCEL", BUYER_ACCT, 5 * USDC, "AVAILABLE", "BUYER", w.now);
    let sigs = (sign("buyer", "dockside/refund-request", &cancel), sign("supplier", "dockside/refund-request", &cancel));
    let cancel_id = rec
        .request_refund(&w.ctx(), &cancel, RefundSignatures { buyer: Some(&sigs.0), supplier: Some(&sigs.1), risk: None })
        .unwrap();
    let excess = refund_req(&rec, "excess", "EXCESS_FUNDING_RETURN", BUYER_ACCT, USDC, "QUARANTINED", "FUNDER", w.now);
    // The excess return is the funder's own request: the supplier, or the token, cannot make it.
    assert_eq!(code(rec.request_refund(&w.as_caller(SUPPLIER_ACCT).ctx(), &excess, NONE)), "FORBIDDEN");
    assert_eq!(code(rec.request_refund(&w.as_caller(TOKEN).ctx(), &excess, NONE)), "FORBIDDEN");
    let excess_id = rec.request_refund(&w.as_caller(BUYER_ACCT).ctx(), &excess, NONE).unwrap();
    // Funding is frozen while accepted value is being refunded.
    assert_eq!(code(pay_in(&mut w, &mut rec, TOKEN, OTHER_FUNDER, USDC)), "FUNDING_FROZEN");

    w.now += 2 * HOUR;
    for id in [&cancel_id, &excess_id] {
        rec.authorize_refund(&w.ctx(), id).unwrap();
    }
    // First attempt fails at the token contract: the exact bucket is restored.
    let (to, amount) = rec.begin_refund(&w.ctx(), &cancel_id).unwrap();
    assert_eq!((to.as_str(), amount), (BUYER_ACCT, 5 * USDC));
    rec.complete_refund(&w.ctx(), &cancel_id, false).unwrap();
    assert_eq!(rec.refunds[&cancel_id].state, RefundState::Failed);
    let b = rec.ledger.funder(BUYER_ACCT);
    assert_eq!((b.available, b.refund_locked, b.refunded, b.quarantined), (5 * USDC, USDC, 0, 0));
    rec.ledger.check_conservation().unwrap();

    // The excess goes back to the same funder, exactly once.
    let (to, amount) = rec.begin_refund(&w.ctx(), &excess_id).unwrap();
    assert_eq!((to.as_str(), amount), (BUYER_ACCT, USDC));
    rec.complete_refund(&w.ctx(), &excess_id, true).unwrap();
    assert_eq!(code(rec.begin_refund(&w.ctx(), &excess_id)), "INVALID_STATE");
    assert_eq!(code(rec.complete_refund(&w.ctx(), &excess_id, true)), "INVALID_STATE");
    assert_eq!(rec.ledger.funder(BUYER_ACCT).refunded, USDC);
    assert_eq!(rec.ledger.held(), 5 * USDC);

    // A fresh MUTUAL_CANCEL request settles the rest.
    let again = refund_req(&rec, "cancel-2", "MUTUAL_CANCEL", BUYER_ACCT, 5 * USDC, "AVAILABLE", "BUYER", w.now);
    let sigs = (sign("buyer", "dockside/refund-request", &again), sign("supplier", "dockside/refund-request", &again));
    let again_id = rec
        .request_refund(&w.ctx(), &again, RefundSignatures { buyer: Some(&sigs.0), supplier: Some(&sigs.1), risk: None })
        .unwrap();
    w.now += 2 * HOUR;
    rec.authorize_refund(&w.ctx(), &again_id).unwrap();
    rec.begin_refund(&w.ctx(), &again_id).unwrap();
    rec.complete_refund(&w.ctx(), &again_id, true).unwrap();
    let b = rec.ledger.funder(BUYER_ACCT);
    assert_eq!((b.funded, b.refunded, b.available, b.quarantined, b.refund_locked), (6 * USDC, 6 * USDC, 0, 0, 0));
    assert_eq!(rec.ledger.held(), 0);
    rec.ledger.check_conservation().unwrap();
}

/* ------------------------------ successor revisions ------------------------------ */

#[test]
fn a_successor_revision_can_never_change_the_asset() {
    let base = token_terms(5 * USDC);
    let (w, mut rec) = token_ready();
    for asset in [nep141(OTHER_TOKEN, 6), nep141(TOKEN, 18), st(vec![("kind", s("NEAR_NATIVE")), ("network", s(NETWORK))])] {
        let mut t = successor(&rec, &base, ALT_DEST);
        set(&mut t, &["asset"], asset.clone());
        assert_eq!(code(rec.propose_destination_change(&w.ctx(), &t, "SUPPLIER", &sign("supplier", "dockside/trade-revision", &t))), "IMMUTABLE_FIELD");
        // A key rebinding that also swaps the asset.
        let mut k = base.clone();
        set(&mut k, &["revision"], u(2));
        set(&mut k, &["predecessorDigest"], s(&rec.terms_digest));
        set(&mut k, &["inspector", "keyVersionId"], s(&id("key", "inspector-2")));
        set(&mut k, &["inspector", "publicKey"], s(&pk("inspector-2")));
        set(&mut k, &["asset"], asset);
        assert_eq!(code(rec.propose_key_rebinding(&w.ctx(), &k, "BUYER", &sign("buyer", "dockside/trade-revision", &k))), "IMMUTABLE_FIELD");
    }
    // The amount is as immutable as it was.
    let mut t = successor(&rec, &base, ALT_DEST);
    set(&mut t, &["amountYocto"], big(6 * USDC));
    assert_eq!(code(rec.propose_destination_change(&w.ctx(), &t, "SUPPLIER", &sign("supplier", "dockside/trade-revision", &t))), "IMMUTABLE_FIELD");
}

#[test]
fn destination_change_needs_the_new_payee_registered_before_the_lock_moves() {
    let base = token_terms(5 * USDC);
    let (mut w, mut rec) = token_ready();
    rec.record_payee_storage(SUPPLIER_ACCT, true).unwrap();
    let live = create(&w, &mut rec, "main");

    let t = successor(&rec, &base, ALT_DEST);
    let digest = rec.propose_destination_change(&w.ctx(), &t, "SUPPLIER", &sign("supplier", "dockside/trade-revision", &t)).unwrap();
    rec.consent_destination_change(&w.ctx(), &digest, "BUYER", &sign("buyer", "dockside/trade-revision", &t)).unwrap();
    w.now += rec.terms.destination_change_delay_ms;

    // The live intent's lock would move to an unconfirmed payee: refused, nothing changes.
    let before = rec.clone();
    assert_eq!(code(rec.activate_destination_change(&w.ctx(), &digest)), "PAYEE_NOT_REGISTERED");
    assert_eq!(rec, before);
    // The pending destination can now be checked; a third account still cannot.
    assert_eq!(code(rec.record_payee_storage("attacker.testnet", true)), "DESTINATION_MISMATCH");
    rec.record_payee_storage(ALT_DEST, true).unwrap();
    assert_eq!(rec.payee_storage.len(), 2);

    let (new_digest, successor_intent) = rec.activate_destination_change(&w.ctx(), &digest).unwrap();
    assert_eq!(new_digest, digest);
    let sid = successor_intent.expect("the lock moved to a successor intent");
    assert_eq!(intent(&rec, &live).state, IntentState::SupersededPreSubmit);
    assert_eq!(intent(&rec, &sid).destination, ALT_DEST);
    assert_eq!(rec.terms.asset, Asset::Nep141 { token_account_id: TOKEN.into(), decimals: 6 });
    // Only the active destination stays confirmed; the old one cannot be checked any more.
    assert_eq!(rec.payee_storage.iter().cloned().collect::<Vec<_>>(), vec![ALT_DEST.to_string()]);
    assert_eq!(code(rec.record_payee_storage(SUPPLIER_ACCT, true)), "DESTINATION_MISMATCH");
    assert_eq!(rec.ledger.held(), 5 * USDC);
    rec.ledger.check_conservation().unwrap();
}

/* ------------------------------- caps and networks ------------------------------- */

fn reg_on(w: &World, limits: &Limits, t: &J) -> Result<TradeRecord, dockside_escrow_core::Error> {
    dockside_escrow_core::register(&w.ctx_with(limits), t, &sign("buyer", "dockside/trade-revision", t), &sign("supplier", "dockside/trade-revision", t))
}

/// `pay_in` on a deployment with `limits`.
fn pay_in_on(w: &mut World, limits: &Limits, rec: &mut TradeRecord, sender: &str, amount: u128) -> &'static str {
    let who = w.caller.clone();
    let digest = rec.terms_digest.clone();
    let r = rec.fund_token(&w.as_caller(TOKEN).ctx_with(limits), sender, &digest, amount, MIN);
    w.caller = who;
    code(r)
}

#[test]
fn cap_bounds_the_trade_amount_and_the_value_a_trade_holds() {
    let mut w = World::new();
    let limits = Limits { max_native: 5 * NEAR, max_nep141: 6 * USDC, nep141_token: None };
    // Registration above the cap.
    assert_eq!(code(reg_on(&w, &limits, &token_terms(6 * USDC + 1))), "CAP_EXCEEDED");
    assert_eq!(code(reg_on(&w, &limits, &terms_with(5 * NEAR + 1, T0 + 30 * 24 * HOUR))), "CAP_EXCEEDED");
    let mut native = reg_on(&w, &limits, &terms_with(5 * NEAR, T0 + 30 * 24 * HOUR)).unwrap();
    let mut rec = reg_on(&w, &limits, &token_terms(5 * USDC)).unwrap();

    // 5 accepted + 1 excess is exactly the cap; one more unit is not.
    assert_eq!(pay_in_on(&mut w, &limits, &mut rec, BUYER_ACCT, 5 * USDC), "OK");
    let before = rec.clone();
    assert_eq!(pay_in_on(&mut w, &limits, &mut rec, OTHER_FUNDER, USDC + 1), "CAP_EXCEEDED");
    assert_eq!(pay_in_on(&mut w, &limits, &mut rec, OTHER_FUNDER, u128::MAX), "CAP_EXCEEDED");
    assert_eq!(rec, before, "an over-cap deposit changes nothing");
    assert_eq!(pay_in_on(&mut w, &limits, &mut rec, OTHER_FUNDER, USDC), "OK");
    assert_eq!(rec.ledger.held(), 6 * USDC);
    assert_eq!(pay_in_on(&mut w, &limits, &mut rec, OTHER_FUNDER, MIN), "CAP_EXCEEDED");
    // Without a cap the same deposit is accepted (and quarantined): the cap is what refused it.
    let mut uncapped = rec.clone();
    assert_eq!(code(pay_in(&mut w, &mut uncapped, TOKEN, OTHER_FUNDER, MIN)), "OK");

    // The native cap is independent of the token cap.
    assert_eq!(code(native.fund(&w.as_caller(BUYER_ACCT).ctx_with(&limits), 5 * NEAR + 1, 1)), "CAP_EXCEEDED");
    native.fund(&w.as_caller(BUYER_ACCT).ctx_with(&limits), 5 * NEAR, 1).unwrap();
    assert_eq!(code(native.fund(&w.as_caller(BUYER_ACCT).ctx_with(&limits), NEAR, 1)), "CAP_EXCEEDED");

    // Value that left the escrow frees room again.
    let excess = refund_req(&rec, "excess", "EXCESS_FUNDING_RETURN", OTHER_FUNDER, USDC, "QUARANTINED", "FUNDER", w.now);
    let rid = rec.request_refund(&w.as_caller(OTHER_FUNDER).ctx_with(&limits), &excess, NONE).unwrap();
    w.now += 2 * HOUR;
    rec.authorize_refund(&w.ctx_with(&limits), &rid).unwrap();
    rec.begin_refund(&w.ctx_with(&limits), &rid).unwrap();
    rec.complete_refund(&w.ctx_with(&limits), &rid, true).unwrap();
    assert_eq!(rec.ledger.held(), 5 * USDC);
    assert_eq!(pay_in_on(&mut w, &limits, &mut rec, OTHER_FUNDER, USDC), "OK");
}

#[test]
fn a_pinned_token_is_the_only_nep141_asset_a_deployment_accepts() {
    let w = World::new();
    let limits = Limits { max_native: 0, max_nep141: 0, nep141_token: Some((TOKEN.into(), 6)) };
    assert_eq!(code(reg_on(&w, &limits, &token_terms(5 * USDC))), "OK");
    let mut other = token_terms(5 * USDC);
    set(&mut other, &["asset"], nep141(OTHER_TOKEN, 6));
    assert_eq!(code(reg_on(&w, &limits, &other)), "UNSUPPORTED_ASSET");
    let mut decimals = token_terms(5 * USDC);
    set(&mut decimals, &["asset"], nep141(TOKEN, 18));
    assert_eq!(code(reg_on(&w, &limits, &decimals)), "UNSUPPORTED_ASSET");
    // Native trades are not affected by the pin.
    assert_eq!(code(reg_on(&w, &limits, &terms())), "OK");
}

#[test]
fn network_guard_accepts_mainnet_only_with_non_zero_caps() {
    let usdc = || Some(("17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1".to_string(), 6));
    // Testnet: no caps unless given.
    assert_eq!(Limits::configure("near-testnet", None, None, None), Ok(Limits::default()));
    assert_eq!(Limits::configure("near-testnet", Some(NEAR), Some(USDC), None).unwrap().max_nep141, USDC);
    // Mainnet: omitted caps take the defaults (5 NEAR, 25 USDC in base units); zero is refused.
    let m = Limits::configure("near-mainnet", None, None, usdc()).unwrap();
    assert_eq!((m.max_native, m.max_nep141), (MAINNET_DEFAULT_MAX_NATIVE, MAINNET_DEFAULT_MAX_NEP141));
    assert_eq!((m.max_native, m.max_nep141), (5 * NEAR, 25 * USDC));
    assert_eq!(code(Limits::configure("near-mainnet", Some(0), None, None)), "CAP_REQUIRED");
    assert_eq!(code(Limits::configure("near-mainnet", None, Some(0), None)), "CAP_REQUIRED");
    assert_eq!(code(Limits::configure("near-mainnet", Some(0), Some(0), usdc())), "CAP_REQUIRED");
    assert_eq!(Limits::configure("near-mainnet", Some(NEAR), Some(USDC), None).unwrap().max_native, NEAR);
    // Any other network label stays blocked.
    for n in ["", "mainnet", "near-betanet", "NEAR-MAINNET", "ethereum"] {
        assert_eq!(code(Limits::configure(n, Some(NEAR), Some(USDC), None)), "FUNDED_RAIL_BLOCKED", "{n}");
    }
    // The pinned token must be a valid account for the network.
    assert_eq!(code(Limits::configure("near-mainnet", None, None, Some(("usdc.testnet".into(), 6)))), "INVALID_ADDRESS");
    assert_eq!(code(Limits::configure("near-testnet", None, None, Some(("usdc.near".into(), 6)))), "INVALID_ADDRESS");
    assert_eq!(code(Limits::configure("near-testnet", None, None, Some((TOKEN.into(), 99)))), "VALIDATION_FAILED");
}

const MAIN_CONTRACT: &str = "escrow.dockside.near";
const MAIN_TOKEN: &str = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

fn mainnet_terms(asset: J, amount: u128) -> J {
    let mut t = evidence_terms();
    set(&mut t, &["profileVersion"], s("dockside-direct-mainnet-v1"));
    set(&mut t, &["network"], s("near-mainnet"));
    set(&mut t, &["escrowContractId"], s(MAIN_CONTRACT));
    set(&mut t, &["buyer", "accountId"], s("buyer.dockside.near"));
    set(&mut t, &["supplier", "accountId"], s("supplier.dockside.near"));
    set(&mut t, &["asset"], asset);
    set(&mut t, &["amountYocto"], big(amount));
    set(&mut t, &["payout"], st(vec![("network", s("near-mainnet")), ("recipientType", s("NEAR_ACCOUNT")), ("destination", s("supplier.dockside.near"))]));
    t
}

#[test]
fn mainnet_terms_use_their_own_profile_token_pin_and_caps() {
    let limits = Limits::configure("near-mainnet", None, None, Some((MAIN_TOKEN.into(), 6))).unwrap();
    let caller = "buyer.dockside.near".to_string();
    let ctx = Ctx { now_ms: T0, predecessor: &caller, contract_id: MAIN_CONTRACT, network: "near-mainnet", verifier: &Dalek, limits: &limits };
    let register = |t: &J| dockside_escrow_core::register(&ctx, t, &sign("buyer", "dockside/trade-revision", t), &sign("supplier", "dockside/trade-revision", t));
    let usdc = |amount: u128| mainnet_terms(st(vec![("kind", s("NEP141")), ("network", s("near-mainnet")), ("tokenAccountId", s(MAIN_TOKEN)), ("decimals", u(6))]), amount);
    let native = |amount: u128| mainnet_terms(st(vec![("kind", s("NEAR_NATIVE")), ("network", s("near-mainnet"))]), amount);

    let rec = register(&usdc(5 * USDC)).unwrap();
    assert_eq!(rec.terms.network, "near-mainnet");
    assert_eq!(code(register(&usdc(25 * USDC))), "OK");
    assert_eq!(code(register(&usdc(25 * USDC + 1))), "CAP_EXCEEDED");
    assert_eq!(code(register(&native(5 * NEAR))), "OK");
    assert_eq!(code(register(&native(5 * NEAR + 1))), "CAP_EXCEEDED");

    // The testnet profile, a testnet account or another token never registers on mainnet.
    let mut t = usdc(5 * USDC);
    set(&mut t, &["profileVersion"], s("dockside-direct-testnet-v1"));
    assert_eq!(code(register(&t)), "UNSUPPORTED_VERSION");
    let mut t = usdc(5 * USDC);
    set(&mut t, &["supplier", "accountId"], s("supplier.testnet"));
    assert_eq!(code(register(&t)), "INVALID_ADDRESS");
    let mut t = usdc(5 * USDC);
    set(&mut t, &["asset", "tokenAccountId"], s("usdt.tether-token.near"));
    assert_eq!(code(register(&t)), "UNSUPPORTED_ASSET");
    // Without a pinned token, mainnet accepts no NEP-141 trade at all.
    let unpinned = Limits::configure("near-mainnet", None, None, None).unwrap();
    let ctx2 = Ctx { now_ms: T0, predecessor: &caller, contract_id: MAIN_CONTRACT, network: "near-mainnet", verifier: &Dalek, limits: &unpinned };
    let t = usdc(5 * USDC);
    let r = dockside_escrow_core::register(&ctx2, &t, &sign("buyer", "dockside/trade-revision", &t), &sign("supplier", "dockside/trade-revision", &t));
    assert_eq!(code(r), "UNSUPPORTED_ASSET");
    // And testnet terms never register on a mainnet contract, nor mainnet terms on testnet.
    assert_eq!(code(register(&token_terms(5 * USDC))), "WRONG_NETWORK");
    let w = World::new();
    assert_eq!(code(reg(&w, &usdc(5 * USDC))), "WRONG_NETWORK");

    // Deposits over the cap are refused on mainnet too (5 accepted, at most 20 more held).
    let mut rec = rec;
    let token = MAIN_TOKEN.to_string();
    let tctx = Ctx { now_ms: T0, predecessor: &token, contract_id: MAIN_CONTRACT, network: "near-mainnet", verifier: &Dalek, limits: &limits };
    let digest = rec.terms_digest.clone();
    assert_eq!(code(rec.fund_token(&tctx, "buyer.dockside.near", &digest, 25 * USDC + 1, MIN)), "CAP_EXCEEDED");
    rec.fund_token(&tctx, "buyer.dockside.near", &digest, 6 * USDC, MIN).unwrap();
    assert_eq!(rec.ledger.funder("buyer.dockside.near").quarantined, USDC);
}
