//! T-006 (rotation, revocation and recovery need an explicit dual-signed trade revision and
//! downstream reauthority) and the key-rebinding half of TDD §4 at the contract boundary.
//!
//! A key rebinding is a successor revision that changes only bound key versions and public keys.
//! At most one party key changes per revision; the other party's bound key anchors it. The new
//! party key signs for itself; a delay applies when a party key changes; activation invalidates
//! the manifest, inspection, holds view, approvals and pre-submit intent of the old revision.

mod common;
use common::evidence::*;
use common::release::*;
use common::*;
use dockside_escrow_core::release::IntentState;
use dockside_escrow_core::TradeRecord;

const REVISION: &str = "dockside/trade-revision";

/// Successor of `active` (typed terms of the active revision) with `changes` applied.
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

fn activate_rb(w: &World, rec: &mut TradeRecord, d: &str) -> &'static str {
    code(rec.activate_key_rebinding(&w.ctx(), d))
}

#[test]
fn t006_successor_may_change_only_key_versions_of_existing_roles() {
    let (w, mut rec) = ready();
    let active = evidence_terms();
    let base = rebound(&rec, &active, &[("buyer", "buyer-2")]);
    let cases: Vec<(&[&str], J, &str)> = vec![
        (&["amountYocto"], big(1), "IMMUTABLE_FIELD"),
        (&["payout", "destination"], s(ALT_DEST), "IMMUTABLE_FIELD"),
        (&["buyer", "principalId"], s(&id("prn", "mallory")), "IMMUTABLE_FIELD"),
        (&["buyer", "accountId"], s("mallory.testnet"), "IMMUTABLE_FIELD"),
        (&["inspector", "principalId"], s(&id("prn", "other-inspector")), "IMMUTABLE_FIELD"),
        (&["manifestAttestor", "enrollmentId"], s(&id("svc", "other")), "IMMUTABLE_FIELD"),
        (&["manifestAttestor", "serviceId"], s("other-attestor"), "IMMUTABLE_FIELD"),
        (&["delayPolicy", "destinationChangeDelayMs"], u(0), "IMMUTABLE_FIELD"),
        (&["revision"], u(3), "VERSION_CONFLICT"),
        (&["predecessorDigest"], s(&"00".repeat(32)), "VERSION_CONFLICT"),
        // Same public key under another version id, or another key under the same id.
        (&["buyer", "publicKey"], s(&pk("buyer")), "VALIDATION_FAILED"),
        (&["buyer", "keyVersionId"], s(&id("key", "buyer-1")), "VALIDATION_FAILED"),
        // A new key that equals another role's key breaks key independence.
        (&["buyer", "publicKey"], s(&pk("supplier")), "SEPARATION_OF_DUTIES"),
    ];
    for (path, v, want) in cases {
        let mut t = base.clone();
        set(&mut t, path, v);
        assert_eq!(code(propose_rb(&w, &mut rec, &t, "SUPPLIER", "supplier")), want, "{path:?}");
    }
    // Nothing rebound is not a rebinding.
    let none = rebound(&rec, &active, &[]);
    assert_eq!(code(propose_rb(&w, &mut rec, &none, "SUPPLIER", "supplier")), "VALIDATION_FAILED");
    // Both party keys in one revision: nothing the contract already binds would anchor it.
    let both = rebound(&rec, &active, &[("buyer", "buyer-2"), ("supplier", "supplier-2")]);
    assert_eq!(code(propose_rb(&w, &mut rec, &both, "SUPPLIER", "supplier-2")), "SEPARATION_OF_DUTIES");
    // A service key cannot go back to an older (or the same) version.
    let mut older = rebound(&rec, &active, &[("manifestAttestor", "attestor-2")]);
    set(&mut older, &["manifestAttestor", "keyVersion"], u(1));
    assert_eq!(code(propose_rb(&w, &mut rec, &older, "SUPPLIER", "supplier")), "VALIDATION_FAILED");
    assert!(rec.rebinding.pending.is_none());
    assert_eq!(rec.terms.revision, 1);
}

#[test]
fn t006_signers_old_party_key_cannot_sign_for_a_new_one_and_non_parties_cannot_sign() {
    let (w, mut rec) = ready();
    let active = evidence_terms();
    let t = rebound(&rec, &active, &[("buyer", "buyer-2")]);
    for (role, signer, want) in [
        // The rebound buyer signs with its NEW key; its old key no longer speaks for it here.
        ("BUYER", "buyer", "SIGNATURE_INVALID"),
        // The unchanged supplier signs with the key the active revision binds.
        ("SUPPLIER", "supplier-2", "SIGNATURE_INVALID"),
        ("SUPPLIER", "risk", "SIGNATURE_INVALID"),
        ("BUYER", "attestor", "SIGNATURE_INVALID"),
        ("RISK_RESOLVER", "risk", "FORBIDDEN"),
        ("INSPECTOR", "inspector", "FORBIDDEN"),
        ("ADMIN", "buyer-2", "FORBIDDEN"),
    ] {
        assert_eq!(code(propose_rb(&w, &mut rec, &t, role, signer)), want, "{role}/{signer}");
    }
    assert!(rec.rebinding.pending.is_none());
    // A legitimate unilateral proposal never activates on its own.
    let d = propose_rb(&w, &mut rec, &t, "BUYER", "buyer-2").unwrap();
    assert_eq!(activate_rb(&w, &mut rec, &d), "INVALID_STATE");
    assert_eq!(code(consent_rb(&w, &mut rec, &t, "BUYER", "buyer-2")), "INVALID_STATE", "no double consent");
    assert_eq!(code(consent_rb(&w, &mut rec, &t, "SUPPLIER", "supplier-2")), "SIGNATURE_INVALID");
    assert_eq!(code(consent_rb(&w, &mut rec, &t, "RISK_RESOLVER", "risk")), "FORBIDDEN");
    // A consent over another successor digest fails closed.
    let other = rebound(&rec, &active, &[("buyer", "buyer-3")]);
    assert_eq!(code(rec.consent_key_rebinding(&w.ctx(), &digest_hex(REVISION, &other), "SUPPLIER", &sign("supplier", REVISION, &other))), "DIGEST_MISMATCH");
    // One pending successor revision at a time, of either kind.
    assert_eq!(code(propose_rb(&w, &mut rec, &other, "BUYER", "buyer-3")), "KEY_REBINDING_PENDING");
    assert_eq!(code(propose(&w, &mut rec, ALT_DEST, "SUPPLIER", "supplier")), "KEY_REBINDING_PENDING");
    assert_eq!(rec.terms.revision, 1);
}

#[test]
fn t006_a_pending_destination_change_excludes_a_rebinding() {
    let (w, mut rec) = ready();
    propose(&w, &mut rec, ALT_DEST, "SUPPLIER", "supplier").unwrap();
    let t = rebound(&rec, &evidence_terms(), &[("inspector", "inspector-2")]);
    assert_eq!(code(propose_rb(&w, &mut rec, &t, "SUPPLIER", "supplier")), "DESTINATION_CHANGE_PENDING");
}

#[test]
fn t006_party_rebinding_waits_the_signed_delay_and_supersedes_every_release_fact() {
    let (mut w, mut rec, iid) = authorized();
    let old_approval = approval_payload(&rec, &iid, w.now, "old");
    let old_holds_view = rec.holds_view_digest(w.now).unwrap();
    let old_manifest = rec.evidence.current.clone().unwrap();
    let t = rebound(&rec, &evidence_terms(), &[("buyer", "buyer-2")]);
    let d = propose_rb(&w, &mut rec, &t, "BUYER", "buyer-2").unwrap();
    w.now += HOUR;
    let until = consent_rb(&w, &mut rec, &t, "SUPPLIER", "supplier").unwrap();
    assert_eq!(until, w.now + rec.terms.destination_change_delay_ms);
    w.now = until - 1;
    assert_eq!(activate_rb(&w, &mut rec, &d), "DELAY_NOT_ELAPSED");
    assert_eq!(rec.terms.buyer.public_key, pk("buyer"), "the bound key stays effective until activation");
    w.now = until;
    let (digest, succ) = rec.activate_key_rebinding(&w.ctx(), &d).unwrap();
    let succ = succ.unwrap();
    assert_eq!((rec.terms.revision, digest.as_str()), (2, d.as_str()));
    assert_eq!(rec.terms.buyer.public_key, pk("buyer-2"));
    assert_eq!(rec.terms.payout_destination, SUPPLIER_ACCT, "destination unchanged");
    assert_eq!(rec.rebinding.history.last().unwrap().status.as_str(), "ACTIVATED");
    // The approved intent is superseded; one successor owns the same reservation, unapproved.
    assert_eq!(intent(&rec, &iid).state, IntentState::SupersededPreSubmit);
    let s_i = intent(&rec, &succ);
    assert_eq!((s_i.state, s_i.trade_revision, s_i.destination.as_str()), (IntentState::ValueLocked, 2, SUPPLIER_ACCT));
    assert!(s_i.approval.is_none());
    assert!(rec.ledger.reservation_matches(&s_i.slice_pairs()));
    // Manifest, inspection and holds view of revision 1 no longer count.
    assert!(rec.evidence.current.is_none());
    assert_eq!(rec.evidence.history.last().unwrap().digest, old_manifest.digest);
    assert!(rec.evidence.current_inspection(w.now).is_none());
    assert_ne!(rec.holds_view_digest(w.now).unwrap(), old_holds_view);
    let b = rec.release_blockers(w.now);
    assert!(b.contains(&"MANIFEST_NOT_CURRENT") && b.contains(&"INSPECTION_NOT_PASS") && b.contains(&"APPROVAL_MISSING"), "{b:?}");
    // Every payload signed for revision 1 is stale; the old buyer key approves nothing.
    assert_eq!(code(rec.approve_release(&w.ctx(), &old_approval, &sign("buyer", "dockside/buyer-approval", &old_approval))), "STALE_REVISION");
    assert_eq!(code(rec.execute_release(&w.ctx(), &succ)), "MANIFEST_NOT_CURRENT");
    // Renewed authority: new manifest revision, new inspection, approval by the NEW buyer key.
    attest_and_inspect(&w, &mut rec, 2, "PASS", "rb2");
    assert_eq!(rec.release_blockers(w.now), vec!["APPROVAL_MISSING"]);
    let p = approval_payload(&rec, &succ, w.now, "rb2");
    assert_eq!(code(rec.approve_release(&w.ctx(), &p, &sign("buyer", "dockside/buyer-approval", &p))), "SIGNATURE_INVALID");
    assert_eq!(code(rec.approve_release(&w.ctx(), &p, &sign("buyer-2", "dockside/buyer-approval", &p))), "OK");
    let (dest, amount, attempt) = rec.execute_release(&w.ctx(), &succ).unwrap();
    assert_eq!((dest.as_str(), amount), (SUPPLIER_ACCT, 10 * NEAR));
    rec.complete_release(&w.ctx(), &succ, &attempt, true).unwrap();
    rec.ledger.check_conservation().unwrap();
}

#[test]
fn t006_service_and_non_party_rebinding_needs_both_consents_but_no_delay() {
    let (w, mut rec) = ready();
    let t = rebound(&rec, &evidence_terms(), &[("manifestAttestor", "attestor-2"), ("riskResolver", "risk-2")]);
    let d = propose_rb(&w, &mut rec, &t, "SUPPLIER", "supplier").unwrap();
    assert_eq!(activate_rb(&w, &mut rec, &d), "INVALID_STATE");
    let until = consent_rb(&w, &mut rec, &t, "BUYER", "buyer").unwrap();
    assert_eq!(until, w.now, "no party key changed: no delay");
    assert_eq!(activate_rb(&w, &mut rec, &d), "OK");
    assert_eq!(rec.terms.manifest_attestor.key_version, 2);
    assert_eq!(rec.terms.risk_resolver.public_key, pk("risk-2"));
    // The old attestor key no longer attests; the rebound key does, at a newer manifest revision.
    let (inv, rep, img) = (invoice("inv-x"), report("rep-x"), photo("img-x"));
    let att = attestation(&rec, 2, complete_slots(&rec, &inv, &rep, &[&img], 2), w.now, "x");
    assert_eq!(code(rec.submit_manifest_attestation(&w.ctx(), &att, &sign("attestor", "dockside/manifest-attestation", &att))), "SIGNATURE_INVALID");
    let digest = rec.submit_manifest_attestation(&w.ctx(), &att, &sign("attestor-2", "dockside/manifest-attestation", &att)).unwrap();
    let ins = inspection(&rec, 2, &digest, "PASS", w.now, "x");
    rec.submit_inspection(&w.ctx(), &ins, &sign("inspector", "dockside/inspection-attestation", &ins)).unwrap();
    assert!(rec.evidence.current_inspection(w.now).is_some());
}

#[test]
fn t006_rebinding_the_inspector_also_requires_items_it_issued_under_the_new_key() {
    let (w, mut rec) = ready();
    let t = rebound(&rec, &evidence_terms(), &[("inspector", "inspector-2")]);
    let d = propose_rb(&w, &mut rec, &t, "SUPPLIER", "supplier").unwrap();
    consent_rb(&w, &mut rec, &t, "BUYER", "buyer").unwrap();
    assert_eq!(activate_rb(&w, &mut rec, &d), "OK");
    // The inspection report was issued by the old inspector key: it does not fill the slot under
    // the new revision, so the attestor cannot make the old items current again.
    let (inv, rep, img) = (invoice("inv-y"), report("rep-y"), photo("img-y"));
    let att = attestation(&rec, 2, complete_slots(&rec, &inv, &rep, &[&img], 2), w.now, "y");
    assert_eq!(code(rec.submit_manifest_attestation(&w.ctx(), &att, &sign("attestor", "dockside/manifest-attestation", &att))), "SIGNATURE_INVALID");
}

#[test]
fn t006_revoked_role_is_cleared_only_for_the_rebound_role_and_a_revoked_anchor_blocks() {
    let revoke = |w: &World, rec: &mut TradeRecord, role: &str, signer_role: &str, signer: &str, n: &str| {
        let bound = rec.terms.all_keys().into_iter().find(|(r, _)| *r == role).map(|(_, k)| k.to_string()).unwrap();
        let rk = with_header(
            rec,
            vec![
                ("role", s(role)),
                ("publicKey", s(&bound)),
                ("signerRole", s(signer_role)),
                ("reasonCode", s("KEY_COMPROMISE")),
                ("issuedAt", u(w.now)),
                ("expiresAt", u(w.now + HOUR)),
                ("nonce", s(&nonce(n))),
            ],
        );
        rec.revoke_key(&w.ctx(), &rk, &sign(signer, "dockside/bound-key-revocation", &rk)).unwrap();
    };
    // The inspector key is revoked on chain; a rebinding to its new key clears that mark.
    let (w, mut rec) = ready();
    revoke(&w, &mut rec, "inspector", "BUYER", "buyer", "ri");
    revoke(&w, &mut rec, "riskResolver", "SELF", "risk", "rr");
    let t = rebound(&rec, &evidence_terms(), &[("inspector", "inspector-2")]);
    let d = propose_rb(&w, &mut rec, &t, "BUYER", "buyer").unwrap();
    consent_rb(&w, &mut rec, &t, "SUPPLIER", "supplier").unwrap();
    assert_eq!(activate_rb(&w, &mut rec, &d), "OK");
    assert!(!rec.revoked_roles.contains("inspector"));
    assert!(rec.revoked_roles.contains("riskResolver"), "a role not rebound stays revoked");

    // The buyer's revoked key is rebound (the supplier anchors it).
    let (mut w, mut rec) = ready();
    revoke(&w, &mut rec, "buyer", "SELF", "buyer", "rb");
    let t = rebound(&rec, &evidence_terms(), &[("buyer", "buyer-2")]);
    let d = propose_rb(&w, &mut rec, &t, "SUPPLIER", "supplier").unwrap();
    consent_rb(&w, &mut rec, &t, "BUYER", "buyer-2").unwrap();
    w.now += rec.terms.destination_change_delay_ms;
    assert_eq!(activate_rb(&w, &mut rec, &d), "OK");
    assert!(!rec.revoked_roles.contains("buyer"));

    // A revoked unchanged party cannot anchor a rebinding, before or after consent.
    let (w, mut rec) = ready();
    revoke(&w, &mut rec, "supplier", "SELF", "supplier", "rs");
    let t = rebound(&rec, &evidence_terms(), &[("buyer", "buyer-2")]);
    assert_eq!(code(propose_rb(&w, &mut rec, &t, "SUPPLIER", "supplier")), "KEY_REVOKED");
    let (mut w, mut rec) = ready();
    let t = rebound(&rec, &evidence_terms(), &[("buyer", "buyer-2")]);
    let d = propose_rb(&w, &mut rec, &t, "BUYER", "buyer-2").unwrap();
    consent_rb(&w, &mut rec, &t, "SUPPLIER", "supplier").unwrap();
    revoke(&w, &mut rec, "supplier", "SELF", "supplier", "rs2");
    w.now += rec.terms.destination_change_delay_ms;
    assert_eq!(activate_rb(&w, &mut rec, &d), "KEY_REVOKED");
    assert_eq!(rec.terms.revision, 1);
}

#[test]
fn t006_revocation_by_either_party_voids_the_pending_rebinding() {
    for (revoker, signer) in [("BUYER", "buyer-2"), ("SUPPLIER", "supplier")] {
        let (w, mut rec) = ready();
        let t = rebound(&rec, &evidence_terms(), &[("buyer", "buyer-2")]);
        let d = propose_rb(&w, &mut rec, &t, "BUYER", "buyer-2").unwrap();
        consent_rb(&w, &mut rec, &t, "SUPPLIER", "supplier").unwrap();
        let mk = |rec: &TradeRecord, role: &str, n: &str| {
            with_header(
                rec,
                vec![
                    ("successorDigest", s(&d)),
                    ("signerRole", s(role)),
                    ("issuedAt", u(w.now)),
                    ("expiresAt", u(w.now + HOUR)),
                    ("nonce", s(&nonce(n))),
                ],
            )
        };
        let bad = mk(&rec, "RISK_RESOLVER", "rv0");
        assert_eq!(code(rec.revoke_key_rebinding(&w.ctx(), &bad, &sign("risk", "dockside/key-rebinding-revoke", &bad))), "FORBIDDEN");
        // Wrong domain (a destination-change revocation signature) fails.
        let p = mk(&rec, revoker, revoker);
        assert_eq!(code(rec.revoke_key_rebinding(&w.ctx(), &p, &sign(signer, "dockside/destination-change-revoke", &p))), "SIGNATURE_INVALID");
        if revoker == "BUYER" {
            // The rebound buyer revokes with its new key, not its old one.
            assert_eq!(code(rec.revoke_key_rebinding(&w.ctx(), &p, &sign("buyer", "dockside/key-rebinding-revoke", &p))), "SIGNATURE_INVALID");
        }
        rec.revoke_key_rebinding(&w.ctx(), &p, &sign(signer, "dockside/key-rebinding-revoke", &p)).unwrap();
        assert_eq!(code(rec.revoke_key_rebinding(&w.ctx(), &p, &sign(signer, "dockside/key-rebinding-revoke", &p))), "NOT_FOUND");
        assert_eq!(activate_rb(&w, &mut rec, &d), "NOT_FOUND");
        assert_eq!(rec.rebinding.history.last().unwrap().status.as_str(), "REVOKED");
        assert_eq!(rec.terms.revision, 1);
    }
}

#[test]
fn t006_activation_is_refused_while_value_is_unresolved_released_or_refunding() {
    for st in unresolved_states() {
        let (w, mut rec, iid) = authorized();
        force_unresolved(&w, &mut rec, &iid, st);
        let t = rebound(&rec, &evidence_terms(), &[("inspector", "inspector-2")]);
        let d = propose_rb(&w, &mut rec, &t, "BUYER", "buyer").unwrap();
        consent_rb(&w, &mut rec, &t, "SUPPLIER", "supplier").unwrap();
        assert_eq!(activate_rb(&w, &mut rec, &d), "VALUE_LOCKED", "{}", st.as_str());
        assert_eq!(rec.terms.revision, 1);
    }
    // Released value: no proposal at all.
    let (w, mut rec, iid) = authorized();
    let (_, _, attempt) = rec.execute_release(&w.ctx(), &iid).unwrap();
    rec.complete_release(&w.ctx(), &iid, &attempt, true).unwrap();
    let t = rebound(&rec, &evidence_terms(), &[("inspector", "inspector-2")]);
    assert_eq!(code(propose_rb(&w, &mut rec, &t, "BUYER", "buyer")), "INVALID_STATE");
    // A live refund intent blocks activation.
    let (w, mut rec) = ready();
    let mut w = w;
    rec.fund(&w.as_caller(OTHER_FUNDER).ctx(), NEAR, 1).unwrap();
    let p = refund_req(&rec, "ex", "EXCESS_FUNDING_RETURN", OTHER_FUNDER, NEAR, "QUARANTINED", "FUNDER", w.now);
    rec.request_refund(&w.as_caller(OTHER_FUNDER).ctx(), &p, dockside_escrow_core::refund::RefundSignatures { buyer: None, supplier: None, risk: None }).unwrap();
    let t = rebound(&rec, &evidence_terms(), &[("inspector", "inspector-2")]);
    let d = propose_rb(&w, &mut rec, &t, "BUYER", "buyer").unwrap();
    consent_rb(&w, &mut rec, &t, "SUPPLIER", "supplier").unwrap();
    assert_eq!(activate_rb(&w, &mut rec, &d), "VALUE_LOCKED");
}

#[test]
fn t006_two_party_rotation_takes_two_revisions_each_anchored_by_the_other_party() {
    let (mut w, mut rec) = ready();
    let r1 = evidence_terms();
    let t2 = rebound(&rec, &r1, &[("buyer", "buyer-2")]);
    let d2 = propose_rb(&w, &mut rec, &t2, "SUPPLIER", "supplier").unwrap();
    consent_rb(&w, &mut rec, &t2, "BUYER", "buyer-2").unwrap();
    w.now += rec.terms.destination_change_delay_ms;
    assert_eq!(activate_rb(&w, &mut rec, &d2), "OK");
    let t3 = rebound(&rec, &t2, &[("supplier", "supplier-2")]);
    // The supplier's old key cannot sign for its new one; the rebound buyer key anchors.
    assert_eq!(code(propose_rb(&w, &mut rec, &t3, "BUYER", "buyer")), "SIGNATURE_INVALID");
    let d3 = propose_rb(&w, &mut rec, &t3, "BUYER", "buyer-2").unwrap();
    consent_rb(&w, &mut rec, &t3, "SUPPLIER", "supplier-2").unwrap();
    w.now += rec.terms.destination_change_delay_ms;
    assert_eq!(activate_rb(&w, &mut rec, &d3), "OK");
    assert_eq!((rec.terms.revision, rec.terms.supplier.public_key.clone()), (3, pk("supplier-2")));
    assert_eq!(rec.revisions.iter().map(|r| r.revision).collect::<Vec<_>>(), vec![1, 2, 3]);
    // A destination change on top is signed by the rebound keys.
    let mut t4 = t3.clone();
    set(&mut t4, &["revision"], u(4));
    set(&mut t4, &["predecessorDigest"], s(&rec.terms_digest));
    set(&mut t4, &["payout", "destination"], s(ALT_DEST));
    assert_eq!(code(rec.propose_destination_change(&w.ctx(), &t4, "SUPPLIER", &sign("supplier", REVISION, &t4))), "SIGNATURE_INVALID");
    rec.propose_destination_change(&w.ctx(), &t4, "SUPPLIER", &sign("supplier-2", REVISION, &t4)).unwrap();
}
