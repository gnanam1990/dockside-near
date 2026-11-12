//! T-051 / REFUND-POLICY `UNEXPECTED_ASSET_RECOVERY` (core half, REAL-PRODUCT-GATE item 9).
//!
//! An unexpected NEP-141 balance can leave the escrow only through the separate asset-recovery
//! protocol: the claimed sender proves control by submitting the request from its own account,
//! the bound risk/policy principal of the governing trade approves over a read-only validation
//! digest, a 72-hour challenge window runs, and only then may anyone execute the exact observed
//! amount to the proven sender through the compiled NEP-141 adapter. Native-NEAR fields, refund
//! intents and conservation are never touched.

mod common;
use common::*;
use dockside_escrow_core::assets::{self, UnexpectedAsset, CHALLENGE_72H_MS};
use dockside_escrow_core::TradeRecord;

const TOKEN: &str = "usdc.fakes.testnet";
const SENDER: &str = "token-sender.testnet";
const CLAIMANT: &str = "other-claimant.testnet";

fn ft(index: u64) -> UnexpectedAsset {
    assets::record(index, "NEP-141", TOKEN, None, "5000000".into(), SENDER, "pay trade", T0).unwrap()
}

fn request(rec: &TradeRecord, a: &UnexpectedAsset, n: &str, f: impl FnOnce(&mut J)) -> J {
    let mut p = with_header(
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
    );
    f(&mut p);
    p
}

fn approval(rec: &TradeRecord, a: &UnexpectedAsset, at: u64, n: &str) -> J {
    let r = a.recoveries.last().expect("recovery");
    with_header(
        rec,
        vec![
            ("recoveryId", s(&r.id)),
            ("requestDigest", s(&r.request_digest)),
            ("assetIndex", u(a.index)),
            ("amount", s(&a.observed_amount)),
            ("recipient", s(&r.recipient)),
            ("recoveryCapability", s("NEP141_FT_TRANSFER")),
            ("validationDigest", s(&"ef".repeat(32))),
            ("approverRole", s("RISK_RESOLVER")),
            ("issuedAt", u(at)),
            ("expiresAt", u(at + HOUR)),
            ("nonce", s(&nonce(&format!("apr-{n}")))),
        ],
    )
}

fn challenge(rec: &TradeRecord, a: &UnexpectedAsset, role: &str, account: Option<&str>, at: u64, n: &str) -> J {
    let r = a.recoveries.last().expect("recovery");
    with_header(
        rec,
        vec![
            ("recoveryId", s(&r.id)),
            ("requestDigest", s(&r.request_digest)),
            ("challengerRole", s(role)),
            ("challengerAccount", opt(account)),
            ("reasonCode", s("OWNERSHIP_DISPUTED")),
            ("evidenceDigest", s(&"12".repeat(32))),
            ("issuedAt", u(at)),
            ("expiresAt", u(at + HOUR)),
            ("nonce", s(&nonce(&format!("chl-{n}")))),
        ],
    )
}

fn revoke(rec: &TradeRecord, a: &UnexpectedAsset, role: &str, at: u64, n: &str) -> J {
    let r = a.recoveries.last().expect("recovery");
    with_header(
        rec,
        vec![
            ("recoveryId", s(&r.id)),
            ("requestDigest", s(&r.request_digest)),
            ("revokerRole", s(role)),
            ("issuedAt", u(at)),
            ("expiresAt", u(at + HOUR)),
            ("nonce", s(&nonce(&format!("rvk-{n}")))),
        ],
    )
}

const REQ: &str = "dockside/asset-recovery-request";
const APR: &str = "dockside/asset-recovery-approval";
const CHL: &str = "dockside/asset-recovery-challenge";
const RVK: &str = "dockside/asset-recovery-revoke";

/// Sender request then risk approval at `T0`; returns the funded world, record and asset.
fn approved() -> (World, TradeRecord, UnexpectedAsset) {
    let (mut w, mut rec) = registered();
    rec.fund(&w.as_caller(BUYER_ACCT).ctx(), 10 * NEAR, 1).unwrap();
    let mut a = ft(0);
    let p = request(&rec, &a, "a", |_| {});
    assets::request_recovery(&mut a, &mut rec, &w.as_caller(SENDER).ctx(), &p).unwrap();
    let ap = approval(&rec, &a, T0, "a");
    assets::approve_recovery(&mut a, &mut rec, &w.as_caller("relayer.testnet").ctx(), &ap, &sign("risk", APR, &ap)).unwrap();
    (w, rec, a)
}

#[test]
fn full_recovery_reaches_the_proven_sender_after_the_72_hour_challenge() {
    let (mut w, rec, mut a) = approved();
    let ledger = rec.ledger.clone();
    assert_eq!(a.state, "RECOVERY_CHALLENGE_PERIOD");
    let r = a.recoveries.last().unwrap().clone();
    assert_eq!(r.deadline, Some(T0 + CHALLENGE_72H_MS));
    assert_eq!(r.recipient, SENDER);
    // Before the window closes nobody can execute.
    w.now = T0 + CHALLENGE_72H_MS - 1;
    assert_eq!(code(assets::begin_recovery(&mut a, &w.as_caller("relayer.testnet").ctx(), &r.id, 1)), "DELAY_NOT_ELAPSED");
    w.now = T0 + CHALLENGE_72H_MS;
    // The NEP-141 adapter needs exactly one yoctoNEAR from the executor, never escrow value.
    assert_eq!(code(assets::begin_recovery(&mut a, &w.as_caller("relayer.testnet").ctx(), &r.id, 0)), "INVALID_AMOUNT");
    let (contract, to, amount) = assets::begin_recovery(&mut a, &w.as_caller("relayer.testnet").ctx(), &r.id, 1).unwrap();
    assert_eq!((contract.as_str(), to.as_str(), amount), (TOKEN, SENDER, 5_000_000u128));
    assert_eq!(a.state, "RECOVERY_SUBMITTED");
    // Submitted: the exact asset is locked; no second execution, no revocation, no challenge.
    assert_eq!(code(assets::begin_recovery(&mut a, &w.ctx(), &r.id, 1)), "INVALID_STATE");
    let mut rec2 = rec.clone();
    let rv = revoke(&rec2, &a, "RISK_RESOLVER", w.now, "late");
    assert_eq!(code(assets::revoke_recovery(&mut a, &mut rec2, &w.ctx(), &rv, Some(&sign("risk", RVK, &rv)))), "INVALID_STATE");
    let executor = assets::complete_recovery(&mut a, &w.ctx(), &r.id, true).unwrap();
    assert_eq!(executor, "relayer.testnet");
    assert_eq!(a.state, "RECOVERED");
    assert_eq!(a.recoveries.last().unwrap().state.as_str(), "RECOVERED");
    assert_eq!(code(assets::complete_recovery(&mut a, &w.ctx(), &r.id, true)), "INVALID_STATE");
    // A recovered asset cannot be requested again.
    let p = request(&rec2, &a, "again", |_| {});
    assert_eq!(code(assets::request_recovery(&mut a, &mut rec2, &w.as_caller(SENDER).ctx(), &p)), "INVALID_STATE");
    assert_eq!(rec.ledger, ledger, "native ledger untouched");
    assert!(rec.refunds.is_empty(), "no native refund intent exists");
    rec.ledger.check_conservation().unwrap();
}

#[test]
fn authoritative_transfer_failure_returns_the_asset_to_review_and_needs_a_new_request() {
    let (mut w, mut rec, mut a) = approved();
    w.now = T0 + CHALLENGE_72H_MS;
    let id1 = a.recoveries.last().unwrap().id.clone();
    assets::begin_recovery(&mut a, &w.as_caller("relayer.testnet").ctx(), &id1, 1).unwrap();
    assets::complete_recovery(&mut a, &w.ctx(), &id1, false).unwrap();
    assert_eq!(a.state, "ASSET_RECOVERY_REVIEW");
    assert_eq!(a.recoveries.last().unwrap().state.as_str(), "FAILED");
    // No blind retry: the failed recovery cannot be executed again.
    assert_eq!(code(assets::begin_recovery(&mut a, &w.ctx(), &id1, 1)), "INVALID_STATE");
    // A fresh request with a new id and new approval is the only path forward.
    let p = request(&rec, &a, "b", |p| {
        set(p, &["issuedAt"], u(w.now));
        set(p, &["expiresAt"], u(w.now + HOUR));
    });
    assets::request_recovery(&mut a, &mut rec, &w.as_caller(SENDER).ctx(), &p).unwrap();
    assert_eq!(a.state, "RECOVERY_REQUESTED");
    assert_eq!(a.recoveries.len(), 2);
}

#[test]
fn request_requires_the_claimed_sender_exact_fields_and_a_safe_adapter() {
    let (mut w, mut rec) = registered();
    let mut a = ft(0);
    let ok = request(&rec, &a, "a", |_| {});
    // Proof of control: only the claimed sender's own account submits the request.
    assert_eq!(code(assets::request_recovery(&mut a, &mut rec, &w.as_caller(BUYER_ACCT).ctx(), &ok)), "FORBIDDEN");
    assert_eq!(code(assets::request_recovery(&mut a, &mut rec, &w.as_caller(CLAIMANT).ctx(), &ok)), "FORBIDDEN");
    let cases: Vec<(&str, J, &str)> = vec![
        ("amount", s("5000001"), "AMOUNT_MISMATCH"),
        ("amount", s("4999999"), "AMOUNT_MISMATCH"),
        ("assetContract", s("other-token.testnet"), "ASSET_MISMATCH"),
        ("standard", s("NEP-171"), "ASSET_MISMATCH"),
        ("assetIndex", u(1), "ASSET_MISMATCH"),
        ("claimedSender", s(CLAIMANT), "ASSET_MISMATCH"),
        // Recipient is always the proven sender, never a buyer, supplier or funder field.
        ("recipient", s(BUYER_ACCT), "RECIPIENT_NOT_SENDER"),
        ("reason", s("EXCESS_FUNDING_RETURN"), "POLICY_MISMATCH"),
        ("policyRevision", u(2), "POLICY_MISMATCH"),
        ("tradeDigest", s(&"00".repeat(32)), "STALE_REVISION"),
        ("evidenceDigest", s("not-hex"), "VALIDATION_FAILED"),
        ("recoveryId", s("rfd_0123"), "VALIDATION_FAILED"),
    ];
    for (i, (field, v, want)) in cases.into_iter().enumerate() {
        let mut p = request(&rec, &a, &format!("m{i}"), |_| {});
        set(&mut p, &[field], v);
        assert_eq!(code(assets::request_recovery(&mut a, &mut rec, &w.as_caller(SENDER).ctx(), &p)), want, "{field}");
    }
    let mut extra = request(&rec, &a, "x", |_| {});
    extra.get_mut("struct").unwrap().as_object_mut().unwrap().insert("originalFunder".into(), s(BUYER_ACCT));
    assert_eq!(code(assets::request_recovery(&mut a, &mut rec, &w.as_caller(SENDER).ctx(), &extra)), "UNKNOWN_FIELD");
    assert_eq!(a.state, "ASSET_RECOVERY_REVIEW", "refused requests change nothing");
    // NFTs and multi-tokens have no safe adapter in this build.
    let mut nft = assets::record(1, "NEP-171", "nft.fakes.testnet", Some("bol-7".into()), "1".into(), SENDER, "", T0).unwrap();
    assert_eq!(nft.state, "UNRECOVERABLE_OR_REVIEW");
    let p = request(&rec, &nft, "nft", |_| {});
    assert_eq!(code(assets::request_recovery(&mut nft, &mut rec, &w.as_caller(SENDER).ctx(), &p)), "ADAPTER_UNSAFE");
    // Valid request, then a replayed nonce and a second live request are refused.
    assets::request_recovery(&mut a, &mut rec, &w.as_caller(SENDER).ctx(), &ok).unwrap();
    assert_eq!(a.state, "RECOVERY_REQUESTED");
    let again = request(&rec, &a, "a2", |_| {});
    assert_eq!(code(assets::request_recovery(&mut a, &mut rec, &w.as_caller(SENDER).ctx(), &again)), "INVALID_STATE");
}

#[test]
fn approval_is_the_bound_risk_principal_over_the_exact_request_and_capability() {
    let (mut w, mut rec) = registered();
    let mut a = ft(0);
    let p = request(&rec, &a, "a", |_| {});
    assets::request_recovery(&mut a, &mut rec, &w.as_caller(SENDER).ctx(), &p).unwrap();
    let ap = approval(&rec, &a, T0, "a");
    for wrong in ["buyer", "supplier", "inspector", "attestor"] {
        assert_eq!(code(assets::approve_recovery(&mut a, &mut rec, &w.ctx(), &ap, &sign(wrong, APR, &ap))), "SIGNATURE_INVALID", "{wrong}");
    }
    // Wrong domain (a refund signature) is refused.
    assert_eq!(code(assets::approve_recovery(&mut a, &mut rec, &w.ctx(), &ap, &sign("risk", "dockside/refund-authorize", &ap))), "SIGNATURE_INVALID");
    for (field, v, want) in [
        ("amount", s("1"), "AMOUNT_MISMATCH"),
        ("recipient", s(SUPPLIER_ACCT), "RECIPIENT_NOT_SENDER"),
        ("recoveryCapability", s("NEP171_NFT_TRANSFER"), "ADAPTER_UNSAFE"),
        ("requestDigest", s(&"00".repeat(32)), "VALIDATION_FAILED"),
        ("approverRole", s("BUYER"), "FORBIDDEN"),
        ("validationDigest", s("x"), "VALIDATION_FAILED"),
    ] {
        let mut x = approval(&rec, &a, T0, field);
        set(&mut x, &[field], v);
        assert_eq!(code(assets::approve_recovery(&mut a, &mut rec, &w.ctx(), &x, &sign("risk", APR, &x))), want, "{field}");
    }
    assert_eq!(a.state, "RECOVERY_REQUESTED");
    assets::approve_recovery(&mut a, &mut rec, &w.ctx(), &ap, &sign("risk", APR, &ap)).unwrap();
    assert_eq!(code(assets::approve_recovery(&mut a, &mut rec, &w.ctx(), &ap, &sign("risk", APR, &ap))), "INVALID_STATE");
    // A revoked risk key can no longer approve a new request.
    let (mut w2, mut rec2) = registered();
    let mut b = ft(0);
    let p = request(&rec2, &b, "b", |_| {});
    assets::request_recovery(&mut b, &mut rec2, &w2.as_caller(SENDER).ctx(), &p).unwrap();
    rec2.revoked_roles.insert("riskResolver".into());
    let ap = approval(&rec2, &b, T0, "b");
    assert_eq!(code(assets::approve_recovery(&mut b, &mut rec2, &w2.ctx(), &ap, &sign("risk", APR, &ap))), "KEY_REVOKED");
}

#[test]
fn challenge_by_party_risk_or_another_claimant_keeps_the_asset_in_review() {
    for (who, signer, account) in [
        ("BUYER", Some("buyer"), None),
        ("SUPPLIER", Some("supplier"), None),
        ("RISK_RESOLVER", Some("risk"), None),
        ("CLAIMANT", None, Some(CLAIMANT)),
    ] {
        let (mut w, mut rec, mut a) = approved();
        w.now = T0 + CHALLENGE_72H_MS - 1;
        let caller = account.unwrap_or("relayer.testnet");
        let c = challenge(&rec, &a, who, account, w.now, who);
        let sig = signer.map(|l| sign(l, CHL, &c));
        assets::challenge_recovery(&mut a, &mut rec, &w.as_caller(caller).ctx(), &c, sig.as_deref()).unwrap();
        assert_eq!(a.state, "ASSET_RECOVERY_REVIEW", "{who}");
        let r = a.recoveries.last().unwrap().clone();
        assert_eq!(r.state.as_str(), "CHALLENGED");
        assert_eq!(r.challenge.as_ref().unwrap().role, who);
        w.now = T0 + CHALLENGE_72H_MS;
        assert_eq!(code(assets::begin_recovery(&mut a, &w.ctx(), &r.id, 1)), "INVALID_STATE", "{who}");
    }
}

#[test]
fn challenge_is_refused_for_strangers_the_recipient_and_after_the_window() {
    let (mut w, mut rec, mut a) = approved();
    w.now = T0 + HOUR;
    // The inspector holds no challenge right; an unsigned party challenge is refused.
    let c = challenge(&rec, &a, "INSPECTOR", None, w.now, "i");
    assert_eq!(code(assets::challenge_recovery(&mut a, &mut rec, &w.ctx(), &c, Some(&sign("inspector", CHL, &c)))), "FORBIDDEN");
    let c = challenge(&rec, &a, "BUYER", None, w.now, "nosig");
    assert_eq!(code(assets::challenge_recovery(&mut a, &mut rec, &w.ctx(), &c, None)), "SIGNATURE_INVALID");
    let c = challenge(&rec, &a, "BUYER", None, w.now, "forged");
    assert_eq!(code(assets::challenge_recovery(&mut a, &mut rec, &w.ctx(), &c, Some(&sign("supplier", CHL, &c)))), "SIGNATURE_INVALID");
    // A claimant must be the transaction signer and cannot be the recipient itself.
    let c = challenge(&rec, &a, "CLAIMANT", Some(CLAIMANT), w.now, "c1");
    assert_eq!(code(assets::challenge_recovery(&mut a, &mut rec, &w.as_caller("someone.testnet").ctx(), &c, None)), "FORBIDDEN");
    let c = challenge(&rec, &a, "CLAIMANT", Some(SENDER), w.now, "c2");
    assert_eq!(code(assets::challenge_recovery(&mut a, &mut rec, &w.as_caller(SENDER).ctx(), &c, None)), "FORBIDDEN");
    w.now = T0 + CHALLENGE_72H_MS;
    let c = challenge(&rec, &a, "BUYER", None, w.now, "late");
    assert_eq!(code(assets::challenge_recovery(&mut a, &mut rec, &w.ctx(), &c, Some(&sign("buyer", CHL, &c)))), "INVALID_STATE");
    assert_eq!(a.state, "RECOVERY_CHALLENGE_PERIOD");
}

#[test]
fn revocation_by_sender_or_risk_before_execution_only() {
    // Claimed sender revokes from its own account (no signature).
    let (mut w, mut rec, mut a) = approved();
    w.now = T0 + HOUR;
    let rv = revoke(&rec, &a, "CLAIMED_SENDER", w.now, "s");
    assert_eq!(code(assets::revoke_recovery(&mut a, &mut rec, &w.as_caller(BUYER_ACCT).ctx(), &rv, None)), "FORBIDDEN");
    assets::revoke_recovery(&mut a, &mut rec, &w.as_caller(SENDER).ctx(), &rv, None).unwrap();
    assert_eq!(a.state, "ASSET_RECOVERY_REVIEW");
    assert_eq!(a.recoveries.last().unwrap().state.as_str(), "REVOKED");
    // Risk revokes with its bound key; the buyer cannot revoke.
    let (mut w, mut rec, mut a) = approved();
    w.now = T0 + HOUR;
    let rv = revoke(&rec, &a, "BUYER", w.now, "b");
    assert_eq!(code(assets::revoke_recovery(&mut a, &mut rec, &w.ctx(), &rv, Some(&sign("buyer", RVK, &rv)))), "FORBIDDEN");
    let rv = revoke(&rec, &a, "RISK_RESOLVER", w.now, "r");
    assert_eq!(code(assets::revoke_recovery(&mut a, &mut rec, &w.ctx(), &rv, Some(&sign("buyer", RVK, &rv)))), "SIGNATURE_INVALID");
    assets::revoke_recovery(&mut a, &mut rec, &w.ctx(), &rv, Some(&sign("risk", RVK, &rv))).unwrap();
    assert_eq!(a.state, "ASSET_RECOVERY_REVIEW");
    // Replay of the same signed revocation is refused (nonce consumed in the governing trade).
    assert_eq!(code(assets::revoke_recovery(&mut a, &mut rec, &w.ctx(), &rv, Some(&sign("risk", RVK, &rv)))), "INVALID_STATE");
}

#[test]
fn recovery_binds_the_governing_trade_and_never_touches_native_value() {
    let (mut w, mut rec) = registered();
    rec.fund(&w.as_caller(BUYER_ACCT).ctx(), 12 * NEAR, 1).unwrap();
    let before = rec.ledger.clone();
    let mut a = ft(0);
    let p = request(&rec, &a, "a", |_| {});
    assets::request_recovery(&mut a, &mut rec, &w.as_caller(SENDER).ctx(), &p).unwrap();
    // A second, different trade cannot approve or challenge a recovery governed by the first.
    let mut other = terms_with(10 * NEAR, T0 + 40 * 24 * HOUR);
    set(&mut other, &["tradeId"], s(&id("trd", "trade-2")));
    set(&mut other, &["policySetter", "scope", "tradeId"], s(&id("trd", "trade-2")));
    let (_, mut rec2) = registered_with(&other);
    let ap = approval(&rec2, &a, T0, "x");
    assert_eq!(code(assets::approve_recovery(&mut a, &mut rec2, &w.ctx(), &ap, &sign("risk", APR, &ap))), "SCOPE_MISMATCH");
    let c = challenge(&rec2, &a, "BUYER", None, T0, "x");
    assert_eq!(code(assets::challenge_recovery(&mut a, &mut rec2, &w.ctx(), &c, Some(&sign("buyer", CHL, &c)))), "SCOPE_MISMATCH");
    assert_eq!(rec.ledger, before);
    assert_eq!(rec.ledger.funders.values().map(|f| f.quarantined).sum::<u128>(), 2 * NEAR, "excess stays native QUARANTINED");
    rec.ledger.check_conservation().unwrap();
}
