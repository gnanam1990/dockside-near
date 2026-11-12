//! Storage growth an account with no role on a trade can cause (external security audit,
//! m33-contract-storage-bounds).
//!
//! * (a) The NEP-141/171/245 receivers persist an unexpected-asset record per call, paid from
//!   the escrow balance that also holds every trade's value. The contract-wide count is capped
//!   (`assets::MAX_UNEXPECTED_ASSETS`); a refused receiver call makes the token contract return
//!   the asset under its own standard. Each asset keeps at most `MAX_RECOVERIES_PER_ASSET`
//!   recovery attempts.
//! * (b) Recovery steps authenticated only by the caller's own account (the claimed sender's
//!   request and CLAIMED_SENDER revoke, a CLAIMANT challenge) never write the governing trade's
//!   nonce set; only the trade's bound keys (risk/policy approval and revocation, party
//!   challenges) consume trade nonces.
//! * (c) `fund` is permissionless, so the per-trade deposit history is capped
//!   (`MAX_DEPOSITS_PER_TRADE`). Past the cap only a deposit that completes an under-funded
//!   trade is still accepted, so filling the history ahead of the buyer cannot block funding.

mod common;
use borsh::to_vec;
use common::*;
use dockside_escrow_core::assets::{self, UnexpectedAsset, MAX_RECOVERIES_PER_ASSET, MAX_UNEXPECTED_ASSETS};
use dockside_escrow_core::{TradeRecord, MAX_COMPLETING_DEPOSITS_OVER_LIMIT, MAX_DEPOSITS_PER_TRADE};

const ATTACKER: &str = "stranger.testnet";
const REQ: &str = "dockside/asset-recovery-request";
const RVK: &str = "dockside/asset-recovery-revoke";
const APR: &str = "dockside/asset-recovery-approval";
const CHL: &str = "dockside/asset-recovery-challenge";
const MIN: u128 = 1_000_000_000_000_000_000_000; // 0.001 NEAR, the default minimum deposit

/// An NEP-141 record the attacker creates by calling `ft_on_transfer` from its own account with
/// `sender_id` set to itself: it is then the claimed sender of an asset with a recovery adapter.
fn self_sent(index: u64) -> UnexpectedAsset {
    assets::record(index, "NEP-141", ATTACKER, None, "1".into(), ATTACKER, "", T0).unwrap()
}

fn request(rec: &TradeRecord, a: &UnexpectedAsset, n: &str) -> J {
    with_header(
        rec,
        vec![
            ("recoveryId", s(&id("arc", n))),
            ("policyId", s("dockside-refund-v1")),
            ("policyRevision", u(1)),
            ("reason", s("UNEXPECTED_ASSET_RECOVERY")),
            ("assetIndex", u(a.index)),
            ("standard", s(&a.standard)),
            ("assetContract", s(&a.asset_contract)),
            ("tokenId", opt(a.token_id.as_deref())),
            ("amount", s(&a.observed_amount)),
            ("claimedSender", s(&a.claimed_sender)),
            ("recipient", s(&a.claimed_sender)),
            ("evidenceDigest", s(&"cd".repeat(32))),
            ("issuedAt", u(T0)),
            ("expiresAt", u(T0 + 24 * HOUR)),
            ("nonce", s(&nonce(&format!("req-{n}")))),
        ],
    )
}

fn step(rec: &TradeRecord, a: &UnexpectedAsset, fields: Vec<(&'static str, J)>, n: &str) -> J {
    let r = a.recoveries.last().expect("recovery");
    let mut v = vec![("recoveryId", s(&r.id)), ("requestDigest", s(&r.request_digest))];
    v.extend(fields);
    v.extend([("issuedAt", u(T0)), ("expiresAt", u(T0 + HOUR)), ("nonce", s(&nonce(n)))]);
    with_header(rec, v)
}

fn revoke(rec: &TradeRecord, a: &UnexpectedAsset, role: &str, n: &str) -> J {
    step(rec, a, vec![("revokerRole", s(role))], &format!("rvk-{n}"))
}

fn claimant_challenge(rec: &TradeRecord, a: &UnexpectedAsset, role: &str, account: Option<&str>, n: &str) -> J {
    step(
        rec,
        a,
        vec![
            ("challengerRole", s(role)),
            ("challengerAccount", opt(account)),
            ("reasonCode", s("OWNERSHIP_DISPUTED")),
            ("evidenceDigest", s(&"12".repeat(32))),
        ],
        &format!("chl-{n}"),
    )
}

fn victim() -> (World, TradeRecord) {
    let (mut w, mut rec) = registered();
    rec.fund(&w.as_caller(BUYER_ACCT).ctx(), 10 * NEAR, MIN).unwrap();
    (w, rec)
}

/* ------------------------- (b) governing-trade nonce set ------------------------- */

#[test]
fn a_stranger_request_and_revoke_loop_leaves_the_governing_trade_unchanged() {
    let (mut w, mut rec) = victim();
    let before = rec.clone();
    let bytes = to_vec(&rec).unwrap().len();
    let mut a = self_sent(0);
    for i in 0..MAX_RECOVERIES_PER_ASSET {
        let n = format!("loop-{i}");
        let p = request(&rec, &a, &n);
        assets::request_recovery(&mut a, &mut rec, &w.as_caller(ATTACKER).ctx(), &p).unwrap();
        let rv = revoke(&rec, &a, "CLAIMED_SENDER", &n);
        assets::revoke_recovery(&mut a, &mut rec, &w.as_caller(ATTACKER).ctx(), &rv, None).unwrap();
    }
    assert_eq!(rec.nonces, before.nonces, "a caller with no role on the trade must not grow its nonce set");
    assert_eq!(rec, before, "recovery steps authenticated by the caller's own account never write the trade");
    assert_eq!(to_vec(&rec).unwrap().len(), bytes);
}

#[test]
fn a_claimant_challenge_does_not_consume_a_governing_trade_nonce() {
    let (mut w, mut rec) = victim();
    let mut a = self_sent(0);
    let p = request(&rec, &a, "c");
    assets::request_recovery(&mut a, &mut rec, &w.as_caller(ATTACKER).ctx(), &p).unwrap();
    let before = rec.nonces.clone();
    let c = claimant_challenge(&rec, &a, "CLAIMANT", Some("other-claimant.testnet"), "c");
    assets::challenge_recovery(&mut a, &mut rec, &w.as_caller("other-claimant.testnet").ctx(), &c, None).unwrap();
    assert_eq!(rec.nonces, before);
    assert_eq!(a.recoveries.last().unwrap().state.as_str(), "CHALLENGED");
}

#[test]
fn signed_recovery_steps_still_consume_single_use_trade_nonces() {
    let (mut w, mut rec) = victim();
    let mut a = self_sent(0);
    let p = request(&rec, &a, "s1");
    assets::request_recovery(&mut a, &mut rec, &w.as_caller(ATTACKER).ctx(), &p).unwrap();
    // A party challenge signed with the bound key consumes a trade nonce.
    let c = claimant_challenge(&rec, &a, "BUYER", None, "s1");
    assets::challenge_recovery(&mut a, &mut rec, &w.ctx(), &c, Some(&sign("buyer", CHL, &c))).unwrap();
    assert!(rec.nonce_used(CHL, &nonce("chl-s1")));
    // Risk/policy approval and revocation consume trade nonces, and a reused one is refused.
    let p = request(&rec, &a, "s2");
    assets::request_recovery(&mut a, &mut rec, &w.as_caller(ATTACKER).ctx(), &p).unwrap();
    let r = a.recoveries.last().unwrap().clone();
    let ap = with_header(
        &rec,
        vec![
            ("recoveryId", s(&r.id)),
            ("requestDigest", s(&r.request_digest)),
            ("assetIndex", u(a.index)),
            ("amount", s(&a.observed_amount)),
            ("recipient", s(&r.recipient)),
            ("recoveryCapability", s("NEP141_FT_TRANSFER")),
            ("validationDigest", s(&"ef".repeat(32))),
            ("approverRole", s("RISK_RESOLVER")),
            ("issuedAt", u(T0)),
            ("expiresAt", u(T0 + HOUR)),
            ("nonce", s(&nonce("apr-s2"))),
        ],
    );
    assets::approve_recovery(&mut a, &mut rec, &w.ctx(), &ap, &sign("risk", APR, &ap)).unwrap();
    assert!(rec.nonce_used(APR, &nonce("apr-s2")));
    let rv = revoke(&rec, &a, "RISK_RESOLVER", "s2");
    assets::revoke_recovery(&mut a, &mut rec, &w.ctx(), &rv, Some(&sign("risk", RVK, &rv))).unwrap();
    assert!(rec.nonce_used(RVK, &nonce("rvk-s2")));
}

#[test]
fn an_unsigned_step_cannot_reuse_a_nonce_the_trade_already_consumed() {
    let (mut w, mut rec) = victim();
    let mut a = self_sent(0);
    // Burn the request nonce in the trade first (as if another payload had used it).
    rec.consume_nonce(REQ, &nonce("req-dup")).unwrap();
    let p = request(&rec, &a, "dup");
    assert_eq!(code(assets::request_recovery(&mut a, &mut rec, &w.as_caller(ATTACKER).ctx(), &p)), "NONCE_REPLAYED");
    let mut bad = request(&rec, &a, "fmt");
    set(&mut bad, &["nonce"], s("not-hex"));
    assert_eq!(code(assets::request_recovery(&mut a, &mut rec, &w.as_caller(ATTACKER).ctx(), &bad)), "VALIDATION_FAILED");
}

/* ------------------- (a) unexpected-asset records and attempts ------------------- */

#[test]
fn recovery_attempts_per_asset_are_capped() {
    let (mut w, mut rec) = victim();
    let mut a = self_sent(0);
    for i in 0..MAX_RECOVERIES_PER_ASSET {
        let n = format!("cap-{i}");
        let p = request(&rec, &a, &n);
        assets::request_recovery(&mut a, &mut rec, &w.as_caller(ATTACKER).ctx(), &p).unwrap();
        let rv = revoke(&rec, &a, "CLAIMED_SENDER", &n);
        assets::revoke_recovery(&mut a, &mut rec, &w.as_caller(ATTACKER).ctx(), &rv, None).unwrap();
    }
    let p = request(&rec, &a, "cap-over");
    assert_eq!(code(assets::request_recovery(&mut a, &mut rec, &w.as_caller(ATTACKER).ctx(), &p)), "CAPACITY_EXCEEDED");
    assert_eq!(a.recoveries.len(), MAX_RECOVERIES_PER_ASSET);
    assert_eq!(a.state, assets::REVIEW_STATE, "the asset stays in review");
}

#[test]
fn unexpected_asset_capacity_is_contract_wide_and_covers_a_whole_batch() {
    assets::ensure_capacity(0, MAX_UNEXPECTED_ASSETS as usize).unwrap();
    assert_eq!(code(assets::ensure_capacity(0, 32)), "CAPACITY_EXCEEDED", "one maximal mt batch alone exceeds the cap");
    assets::ensure_capacity(MAX_UNEXPECTED_ASSETS - 1, 1).unwrap();
    assert_eq!(code(assets::ensure_capacity(MAX_UNEXPECTED_ASSETS, 1)), "CAPACITY_EXCEEDED");
    assert_eq!(code(assets::ensure_capacity(MAX_UNEXPECTED_ASSETS - 1, 2)), "CAPACITY_EXCEEDED", "an mt batch fits whole or not at all");
    assert_eq!(code(assets::ensure_capacity(u64::MAX, usize::MAX)), "CAPACITY_EXCEEDED");
}

#[test]
fn the_worst_case_unexpected_asset_storage_is_bounded() {
    // A maximal record (64-byte accounts, 256-byte token id) carrying the maximum number of
    // maximal recovery attempts, each ended by a challenge.
    let acct = "a".repeat(64);
    let mut a = assets::record(0, "NEP-245", &acct, Some("t".repeat(256)), u128::MAX.to_string(), &acct, "", u64::MAX).unwrap();
    for i in 0..MAX_RECOVERIES_PER_ASSET {
        a.recoveries.push(assets::AssetRecovery {
            id: id("arc", &format!("w{i}")),
            trade_id: id("trd", "w"),
            trade_revision: u64::MAX,
            recipient: acct.clone(),
            amount: u128::MAX.to_string(),
            capability: assets::NEP141_CAPABILITY.into(),
            request_digest: "f".repeat(64),
            evidence_digest: "f".repeat(64),
            state: assets::RecoveryState::Challenged,
            requested_at: u64::MAX,
            request_expires_at: u64::MAX,
            approval_digest: Some("f".repeat(64)),
            validation_digest: Some("f".repeat(64)),
            approved_at: Some(u64::MAX),
            deadline: Some(u64::MAX),
            challenge: Some(assets::RecoveryChallenge {
                role: "RISK_RESOLVER".into(),
                account: Some(acct.clone()),
                reason_code: "r".repeat(64),
                evidence_digest: "f".repeat(64),
                digest: "f".repeat(64),
                at: u64::MAX,
            }),
            revoked_by: Some("CLAIMED_SENDER".into()),
            executor: Some(acct.clone()),
            history: vec![("CHALLENGE_PERIOD".into(), u64::MAX); 3],
        });
    }
    let per_asset = to_vec(&a).unwrap().len() as u64;
    let total = per_asset * MAX_UNEXPECTED_ASSETS;
    // 1e19 yoctoNEAR per byte (NEAR storage price): stay under 1 NEAR of storage stake in total.
    assert!(total < 100_000, "worst-case unexpected-asset storage is {total} bytes ({per_asset} per asset)");
}

/* --------------------------- (c) per-trade deposit history --------------------------- */

#[test]
fn repeated_minimum_deposits_from_a_stranger_stop_at_the_cap() {
    let (mut w, mut rec) = victim();
    let mut refused = None;
    for i in 0..(MAX_DEPOSITS_PER_TRADE + MAX_COMPLETING_DEPOSITS_OVER_LIMIT + 50) {
        if let Err(e) = rec.fund(&w.as_caller(ATTACKER).ctx(), MIN, MIN) {
            refused = Some((i, e.code));
            break;
        }
    }
    assert_eq!(refused, Some((MAX_DEPOSITS_PER_TRADE - 1, "CAPACITY_EXCEEDED")), "the buyer's deposit is the first of the cap");
    assert_eq!(rec.ledger.deposits.len(), MAX_DEPOSITS_PER_TRADE);
    rec.ledger.check_conservation().unwrap();
}

#[test]
fn a_full_deposit_history_cannot_block_the_completing_deposit() {
    let (mut w, mut rec) = registered();
    // A stranger fills the whole history with minimum partial deposits before the buyer funds.
    for _ in 0..MAX_DEPOSITS_PER_TRADE {
        rec.fund(&w.as_caller(ATTACKER).ctx(), MIN, MIN).unwrap();
    }
    assert!(!rec.ledger.fully_funded());
    // A further partial deposit is refused, from anyone.
    assert_eq!(code(rec.fund(&w.as_caller(BUYER_ACCT).ctx(), NEAR, MIN)), "CAPACITY_EXCEEDED");
    // The deposit that completes the trade is accepted (its excess is quarantined as usual).
    let o = rec.fund(&w.as_caller(OTHER_FUNDER).ctx(), 10 * NEAR, MIN).unwrap();
    assert!(o.fully_funded);
    assert_eq!(o.quarantined, MAX_DEPOSITS_PER_TRADE as u128 * MIN);
    // Afterwards nothing more fits: the trade is fully funded, so no deposit completes it.
    assert_eq!(code(rec.fund(&w.as_caller(ATTACKER).ctx(), MIN, MIN)), "CAPACITY_EXCEEDED");
    assert_eq!(rec.ledger.deposits.len(), MAX_DEPOSITS_PER_TRADE + 1);
    rec.ledger.check_conservation().unwrap();
}

#[test]
fn the_worst_case_trade_ledger_is_bounded() {
    let (mut w, mut rec) = registered();
    let empty = to_vec(&rec).unwrap().len();
    // Distinct maximal-length funders maximise the funders map as well as the history.
    let mut i = 0usize;
    loop {
        let who = format!("{:0>60}.near", i);
        if rec.fund(&w.as_caller(&who).ctx(), MIN, MIN).is_err() {
            break;
        }
        i += 1;
    }
    let grown = to_vec(&rec).unwrap().len() - empty;
    assert_eq!(rec.ledger.deposits.len(), MAX_DEPOSITS_PER_TRADE);
    assert!(grown < 32_000, "a full deposit history adds {grown} bytes to the trade record");
}
