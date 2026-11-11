//! T-020 (unilateral destination change is rejected), T-021 (dual-consent delayed change
//! invalidates release facts) and T-047 (activation supersedes only a pre-submit intent) at the
//! contract boundary. The contract exposes no other write path to `payout.destination`.

mod common;
use common::evidence::*;
use common::release::*;
use common::*;
use dockside_escrow_core::release::IntentState;
use dockside_escrow_core::TradeRecord;

fn activate(w: &World, rec: &mut TradeRecord, d: &str) -> &'static str {
    code(rec.activate_destination_change(&w.ctx(), d))
}

#[test]
fn t020_no_single_party_or_non_party_path_changes_the_destination() {
    let (mut w, mut rec) = ready();
    // Every non-party key fails, every non-party role is refused.
    for (role, signer, want) in [
        ("SUPPLIER", "buyer", "SIGNATURE_INVALID"),
        ("BUYER", "supplier", "SIGNATURE_INVALID"),
        ("BUYER", "risk", "SIGNATURE_INVALID"),
        ("SUPPLIER", "inspector", "SIGNATURE_INVALID"),
        ("SUPPLIER", "attestor", "SIGNATURE_INVALID"),
        ("BUYER", "policy", "SIGNATURE_INVALID"),
        ("RISK_RESOLVER", "risk", "FORBIDDEN"),
        ("INSPECTOR", "inspector", "FORBIDDEN"),
        ("ADMIN", "buyer", "FORBIDDEN"),
        ("EXECUTOR", "supplier", "FORBIDDEN"),
    ] {
        assert_eq!(code(propose(&w, &mut rec, ALT_DEST, role, signer)), want, "{role}/{signer}");
    }
    assert!(rec.destination.pending.is_none());
    // A single-party proposal never becomes effective.
    let d = propose(&w, &mut rec, ALT_DEST, "SUPPLIER", "supplier").unwrap();
    assert_eq!(activate(&w, &mut rec, &d), "INVALID_STATE");
    w.now += 30 * DAY;
    assert_eq!(activate(&w, &mut rec, &d), "INVALID_STATE", "waiting does not substitute for consent");
    assert_eq!(rec.terms.payout_destination, SUPPLIER_ACCT);
    // The proposer cannot consent twice, a non-party cannot consent.
    w.now = T0;
    let (_, mut rec) = ready();
    let d = propose(&w, &mut rec, ALT_DEST, "SUPPLIER", "supplier").unwrap();
    assert_eq!(code(consent_dest(&w, &mut rec, ALT_DEST, "SUPPLIER", "supplier")), "INVALID_STATE");
    assert_eq!(code(consent_dest(&w, &mut rec, ALT_DEST, "RISK_RESOLVER", "risk")), "FORBIDDEN");
    assert_eq!(code(consent_dest(&w, &mut rec, ALT_DEST, "BUYER", "risk")), "SIGNATURE_INVALID");
    // A consent over a different digest fails closed.
    let other = successor_terms(&rec, "harbor-other.testnet");
    assert_eq!(code(rec.consent_destination_change(&w.ctx(), &digest_hex("dockside/trade-revision", &other), "BUYER", &sign("buyer", "dockside/trade-revision", &other))), "DIGEST_MISMATCH");
    // A conflicting proposal while one is pending fails closed.
    assert_eq!(code(propose(&w, &mut rec, "harbor-other.testnet", "BUYER", "buyer")), "DESTINATION_CHANGE_PENDING");
    assert_eq!(rec.destination.pending.as_ref().unwrap().successor_digest, d);
    assert_eq!(rec.terms.payout_destination, SUPPLIER_ACCT);
}

#[test]
fn t020_successor_may_change_only_the_destination_and_must_chain_the_revision() {
    let (w, mut rec) = ready();
    let base = successor_terms(&rec, ALT_DEST);
    let cases: Vec<(&[&str], J, &str)> = vec![
        (&["amountYocto"], big(1), "IMMUTABLE_FIELD"),
        (&["supplier", "accountId"], s("mallory.testnet"), "IMMUTABLE_FIELD"),
        (&["inspector", "publicKey"], s(&pk("mallory")), "IMMUTABLE_FIELD"),
        (&["delayPolicy", "destinationChangeDelayMs"], u(0), "IMMUTABLE_FIELD"),
        (&["expiresAt"], u(T0 + 90 * DAY), "IMMUTABLE_FIELD"),
        (&["revision"], u(3), "VERSION_CONFLICT"),
        (&["predecessorDigest"], s(&"00".repeat(32)), "VERSION_CONFLICT"),
        (&["payout", "destination"], s(SUPPLIER_ACCT), "VALIDATION_FAILED"),
        (&["payout", "destination"], s("abcdef"), "INVALID_ADDRESS"),
    ];
    for (path, v, want) in cases {
        let mut t = base.clone();
        set(&mut t, path, v);
        assert_eq!(code(rec.propose_destination_change(&w.ctx(), &t, "SUPPLIER", &sign("supplier", "dockside/trade-revision", &t))), want, "{path:?}");
    }
    // Revision 2 terms cannot be registered as a fresh trade either.
    assert_eq!(code(dockside_escrow_core::register(&w.ctx(), &base, &sign("buyer", "dockside/trade-revision", &base), &sign("supplier", "dockside/trade-revision", &base))), "NOT_SUPPORTED");
    assert!(rec.destination.pending.is_none());
}

#[test]
fn t020_revocation_by_either_party_voids_the_pending_change() {
    for revoker in ["BUYER", "SUPPLIER"] {
        let (mut w, mut rec) = ready();
        let d = dual_consented(&mut w, &mut rec, ALT_DEST);
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
        assert_eq!(code(rec.revoke_destination_change(&w.ctx(), &bad, &sign("risk", "dockside/destination-change-revoke", &bad))), "FORBIDDEN");
        let p = mk(&rec, revoker, revoker);
        let signer = if revoker == "BUYER" { "buyer" } else { "supplier" };
        rec.revoke_destination_change(&w.ctx(), &p, &sign(signer, "dockside/destination-change-revoke", &p)).unwrap();
        assert_eq!(activate(&w, &mut rec, &d), "NOT_FOUND");
        assert_eq!(rec.terms.payout_destination, SUPPLIER_ACCT);
        assert_eq!(rec.destination.history.last().unwrap().status.as_str(), "REVOKED");
    }
}

#[test]
fn t021_delay_starts_at_the_second_consent_and_is_enforced() {
    let (mut w, mut rec) = ready();
    let d = propose(&w, &mut rec, ALT_DEST, "BUYER", "buyer").unwrap();
    w.now += 5 * HOUR;
    let until = consent_dest(&w, &mut rec, ALT_DEST, "SUPPLIER", "supplier").unwrap();
    assert_eq!(until, w.now + DAY);
    w.now = until - 1;
    assert_eq!(activate(&w, &mut rec, &d), "DELAY_NOT_ELAPSED");
    assert_eq!(rec.terms.payout_destination, SUPPLIER_ACCT, "current destination stays effective");
    w.now = until;
    assert_eq!(activate(&w, &mut rec, &d), "OK");
    assert_eq!(rec.terms.payout_destination, ALT_DEST);
    assert_eq!(rec.terms.revision, 2);
    assert_eq!(rec.terms_digest, d);
    assert_eq!(rec.revisions.iter().map(|r| r.revision).collect::<Vec<_>>(), vec![1, 2]);
}

#[test]
fn t021_activation_invalidates_manifest_attestation_inspection_holds_view_intent_and_approval() {
    let (mut w, mut rec, iid) = authorized();
    let old_header_approval = approval_payload(&rec, &iid, w.now, "old");
    let old_holds_view = rec.holds_view_digest(w.now).unwrap();
    let old_manifest = rec.evidence.current.clone().unwrap();
    let d = dual_consented(&mut w, &mut rec, ALT_DEST);
    let (_, succ) = rec.activate_destination_change(&w.ctx(), &d).unwrap();
    let succ = succ.unwrap();
    // Old intent superseded; successor owns the same exact reservation, unapproved.
    assert_eq!(intent(&rec, &iid).state, IntentState::SupersededPreSubmit);
    assert_eq!(intent(&rec, &iid).successor.as_deref(), Some(succ.as_str()));
    let s_i = intent(&rec, &succ);
    assert_eq!((s_i.state, s_i.trade_revision, s_i.destination.as_str()), (IntentState::ValueLocked, 2, ALT_DEST));
    assert_eq!(s_i.slice_pairs(), intent(&rec, &iid).slice_pairs());
    assert!(s_i.approval.is_none());
    assert!(rec.ledger.reservation_matches(&s_i.slice_pairs()));
    // Old manifest and inspection moved to history; nothing is current.
    assert!(rec.evidence.current.is_none());
    assert_eq!(rec.evidence.history.last().unwrap().digest, old_manifest.digest);
    assert!(rec.evidence.current_inspection(w.now).is_none());
    assert_ne!(rec.holds_view_digest(w.now).unwrap(), old_holds_view);
    let b = rec.release_blockers(w.now);
    assert!(b.contains(&"MANIFEST_NOT_CURRENT") && b.contains(&"INSPECTION_NOT_PASS") && b.contains(&"APPROVAL_MISSING"), "{b:?}");
    // Every payload signed for revision 1 is now stale.
    assert_eq!(code(rec.approve_release(&w.ctx(), &old_header_approval, &sign("buyer", "dockside/buyer-approval", &old_header_approval))), "STALE_REVISION");
    assert_eq!(code(rec.execute_release(&w.ctx(), &iid)), "INVALID_STATE");
    assert_eq!(code(rec.execute_release(&w.ctx(), &succ)), "MANIFEST_NOT_CURRENT");
    // A new manifest at a higher manifest revision, a new inspection and a new approval are required.
    attest_and_inspect(&w, &mut rec, 2, "PASS", "rev2");
    assert_eq!(rec.release_blockers(w.now), vec!["APPROVAL_MISSING"]);
    assert_eq!(approve(&w, &mut rec, &succ, "rev2"), "OK");
    let (dest, amount, attempt) = rec.execute_release(&w.ctx(), &succ).unwrap();
    assert_eq!((dest.as_str(), amount), (ALT_DEST, 10 * NEAR));
    rec.complete_release(&w.ctx(), &succ, &attempt, true).unwrap();
    assert_eq!(rec.ledger.funder(BUYER_ACCT).released + rec.ledger.funder(OTHER_FUNDER).released, 10 * NEAR);
    rec.ledger.check_conservation().unwrap();
}

#[test]
fn t021_old_manifest_revision_cannot_be_reattested_and_unresolved_holds_keep_blocking() {
    let (mut w, mut rec, _) = authorized();
    set_hold(&w, &mut rec, "carry", "RISK_RESOLVER", 30 * DAY);
    let d = dual_consented(&mut w, &mut rec, ALT_DEST);
    rec.activate_destination_change(&w.ctx(), &d).unwrap();
    // Manifest revision 1 again (even with the new header) is not newer than history.
    let (inv, rep, img) = (invoice("again"), report("again"), photo("again"));
    let att = attestation(&rec, 1, complete_slots(&rec, &inv, &rep, &[&img], 1), w.now, "again");
    assert_eq!(code(rec.submit_manifest_attestation(&w.ctx(), &att, &sign("attestor", "dockside/manifest-attestation", &att))), "STALE_MANIFEST");
    attest_and_inspect(&w, &mut rec, 2, "PASS", "r2");
    let succ = rec.release.live.clone().unwrap();
    // The hold set under revision 1 is still unresolved and still blocks under revision 2.
    assert_eq!(approve(&w, &mut rec, &succ, "h"), "HOLD_ACTIVE");
    assert_eq!(resolve(&w, &mut rec, "carry", "RELEASE_HOLD", "carry"), "OK");
    assert_eq!(approve(&w, &mut rec, &succ, "h2"), "OK");
}

#[test]
fn t021_revoked_party_key_blocks_activation() {
    let (mut w, mut rec) = ready();
    let d = dual_consented(&mut w, &mut rec, ALT_DEST);
    let rk = with_header(
        &rec,
        vec![
            ("role", s("buyer")),
            ("publicKey", s(&rec.terms.buyer.public_key)),
            ("signerRole", s("SELF")),
            ("reasonCode", s("KEY_COMPROMISE")),
            ("issuedAt", u(w.now)),
            ("expiresAt", u(w.now + HOUR)),
            ("nonce", s(&nonce("rk"))),
        ],
    );
    rec.revoke_key(&w.ctx(), &rk, &sign("buyer", "dockside/bound-key-revocation", &rk)).unwrap();
    assert_eq!(activate(&w, &mut rec, &d), "KEY_REVOKED");
    assert_eq!(rec.terms.payout_destination, SUPPLIER_ACCT);
}

#[test]
fn t047_activation_against_every_intent_state() {
    // Pre-submit: VALUE_LOCKED and DIRECT_TESTNET_AUTHORIZED supersede with one successor.
    for approved in [false, true] {
        let (mut w, mut rec) = ready();
        let iid = create(&w, &mut rec, "p");
        if approved {
            assert_eq!(approve(&w, &mut rec, &iid, "p"), "OK");
        }
        let ledger = rec.ledger.clone();
        let d = dual_consented(&mut w, &mut rec, ALT_DEST);
        let (_, succ) = rec.activate_destination_change(&w.ctx(), &d).unwrap();
        assert_eq!(intent(&rec, &iid).state, IntentState::SupersededPreSubmit);
        assert_eq!(rec.release.live, succ);
        assert_eq!(rec.ledger, ledger, "reservation transferred without touching the ledger");
        assert_eq!(rec.release.intents.values().filter(|i| i.state.is_live()).count(), 1, "one live owner of the value");
    }
    // Unresolved post-submit states reject activation.
    for st in unresolved_states() {
        let (mut w, mut rec, iid) = authorized();
        force_unresolved(&w, &mut rec, &iid, st);
        let d = dual_consented(&mut w, &mut rec, ALT_DEST);
        assert_eq!(activate(&w, &mut rec, &d), "VALUE_LOCKED", "{}", st.as_str());
        assert_eq!(rec.terms.revision, 1);
        // A late receipt stays bound to the original intent and pays the original destination once.
        if matches!(st, IntentState::Submitting | IntentState::Unknown) {
            let attempt = intent(&rec, &iid).attempts[0].clone();
            rec.complete_release(&w.ctx(), &iid, &attempt, true).unwrap();
            assert_eq!(intent(&rec, &iid).state, IntentState::Paid);
            assert_eq!(activate(&w, &mut rec, &d), "INVALID_STATE", "terminal payout rejects activation");
            let p = intent_payload(&rec, &id("rli", "second"), w.now, "second");
            assert_eq!(code(rec.create_release_intent(&w.ctx(), &p, &sign("buyer", "dockside/release-intent", &p))), "INVALID_STATE");
        }
    }
    // Terminal PAID before any proposal: proposals are refused outright.
    let (w, mut rec, iid) = authorized();
    let (_, _, attempt) = rec.execute_release(&w.ctx(), &iid).unwrap();
    rec.complete_release(&w.ctx(), &iid, &attempt, true).unwrap();
    assert_eq!(code(propose(&w, &mut rec, ALT_DEST, "SUPPLIER", "supplier")), "INVALID_STATE");
    // Terminal exits (cancelled, abandoned, failed) leave nothing to supersede: activation proceeds with none.
    let (mut w, mut rec, iid) = authorized();
    let (_, _, attempt) = rec.execute_release(&w.ctx(), &iid).unwrap();
    rec.complete_release(&w.ctx(), &iid, &attempt, false).unwrap();
    let d = dual_consented(&mut w, &mut rec, ALT_DEST);
    assert_eq!(rec.activate_destination_change(&w.ctx(), &d).unwrap().1, None);
    assert_eq!(intent(&rec, &iid).state, IntentState::Failed);
}

#[test]
fn t047_a_live_refund_blocks_activation() {
    let (mut w, mut rec) = ready();
    rec.fund(&w.as_caller(OTHER_FUNDER).ctx(), NEAR, 1).unwrap();
    let p = refund_req(&rec, "ex", "EXCESS_FUNDING_RETURN", OTHER_FUNDER, NEAR, "QUARANTINED", "FUNDER", w.now);
    rec.request_refund(&w.as_caller(OTHER_FUNDER).ctx(), &p, dockside_escrow_core::refund::RefundSignatures { buyer: None, supplier: None, risk: None }).unwrap();
    let d = dual_consented(&mut w, &mut rec, ALT_DEST);
    assert_eq!(activate(&w, &mut rec, &d), "VALUE_LOCKED");
}
