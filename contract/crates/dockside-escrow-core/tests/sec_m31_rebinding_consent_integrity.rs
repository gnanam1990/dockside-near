//! External security audit, m31: integrity of successor-revision consents.
//!
//! (a) A key rebinding that changes one party's key is anchored by the other party. That
//!     counterparty must not be able to seize the rebound party's role on its own: the rebound
//!     party's old bound key (while not revoked on chain) can veto the pending rebinding, and a
//!     trade whose signed delay is zero (no veto window) cannot rebind a party whose old key is
//!     still live on chain.
//! (b) A revoked consent fails closed (TDD §7 step 10): once a party that consented withdraws a
//!     destination change or a key rebinding, its signature over that successor digest cannot be
//!     replayed to restore the change.

mod common;
use common::evidence::*;
use common::release::*;
use common::*;
use dockside_escrow_core::TradeRecord;

const REVISION: &str = "dockside/trade-revision";

fn rebound(rec: &TradeRecord, active: &J, changes: &[(&str, &str)]) -> J {
    let mut t = active.clone();
    set(&mut t, &["revision"], u(rec.terms.revision + 1));
    set(&mut t, &["predecessorDigest"], s(&rec.terms_digest));
    for (role, label) in changes {
        match *role {
            "manifestAttestor" | "policySetter" => {
                let cur: u64 = t["struct"][*role]["struct"]["keyVersion"]["u64"].as_str().unwrap().parse().unwrap();
                set(&mut t, &[*role, "keyVersion"], u(cur + 1));
                set(&mut t, &[*role, "publicKey"], s(&pk(label)));
            }
            _ => {
                set(&mut t, &[*role, "keyVersionId"], s(&id("key", label)));
                set(&mut t, &[*role, "publicKey"], s(&pk(label)));
            }
        }
    }
    t
}

fn propose_rb(w: &World, rec: &mut TradeRecord, t: &J, role: &str, signer: &str) -> Result<String, dockside_escrow_core::Error> {
    rec.propose_key_rebinding(&w.ctx(), t, role, &sign(signer, REVISION, t))
}

fn consent_rb(w: &World, rec: &mut TradeRecord, t: &J, role: &str, signer: &str) -> Result<u64, dockside_escrow_core::Error> {
    rec.consent_key_rebinding(&w.ctx(), &digest_hex(REVISION, t), role, &sign(signer, REVISION, t))
}

fn revoke_payload(w: &World, rec: &TradeRecord, d: &str, role: &str, n: &str) -> J {
    with_header(
        rec,
        vec![
            ("successorDigest", s(d)),
            ("signerRole", s(role)),
            ("issuedAt", u(w.now)),
            ("expiresAt", u(w.now + HOUR)),
            ("nonce", s(&nonce(n))),
        ],
    )
}

fn revoke_rb(w: &World, rec: &mut TradeRecord, d: &str, role: &str, signer: &str, n: &str) -> &'static str {
    let p = revoke_payload(w, rec, d, role, n);
    code(rec.revoke_key_rebinding(&w.ctx(), &p, &sign(signer, "dockside/key-rebinding-revoke", &p)))
}

fn revoke_dest(w: &World, rec: &mut TradeRecord, d: &str, role: &str, signer: &str, n: &str) -> &'static str {
    let p = revoke_payload(w, rec, d, role, n);
    code(rec.revoke_destination_change(&w.ctx(), &p, &sign(signer, "dockside/destination-change-revoke", &p)))
}

fn self_revoke(w: &World, rec: &mut TradeRecord, role: &str, signer: &str, n: &str) {
    let bound = rec.terms.all_keys().into_iter().find(|(r, _)| *r == role).map(|(_, k)| k.to_string()).unwrap();
    let rk = with_header(
        rec,
        vec![
            ("role", s(role)),
            ("publicKey", s(&bound)),
            ("signerRole", s("SELF")),
            ("reasonCode", s("KEY_COMPROMISE")),
            ("issuedAt", u(w.now)),
            ("expiresAt", u(w.now + HOUR)),
            ("nonce", s(&nonce(n))),
        ],
    );
    rec.revoke_key(&w.ctx(), &rk, &sign(signer, "dockside/bound-key-revocation", &rk)).unwrap();
}

/// The supplier writes a successor that rebinds the buyer and every non-party key to keys it
/// generated, signs "as the buyer" with its own new key and consents with its real key.
fn takeover(w: &World, rec: &mut TradeRecord) -> (J, String) {
    let t = rebound(
        rec,
        &evidence_terms(),
        &[
            ("buyer", "mallory-buyer"),
            ("inspector", "mallory-inspector"),
            ("riskResolver", "mallory-risk"),
            ("manifestAttestor", "mallory-attestor"),
            ("policySetter", "mallory-policy"),
        ],
    );
    let d = propose_rb(w, rec, &t, "BUYER", "mallory-buyer").unwrap();
    consent_rb(w, rec, &t, "SUPPLIER", "supplier").unwrap();
    (t, d)
}

#[test]
fn m31a_the_rebound_partys_live_old_key_vetoes_a_counterparty_rebinding() {
    let (mut w, mut rec) = ready();
    let (t, d) = takeover(&w, &mut rec);
    // The real buyer still holds the key the active revision binds: it can withdraw the rebinding.
    assert_eq!(revoke_rb(&w, &mut rec, &d, "BUYER", "buyer", "veto"), "OK");
    assert_eq!(rec.rebinding.history.last().unwrap().status.as_str(), "REVOKED");
    w.now += rec.terms.destination_change_delay_ms;
    assert_eq!(code(rec.activate_key_rebinding(&w.ctx(), &d)), "NOT_FOUND");
    assert_eq!(rec.terms.buyer.public_key, pk("buyer"));
    assert_eq!(rec.terms.revision, 1);
    // The vetoed successor cannot be restored by replaying its signatures.
    assert_eq!(code(propose_rb(&w, &mut rec, &t, "BUYER", "mallory-buyer")), "NONCE_REPLAYED");
    assert!(rec.rebinding.pending.is_none());
    // A stranger key still cannot revoke in the buyer's role.
    let (w, mut rec) = ready();
    let (_, d) = takeover(&w, &mut rec);
    assert_eq!(revoke_rb(&w, &mut rec, &d, "BUYER", "risk", "x"), "SIGNATURE_INVALID");
}

#[test]
fn m31a_an_old_key_revoked_on_chain_no_longer_vetoes_and_the_recovery_rebinding_activates() {
    // Compromise: the buyer self-revokes its old key, so whoever holds it cannot veto any more.
    let (mut w, mut rec) = ready();
    self_revoke(&w, &mut rec, "buyer", "buyer", "rb");
    let t = rebound(&rec, &evidence_terms(), &[("buyer", "buyer-2")]);
    let d = propose_rb(&w, &mut rec, &t, "SUPPLIER", "supplier").unwrap();
    consent_rb(&w, &mut rec, &t, "BUYER", "buyer-2").unwrap();
    assert_eq!(revoke_rb(&w, &mut rec, &d, "BUYER", "buyer", "veto"), "KEY_REVOKED");
    w.now += rec.terms.destination_change_delay_ms;
    assert_eq!(code(rec.activate_key_rebinding(&w.ctx(), &d)), "OK");
    assert_eq!(rec.terms.buyer.public_key, pk("buyer-2"));
}

#[test]
fn m31a_zero_signed_delay_cannot_rebind_a_party_whose_old_key_is_live() {
    let mut terms = evidence_terms();
    set(&mut terms, &["delayPolicy", "destinationChangeDelayMs"], u(0));
    let (w, mut rec) = registered_with(&terms);
    rec.register_evidence_policy(&policy()).unwrap();
    let t = rebound(&rec, &terms, &[("buyer", "mallory-buyer")]);
    let d = propose_rb(&w, &mut rec, &t, "BUYER", "mallory-buyer").unwrap();
    consent_rb(&w, &mut rec, &t, "SUPPLIER", "supplier").unwrap();
    // No window for the old key to veto: activation is refused while that key is live on chain.
    assert_eq!(code(rec.activate_key_rebinding(&w.ctx(), &d)), "INVALID_STATE");
    assert_eq!(rec.terms.buyer.public_key, pk("buyer"));
    // Once the buyer retires the old key itself, the zero-delay rebinding activates.
    self_revoke(&w, &mut rec, "buyer", "buyer", "rb");
    assert_eq!(code(rec.activate_key_rebinding(&w.ctx(), &d)), "OK");
    assert_eq!(rec.terms.buyer.public_key, pk("mallory-buyer"));
    // A non-party rebinding under a zero delay is unaffected.
    let (w, mut rec) = registered_with(&terms);
    rec.register_evidence_policy(&policy()).unwrap();
    let t = rebound(&rec, &terms, &[("inspector", "inspector-2")]);
    let d = propose_rb(&w, &mut rec, &t, "SUPPLIER", "supplier").unwrap();
    consent_rb(&w, &mut rec, &t, "BUYER", "buyer").unwrap();
    assert_eq!(code(rec.activate_key_rebinding(&w.ctx(), &d)), "OK");
}

#[test]
fn m31b_a_revoked_destination_consent_cannot_be_replayed() {
    for (revoker, signer) in [("BUYER", "buyer"), ("SUPPLIER", "supplier")] {
        let (mut w, mut rec) = ready();
        let t = successor_terms(&rec, ALT_DEST);
        let d = propose(&w, &mut rec, ALT_DEST, "SUPPLIER", "supplier").unwrap();
        consent_dest(&w, &mut rec, ALT_DEST, "BUYER", "buyer").unwrap();
        assert_eq!(revoke_dest(&w, &mut rec, &d, revoker, signer, "rv"), "OK");
        // Anyone replays the earlier public signatures.
        let supplier_sig = sign("supplier", REVISION, &t);
        let buyer_sig = sign("buyer", REVISION, &t);
        let first = if revoker == "SUPPLIER" {
            code(rec.propose_destination_change(&w.ctx(), &t, "SUPPLIER", &supplier_sig))
        } else {
            rec.propose_destination_change(&w.ctx(), &t, "SUPPLIER", &supplier_sig).unwrap();
            code(rec.consent_destination_change(&w.ctx(), &d, "BUYER", &buyer_sig))
        };
        assert_eq!(first, "NONCE_REPLAYED", "{revoker}");
        // The buyer's own proposal path is closed too when the buyer withdrew.
        if revoker == "BUYER" {
            assert_eq!(revoke_dest(&w, &mut rec, &d, "SUPPLIER", "supplier", "rv2"), "OK");
            assert_eq!(code(rec.propose_destination_change(&w.ctx(), &t, "BUYER", &buyer_sig)), "NONCE_REPLAYED");
        }
        w.now += rec.terms.destination_change_delay_ms;
        assert_eq!(code(rec.activate_destination_change(&w.ctx(), &d)), "NOT_FOUND");
        assert_eq!(rec.terms.payout_destination, SUPPLIER_ACCT);
    }
}

#[test]
fn m31b_rejecting_an_unconsented_proposal_keeps_a_later_genuine_consent_possible() {
    // The buyer rejects a supplier proposal it never signed; the supplier proposes the same
    // destination again and the buyer now consents (the product's reject-then-agree flow).
    let (mut w, mut rec) = ready();
    let d = propose(&w, &mut rec, ALT_DEST, "SUPPLIER", "supplier").unwrap();
    assert_eq!(revoke_dest(&w, &mut rec, &d, "BUYER", "buyer", "rv"), "OK");
    assert_eq!(propose(&w, &mut rec, ALT_DEST, "SUPPLIER", "supplier").unwrap(), d);
    consent_dest(&w, &mut rec, ALT_DEST, "BUYER", "buyer").unwrap();
    w.now += rec.terms.destination_change_delay_ms;
    assert_eq!(code(rec.activate_destination_change(&w.ctx(), &d)), "OK");
    assert_eq!(rec.terms.payout_destination, ALT_DEST);
}

#[test]
fn m31b_a_revoked_rebinding_consent_cannot_be_replayed() {
    for (revoker, signer) in [("BUYER", "buyer"), ("SUPPLIER", "supplier")] {
        let (mut w, mut rec) = ready();
        let t = rebound(&rec, &evidence_terms(), &[("inspector", "inspector-2")]);
        let d = propose_rb(&w, &mut rec, &t, "SUPPLIER", "supplier").unwrap();
        consent_rb(&w, &mut rec, &t, "BUYER", "buyer").unwrap();
        assert_eq!(revoke_rb(&w, &mut rec, &d, revoker, signer, "rv"), "OK");
        let replay = if revoker == "SUPPLIER" {
            code(propose_rb(&w, &mut rec, &t, "SUPPLIER", "supplier"))
        } else {
            propose_rb(&w, &mut rec, &t, "SUPPLIER", "supplier").unwrap();
            code(consent_rb(&w, &mut rec, &t, "BUYER", "buyer"))
        };
        assert_eq!(replay, "NONCE_REPLAYED", "{revoker}");
        w.now += rec.terms.destination_change_delay_ms;
        assert_ne!(code(rec.activate_key_rebinding(&w.ctx(), &d)), "OK");
        assert_eq!(rec.terms.revision, 1);
    }
}
