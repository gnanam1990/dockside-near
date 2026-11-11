//! T-016 at the contract boundary: an expired-unresolved hold keeps blocking until a valid signed
//! risk/policy resolution; resolution nonces are single-use across holds; a revoked resolver key
//! cannot clear a hold that was set before the revocation.

mod common;
use common::*;
use dockside_escrow_core::TradeRecord;

fn set_payload(rec: &TradeRecord, hold: &str, now: u64, ttl: u64) -> J {
    with_header(
        rec,
        vec![
            ("holdId", s(&id("hld", hold))),
            ("manifestDigest", null()),
            ("reasonCode", s("DOC_MISMATCH")),
            ("issuerRole", s("POLICY_SETTER")),
            ("ruleId", s("doc-mismatch@1")),
            ("schema", s("dockside/hold-set@1")),
            ("issuedAt", u(now)),
            ("expiresAt", u(now + ttl)),
            ("nonce", s(&nonce(&format!("set/{hold}")))),
        ],
    )
}

fn resolve_payload(rec: &TradeRecord, hold: &str, n: &str, now: u64) -> J {
    with_header(
        rec,
        vec![
            ("holdId", s(&id("hld", hold))),
            ("holdReasonCode", s("DOC_MISMATCH")),
            ("manifestDigest", null()),
            ("resolutionCode", s("RETRY_INSPECTION")),
            ("evidenceDigest", s(&"ab".repeat(32))),
            ("resolverRole", s("RISK_RESOLVER")),
            ("schema", s("dockside/hold-resolve@1")),
            ("issuedAt", u(now)),
            ("expiresAt", u(now + HOUR)),
            ("nonce", s(&nonce(n))),
        ],
    )
}

#[test]
fn expired_unresolved_blocks_until_a_valid_risk_resolution() {
    let (mut w, mut rec) = registered();
    let p = set_payload(&rec, "e1", w.now, HOUR);
    rec.set_hold(&w.ctx(), &p, &sign("policy", "dockside/hold-set", &p)).unwrap();
    w.now += 3 * HOUR;
    assert_eq!(rec.holds[&id("hld", "e1")].status(w.now), "EXPIRED_UNRESOLVED");
    assert_eq!(rec.blocking_holds(), 1);
    // The deterministic-policy key cannot clear its own expired hold.
    let r = resolve_payload(&rec, "e1", "e1-a", w.now);
    assert_eq!(code(rec.resolve_hold(&w.ctx(), &r, &sign("policy", "dockside/hold-resolve", &r))), "SIGNATURE_INVALID");
    assert_eq!(rec.blocking_holds(), 1);
    rec.resolve_hold(&w.ctx(), &r, &sign("risk", "dockside/hold-resolve", &r)).unwrap();
    assert_eq!(rec.holds[&id("hld", "e1")].status(w.now), "RESOLVED");
    assert_eq!(rec.blocking_holds(), 0);
}

#[test]
fn resolution_nonces_are_single_use_across_holds() {
    let (w, mut rec) = registered();
    for h in ["n1", "n2"] {
        let p = set_payload(&rec, h, w.now, DAY_MS);
        rec.set_hold(&w.ctx(), &p, &sign("policy", "dockside/hold-set", &p)).unwrap();
    }
    let r1 = resolve_payload(&rec, "n1", "shared", w.now);
    rec.resolve_hold(&w.ctx(), &r1, &sign("risk", "dockside/hold-resolve", &r1)).unwrap();
    let r2 = resolve_payload(&rec, "n2", "shared", w.now);
    assert_eq!(code(rec.resolve_hold(&w.ctx(), &r2, &sign("risk", "dockside/hold-resolve", &r2))), "NONCE_REPLAYED");
    assert_eq!(rec.blocking_holds(), 1);
}

#[test]
fn a_revoked_resolver_cannot_clear_an_existing_hold() {
    let (w, mut rec) = registered();
    let p = set_payload(&rec, "v1", w.now, DAY_MS);
    rec.set_hold(&w.ctx(), &p, &sign("policy", "dockside/hold-set", &p)).unwrap();
    let bound = rec.terms.all_keys().into_iter().find(|(r, _)| *r == "riskResolver").unwrap().1.to_string();
    let rv = with_header(
        &rec,
        vec![
            ("role", s("riskResolver")),
            ("publicKey", s(&bound)),
            ("signerRole", s("SELF")),
            ("reasonCode", s("KEY_COMPROMISE")),
            ("issuedAt", u(w.now)),
            ("expiresAt", u(w.now + HOUR)),
            ("nonce", s(&nonce("rv"))),
        ],
    );
    rec.revoke_key(&w.ctx(), &rv, &sign("risk", "dockside/bound-key-revocation", &rv)).unwrap();
    let r = resolve_payload(&rec, "v1", "v1-a", w.now);
    assert_eq!(code(rec.resolve_hold(&w.ctx(), &r, &sign("risk", "dockside/hold-resolve", &r))), "KEY_REVOKED");
    assert_eq!(rec.holds[&id("hld", "v1")].status(w.now), "ACTIVE");
}

const DAY_MS: u64 = 24 * HOUR;
