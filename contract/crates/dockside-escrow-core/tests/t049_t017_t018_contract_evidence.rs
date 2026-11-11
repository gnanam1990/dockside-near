//! Contract boundary for M03: T-049 (manifest attestation cannot be forged or stale), and the
//! contract halves of T-017 (only the bound inspector over the current complete manifest) and
//! T-018 (changed evidence invalidates attestation). Every mutation below is re-signed by the
//! bound attestor key (and re-sealed where noted) so that only the mutated predicate differs:
//! the contract must reject it by recomputation, not by a broken signature.

mod common;
use common::evidence::*;
use common::*;
use dockside_escrow_core::TradeRecord;

fn base(rec: &TradeRecord) -> (Item, Item, Item) {
    let _ = rec;
    (invoice("inv-1"), report("rep-1"), photo("img-1"))
}

fn att_for(rec: &TradeRecord, rev: u64, inv: &Item, rep: &Item, photos: &[&Item], cv: u64, n: &str) -> J {
    attestation(rec, rev, complete_slots(rec, inv, rep, photos, cv), T0, n)
}

fn submit(rec: &mut TradeRecord, w: &World, att: &J, signer: &str) -> &'static str {
    code(rec.submit_manifest_attestation(&w.ctx(), att, &sign(signer, "dockside/manifest-attestation", att)))
}

fn item<'a>(att: &'a mut J, slot: usize, i: usize) -> &'a mut J {
    &mut att["struct"]["slots"]["list"][slot]["struct"]["items"]["list"][i]
}

fn slot<'a>(att: &'a mut J, slot: usize) -> &'a mut J {
    &mut att["struct"]["slots"]["list"][slot]
}

#[test]
fn complete_manifest_signed_by_the_bound_attestor_is_accepted_and_completeness_is_derived() {
    let (w, mut rec) = evidence_trade();
    let (inv, rep, img) = base(&rec);
    let att = att_for(&rec, 1, &inv, &rep, &[&img], 1, "a1");
    let digest = rec.submit_manifest_attestation(&w.ctx(), &att, &sign("attestor", "dockside/manifest-attestation", &att)).unwrap();
    assert_eq!(digest, att["struct"]["manifestDigest"]["str"].as_str().unwrap());
    assert_eq!(rec.current_manifest_digest(w.now), Some(digest.clone()));
    assert!(rec.evidence.usable(w.now).is_some());
    let v = dockside_escrow_core::views::evidence(&rec, w.now);
    assert_eq!(v["usable"], json!(true));
    assert_eq!(v["current"]["items"].as_array().unwrap().len(), 3);
}

#[test]
fn policy_must_match_the_signed_revision_and_be_registered_first() {
    let (w, mut rec) = registered();
    let (inv, rep, img) = base(&rec);
    let att = att_for(&rec, 1, &inv, &rep, &[&img], 1, "p0");
    assert_eq!(submit(&mut rec, &w, &att, "attestor"), "POLICY_NOT_REGISTERED");
    // The generic M02 terms bind digest "ab..": a real policy does not match it.
    assert_eq!(code(rec.register_evidence_policy(&policy())), "POLICY_MISMATCH");
    let (_, mut rec) = evidence_trade();
    assert_eq!(code(rec.register_evidence_policy(&policy())), "INVALID_STATE");
}

#[test]
fn caller_completeness_flags_and_projection_fields_are_rejected() {
    let (w, mut rec) = evidence_trade();
    let (inv, rep, img) = base(&rec);
    let mut att = att_for(&rec, 1, &inv, &rep, &[&img], 1, "c1");
    set(&mut att, &["complete"], json!({"bool": true}));
    assert_eq!(submit(&mut rec, &w, &att, "attestor"), "UNKNOWN_FIELD");
    let mut att = att_for(&rec, 1, &inv, &rep, &[&img], 1, "c2");
    set(slot(&mut att, 0), &["complete"], json!({"bool": true}));
    assert_eq!(submit(&mut rec, &w, &att, "attestor"), "UNKNOWN_FIELD");
    let mut att = att_for(&rec, 1, &inv, &rep, &[&img], 1, "c3");
    set(item(&mut att, 0, 0), &["eligible"], json!({"bool": true}));
    assert_eq!(submit(&mut rec, &w, &att, "attestor"), "UNKNOWN_FIELD");
    assert!(rec.evidence.current.is_none());
}

#[test]
fn every_item_predicate_is_recomputed_by_the_contract() {
    let (w, rec0) = evidence_trade();
    let (inv, rep, img) = base(&rec0);
    type Mut = fn(&mut J);
    let cases: Vec<(&str, Mut, &str)> = vec![
        ("uploader identity", |a| set(item(a, 0, 0), &["uploader", "principalId"], s(&id("prn", "intruder"))), "KEY_NOT_BOUND"),
        ("uploader capability", |a| set(item(a, 0, 0), &["uploader", "capability"], s("BUYER_APPROVER")), "FORBIDDEN"),
        ("uploader key version", |a| set(item(a, 0, 0), &["uploader", "keyVersionId"], s(&id("key", "supplier-2"))), "KEY_NOT_BOUND"),
        ("uploader org", |a| {
            set(item(a, 0, 0), &["uploader", "capability"], s("EVIDENCE_UPLOADER"));
            set(item(a, 0, 0), &["uploader", "organizationId"], s(&id("org", "unrelated")));
        }, "SCOPE_MISMATCH"),
        ("issuer identity", |a| set(item(a, 0, 0), &["issuer", "principalId"], s(&id("prn", "intruder"))), "KEY_NOT_BOUND"),
        ("issuer capability", |a| set(item(a, 0, 0), &["issuer", "capability"], s("BUYER_APPROVER")), "FORBIDDEN"),
        ("issuer key/signature", |a| set(item(a, 0, 0), &["issuer", "signature"], s(&sign_digest("buyer", &[7u8; 32]))), "SIGNATURE_INVALID"),
        ("detected MIME", |a| set(item(a, 0, 0), &["detectedMime"], s("application/x-msdownload")), "UNSUPPORTED_CONTENT"),
        ("content class", |a| set(item(a, 0, 0), &["contentClass"], s("IMAGE")), "UNSUPPORTED_CONTENT"),
        ("item bytes", |a| set(item(a, 0, 0), &["byteLength"], u(70_000)), "LIMIT_EXCEEDED"),
        ("pages", |a| set(item(a, 0, 0), &["resources", "pages"], u(21)), "LIMIT_EXCEEDED"),
        ("pixels", |a| set(item(a, 2, 0), &["resources", "pixels"], u(5_000_000)), "LIMIT_EXCEEDED"),
        ("decompressed bytes", |a| set(item(a, 0, 0), &["resources", "decompressedBytes"], u(2_000_000)), "LIMIT_EXCEEDED"),
        ("decompression ratio", |a| set(item(a, 0, 0), &["resources", "decompressionRatioPermille"], u(200_000)), "LIMIT_EXCEEDED"),
        ("parse time", |a| set(item(a, 0, 0), &["resources", "parseTimeMs"], u(5_000)), "LIMIT_EXCEEDED"),
        ("parser profile", |a| set(item(a, 0, 0), &["resources", "parserProfile"], s("pdfjs@9")), "UNSUPPORTED_CONTENT"),
        ("original digest", |a| set(item(a, 0, 0), &["originalDigest"], s(&"11".repeat(32))), "SIGNATURE_INVALID"),
        ("derived class", |a| set(&mut item(a, 0, 0)["struct"]["derived"]["list"][0], &["artifactClass"], s("OCR")), "VALIDATION_FAILED"),
        ("derived digest", |a| set(&mut item(a, 0, 0)["struct"]["derived"]["list"][0], &["digest"], s("not-a-digest")), "VALIDATION_FAILED"),
        ("derived transform", |a| set(&mut item(a, 0, 0)["struct"]["derived"]["list"][0], &["transformProfile"], s("other@1")), "VALIDATION_FAILED"),
        ("derived source binding", |a| set(&mut item(a, 0, 0)["struct"]["derived"]["list"][0], &["sourceDigest"], s(&"22".repeat(32))), "SOURCE_MISMATCH"),
        ("derived missing", |a| set(item(a, 0, 0), &["derived"], list(vec![])), "VALIDATION_FAILED"),
        ("version without predecessor", |a| set(item(a, 0, 0), &["version"], u(2)), "VALIDATION_FAILED"),
        ("predecessor on v1", |a| set(item(a, 0, 0), &["predecessorItemId"], s(&id("evi", "older"))), "VALIDATION_FAILED"),
        ("issuedAt changed", |a| set(item(a, 0, 0), &["issuer", "issuedAt"], u(T0 - 2 * DAY)), "SIGNATURE_INVALID"),
        ("freshness deadline", |a| set(item(a, 0, 0), &["freshUntil"], u(T0 + 365 * DAY)), "VALIDATION_FAILED"),
        ("itemCount", |a| set(slot(a, 2), &["itemCount"], u(2)), "VALIDATION_FAILED"),
        ("min cardinality", |a| {
            set(slot(a, 2), &["items"], list(vec![]));
            set(slot(a, 2), &["itemCount"], u(0));
        }, "INCOMPLETE"),
        ("missing slot", |a| {
            a["struct"]["slots"]["list"].as_array_mut().unwrap().pop();
        }, "INCOMPLETE"),
        ("slot order", |a| a["struct"]["slots"]["list"].as_array_mut().unwrap().swap(0, 1), "INCOMPLETE"),
        ("slot policy digest", |a| set(slot(a, 0), &["slotPolicyDigest"], s(&"33".repeat(32))), "POLICY_MISMATCH"),
        ("stale policy revision", |a| set(a, &["evidencePolicyRevision"], u(2)), "POLICY_MISMATCH"),
        ("policy digest", |a| set(a, &["evidencePolicyDigest"], s(&"44".repeat(32))), "POLICY_MISMATCH"),
        ("schema", |a| set(a, &["schema"], s("dockside/manifest-attestation@2")), "UNSUPPORTED_VERSION"),
        ("network", |a| set(a, &["network"], s("near-mainnet")), "WRONG_NETWORK"),
        ("trade revision", |a| set(a, &["tradeRevision"], u(2)), "STALE_REVISION"),
        ("cross-trade", |a| set(a, &["tradeId"], s(&id("trd", "other"))), "SCOPE_MISMATCH"),
        ("cross-org attestor", |a| set(a, &["organizationId"], s(&id("org", "supplier-org"))), "SCOPE_MISMATCH"),
        ("attestor scope org", |a| set(a, &["attestor", "scope", "organizationId"], s(&id("org", "other"))), "SCOPE_MISMATCH"),
        ("attestor trade scope", |a| set(a, &["attestor", "scope", "tradeId"], s(&id("trd", "other"))), "SCOPE_MISMATCH"),
        ("attestor policy scope", |a| set(a, &["attestor", "scope", "evidencePolicyRevision"], u(2)), "SCOPE_MISMATCH"),
        ("wrong-but-enrolled enrollment", |a| set(a, &["attestor", "enrollmentId"], s(&id("svc", "attestor-b"))), "KEY_NOT_BOUND"),
        ("rotated key version", |a| set(a, &["attestor", "keyVersion"], u(2)), "KEY_NOT_BOUND"),
        ("capability", |a| set(a, &["attestor", "capability"], s("DETERMINISTIC_POLICY_SET")), "SCOPE_MISMATCH"),
        ("lifetime", |a| set(a, &["expiresAt"], u(T0 + 2 * DAY)), "VALIDATION_FAILED"),
    ];
    for (name, m, expected) in cases {
        let mut rec = rec0.clone();
        let mut att = att_for(&rec, 1, &inv, &rep, &[&img], 1, name);
        m(&mut att);
        reseal(&rec, &mut att);
        assert_eq!(submit(&mut rec, &w, &att, "attestor"), expected, "{name}");
        assert!(rec.evidence.current.is_none(), "{name}: nothing accepted");
    }
}

#[test]
fn issuer_time_freshness_aggregate_and_duplicates_are_enforced_with_valid_issuer_signatures() {
    let (w, rec0) = evidence_trade();
    let (inv, rep, img) = base(&rec0);
    let check = |inv: &Item, rep: &Item, photos: &[&Item], expected: &str, n: &str| {
        let mut rec = rec0.clone();
        let att = att_for(&rec, 1, inv, rep, photos, 1, n);
        assert_eq!(submit(&mut rec, &w, &att, "attestor"), expected, "{n}");
    };
    let future = Item { issued_at: T0 + HOUR, ..invoice("inv-f") };
    check(&future, &rep, &[&img], "NOT_YET_VALID", "future");
    let stale = Item { issued_at: T0 - 31 * DAY, ..invoice("inv-s") };
    check(&stale, &rep, &[&img], "STALE_ITEM", "stale");
    let big1 = Item { bytes: 60_000, ..photo("img-a") };
    let big2 = Item { bytes: 60_000, ..photo("img-b") };
    check(&inv, &rep, &[&big1, &big2], "LIMIT_EXCEEDED", "aggregate");
    let p2 = photo("img-2");
    let p3 = photo("img-3");
    check(&inv, &rep, &[&img, &p2, &p3], "OVER_CARDINALITY", "over");
    check(&inv, &rep, &[&img, &img], "VALIDATION_FAILED", "duplicate");
    // An invoice "issued" by the buyer key while claiming the supplier's identity.
    let forged = Item { issuer_label: "buyer", ..invoice("inv-x") };
    check(&forged, &rep, &[&img], "SIGNATURE_INVALID", "forged-issuer");
    // The inspector cannot issue the supplier's invoice slot.
    let wrong_issuer = Item { issuer_cap: "INSPECTOR", issuer_label: "inspector", ..invoice("inv-y") };
    check(&wrong_issuer, &rep, &[&img], "FORBIDDEN", "wrong-issuer");
}

#[test]
fn signature_expiry_replay_wrong_attestor_and_revocation() {
    let (mut w, rec0) = evidence_trade();
    let (inv, rep, img) = base(&rec0);
    // Unsealed digest change: the contract recomputes the manifest digest.
    let mut rec = rec0.clone();
    let mut att = att_for(&rec, 1, &inv, &rep, &[&img], 1, "d1");
    set(&mut att, &["manifestDigest"], s(&"55".repeat(32)));
    assert_eq!(submit(&mut rec, &w, &att, "attestor"), "DIGEST_MISMATCH");
    // Mutation without re-signing.
    let att = att_for(&rec, 1, &inv, &rep, &[&img], 1, "d2");
    let sig = sign("attestor", "dockside/manifest-attestation", &att);
    let mut tampered = att.clone();
    set(item(&mut tampered, 0, 0), &["byteLength"], u(9));
    reseal(&rec, &mut tampered);
    assert_eq!(code(rec.submit_manifest_attestation(&w.ctx(), &tampered, &sig)), "SIGNATURE_INVALID");
    // Wrong-but-valid keys: another enrolled attestor, the policy setter, the buyer, a rotated key.
    for k in ["attestor-other", "policy", "buyer", "attestor-v2"] {
        assert_eq!(submit(&mut rec, &w, &att, k), "SIGNATURE_INVALID", "{k}");
    }
    // Accept, then replay the same revision and reuse the nonce.
    assert_eq!(submit(&mut rec, &w, &att, "attestor"), "OK");
    assert_eq!(submit(&mut rec, &w, &att, "attestor"), "STALE_MANIFEST");
    let mut again = att_for(&rec, 2, &inv, &rep, &[&img], 1, "d2");
    reseal(&rec, &mut again);
    assert_eq!(submit(&mut rec, &w, &again, "attestor"), "NONCE_REPLAYED");
    // Expired attestation.
    let late = att_for(&rec, 3, &inv, &rep, &[&img], 1, "d3");
    w.now = T0 + 2 * HOUR;
    assert_eq!(submit(&mut rec, &w, &late, "attestor"), "EXPIRED");
    // Revocation of the bound attestor: the unconsumed accepted manifest is invalidated and new
    // attestations are refused, even correctly signed ones.
    w.now = T0;
    let r = with_header(
        &rec,
        vec![
            ("role", s("manifestAttestor")),
            ("publicKey", s(&pk("attestor"))),
            ("signerRole", s("BUYER")),
            ("reasonCode", s("KEY_COMPROMISE")),
            ("issuedAt", u(T0)),
            ("expiresAt", u(T0 + HOUR)),
            ("nonce", s(&nonce("revoke-attestor"))),
        ],
    );
    rec.revoke_key(&w.ctx(), &r, &sign("buyer", "dockside/bound-key-revocation", &r)).unwrap();
    assert_eq!(rec.current_manifest_digest(w.now), None);
    let fresh = att_for(&rec, 4, &inv, &rep, &[&img], 1, "d4");
    assert_eq!(submit(&mut rec, &w, &fresh, "attestor"), "KEY_REVOKED");
}

#[test]
fn t018_replacement_supersedes_attestation_inspection_and_predecessor_items() {
    let (w, mut rec) = evidence_trade();
    let (inv, rep, img) = base(&rec);
    let a1 = att_for(&rec, 1, &inv, &rep, &[&img], 1, "r1");
    let d1 = rec.submit_manifest_attestation(&w.ctx(), &a1, &sign("attestor", "dockside/manifest-attestation", &a1)).unwrap();
    let i1 = inspection(&rec, 1, &d1, "PASS", T0, "i1");
    rec.submit_inspection(&w.ctx(), &i1, &sign("inspector", "dockside/inspection-attestation", &i1)).unwrap();
    assert_eq!(rec.evidence.current_inspection(w.now).map(|i| i.decision.as_str()), Some("PASS"));
    // Replace the invoice: version 2 with predecessor, slot currentness bumped.
    let inv2 = Item { version: 2, predecessor: Some(inv.id.clone()), ..invoice("inv-2") };
    let a2 = att_for(&rec, 2, &inv2, &rep, &[&img], 2, "r2");
    let d2 = rec.submit_manifest_attestation(&w.ctx(), &a2, &sign("attestor", "dockside/manifest-attestation", &a2)).unwrap();
    assert_ne!(d1, d2, "changed evidence changes the manifest digest");
    assert_eq!(rec.evidence.current_inspection(w.now), None, "predecessor inspection no longer authorizes");
    assert_eq!(rec.evidence.history.len(), 1);
    assert_eq!(format!("{:?}", rec.evidence.history[0].status), "Superseded");
    // Old inspection and old manifest cannot be replayed onto the new state.
    let stale_inspection = inspection(&rec, 1, &d1, "PASS", T0, "i-stale");
    assert_eq!(code(rec.submit_inspection(&w.ctx(), &stale_inspection, &sign("inspector", "dockside/inspection-attestation", &stale_inspection))), "STALE_MANIFEST");
    // The replaced invoice cannot come back as current, and currentness cannot regress.
    let a3 = att_for(&rec, 3, &inv, &rep, &[&img], 2, "r3");
    assert_eq!(submit(&mut rec, &w, &a3, "attestor"), "STALE_ITEM");
    let a4 = att_for(&rec, 3, &inv2, &rep, &[&img], 1, "r4");
    assert_eq!(submit(&mut rec, &w, &a4, "attestor"), "STALE_MANIFEST");
    // Removing a required item (empty photo slot) cannot be attested as complete.
    let mut a5 = att_for(&rec, 3, &inv2, &rep, &[&img], 2, "r5");
    set(slot(&mut a5, 2), &["items"], list(vec![]));
    set(slot(&mut a5, 2), &["itemCount"], u(0));
    reseal(&rec, &mut a5);
    assert_eq!(submit(&mut rec, &w, &a5, "attestor"), "INCOMPLETE");
}

#[test]
fn t017_only_the_bound_inspector_attests_the_current_usable_manifest() {
    let (mut w, mut rec) = evidence_trade();
    let none = inspection(&rec, 1, &"66".repeat(32), "PASS", T0, "n0");
    assert_eq!(code(rec.submit_inspection(&w.ctx(), &none, &sign("inspector", "dockside/inspection-attestation", &none))), "MANIFEST_NOT_CURRENT");
    let (inv, rep, img) = base(&rec);
    let a = att_for(&rec, 1, &inv, &rep, &[&img], 1, "q1");
    let d = rec.submit_manifest_attestation(&w.ctx(), &a, &sign("attestor", "dockside/manifest-attestation", &a)).unwrap();
    let p = inspection(&rec, 1, &d, "PASS", T0, "q2");
    // Buyer-controlled, risk, attestor and unbound inspector keys are refused.
    for k in ["buyer", "risk", "attestor", "inspector-2"] {
        assert_eq!(code(rec.submit_inspection(&w.ctx(), &p, &sign(k, "dockside/inspection-attestation", &p))), "SIGNATURE_INVALID", "{k}");
    }
    let mut other = p.clone();
    set(&mut other, &["inspectorPrincipalId"], s(&id("prn", "inspector-2")));
    assert_eq!(code(rec.submit_inspection(&w.ctx(), &other, &sign("inspector", "dockside/inspection-attestation", &other))), "KEY_NOT_BOUND");
    let mut bad = p.clone();
    set(&mut bad, &["decision"], s("AUTO_PASS"));
    assert_eq!(code(rec.submit_inspection(&w.ctx(), &bad, &sign("inspector", "dockside/inspection-attestation", &bad))), "VALIDATION_FAILED");
    let mut wrong_manifest = p.clone();
    set(&mut wrong_manifest, &["manifestDigest"], s(&"77".repeat(32)));
    assert_eq!(code(rec.submit_inspection(&w.ctx(), &wrong_manifest, &sign("inspector", "dockside/inspection-attestation", &wrong_manifest))), "STALE_MANIFEST");
    rec.submit_inspection(&w.ctx(), &p, &sign("inspector", "dockside/inspection-attestation", &p)).unwrap();
    assert_eq!(code(rec.submit_inspection(&w.ctx(), &p, &sign("inspector", "dockside/inspection-attestation", &p))), "NONCE_REPLAYED");
    // After the attestation expires the manifest is no longer usable for a new inspection.
    w.now = T0 + 2 * HOUR;
    let late = inspection(&rec, 1, &d, "FAIL", w.now, "q3");
    assert_eq!(code(rec.submit_inspection(&w.ctx(), &late, &sign("inspector", "dockside/inspection-attestation", &late))), "MANIFEST_NOT_CURRENT");
    // Revoking the inspector key invalidates its unconsumed decision.
    w.now = T0;
    let r = with_header(
        &rec,
        vec![
            ("role", s("inspector")),
            ("publicKey", s(&pk("inspector"))),
            ("signerRole", s("SUPPLIER")),
            ("reasonCode", s("KEY_COMPROMISE")),
            ("issuedAt", u(T0)),
            ("expiresAt", u(T0 + HOUR)),
            ("nonce", s(&nonce("revoke-inspector"))),
        ],
    );
    rec.revoke_key(&w.ctx(), &r, &sign("supplier", "dockside/bound-key-revocation", &r)).unwrap();
    assert_eq!(rec.evidence.current_inspection(w.now), None);
    let again = inspection(&rec, 1, &d, "PASS", T0, "q4");
    assert_eq!(code(rec.submit_inspection(&w.ctx(), &again, &sign("inspector", "dockside/inspection-attestation", &again))), "KEY_REVOKED");
}

#[test]
fn holds_bind_the_current_manifest_once_one_exists() {
    let (w, mut rec) = evidence_trade();
    let (inv, rep, img) = base(&rec);
    let a = att_for(&rec, 1, &inv, &rep, &[&img], 1, "h1");
    let d = rec.submit_manifest_attestation(&w.ctx(), &a, &sign("attestor", "dockside/manifest-attestation", &a)).unwrap();
    let hdr = rec.clone();
    let mk = |m: &str, n: &str| {
        with_header(
            &hdr,
            vec![
                ("holdId", s(&id("hld", n))),
                ("manifestDigest", s(m)),
                ("reasonCode", s("DOC_MISMATCH")),
                ("issuerRole", s("POLICY_SETTER")),
                ("ruleId", s("invoice-amount@1")),
                ("schema", s("dockside/hold-set@1")),
                ("issuedAt", u(T0)),
                ("expiresAt", u(T0 + DAY)),
                ("nonce", s(&nonce(n))),
            ],
        )
    };
    let stale = mk(&"88".repeat(32), "hs1");
    assert_eq!(code(rec.set_hold(&w.ctx(), &stale, &sign("policy", "dockside/hold-set", &stale))), "STALE_MANIFEST");
    let ok = mk(&d, "hs2");
    rec.set_hold(&w.ctx(), &ok, &sign("policy", "dockside/hold-set", &ok)).unwrap();
    assert_eq!(rec.blocking_holds(), 1);
}
