//! On-contract HoldRecord SET/RESOLVE separation and bound-key revocation
//! (contract-side half of T-014 / T-016; INV-10, INV-11).

mod common;
use common::*;
use dockside_escrow_core::refund::RefundSignatures;
use dockside_escrow_core::TradeRecord;

fn hold_set(rec: &TradeRecord, hold: &str, role: &str, rule: Option<&str>, now: u64, ttl: u64) -> J {
    with_header(
        rec,
        vec![
            ("holdId", s(&id("hld", hold))),
            ("manifestDigest", null()),
            ("reasonCode", s("SANCTIONS_SCREEN_MATCH")),
            ("issuerRole", s(role)),
            ("ruleId", opt(rule)),
            ("schema", s("dockside/hold-set@1")),
            ("issuedAt", u(now)),
            ("expiresAt", u(now + ttl)),
            ("nonce", s(&nonce(&format!("set/{hold}")))),
        ],
    )
}

fn hold_resolve(rec: &TradeRecord, hold: &str, n: &str, now: u64) -> J {
    with_header(
        rec,
        vec![
            ("holdId", s(&id("hld", hold))),
            ("holdReasonCode", s("SANCTIONS_SCREEN_MATCH")),
            ("manifestDigest", null()),
            ("resolutionCode", s("RELEASE_HOLD")),
            ("evidenceDigest", s(&"ef".repeat(32))),
            ("resolverRole", s("RISK_RESOLVER")),
            ("schema", s("dockside/hold-resolve@1")),
            ("issuedAt", u(now)),
            ("expiresAt", u(now + HOUR)),
            ("nonce", s(&nonce(&format!("resolve/{n}")))),
        ],
    )
}

#[test]
fn deterministic_policy_and_risk_may_set_but_no_one_else() {
    let (w, mut rec) = registered();
    let p = hold_set(&rec, "h1", "POLICY_SETTER", Some("sanctions-screen@3"), w.now, 24 * HOUR);
    rec.set_hold(&w.ctx(), &p, &sign("policy", "dockside/hold-set", &p)).unwrap();
    let p2 = hold_set(&rec, "h2", "RISK_RESOLVER", None, w.now, 24 * HOUR);
    rec.set_hold(&w.ctx(), &p2, &sign("risk", "dockside/hold-set", &p2)).unwrap();
    assert_eq!(rec.blocking_holds(), 2);
    // Buyer, supplier, inspector and attestor keys cannot SET under either issuer role.
    for (n, label) in ["buyer", "supplier", "inspector", "attestor"].iter().enumerate() {
        let p = hold_set(&rec, &format!("x{n}"), "RISK_RESOLVER", None, w.now, HOUR);
        assert_eq!(code(rec.set_hold(&w.ctx(), &p, &sign(label, "dockside/hold-set", &p))), "SIGNATURE_INVALID", "{label}");
    }
    for role in ["BUYER", "MODEL", "INSPECTOR"] {
        let p = hold_set(&rec, "m1", role, None, w.now, HOUR);
        assert_eq!(code(rec.set_hold(&w.ctx(), &p, &sign("policy", "dockside/hold-set", &p))), "FORBIDDEN", "{role}");
    }
    // Deterministic policy must name the versioned rule it executed.
    let p = hold_set(&rec, "r1", "POLICY_SETTER", None, w.now, HOUR);
    assert_eq!(code(rec.set_hold(&w.ctx(), &p, &sign("policy", "dockside/hold-set", &p))), "VALIDATION_FAILED");
    // Replay of an accepted SET.
    assert_eq!(code(rec.set_hold(&w.ctx(), &p2, &sign("risk", "dockside/hold-set", &p2))), "INVALID_STATE");
}

#[test]
fn only_the_bound_risk_resolver_can_resolve() {
    let (mut w, mut rec) = registered();
    let p = hold_set(&rec, "h1", "POLICY_SETTER", Some("doc-mismatch@1"), w.now, 24 * HOUR);
    rec.set_hold(&w.ctx(), &p, &sign("policy", "dockside/hold-set", &p)).unwrap();
    let r = hold_resolve(&rec, "h1", "a", w.now);
    for label in ["policy", "buyer", "supplier", "inspector", "attestor"] {
        assert_eq!(code(rec.resolve_hold(&w.ctx(), &r, &sign(label, "dockside/hold-resolve", &r))), "SIGNATURE_INVALID", "{label}");
    }
    // A risk SET signature is not a RESOLVE (domain separation).
    assert_eq!(code(rec.resolve_hold(&w.ctx(), &r, &sign("risk", "dockside/hold-set", &r))), "SIGNATURE_INVALID");
    let mutate = |path: &[&str], v: J, expected: &str, rec: &mut TradeRecord, w: &World| {
        let mut m = r.clone();
        set(&mut m, path, v);
        assert_eq!(code(rec.resolve_hold(&w.ctx(), &m, &sign("risk", "dockside/hold-resolve", &m))), expected, "{path:?}");
    };
    mutate(&["resolverRole"], s("DETERMINISTIC_POLICY"), "FORBIDDEN", &mut rec, &w);
    mutate(&["holdReasonCode"], s("OTHER"), "VALIDATION_FAILED", &mut rec, &w);
    mutate(&["tradeRevision"], u(2), "STALE_REVISION", &mut rec, &w);
    mutate(&["manifestDigest"], s(&"aa".repeat(32)), "STALE_MANIFEST", &mut rec, &w);
    mutate(&["resolutionCode"], s("AUTO_PASS"), "VALIDATION_FAILED", &mut rec, &w);
    mutate(&["nonce"], s("00"), "VALIDATION_FAILED", &mut rec, &w);
    mutate(&["expiresAt"], u(w.now + 48 * HOUR), "VALIDATION_FAILED", &mut rec, &w);
    // Expired resolution signature.
    w.now += 2 * HOUR;
    assert_eq!(code(rec.resolve_hold(&w.ctx(), &r, &sign("risk", "dockside/hold-resolve", &r))), "EXPIRED");
    assert_eq!(rec.blocking_holds(), 1);
    let r2 = hold_resolve(&rec, "h1", "b", w.now);
    rec.resolve_hold(&w.ctx(), &r2, &sign("risk", "dockside/hold-resolve", &r2)).unwrap();
    assert_eq!(rec.blocking_holds(), 0);
    assert_eq!(rec.holds[&id("hld", "h1")].status(w.now), "RESOLVED");
    let r3 = hold_resolve(&rec, "h1", "c", w.now);
    assert_eq!(code(rec.resolve_hold(&w.ctx(), &r3, &sign("risk", "dockside/hold-resolve", &r3))), "INVALID_STATE");
}

#[test]
fn expiry_never_clears_a_hold() {
    let (mut w, mut rec) = registered();
    let p = hold_set(&rec, "h1", "RISK_RESOLVER", None, w.now, HOUR);
    rec.set_hold(&w.ctx(), &p, &sign("risk", "dockside/hold-set", &p)).unwrap();
    w.now += 2 * HOUR;
    let h = &rec.holds[&id("hld", "h1")];
    assert_eq!(h.status(w.now), "EXPIRED_UNRESOLVED");
    assert_eq!(rec.blocking_holds(), 1, "an expired-unresolved hold keeps blocking");
    // Trade-expiry and mutual-cancel refund authorization read the hold state.
    rec.fund(&w.as_caller(BUYER_ACCT).ctx(), 10 * NEAR, 1).unwrap();
    let mut req = with_header(
        &rec,
        vec![
            ("refundIntentId", s(&id("rfd", "c"))),
            ("policyId", s("dockside-refund-v1")),
            ("policyRevision", u(1)),
            ("reason", s("MUTUAL_CANCEL")),
            ("funder", s(BUYER_ACCT)),
            ("amountYocto", big(10 * NEAR)),
            ("sourceBucket", s("AVAILABLE")),
            ("initiatorRole", s("BUYER")),
            ("issuedAt", u(w.now)),
            ("expiresAt", u(w.now + HOUR)),
            ("nonce", s(&nonce("c"))),
        ],
    );
    let id_ = rec
        .request_refund(&w.ctx(), &req, RefundSignatures { buyer: Some(&sign("buyer", "dockside/refund-request", &req)), supplier: Some(&sign("supplier", "dockside/refund-request", &req)), risk: None })
        .unwrap();
    w.now += HOUR;
    assert_eq!(code(rec.authorize_refund(&w.ctx(), &id_)), "HOLD_ACTIVE");
    set(&mut req, &["nonce"], s(&nonce("unused")));
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
fn revoked_bound_keys_lose_authority_immediately() {
    let (w, mut rec) = registered();
    // A party cannot revoke the other party.
    let bad = revocation(&rec, "supplier", "BUYER", "r0", w.now);
    assert_eq!(code(rec.revoke_key(&w.ctx(), &bad, &sign("buyer", "dockside/bound-key-revocation", &bad))), "FORBIDDEN");
    // Buyer revokes the risk resolver key; the risk resolver can then neither SET nor RESOLVE.
    let r = revocation(&rec, "riskResolver", "BUYER", "r1", w.now);
    assert_eq!(code(rec.revoke_key(&w.ctx(), &r, &sign("supplier", "dockside/bound-key-revocation", &r))), "SIGNATURE_INVALID");
    rec.revoke_key(&w.ctx(), &r, &sign("buyer", "dockside/bound-key-revocation", &r)).unwrap();
    let p = hold_set(&rec, "h9", "RISK_RESOLVER", None, w.now, HOUR);
    assert_eq!(code(rec.set_hold(&w.ctx(), &p, &sign("risk", "dockside/hold-set", &p))), "KEY_REVOKED");
    // Self-revocation of the policy setter.
    let r2 = revocation(&rec, "policySetter", "SELF", "r2", w.now);
    rec.revoke_key(&w.ctx(), &r2, &sign("policy", "dockside/bound-key-revocation", &r2)).unwrap();
    let p = hold_set(&rec, "h8", "POLICY_SETTER", Some("x@1"), w.now, HOUR);
    assert_eq!(code(rec.set_hold(&w.ctx(), &p, &sign("policy", "dockside/hold-set", &p))), "KEY_REVOKED");
    // A rotated key that the revision does not bind cannot be substituted.
    let mut r3 = revocation(&rec, "inspector", "SELF", "r3", w.now);
    set(&mut r3, &["publicKey"], s(&pk("inspector-v2")));
    assert_eq!(code(rec.revoke_key(&w.ctx(), &r3, &sign("inspector-v2", "dockside/bound-key-revocation", &r3))), "KEY_NOT_BOUND");
    assert_eq!(rec.revoked_roles.len(), 2);
}
