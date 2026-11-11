//! T-015 (an ACTIVE or EXPIRED_UNRESOLVED HoldRecord blocks the direct release entry point) and
//! T-019 (release requires the exact complete conjunction) at the contract boundary. Holds are set
//! through the bound deterministic-policy key and the risk/policy key; inspection is the bound
//! inspector's signature over the contract-accepted manifest. Nothing here is a projection.

mod common;
use common::evidence::*;
use common::release::*;
use common::*;
use dockside_escrow_core::release::IntentState;

fn execute(w: &World, rec: &mut dockside_escrow_core::TradeRecord, i: &str) -> &'static str {
    code(rec.execute_release(&w.ctx(), i))
}

#[test]
fn t019_the_exact_complete_conjunction_releases_to_the_bound_supplier() {
    let (w, mut rec, i) = authorized();
    assert!(rec.release_blockers(w.now).is_empty(), "{:?}", rec.release_blockers(w.now));
    let before = rec.ledger.clone();
    let (dest, amount, attempt) = rec.execute_release(&w.ctx(), &i).unwrap();
    assert_eq!((dest.as_str(), amount), (SUPPLIER_ACCT, 10 * NEAR));
    assert!(attempt.starts_with("rla_"));
    assert_eq!(intent(&rec, &i).state, IntentState::Submitting);
    assert!(rec.evidence.current.as_ref().unwrap().consumed, "release consumes the manifest attestation");
    assert_eq!(rec.ledger, before, "value stays reserved until the receipt");
    rec.complete_release(&w.ctx(), &i, &attempt, true).unwrap();
    assert_eq!(intent(&rec, &i).state, IntentState::Paid);
    assert_eq!(rec.ledger.funder(BUYER_ACCT).released, 6 * NEAR);
    assert_eq!(rec.ledger.funder(OTHER_FUNDER).released, 4 * NEAR);
    assert_eq!(rec.ledger.funder(BUYER_ACCT).reserved, 0);
    rec.ledger.check_conservation().unwrap();
    // Consumed value: no second release, no new intent.
    assert_eq!(execute(&w, &mut rec, &i), "INVALID_STATE");
    let p = intent_payload(&rec, &id("rli", "again"), w.now, "again");
    assert_eq!(code(rec.create_release_intent(&w.ctx(), &p, &sign("buyer", "dockside/release-intent", &p))), "INVALID_STATE");
}

#[test]
fn t015_active_and_expired_unresolved_holds_reject_direct_release() {
    for issuer in ["POLICY_SETTER", "RISK_RESOLVER"] {
        let (mut w, mut rec, i) = authorized();
        set_hold(&w, &mut rec, &format!("{issuer}-h"), issuer, 10 * 60_000);
        assert_eq!(rec.holds.values().next().unwrap().status(w.now), "ACTIVE");
        assert_eq!(execute(&w, &mut rec, &i), "HOLD_ACTIVE", "{issuer}");
        w.now += 20 * 60_000;
        assert_eq!(rec.holds.values().next().unwrap().status(w.now), "EXPIRED_UNRESOLVED");
        assert!(rec.release_blockers(w.now).contains(&"HOLD_ACTIVE"));
        assert_eq!(execute(&w, &mut rec, &i), "HOLD_ACTIVE", "{issuer}: expiry never clears a hold");
        assert_eq!(intent(&rec, &i).state, IntentState::DirectTestnetAuthorized, "lock unchanged");
        // A valid risk resolution clears the hold, but the approval saw a different holds view.
        assert_eq!(resolve(&w, &mut rec, &format!("{issuer}-h"), "RELEASE_HOLD", issuer), "OK");
        assert_eq!(execute(&w, &mut rec, &i), "APPROVAL_STALE");
    }
}

#[test]
fn t015_a_hold_set_before_approval_blocks_approval_and_resolution_then_allows_fresh_approval() {
    let (w, mut rec) = ready();
    let i = create(&w, &mut rec, "h");
    set_hold(&w, &mut rec, "pre", "POLICY_SETTER", DAY);
    assert_eq!(approve(&w, &mut rec, &i, "a1"), "HOLD_ACTIVE");
    // The deterministic-policy key cannot resolve its own hold.
    let r = with_header(
        &rec,
        vec![
            ("holdId", s(&id("hld", "pre"))),
            ("holdReasonCode", s("DOC_MISMATCH")),
            ("manifestDigest", opt(rec.current_manifest_digest(w.now).as_deref())),
            ("resolutionCode", s("RELEASE_HOLD")),
            ("evidenceDigest", s(&"ab".repeat(32))),
            ("resolverRole", s("RISK_RESOLVER")),
            ("schema", s("dockside/hold-resolve@1")),
            ("issuedAt", u(w.now)),
            ("expiresAt", u(w.now + HOUR)),
            ("nonce", s(&nonce("policy-resolve"))),
        ],
    );
    assert_eq!(code(rec.resolve_hold(&w.ctx(), &r, &sign("policy", "dockside/hold-resolve", &r))), "SIGNATURE_INVALID");
    assert_eq!(approve(&w, &mut rec, &i, "a2"), "HOLD_ACTIVE");
    assert_eq!(resolve(&w, &mut rec, "pre", "RELEASE_HOLD", "pre"), "OK");
    assert_eq!(approve(&w, &mut rec, &i, "a3"), "OK");
    let (_, _, attempt) = rec.execute_release(&w.ctx(), &i).unwrap();
    rec.complete_release(&w.ctx(), &i, &attempt, true).unwrap();
}

#[test]
fn t019_missing_prerequisites_are_enumerated_and_each_one_rejects() {
    // No manifest, no inspection, no intent.
    let (mut w, mut rec) = evidence_trade();
    fund_full(&mut w, &mut rec);
    let b = rec.release_blockers(w.now);
    assert_eq!(b, vec!["MANIFEST_NOT_CURRENT", "INSPECTION_NOT_PASS", "NO_RELEASE_INTENT"]);
    let i = create(&w, &mut rec, "x");
    assert_eq!(execute(&w, &mut rec, &i), "MANIFEST_NOT_CURRENT");
    assert_eq!(approve(&w, &mut rec, &i, "x"), "MANIFEST_NOT_CURRENT");
    // Manifest without a PASS: FAIL and REVIEW never authorize.
    for decision in ["FAIL", "REVIEW"] {
        let (mut w, mut rec) = evidence_trade();
        fund_full(&mut w, &mut rec);
        attest_and_inspect(&w, &mut rec, 1, decision, decision);
        let i = create(&w, &mut rec, decision);
        assert_eq!(approve(&w, &mut rec, &i, decision), "INSPECTION_NOT_PASS");
        assert!(rec.release_blockers(w.now).contains(&"INSPECTION_NOT_PASS"));
    }
    // An unapproved intent.
    let (w, mut rec) = ready();
    let i = create(&w, &mut rec, "u");
    assert_eq!(rec.release_blockers(w.now), vec!["APPROVAL_MISSING"]);
    assert_eq!(execute(&w, &mut rec, &i), "APPROVAL_MISSING");
}

#[test]
fn t019_wrong_or_stale_approvals_are_rejected() {
    let (w, mut rec) = ready();
    let i = create(&w, &mut rec, "w");
    let good = approval_payload(&rec, &i, w.now, "g");
    // Signed by anyone but the bound buyer key.
    for signer in ["supplier", "inspector", "risk", "attestor", "policy"] {
        assert_eq!(code(rec.approve_release(&w.ctx(), &good, &sign(signer, "dockside/buyer-approval", &good))), "SIGNATURE_INVALID", "{signer}");
    }
    // Right key, wrong domain.
    assert_eq!(code(rec.approve_release(&w.ctx(), &good, &sign("buyer", "dockside/release-intent", &good))), "SIGNATURE_INVALID");
    let mutations: Vec<(&[&str], J, &str)> = vec![
        (&["intentStateVersion"], u(9), "VERSION_CONFLICT"),
        (&["amountYocto"], big(9 * NEAR), "INVALID_AMOUNT"),
        (&["executionProfile"], s("FUNDED_1CLICK"), "PROFILE_MISMATCH"),
        (&["destination"], s(ALT_DEST), "DESTINATION_MISMATCH"),
        (&["manifestDigest"], s(&"11".repeat(32)), "STALE_MANIFEST"),
        (&["attestationDigest"], s(&"11".repeat(32)), "STALE_MANIFEST"),
        (&["manifestRevision"], u(7), "STALE_MANIFEST"),
        (&["inspectionDigest"], s(&"11".repeat(32)), "STALE_MANIFEST"),
        (&["holdsViewDigest"], s(&"11".repeat(32)), "STALE_HOLDS"),
        (&["signerRole"], s("SUPPLIER_SIGNER"), "FORBIDDEN"),
        (&["tradeRevision"], u(2), "STALE_REVISION"),
    ];
    for (path, v, want) in mutations {
        let mut p = good.clone();
        set(&mut p, path, v);
        assert_eq!(code(rec.approve_release(&w.ctx(), &p, &sign("buyer", "dockside/buyer-approval", &p))), want, "{path:?}");
    }
    let mut unknown = good.clone();
    set(&mut unknown, &["complete"], json!({"bool": true}));
    assert_eq!(code(rec.approve_release(&w.ctx(), &unknown, &sign("buyer", "dockside/buyer-approval", &unknown))), "UNKNOWN_FIELD");
    assert_eq!(intent(&rec, &i).state, IntentState::ValueLocked, "no mutation authorized anything");
    rec.approve_release(&w.ctx(), &good, &sign("buyer", "dockside/buyer-approval", &good)).unwrap();
    // Replay of the same approval (even after state change) fails.
    assert_eq!(code(rec.approve_release(&w.ctx(), &good, &sign("buyer", "dockside/buyer-approval", &good))), "INVALID_STATE");
}

#[test]
fn t019_expired_approval_and_changed_evidence_after_approval_reject_release() {
    // Approval expiry.
    let (mut w, mut rec, i) = authorized();
    w.now += DAY;
    let b = rec.release_blockers(w.now);
    assert!(b.contains(&"APPROVAL_EXPIRED"), "{b:?}");
    assert_eq!(execute(&w, &mut rec, &i), "MANIFEST_NOT_CURRENT", "the 1h attestation also lapsed");
    // Replacement evidence after approval: the approval is bound to the old manifest.
    let (w, mut rec, i) = authorized();
    attest_and_inspect(&w, &mut rec, 2, "PASS", "r2");
    assert_eq!(execute(&w, &mut rec, &i), "APPROVAL_STALE");
    // A new inspector decision alone also invalidates the approval.
    let (w, mut rec, i) = authorized();
    let m = rec.evidence.current.clone().unwrap();
    let ins = inspection(&rec, m.revision, &m.digest, "PASS", w.now, "second-pass");
    rec.submit_inspection(&w.ctx(), &ins, &sign("inspector", "dockside/inspection-attestation", &ins)).unwrap();
    assert_eq!(execute(&w, &mut rec, &i), "APPROVAL_STALE");
    // Inspector key revoked after approval: no current inspection.
    let (w, mut rec, i) = authorized();
    let bound = rec.terms.inspector.public_key.clone();
    let rv = with_header(
        &rec,
        vec![
            ("role", s("inspector")),
            ("publicKey", s(&bound)),
            ("signerRole", s("BUYER")),
            ("reasonCode", s("KEY_COMPROMISE")),
            ("issuedAt", u(w.now)),
            ("expiresAt", u(w.now + HOUR)),
            ("nonce", s(&nonce("rv-ins"))),
        ],
    );
    rec.revoke_key(&w.ctx(), &rv, &sign("buyer", "dockside/bound-key-revocation", &rv)).unwrap();
    assert_eq!(execute(&w, &mut rec, &i), "INSPECTION_NOT_PASS");
}

#[test]
fn t019_wrong_profile_recipient_and_value_fail_at_intent_creation() {
    let (w, mut rec) = ready();
    let base = intent_payload(&rec, &id("rli", "p"), w.now, "p");
    let cases: Vec<(&[&str], J, &str)> = vec![
        (&["executionProfile"], s("FUNDED_1CLICK"), "FUNDED_RAIL_BLOCKED"),
        (&["executionProfile"], s("DRY_QUOTE"), "UNSUPPORTED_VERSION"),
        (&["destination"], s(ALT_DEST), "DESTINATION_MISMATCH"),
        (&["destinationDigest"], s(&"11".repeat(32)), "DESTINATION_MISMATCH"),
        (&["amountYocto"], big(5 * NEAR), "INVALID_AMOUNT"),
        (&["sourceBucketDigest"], s(&"11".repeat(32)), "STALE_LEDGER"),
        (&["intentExpiresAt"], u(w.now), "VALIDATION_FAILED"),
        (&["intentExpiresAt"], u(w.now + 40 * DAY), "VALIDATION_FAILED"),
        (&["signerRole"], s("SUPPLIER_SIGNER"), "FORBIDDEN"),
        (&["network"], s("near-mainnet"), "WRONG_NETWORK"),
    ];
    for (path, v, want) in cases {
        let mut p = base.clone();
        set(&mut p, path, v);
        assert_eq!(code(rec.create_release_intent(&w.ctx(), &p, &sign("buyer", "dockside/release-intent", &p))), want, "{path:?}");
    }
    assert_eq!(code(rec.create_release_intent(&w.ctx(), &base, &sign("supplier", "dockside/release-intent", &base))), "SIGNATURE_INVALID");
    assert!(rec.release.intents.is_empty());
    assert_eq!(rec.ledger.funder(BUYER_ACCT).available, 6 * NEAR, "nothing reserved");
}

#[test]
fn t019_partial_funding_cannot_back_an_intent() {
    let (mut w, mut rec) = evidence_trade();
    rec.fund(&w.as_caller(BUYER_ACCT).ctx(), 6 * NEAR, 1).unwrap();
    attest_and_inspect(&w, &mut rec, 1, "PASS", "pf");
    let p = intent_payload(&rec, &id("rli", "pf"), w.now, "pf");
    assert_eq!(code(rec.create_release_intent(&w.ctx(), &p, &sign("buyer", "dockside/release-intent", &p))), "NOT_FULLY_FUNDED");
}

#[test]
fn t019_failed_transfer_restores_exact_slices_and_requires_a_new_intent() {
    let (w, mut rec, i) = authorized();
    let (_, _, attempt) = rec.execute_release(&w.ctx(), &i).unwrap();
    assert_eq!(code(rec.complete_release(&w.ctx(), &i, "rla_00000000000000000000000000000000", false)), "VALIDATION_FAILED");
    rec.complete_release(&w.ctx(), &i, &attempt, false).unwrap();
    assert_eq!(intent(&rec, &i).state, IntentState::Failed);
    assert_eq!(rec.ledger.funder(BUYER_ACCT).available, 6 * NEAR);
    assert_eq!(rec.ledger.funder(OTHER_FUNDER).available, 4 * NEAR);
    assert_eq!(rec.release.live, None);
    // The old intent is never resubmitted; a new intent needs fresh evidence (the attestation was consumed).
    assert_eq!(execute(&w, &mut rec, &i), "INVALID_STATE");
    let j = create(&w, &mut rec, "retry");
    assert_eq!(approve(&w, &mut rec, &j, "retry"), "MANIFEST_CONSUMED");
    attest_and_inspect(&w, &mut rec, 2, "PASS", "retry");
    assert_eq!(approve(&w, &mut rec, &j, "retry2"), "OK");
    assert!(rec.release_blockers(w.now).is_empty());
}
