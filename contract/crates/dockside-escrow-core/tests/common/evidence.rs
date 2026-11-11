//! Evidence fixtures for contract-boundary tests: a real EvidencePolicy, issuer-signed items and a
//! ManifestAttestation signed by the bound attestor key, all as typed JSON.
#![allow(dead_code)]

use super::*;
use dockside_escrow_core::TradeRecord;

pub const DAY: u64 = 24 * HOUR;

pub fn slot_policy(slot: &str, mime: &[&str], class: &str, issuer: &str, uploaders: &[&str], min: u64, max: u64, derived: (&str, &str)) -> J {
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

/// Trade registered with the real policy digest, policy registered on the record.
pub fn evidence_trade() -> (World, TradeRecord) {
    let mut t = terms();
    set(&mut t, &["evidencePolicy", "digest"], s(&policy_digest()));
    let (w, mut rec) = registered_with(&t);
    rec.register_evidence_policy(&policy()).expect("policy registers");
    (w, rec)
}

pub struct Item {
    pub slot: &'static str,
    pub id: String,
    pub version: u64,
    pub predecessor: Option<String>,
    pub digest: String,
    pub mime: &'static str,
    pub class: &'static str,
    pub issuer_cap: &'static str,
    pub issuer_label: &'static str,
    pub uploader_cap: &'static str,
    pub issued_at: u64,
    pub bytes: u64,
    pub pages: u64,
    pub pixels: u64,
    pub derived_class: &'static str,
    pub derived_profile: &'static str,
}

pub fn invoice(label: &str) -> Item {
    Item {
        slot: "commercial-invoice",
        id: id("evi", label),
        version: 1,
        predecessor: None,
        digest: hex::encode(sha256_of(label)),
        mime: "application/pdf",
        class: "DOCUMENT",
        issuer_cap: "SUPPLIER_SIGNER",
        issuer_label: "supplier",
        uploader_cap: "SUPPLIER_SIGNER",
        issued_at: T0 - DAY,
        bytes: 2_048,
        pages: 1,
        pixels: 0,
        derived_class: "TEXT_EXTRACT",
        derived_profile: "dockside-text@1",
    }
}

pub fn report(label: &str) -> Item {
    Item { slot: "inspection-report", issuer_cap: "INSPECTOR", issuer_label: "inspector", uploader_cap: "INSPECTOR", ..invoice(label) }
}

pub fn photo(label: &str) -> Item {
    Item {
        slot: "cargo-photos",
        mime: "image/png",
        class: "IMAGE",
        issuer_cap: "INSPECTOR",
        issuer_label: "inspector",
        uploader_cap: "INSPECTOR",
        pages: 0,
        pixels: 1_000_000,
        derived_class: "IMAGE_METADATA",
        derived_profile: "dockside-image-meta@1",
        ..invoice(label)
    }
}

pub fn sha256_of(label: &str) -> [u8; 32] {
    use sha2::Digest;
    sha2::Sha256::digest(format!("item/{label}").as_bytes()).into()
}

fn party(rec: &TradeRecord, cap: &str) -> (String, String, String) {
    match cap {
        "SUPPLIER_SIGNER" => (rec.terms.supplier.principal_id.clone(), rec.terms.supplier.key_version_id.clone(), rec.terms.supplier.organization_id.clone()),
        "BUYER_APPROVER" => (rec.terms.buyer.principal_id.clone(), rec.terms.buyer.key_version_id.clone(), rec.terms.buyer.organization_id.clone()),
        "INSPECTOR" => (rec.terms.inspector.principal_id.clone(), rec.terms.inspector.key_version_id.clone(), id("org", "inspections")),
        _ => (id("prn", "uploader"), id("key", "uploader-1"), rec.terms.supplier.organization_id.clone()),
    }
}

pub fn issuance(rec: &TradeRecord, it: &Item) -> J {
    let (p, k, _) = party(rec, it.issuer_cap);
    st(vec![
        ("tradeId", s(&rec.terms.trade_id)),
        ("slotId", s(it.slot)),
        ("originalDigest", s(&it.digest)),
        ("issuedAt", u(it.issued_at)),
        ("issuerPrincipalId", s(&p)),
        ("issuerKeyVersionId", s(&k)),
        ("issuerCapability", s(it.issuer_cap)),
    ])
}

pub fn item_facts(rec: &TradeRecord, it: &Item) -> J {
    let (ip, ik, _) = party(rec, it.issuer_cap);
    let (up, uk, uorg) = party(rec, it.uploader_cap);
    let sig = sign(it.issuer_label, "dockside/evidence-issuance", &issuance(rec, it));
    st(vec![
        ("itemId", s(&it.id)),
        ("version", u(it.version)),
        ("predecessorItemId", opt(it.predecessor.as_deref())),
        ("originalDigest", s(&it.digest)),
        ("byteLength", u(it.bytes)),
        ("detectedMime", s(it.mime)),
        ("contentClass", s(it.class)),
        (
            "resources",
            st(vec![
                ("pages", u(it.pages)),
                ("pixels", u(it.pixels)),
                ("decompressedBytes", u(it.bytes)),
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
                ("digest", s(&hex::encode(sha256_of(&format!("derived/{}", it.id))))),
                ("transformProfile", s(it.derived_profile)),
                ("sourceDigest", s(&it.digest)),
            ])]),
        ),
    ])
}

pub fn slot_digest(i: usize) -> String {
    let p = policy();
    let slots = p["struct"]["slots"]["list"].as_array().unwrap().clone();
    digest_hex("dockside/evidence-slot-policy", &slots[i])
}

pub fn slot_facts(rec: &TradeRecord, idx: usize, slot: &str, items: &[&Item], currentness: u64) -> J {
    st(vec![
        ("slotId", s(slot)),
        ("slotPolicyDigest", s(&slot_digest(idx))),
        ("itemCount", u(items.len() as u64)),
        ("currentnessVersion", u(currentness)),
        ("items", list(items.iter().map(|i| item_facts(rec, i)).collect())),
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

pub fn attestation(rec: &TradeRecord, revision: u64, slots: J, now: u64, n: &str) -> J {
    let digest = manifest_digest(rec, revision, &slots);
    let b = &rec.terms.manifest_attestor;
    with_header(
        rec,
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
            ("nonce", s(&nonce(n))),
            ("slots", slots),
        ],
    )
}

pub fn complete_slots(rec: &TradeRecord, inv: &Item, rep: &Item, photos: &[&Item], cv: u64) -> J {
    list(vec![
        slot_facts(rec, 0, "commercial-invoice", &[inv], cv),
        slot_facts(rec, 1, "inspection-report", &[rep], cv),
        slot_facts(rec, 2, "cargo-photos", photos, cv),
    ])
}

/// Re-derive the manifest digest after a mutation so only the mutated predicate differs.
pub fn reseal(rec: &TradeRecord, att: &mut J) {
    let rev = att["struct"]["manifestRevision"]["u64"].as_str().unwrap().parse().unwrap();
    let slots = att["struct"]["slots"].clone();
    set(att, &["manifestDigest"], s(&manifest_digest(rec, rev, &slots)));
}

pub fn inspection(rec: &TradeRecord, manifest_rev: u64, manifest_digest: &str, decision: &str, now: u64, n: &str) -> J {
    with_header(
        rec,
        vec![
            ("milestoneId", s("shipment-1")),
            ("evidencePolicyId", s("commercial-docs")),
            ("evidencePolicyRevision", u(1)),
            ("manifestRevision", u(manifest_rev)),
            ("manifestDigest", s(manifest_digest)),
            ("decision", s(decision)),
            ("reasonCodes", list(vec![s("DOCS_MATCH")])),
            ("inspectorPrincipalId", s(&rec.terms.inspector.principal_id)),
            ("inspectorKeyVersionId", s(&rec.terms.inspector.key_version_id)),
            ("schema", s("dockside/inspection-attestation@1")),
            ("issuedAt", u(now)),
            ("expiresAt", u(now + 7 * DAY)),
            ("nonce", s(&nonce(n))),
        ],
    )
}
