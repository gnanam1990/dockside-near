//! Signed payload builders. Each mirrors the typed JSON packages/core emits and the exact field
//! set the contract decodes; signatures are over the DCE-1 digest the contract recomputes.

use crate::*;
use dockside_escrow_core::assets::UnexpectedAsset;
use dockside_escrow_core::destination::ChangeStatus;
use dockside_escrow_core::release::{destination_digest, source_bucket_digest};
use dockside_escrow_core::TradeRecord;

/* ----------------------------------- terms ----------------------------------- */

/// Revision-1 terms naming the run's escrow account, party accounts and keys.
pub fn terms(fx: &Fixture) -> J {
    let buyer_org = fx.id("org", "buyer-org");
    let trade = fx.trade_id();
    let svc = |enr: &str, sid: &str, label: &str, cap: &str, trade_scope: Option<&str>, schema: &str| {
        st(vec![
            ("enrollmentId", s(&fx.id("svc", enr))),
            ("serviceId", s(sid)),
            ("keyVersion", u(1)),
            ("publicKey", s(&fx.pk(label))),
            ("capability", s(cap)),
            (
                "scope",
                st(vec![
                    ("organizationId", s(&buyer_org)),
                    ("tradeId", opt(trade_scope)),
                    ("evidencePolicyId", s("commercial-docs")),
                    ("evidencePolicyRevision", u(1)),
                ]),
            ),
            ("attestationSchema", s(schema)),
        ])
    };
    let a = &fx.accounts;
    st(vec![
        ("schemaVersion", u(1)),
        ("profileVersion", s("dockside-direct-testnet-v1")),
        ("tradeId", s(&trade)),
        ("revision", u(1)),
        ("predecessorDigest", null()),
        ("network", s(NETWORK)),
        ("escrowContractId", s(&a.contract)),
        (
            "buyer",
            st(vec![
                ("organizationId", s(&buyer_org)),
                ("principalId", s(&fx.id("prn", "buyer"))),
                ("keyVersionId", s(&fx.id("key", "buyer-1"))),
                ("publicKey", s(&fx.pk("buyer"))),
                ("accountId", s(&a.buyer)),
            ]),
        ),
        (
            "supplier",
            st(vec![
                ("organizationId", s(&fx.id("org", "supplier-org"))),
                ("principalId", s(&fx.id("prn", "supplier"))),
                ("keyVersionId", s(&fx.id("key", "supplier-1"))),
                ("publicKey", s(&fx.pk("supplier"))),
                ("accountId", s(&a.supplier)),
            ]),
        ),
        ("asset", st(vec![("kind", s("NEAR_NATIVE")), ("network", s(NETWORK))])),
        ("amountYocto", big(fx.amount_yocto)),
        ("milestone", st(vec![("id", s("shipment-1")), ("description", s("Container loaded"))])),
        ("evidencePolicy", st(vec![("id", s("commercial-docs")), ("revision", u(1)), ("digest", s(&policy_digest()))])),
        (
            "inspector",
            st(vec![
                ("principalId", s(&fx.id("prn", "inspector"))),
                ("keyVersionId", s(&fx.id("key", "inspector-1"))),
                ("publicKey", s(&fx.pk("inspector"))),
                ("attestationSchema", s("dockside/inspection-attestation@1")),
            ]),
        ),
        ("manifestAttestor", svc("attestor", "manifest-attestor", "attestor", "MANIFEST_ATTEST", None, "dockside/manifest-attestation@1")),
        ("policySetter", svc("policy", "deterministic-policy", "policy", "DETERMINISTIC_POLICY_SET", Some(&trade), "dockside/hold-set@1")),
        (
            "riskResolver",
            st(vec![
                ("principalId", s(&fx.id("prn", "risk"))),
                ("keyVersionId", s(&fx.id("key", "risk-1"))),
                ("publicKey", s(&fx.pk("risk"))),
            ]),
        ),
        ("payout", st(vec![("network", s(NETWORK)), ("recipientType", s("NEAR_ACCOUNT")), ("destination", s(&a.supplier))])),
        ("refundPolicy", st(vec![("id", s("dockside-refund-v1")), ("revision", u(1))])),
        ("delayPolicy", st(vec![("destinationChangeDelayMs", u(fx.destination_change_delay_ms))])),
        ("expiresAt", u(fx.t0 + 30 * DAY)),
    ])
}

/// `register_trade` arguments: terms plus both party signatures over the revision digest.
pub fn register_args(fx: &Fixture) -> J {
    let t = terms(fx);
    json!({
        "terms": t,
        "buyer_signature": fx.sign("buyer", "dockside/trade-revision", &t),
        "supplier_signature": fx.sign("supplier", "dockside/trade-revision", &t),
    })
}

/// Common header of every signed trade payload.
pub fn with_header(rec: &TradeRecord, contract: &str, mut extra: Vec<(&'static str, J)>) -> J {
    let mut f = vec![
        ("contractId", s(contract)),
        ("tradeId", s(&rec.terms.trade_id)),
        ("tradeRevision", u(rec.terms.revision)),
        ("tradeDigest", s(&rec.terms_digest)),
    ];
    f.append(&mut extra);
    st(f)
}

/* ---------------------------------- evidence ---------------------------------- */

#[allow(clippy::too_many_arguments)]
fn slot_policy(slot: &str, mime: &[&str], class: &str, issuer: &str, uploaders: &[&str], min: u64, max: u64, derived: (&str, &str)) -> J {
    st(vec![
        ("schema", s("dockside/evidence-slot-policy@1")),
        ("slotId", s(slot)),
        ("purpose", s(&format!("{slot} for the milestone"))),
        ("minItems", u(min)),
        ("maxItems", u(max)),
        ("allowedMime", list(mime.iter().map(|m| s(m)).collect())),
        ("contentClass", s(class)),
        ("maxItemBytes", u(65_536)),
        ("maxAggregateBytes", u(if slot == "cargo-photos" { 100_000 } else { 65_536 })),
        (
            "limits",
            st(vec![
                ("maxPages", u(20)),
                ("maxPixels", u(4_000_000)),
                ("maxDecompressedBytes", u(1_048_576)),
                ("maxDecompressionRatioPermille", u(100_000)),
                ("maxParseTimeMs", u(2_000)),
            ]),
        ),
        ("parserProfiles", list(vec![s("dockside-sniff@1")])),
        ("uploaderCapabilities", list(uploaders.iter().map(|c| s(c)).collect())),
        ("issuerCapabilities", list(vec![s(issuer)])),
        ("issuedAtRequired", json!({"bool": true})),
        ("freshnessMs", u(30 * DAY)),
        ("replacement", s("SUPERSEDE_CURRENT")),
        ("requiredDerived", list(vec![st(vec![("artifactClass", s(derived.0)), ("transformProfile", s(derived.1))])])),
    ])
}

/// The three-slot commercial-documents EvidencePolicy.
pub fn policy() -> J {
    st(vec![
        ("schema", s("dockside/evidence-policy@1")),
        ("policyId", s("commercial-docs")),
        ("revision", u(1)),
        ("attestationLifetimeMs", u(DAY)),
        (
            "slots",
            list(vec![
                slot_policy("commercial-invoice", &["application/pdf", "text/plain"], "DOCUMENT", "SUPPLIER_SIGNER", &["SUPPLIER_SIGNER", "EVIDENCE_UPLOADER"], 1, 1, ("TEXT_EXTRACT", "dockside-text@1")),
                slot_policy("inspection-report", &["application/pdf", "text/plain"], "DOCUMENT", "INSPECTOR", &["INSPECTOR"], 1, 1, ("TEXT_EXTRACT", "dockside-text@1")),
                slot_policy("cargo-photos", &["image/png", "image/jpeg"], "IMAGE", "INSPECTOR", &["INSPECTOR", "BUYER_APPROVER"], 1, 2, ("IMAGE_METADATA", "dockside-image-meta@1")),
            ]),
        ),
    ])
}

pub fn policy_digest() -> String {
    digest_hex("dockside/evidence-policy", &policy())
}

fn slot_digest(i: usize) -> String {
    let p = policy();
    let slots = p["struct"]["slots"]["list"].as_array().expect("slots").clone();
    digest_hex("dockside/evidence-slot-policy", &slots[i])
}

struct Item {
    slot: &'static str,
    id: String,
    digest: String,
    mime: &'static str,
    class: &'static str,
    issuer_cap: &'static str,
    issuer_label: &'static str,
    uploader_cap: &'static str,
    issued_at: u64,
    pages: u64,
    pixels: u64,
    derived_class: &'static str,
    derived_profile: &'static str,
}

fn item(fx: &Fixture, slot: &'static str, label: &str, issued_at: u64) -> Item {
    let doc = Item {
        slot,
        id: fx.id("evi", label),
        digest: hex::encode(sha256(format!("item/{}/{label}", fx.seed).as_bytes())),
        mime: "application/pdf",
        class: "DOCUMENT",
        issuer_cap: "SUPPLIER_SIGNER",
        issuer_label: "supplier",
        uploader_cap: "SUPPLIER_SIGNER",
        issued_at,
        pages: 1,
        pixels: 0,
        derived_class: "TEXT_EXTRACT",
        derived_profile: "dockside-text@1",
    };
    match slot {
        "commercial-invoice" => doc,
        "inspection-report" => Item { issuer_cap: "INSPECTOR", issuer_label: "inspector", uploader_cap: "INSPECTOR", ..doc },
        _ => Item {
            mime: "image/png",
            class: "IMAGE",
            issuer_cap: "INSPECTOR",
            issuer_label: "inspector",
            uploader_cap: "INSPECTOR",
            pages: 0,
            pixels: 1_000_000,
            derived_class: "IMAGE_METADATA",
            derived_profile: "dockside-image-meta@1",
            ..doc
        },
    }
}

fn party(fx: &Fixture, rec: &TradeRecord, cap: &str) -> (String, String, String) {
    match cap {
        "SUPPLIER_SIGNER" => (rec.terms.supplier.principal_id.clone(), rec.terms.supplier.key_version_id.clone(), rec.terms.supplier.organization_id.clone()),
        "BUYER_APPROVER" => (rec.terms.buyer.principal_id.clone(), rec.terms.buyer.key_version_id.clone(), rec.terms.buyer.organization_id.clone()),
        _ => (rec.terms.inspector.principal_id.clone(), rec.terms.inspector.key_version_id.clone(), fx.id("org", "inspections")),
    }
}

fn item_facts(fx: &Fixture, rec: &TradeRecord, it: &Item) -> J {
    let (ip, ik, _) = party(fx, rec, it.issuer_cap);
    let (up, uk, uorg) = party(fx, rec, it.uploader_cap);
    let issuance = st(vec![
        ("tradeId", s(&rec.terms.trade_id)),
        ("slotId", s(it.slot)),
        ("originalDigest", s(&it.digest)),
        ("issuedAt", u(it.issued_at)),
        ("issuerPrincipalId", s(&ip)),
        ("issuerKeyVersionId", s(&ik)),
        ("issuerCapability", s(it.issuer_cap)),
    ]);
    let sig = fx.sign(it.issuer_label, "dockside/evidence-issuance", &issuance);
    st(vec![
        ("itemId", s(&it.id)),
        ("version", u(1)),
        ("predecessorItemId", null()),
        ("originalDigest", s(&it.digest)),
        ("byteLength", u(2_048)),
        ("detectedMime", s(it.mime)),
        ("contentClass", s(it.class)),
        (
            "resources",
            st(vec![
                ("pages", u(it.pages)),
                ("pixels", u(it.pixels)),
                ("decompressedBytes", u(2_048)),
                ("decompressionRatioPermille", u(1_000)),
                ("parseTimeMs", u(3)),
                ("parserProfile", s("dockside-sniff@1")),
            ]),
        ),
        ("uploader", st(vec![("principalId", s(&up)), ("organizationId", s(&uorg)), ("capability", s(it.uploader_cap)), ("keyVersionId", s(&uk))])),
        ("issuer", st(vec![("principalId", s(&ip)), ("capability", s(it.issuer_cap)), ("keyVersionId", s(&ik)), ("issuedAt", u(it.issued_at)), ("signature", s(&sig))])),
        ("freshUntil", u(it.issued_at + 30 * DAY)),
        (
            "derived",
            list(vec![st(vec![
                ("artifactClass", s(it.derived_class)),
                ("digest", s(&hex::encode(sha256(format!("derived/{}", it.id).as_bytes())))),
                ("transformProfile", s(it.derived_profile)),
                ("sourceDigest", s(&it.digest)),
            ])]),
        ),
    ])
}

fn slot_facts(fx: &Fixture, rec: &TradeRecord, idx: usize, slot: &str, items: &[&Item], currentness: u64) -> J {
    st(vec![
        ("slotId", s(slot)),
        ("slotPolicyDigest", s(&slot_digest(idx))),
        ("itemCount", u(items.len() as u64)),
        ("currentnessVersion", u(currentness)),
        ("items", list(items.iter().map(|i| item_facts(fx, rec, i)).collect())),
    ])
}

pub fn manifest_digest(rec: &TradeRecord, revision: u64, slots: &J) -> String {
    let m = st(vec![
        ("tradeId", s(&rec.terms.trade_id)),
        ("tradeRevision", u(rec.terms.revision)),
        ("evidencePolicyId", s("commercial-docs")),
        ("evidencePolicyRevision", u(1)),
        ("manifestRevision", u(revision)),
        ("slots", slots.clone()),
    ]);
    digest_hex("dockside/evidence-manifest", &m)
}

/// `submit_manifest_attestation` arguments for a complete manifest at `revision`, issued `now`.
/// Every slot is filled by issuer-signed items; `n` keeps item ids and nonces distinct.
pub fn attestation_args(fx: &Fixture, rec: &TradeRecord, revision: u64, now: u64, n: &str) -> J {
    let issued = now.saturating_sub(HOUR);
    let inv = item(fx, "commercial-invoice", &format!("inv-{n}"), issued);
    let rep = item(fx, "inspection-report", &format!("rep-{n}"), issued);
    let img = item(fx, "cargo-photos", &format!("img-{n}"), issued);
    let slots = list(vec![
        slot_facts(fx, rec, 0, "commercial-invoice", &[&inv], revision),
        slot_facts(fx, rec, 1, "inspection-report", &[&rep], revision),
        slot_facts(fx, rec, 2, "cargo-photos", &[&img], revision),
    ]);
    let digest = manifest_digest(rec, revision, &slots);
    let b = &rec.terms.manifest_attestor;
    let p = with_header(
        rec,
        &fx.accounts.contract,
        vec![
            ("network", s(NETWORK)),
            ("organizationId", s(&b.scope.organization_id)),
            ("evidencePolicyId", s("commercial-docs")),
            ("evidencePolicyRevision", u(1)),
            ("evidencePolicyDigest", s(&policy_digest())),
            ("schema", s("dockside/manifest-attestation@1")),
            ("manifestRevision", u(revision)),
            ("manifestDigest", s(&digest)),
            (
                "attestor",
                st(vec![
                    ("enrollmentId", s(&b.enrollment_id)),
                    ("serviceId", s(&b.service_id)),
                    ("keyVersion", u(b.key_version)),
                    ("capability", s("MANIFEST_ATTEST")),
                    (
                        "scope",
                        st(vec![
                            ("organizationId", s(&b.scope.organization_id)),
                            ("tradeId", opt(b.scope.trade_id.as_deref())),
                            ("evidencePolicyId", s("commercial-docs")),
                            ("evidencePolicyRevision", u(1)),
                        ]),
                    ),
                ]),
            ),
            ("issuedAt", u(now)),
            ("expiresAt", u(now + HOUR)),
            ("nonce", s(&fx.nonce(&format!("att-{n}")))),
            ("slots", slots),
        ],
    );
    json!({ "trade_id": rec.terms.trade_id, "signature": fx.sign("attestor", "dockside/manifest-attestation", &p), "payload": p })
}

/// `submit_inspection` arguments: the bound inspector's decision over the current manifest.
pub fn inspection_args(fx: &Fixture, rec: &TradeRecord, decision: &str, now: u64, n: &str) -> J {
    let m = rec.evidence.current.as_ref().expect("a contract-accepted manifest");
    let p = with_header(
        rec,
        &fx.accounts.contract,
        vec![
            ("milestoneId", s("shipment-1")),
            ("evidencePolicyId", s("commercial-docs")),
            ("evidencePolicyRevision", u(1)),
            ("manifestRevision", u(m.revision)),
            ("manifestDigest", s(&m.digest)),
            ("decision", s(decision)),
            ("reasonCodes", list(vec![s("DOCS_MATCH")])),
            ("inspectorPrincipalId", s(&rec.terms.inspector.principal_id)),
            ("inspectorKeyVersionId", s(&rec.terms.inspector.key_version_id)),
            ("schema", s("dockside/inspection-attestation@1")),
            ("issuedAt", u(now)),
            ("expiresAt", u(now + 7 * DAY)),
            ("nonce", s(&fx.nonce(&format!("ins-{n}")))),
        ],
    );
    json!({ "trade_id": rec.terms.trade_id, "signature": fx.sign("inspector", "dockside/inspection-attestation", &p), "payload": p })
}

/* ---------------------------------- release ---------------------------------- */

/// `create_release_intent` arguments locking the current available slices.
pub fn intent_args(fx: &Fixture, rec: &TradeRecord, now: u64, n: &str) -> J {
    let slices = rec.ledger.available_slices();
    let p = with_header(
        rec,
        &fx.accounts.contract,
        vec![
            ("network", s(NETWORK)),
            ("releaseIntentId", s(&fx.id("rli", n))),
            ("amountYocto", big(rec.terms.amount_yocto)),
            ("executionProfile", s("DIRECT_TESTNET")),
            ("destination", s(&rec.terms.payout_destination)),
            ("destinationDigest", s(&destination_digest(NETWORK, &rec.terms.payout_destination).expect("destination"))),
            ("sourceBucketDigest", s(&source_bucket_digest(&slices).expect("slices"))),
            ("intentExpiresAt", u(now + 3 * DAY)),
            ("signerRole", s("BUYER_APPROVER")),
            ("issuedAt", u(now)),
            ("expiresAt", u(now + HOUR)),
            ("nonce", s(&fx.nonce(&format!("intent/{n}")))),
        ],
    );
    json!({ "trade_id": rec.terms.trade_id, "buyer_signature": fx.sign("buyer", "dockside/release-intent", &p), "payload": p })
}

/// `approve_release` arguments bound to the intent, current manifest, inspection and holds view.
pub fn approval_args(fx: &Fixture, rec: &TradeRecord, intent_id: &str, now: u64, n: &str) -> J {
    let i = &rec.release.intents[intent_id];
    let m = rec.evidence.current.as_ref();
    let ins = rec.evidence.inspection.as_ref();
    let zero = "00".repeat(32);
    let p = with_header(
        rec,
        &fx.accounts.contract,
        vec![
            ("releaseIntentId", s(intent_id)),
            ("intentStateVersion", u(i.version)),
            ("amountYocto", big(i.amount)),
            ("executionProfile", s(&i.profile)),
            ("destination", s(&i.destination)),
            ("destinationDigest", s(&destination_digest(NETWORK, &i.destination).expect("destination"))),
            ("manifestRevision", u(m.map(|m| m.revision).unwrap_or(0))),
            ("manifestDigest", s(&m.map(|m| m.digest.clone()).unwrap_or_else(|| zero.clone()))),
            ("attestationDigest", s(&m.map(|m| m.attestation_digest.clone()).unwrap_or_else(|| zero.clone()))),
            ("inspectionDigest", s(&ins.map(|i| i.digest.clone()).unwrap_or_else(|| zero.clone()))),
            ("holdsViewDigest", s(&rec.holds_view_digest(now).expect("holds view"))),
            ("signerRole", s("BUYER_APPROVER")),
            ("issuedAt", u(now)),
            ("expiresAt", u(now + DAY)),
            ("nonce", s(&fx.nonce(&format!("approval/{n}")))),
        ],
    );
    json!({ "trade_id": rec.terms.trade_id, "signature": fx.sign("buyer", "dockside/buyer-approval", &p), "payload": p })
}

pub fn execute_release_args(rec: &TradeRecord, intent_id: &str) -> J {
    json!({ "trade_id": rec.terms.trade_id, "release_intent_id": intent_id })
}

/* ------------------------------ destination change ------------------------------ */

/// The typed terms of the active revision, rebuilt from revision 1 and the activated changes.
pub fn active_terms(fx: &Fixture, rec: &TradeRecord) -> J {
    let mut t = terms(fx);
    for ch in rec.destination.history.iter().filter(|c| c.status == ChangeStatus::Activated) {
        let d = digest_hex("dockside/trade-revision", &t);
        set(&mut t, &["revision"], u(ch.terms.revision));
        set(&mut t, &["predecessorDigest"], s(&d));
        set(&mut t, &["payout", "destination"], s(&ch.to_destination));
    }
    assert_eq!(digest_hex("dockside/trade-revision", &t), rec.terms_digest, "fixture rebuilds the active revision");
    t
}

/// Successor revision of the active terms that changes only the payout destination.
pub fn successor_terms(fx: &Fixture, rec: &TradeRecord, dest: &str) -> J {
    let mut t = active_terms(fx, rec);
    set(&mut t, &["revision"], u(rec.terms.revision + 1));
    set(&mut t, &["predecessorDigest"], s(&rec.terms_digest));
    set(&mut t, &["payout", "destination"], s(dest));
    t
}

/// `propose_destination_change` arguments; `signer` is the key label that signs.
pub fn propose_destination_args(fx: &Fixture, rec: &TradeRecord, dest: &str, role: &str, signer: &str) -> J {
    let t = successor_terms(fx, rec, dest);
    json!({
        "trade_id": rec.terms.trade_id,
        "signature": fx.sign(signer, "dockside/trade-revision", &t),
        "successor_terms": t,
        "proposer_role": role,
    })
}

pub fn consent_destination_args(fx: &Fixture, rec: &TradeRecord, dest: &str, role: &str, signer: &str) -> J {
    let t = successor_terms(fx, rec, dest);
    json!({
        "trade_id": rec.terms.trade_id,
        "successor_digest": digest_hex("dockside/trade-revision", &t),
        "role": role,
        "signature": fx.sign(signer, "dockside/trade-revision", &t),
    })
}

pub fn activate_destination_args(fx: &Fixture, rec: &TradeRecord, dest: &str) -> J {
    let t = successor_terms(fx, rec, dest);
    json!({ "trade_id": rec.terms.trade_id, "successor_digest": digest_hex("dockside/trade-revision", &t) })
}

/* ---------------------------------- refunds ---------------------------------- */

/// A typed `dockside/refund-request` payload.
#[allow(clippy::too_many_arguments)]
pub fn refund_request(fx: &Fixture, rec: &TradeRecord, label: &str, reason: &str, funder: &str, amount: u128, bucket: &str, initiator: &str, now: u64) -> J {
    with_header(
        rec,
        &fx.accounts.contract,
        vec![
            ("refundIntentId", s(&fx.id("rfd", label))),
            ("policyId", s("dockside-refund-v1")),
            ("policyRevision", u(1)),
            ("reason", s(reason)),
            ("funder", s(funder)),
            ("amountYocto", big(amount)),
            ("sourceBucket", s(bucket)),
            ("initiatorRole", s(initiator)),
            ("issuedAt", u(now)),
            ("expiresAt", u(now + DAY)),
            ("nonce", s(&fx.nonce(&format!("refund/{label}")))),
        ],
    )
}

/// `request_refund` arguments. Party signatures are added for the roles named in `signers`.
pub fn request_refund_args(fx: &Fixture, rec: &TradeRecord, payload: &J, signers: &[&str]) -> J {
    let sig = |label: &str| {
        if signers.contains(&label) {
            J::String(fx.sign(label, "dockside/refund-request", payload))
        } else {
            J::Null
        }
    };
    json!({
        "trade_id": rec.terms.trade_id,
        "payload": payload,
        "buyer_signature": sig("buyer"),
        "supplier_signature": sig("supplier"),
        "risk_signature": sig("risk"),
    })
}

pub fn refund_id(fx: &Fixture, label: &str) -> String {
    fx.id("rfd", label)
}

/// `cosign_refund` arguments: the named role signs the same request digest (`request` is the
/// typed payload the refund was requested with).
pub fn cosign_refund_args(fx: &Fixture, rec: &TradeRecord, request: &J, role: &str) -> J {
    let id = request["struct"]["refundIntentId"]["str"].as_str().expect("refundIntentId").to_string();
    assert_eq!(rec.refunds[&id].request_digest, digest_hex("dockside/refund-request", request));
    let label = fx.role_key(role).0;
    json!({
        "trade_id": rec.terms.trade_id,
        "refund_intent_id": id,
        "role": role,
        "signature": fx.sign(label, "dockside/refund-request", request),
    })
}

pub fn refund_op_args(rec: &TradeRecord, refund_intent_id: &str) -> J {
    json!({ "trade_id": rec.terms.trade_id, "refund_intent_id": refund_intent_id })
}

/* ----------------------------- unexpected assets ----------------------------- */

pub fn asset_request_args(fx: &Fixture, rec: &TradeRecord, a: &UnexpectedAsset, now: u64, n: &str) -> J {
    let p = with_header(
        rec,
        &fx.accounts.contract,
        vec![
            ("recoveryId", s(&fx.id("arc", n))),
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
            ("issuedAt", u(now)),
            ("expiresAt", u(now + DAY)),
            ("nonce", s(&fx.nonce(&format!("req-{n}")))),
        ],
    );
    json!({ "asset_index": a.index, "trade_id": rec.terms.trade_id, "payload": p })
}

pub fn asset_approval_args(fx: &Fixture, rec: &TradeRecord, a: &UnexpectedAsset, now: u64, n: &str) -> J {
    let r = a.recoveries.last().expect("recovery");
    let p = with_header(
        rec,
        &fx.accounts.contract,
        vec![
            ("recoveryId", s(&r.id)),
            ("requestDigest", s(&r.request_digest)),
            ("assetIndex", u(a.index)),
            ("amount", s(&a.observed_amount)),
            ("recipient", s(&r.recipient)),
            ("recoveryCapability", s("NEP141_FT_TRANSFER")),
            ("validationDigest", s(&"ef".repeat(32))),
            ("approverRole", s("RISK_RESOLVER")),
            ("issuedAt", u(now)),
            ("expiresAt", u(now + HOUR)),
            ("nonce", s(&fx.nonce(&format!("apr-{n}")))),
        ],
    );
    json!({
        "asset_index": a.index,
        "trade_id": rec.terms.trade_id,
        "signature": fx.sign("risk", "dockside/asset-recovery-approval", &p),
        "payload": p,
    })
}

pub fn execute_asset_recovery_args(a: &UnexpectedAsset) -> J {
    let r = a.recoveries.last().expect("recovery");
    json!({ "asset_index": a.index, "recovery_id": r.id })
}

/// Manifest revisions never regress: the next one is above every accepted revision.
pub fn next_manifest_revision(rec: &TradeRecord) -> u64 {
    rec.evidence.last_revision().map(|r| r + 1).unwrap_or(1)
}

pub fn policy_args(rec: &TradeRecord) -> J {
    json!({ "trade_id": rec.terms.trade_id, "policy": policy() })
}

/// A deposit names the trade revision digest the funder agreed to.
pub fn fund_args(trade_id: &str, terms_digest: &str) -> J {
    json!({ "trade_id": trade_id, "terms_digest": terms_digest })
}
