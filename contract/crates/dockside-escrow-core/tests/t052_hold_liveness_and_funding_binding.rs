//! External security audit follow-ups (m32):
//! (a) one trade party alone cannot revoke the risk resolver key, the only authority that can
//!     RESOLVE a hold, so a party cannot strand escrow behind an unresolved hold;
//! (b) a deposit names the trade revision digest the funder agreed to, so a record registered
//!     first under the same trade id with other terms cannot capture it.

mod common;
use common::*;
use dockside_escrow_core::{register, TradeRecord};

fn hold_set(rec: &TradeRecord, hold: &str, now: u64) -> J {
    with_header(
        rec,
        vec![
            ("holdId", s(&id("hld", hold))),
            ("manifestDigest", null()),
            ("reasonCode", s("INSPECTION_FAIL")),
            ("issuerRole", s("POLICY_SETTER")),
            ("ruleId", s("inspection-fail@1")),
            ("schema", s("dockside/hold-set@1")),
            ("issuedAt", u(now)),
            ("expiresAt", u(now + 24 * HOUR)),
            ("nonce", s(&nonce(&format!("set/{hold}")))),
        ],
    )
}

fn hold_resolve(rec: &TradeRecord, hold: &str, now: u64) -> J {
    with_header(
        rec,
        vec![
            ("holdId", s(&id("hld", hold))),
            ("holdReasonCode", s("INSPECTION_FAIL")),
            ("manifestDigest", null()),
            ("resolutionCode", s("RELEASE_HOLD")),
            ("evidenceDigest", s(&"ef".repeat(32))),
            ("resolverRole", s("RISK_RESOLVER")),
            ("schema", s("dockside/hold-resolve@1")),
            ("issuedAt", u(now)),
            ("expiresAt", u(now + HOUR)),
            ("nonce", s(&nonce(&format!("resolve/{hold}")))),
        ],
    )
}

fn revocation(rec: &TradeRecord, role: &str, signer: &str, n: &str, now: u64) -> J {
    let bound = rec.terms.all_keys().into_iter().find(|(r, _)| *r == role).unwrap().1.to_string();
    with_header(
        rec,
        vec![
            ("role", s(role)),
            ("publicKey", s(&bound)),
            ("signerRole", s(signer)),
            ("reasonCode", s("KEY_COMPROMISE")),
            ("issuedAt", u(now)),
            ("expiresAt", u(now + HOUR)),
            ("nonce", s(&nonce(n))),
        ],
    )
}

#[test]
fn a_party_alone_cannot_revoke_the_risk_resolver_under_a_hold() {
    let (w, mut rec) = registered();
    rec.fund(&w.ctx(), 10 * NEAR, 1).unwrap();
    let p = hold_set(&rec, "h1", w.now);
    rec.set_hold(&w.ctx(), &p, &sign("policy", "dockside/hold-set", &p)).unwrap();
    assert_eq!(rec.blocking_holds(), 1);
    for (signer, label) in [("SUPPLIER", "supplier"), ("BUYER", "buyer")] {
        let r = revocation(&rec, "riskResolver", signer, &format!("rr/{label}"), w.now);
        assert_eq!(code(rec.revoke_key(&w.ctx(), &r, &sign(label, "dockside/bound-key-revocation", &r))), "FORBIDDEN", "{signer}");
    }
    assert!(!rec.revoked_roles.contains("riskResolver"));
    // The hold stays resolvable by the bound risk/policy principal.
    let r = hold_resolve(&rec, "h1", w.now);
    rec.resolve_hold(&w.ctx(), &r, &sign("risk", "dockside/hold-resolve", &r)).unwrap();
    assert_eq!(rec.blocking_holds(), 0);
}

#[test]
fn a_party_alone_cannot_revoke_the_risk_resolver_before_a_hold_either() {
    // Revoking first and letting the deterministic policy set the hold later strands the trade the same way.
    let (w, mut rec) = registered();
    let r = revocation(&rec, "riskResolver", "SUPPLIER", "rr", w.now);
    assert_eq!(code(rec.revoke_key(&w.ctx(), &r, &sign("supplier", "dockside/bound-key-revocation", &r))), "FORBIDDEN");
    let p = hold_set(&rec, "h1", w.now);
    rec.set_hold(&w.ctx(), &p, &sign("policy", "dockside/hold-set", &p)).unwrap();
    let r = hold_resolve(&rec, "h1", w.now);
    rec.resolve_hold(&w.ctx(), &r, &sign("risk", "dockside/hold-resolve", &r)).unwrap();
}

#[test]
fn the_risk_resolver_key_can_still_revoke_itself_and_parties_keep_other_revocations() {
    let (w, mut rec) = registered();
    let r = revocation(&rec, "riskResolver", "SELF", "self", w.now);
    rec.revoke_key(&w.ctx(), &r, &sign("risk", "dockside/bound-key-revocation", &r)).unwrap();
    assert!(rec.revoked_roles.contains("riskResolver"));
    for (n, role) in ["inspector", "manifestAttestor", "policySetter"].iter().enumerate() {
        let signer = if n % 2 == 0 { ("BUYER", "buyer") } else { ("SUPPLIER", "supplier") };
        let r = revocation(&rec, role, signer.0, &format!("p{n}"), w.now);
        rec.revoke_key(&w.ctx(), &r, &sign(signer.1, "dockside/bound-key-revocation", &r)).unwrap();
    }
    assert_eq!(rec.revoked_roles.len(), 4);
}

/// The supplier (or anyone who saw the proposal package) registers the same trade id first, with
/// terms whose every bound key and payout it controls.
fn squatted_terms() -> J {
    let mut t = terms();
    for (path, label) in [
        ("buyer", "sq-buyer"),
        ("supplier", "sq-supplier"),
        ("inspector", "sq-inspector"),
        ("riskResolver", "sq-risk"),
        ("manifestAttestor", "sq-attestor"),
        ("policySetter", "sq-policy"),
    ] {
        set(&mut t, &[path, "publicKey"], s(&pk(label)));
    }
    set(&mut t, &["payout", "destination"], s("squatter.testnet"));
    t
}

#[test]
fn a_deposit_binds_the_agreed_terms_digest() {
    let agreed = terms();
    let agreed_digest = digest_hex("dockside/trade-revision", &agreed);
    let sq = squatted_terms();
    let w = World::new();
    let mut squat = register(&w.ctx(), &sq, &sign("sq-buyer", "dockside/trade-revision", &sq), &sign("sq-supplier", "dockside/trade-revision", &sq)).unwrap();
    assert_eq!(squat.terms.trade_id, rec_trade_id(&agreed), "same trade id");
    assert_ne!(squat.terms_digest, agreed_digest);
    // The buyer funds the digest it signed: the squatted record refuses the deposit.
    let buyer = &w;
    assert_eq!(code(squat.fund_exact(&buyer.ctx(), &agreed_digest, 10 * NEAR, 1)), "STALE_REVISION");
    assert_eq!(squat.ledger.committed(), 0);
    // The genuine record accepts the same deposit.
    let (_, mut rec) = registered_with(&agreed);
    let o = rec.fund_exact(&buyer.ctx(), &agreed_digest, 10 * NEAR, 1).unwrap();
    assert!(o.fully_funded);
    // A malformed or stale digest fails closed as well.
    assert_eq!(code(rec.fund_exact(&buyer.ctx(), "zz", NEAR, 1)), "VALIDATION_FAILED");
    assert_eq!(code(rec.fund_exact(&buyer.ctx(), &"00".repeat(32), NEAR, 1)), "STALE_REVISION");
}

fn rec_trade_id(t: &J) -> String {
    let w = World::new();
    register(&w.ctx(), t, &sign("buyer", "dockside/trade-revision", t), &sign("supplier", "dockside/trade-revision", t)).unwrap().terms.trade_id
}
