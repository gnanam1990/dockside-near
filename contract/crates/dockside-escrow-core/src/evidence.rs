//! EvidencePolicy, ManifestAttestation and InspectionAttestation (FR-03, FR-04, INV-04, INV-16).
//!
//! The contract stores the signed trade's EvidencePolicy (its digest must equal the digest bound
//! in the terms) and accepts a manifest only through a ManifestAttestation signed by the exact
//! bound attestor key. It recomputes every slot-policy digest, every item predicate and the manifest
//! digest from the signed facts and *derives* completeness; there is no completeness flag anywhere.
//! An inspector attestation is accepted only for the current, usable, contract-accepted manifest.

use crate::crypto::verify;
use crate::domains;
use crate::error::{ensure, err, Error, R};
use crate::trade::{digest_hex, Ctx, TradeRecord, MAX_SKEW_MS};
use crate::typed::{decode, is_hex64, is_id, is_nonce, Obj};
use alloc::collections::{BTreeMap, BTreeSet};
use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;
use borsh::{BorshDeserialize, BorshSerialize};
use dockside_canonical::Value;
use serde_json::Value as J;

pub const POLICY_SCHEMA: &str = "dockside/evidence-policy@1";
pub const ATTESTATION_SCHEMA: &str = "dockside/manifest-attestation@1";
pub const INSPECTION_SCHEMA: &str = "dockside/inspection-attestation@1";
pub const MAX_INSPECTION_LIFETIME_MS: u64 = 30 * 24 * 3600_000;
const ISSUER_CAPABILITIES: [&str; 3] = ["BUYER_APPROVER", "SUPPLIER_SIGNER", "INSPECTOR"];
const UPLOADER_CAPABILITIES: [&str; 4] = ["BUYER_APPROVER", "SUPPLIER_SIGNER", "INSPECTOR", "EVIDENCE_UPLOADER"];

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct DerivedRule {
    pub artifact_class: String,
    pub transform_profile: String,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct SlotRule {
    pub slot_id: String,
    pub digest: String,
    pub min_items: u64,
    pub max_items: u64,
    pub allowed_mime: Vec<String>,
    pub content_class: String,
    pub max_item_bytes: u64,
    pub max_aggregate_bytes: u64,
    pub max_pages: u64,
    pub max_pixels: u64,
    pub max_decompressed_bytes: u64,
    pub max_ratio_permille: u64,
    pub max_parse_time_ms: u64,
    pub parser_profiles: Vec<String>,
    pub uploader_capabilities: Vec<String>,
    pub issuer_capabilities: Vec<String>,
    pub issued_at_required: bool,
    pub freshness_ms: u64,
    pub required_derived: Vec<DerivedRule>,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct PolicyRules {
    pub policy_id: String,
    pub revision: u64,
    pub digest: String,
    pub attestation_lifetime_ms: u64,
    pub slots: Vec<SlotRule>,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum ManifestStatus {
    Valid,
    Superseded,
    /// The bound attestor key was revoked before the attestation was consumed.
    Invalidated,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct ManifestRecord {
    pub revision: u64,
    pub digest: String,
    pub attestation_digest: String,
    pub accepted_at: u64,
    pub expires_at: u64,
    pub min_fresh_until: u64,
    pub items: Vec<String>,
    pub status: ManifestStatus,
    /// Set when a release consumes this attestation (M04); consumed history stays verifiable.
    pub consumed: bool,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct InspectionRecord {
    pub decision: String,
    pub reason_codes: Vec<String>,
    pub manifest_digest: String,
    pub manifest_revision: u64,
    pub digest: String,
    pub recorded_at: u64,
    pub expires_at: u64,
    pub invalidated: bool,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct EvidenceState {
    pub policy: Option<PolicyRules>,
    pub current: Option<ManifestRecord>,
    pub history: Vec<ManifestRecord>,
    pub superseded_items: BTreeSet<String>,
    pub accepted_items: BTreeSet<String>,
    pub slot_currentness: BTreeMap<String, u64>,
    pub inspection: Option<InspectionRecord>,
}

impl EvidenceState {
    /// Digest of the current contract-accepted manifest while its attestation is still authority.
    pub fn current_digest(&self, _now_ms: u64, _revoked: &BTreeSet<String>) -> Option<String> {
        self.current.as_ref().filter(|m| m.status == ManifestStatus::Valid).map(|m| m.digest.clone())
    }

    /// Current manifest usable for inspection/release: valid, attestation unexpired, every item fresh.
    pub fn usable(&self, now_ms: u64) -> Option<&ManifestRecord> {
        self.current
            .as_ref()
            .filter(|m| m.status == ManifestStatus::Valid && now_ms < m.expires_at && now_ms < m.min_fresh_until)
    }

    /// The current inspector decision, only while it is bound to the current valid manifest.
    pub fn current_inspection(&self, now_ms: u64) -> Option<&InspectionRecord> {
        let m = self.current.as_ref().filter(|m| m.status == ManifestStatus::Valid)?;
        self.inspection
            .as_ref()
            .filter(|i| !i.invalidated && i.manifest_digest == m.digest && now_ms < i.expires_at)
    }

    pub fn invalidate_unconsumed(&mut self, role: &str, _now_ms: u64) {
        match role {
            "manifestAttestor" => {
                if let Some(m) = self.current.as_mut() {
                    if !m.consumed && m.status == ManifestStatus::Valid {
                        m.status = ManifestStatus::Invalidated;
                    }
                }
            }
            "inspector" => {
                if let Some(i) = self.inspection.as_mut() {
                    i.invalidated = true;
                }
            }
            _ => {}
        }
    }
}

fn slug(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty() && b.len() <= 64 && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

fn token(s: &str) -> bool {
    !s.is_empty() && s.len() <= 96 && s.bytes().all(|b| b.is_ascii_graphic())
}

fn code_ok(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
}

const SLOT_FIELDS: [&str; 17] = [
    "slotId", "purpose", "minItems", "maxItems", "allowedMime", "contentClass", "maxItemBytes", "maxAggregateBytes",
    "limits", "parserProfiles", "uploaderCapabilities", "issuerCapabilities", "issuedAtRequired", "freshnessMs",
    "replacement", "requiredDerived", "schema",
];

fn parse_slot(v: &Value) -> R<SlotRule> {
    let o = Obj::exact(v, &SLOT_FIELDS, "slot policy")?;
    o.expect_str("schema", "dockside/evidence-slot-policy@1", "UNSUPPORTED_VERSION")?;
    o.expect_str("replacement", "SUPERSEDE_CURRENT", "UNSUPPORTED_VERSION")?;
    o.str("purpose")?;
    let lim = o.obj("limits", &["maxPages", "maxPixels", "maxDecompressedBytes", "maxDecompressionRatioPermille", "maxParseTimeMs"], "slot limits")?;
    let mut derived = Vec::new();
    for d in o.list("requiredDerived")? {
        let d = Obj::exact(d, &["artifactClass", "transformProfile"], "derived rule")?;
        derived.push(DerivedRule { artifact_class: d.str("artifactClass")?, transform_profile: d.str("transformProfile")? });
    }
    let (_, digest) = digest_hex(domains::EVIDENCE_SLOT_POLICY, v)?;
    let r = SlotRule {
        slot_id: o.str("slotId")?,
        digest: crate::typed::hex_encode(&digest),
        min_items: o.u64("minItems")?,
        max_items: o.u64("maxItems")?,
        allowed_mime: o.str_list("allowedMime")?,
        content_class: o.str("contentClass")?,
        max_item_bytes: o.u64("maxItemBytes")?,
        max_aggregate_bytes: o.u64("maxAggregateBytes")?,
        max_pages: lim.u64("maxPages")?,
        max_pixels: lim.u64("maxPixels")?,
        max_decompressed_bytes: lim.u64("maxDecompressedBytes")?,
        max_ratio_permille: lim.u64("maxDecompressionRatioPermille")?,
        max_parse_time_ms: lim.u64("maxParseTimeMs")?,
        parser_profiles: o.str_list("parserProfiles")?,
        uploader_capabilities: o.str_list("uploaderCapabilities")?,
        issuer_capabilities: o.str_list("issuerCapabilities")?,
        issued_at_required: o.bool("issuedAtRequired")?,
        freshness_ms: o.u64("freshnessMs")?,
        required_derived: derived,
    };
    ensure(slug(&r.slot_id), "VALIDATION_FAILED", "slotId must be a slug")?;
    ensure(r.min_items >= 1 && r.max_items >= r.min_items && r.max_items <= 32, "VALIDATION_FAILED", "slot cardinality must be 1 <= min <= max <= 32")?;
    ensure(!r.allowed_mime.is_empty() && r.allowed_mime.iter().all(|m| token(m)), "VALIDATION_FAILED", "allowedMime required")?;
    ensure(!r.parser_profiles.is_empty(), "VALIDATION_FAILED", "parserProfiles required")?;
    ensure(r.max_item_bytes > 0 && r.max_aggregate_bytes >= r.max_item_bytes, "VALIDATION_FAILED", "byte limits invalid")?;
    ensure(r.freshness_ms > 0, "VALIDATION_FAILED", "freshness required")?;
    ensure(
        !r.uploader_capabilities.is_empty() && r.uploader_capabilities.iter().all(|c| UPLOADER_CAPABILITIES.contains(&c.as_str())),
        "VALIDATION_FAILED",
        "uploader capabilities must be evidence-slot capabilities",
    )?;
    ensure(
        !r.issuer_capabilities.is_empty() && r.issuer_capabilities.iter().all(|c| ISSUER_CAPABILITIES.contains(&c.as_str())),
        "VALIDATION_FAILED",
        "issuers must be bound trade parties",
    )?;
    Ok(r)
}

fn party_identity<'a>(t: &'a TradeRecord, capability: &str) -> Option<(&'a str, &'a str, &'static str)> {
    match capability {
        "BUYER_APPROVER" => Some((&t.terms.buyer.principal_id, &t.terms.buyer.key_version_id, "buyer")),
        "SUPPLIER_SIGNER" => Some((&t.terms.supplier.principal_id, &t.terms.supplier.key_version_id, "supplier")),
        "INSPECTOR" => Some((&t.terms.inspector.principal_id, &t.terms.inspector.key_version_id, "inspector")),
        _ => None,
    }
}

impl TradeRecord {
    /// Store the EvidencePolicy whose digest the signed trade revision binds.
    pub fn register_evidence_policy(&mut self, policy: &J) -> R<String> {
        ensure(self.evidence.policy.is_none(), "INVALID_STATE", "evidence policy already registered")?;
        let v = decode(policy)?;
        let (hex, _) = digest_hex(domains::EVIDENCE_POLICY, &v)?;
        ensure(hex == self.terms.evidence_policy.digest, "POLICY_MISMATCH", "policy digest differs from the signed trade revision")?;
        let o = Obj::exact(&v, &["schema", "policyId", "revision", "attestationLifetimeMs", "slots"], "evidence policy")?;
        o.expect_str("schema", POLICY_SCHEMA, "UNSUPPORTED_VERSION")?;
        o.expect_str("policyId", &self.terms.evidence_policy.id, "POLICY_MISMATCH")?;
        ensure(o.u64("revision")? == self.terms.evidence_policy.revision, "POLICY_MISMATCH", "policy revision mismatch")?;
        let lifetime = o.u64("attestationLifetimeMs")?;
        ensure(lifetime > 0 && lifetime <= 30 * 24 * 3600_000, "VALIDATION_FAILED", "attestation lifetime out of range")?;
        let mut slots = Vec::new();
        for s in o.list("slots")? {
            slots.push(parse_slot(s)?);
        }
        ensure(!slots.is_empty(), "VALIDATION_FAILED", "an EvidencePolicy cannot be empty")?;
        let ids: BTreeSet<&str> = slots.iter().map(|s| s.slot_id.as_str()).collect();
        ensure(ids.len() == slots.len(), "VALIDATION_FAILED", "slot ids must be unique")?;
        self.evidence.policy = Some(PolicyRules {
            policy_id: self.terms.evidence_policy.id.clone(),
            revision: self.terms.evidence_policy.revision,
            digest: hex.clone(),
            attestation_lifetime_ms: lifetime,
            slots,
        });
        Ok(hex)
    }

    fn check_identity(&self, o: &Obj<'_>, allowed: &[String], what: &'static str) -> R<(String, &'static str)> {
        let cap = o.str("capability")?;
        ensure(allowed.iter().any(|c| *c == cap), "FORBIDDEN", &format!("{what} capability not allowed for this slot"))?;
        let principal = o.str("principalId")?;
        let key = o.str("keyVersionId")?;
        match party_identity(self, &cap) {
            Some((p, k, role)) => {
                ensure(principal == p && key == k, "KEY_NOT_BOUND", &format!("{what} is not the party bound by this revision"))?;
                Ok((cap, role))
            }
            None => {
                ensure(is_id(&principal, "prn") && is_id(&key, "key"), "VALIDATION_FAILED", "identity malformed")?;
                Ok((cap, ""))
            }
        }
    }

    fn check_item(&self, ctx: &Ctx<'_>, slot: &SlotRule, v: &Value, attested_at: u64) -> R<(String, Option<String>, u64, u64)> {
        let o = Obj::exact(
            v,
            &["itemId", "version", "predecessorItemId", "originalDigest", "byteLength", "detectedMime", "contentClass", "resources", "uploader", "issuer", "freshUntil", "derived"],
            "evidence item",
        )?;
        let id = o.str("itemId")?;
        ensure(is_id(&id, "evi"), "VALIDATION_FAILED", "itemId malformed")?;
        ensure(!self.evidence.superseded_items.contains(&id), "STALE_ITEM", "item was replaced by an accepted successor")?;
        let version = o.u64("version")?;
        let pred = o.opt_str("predecessorItemId")?;
        ensure(version >= 1 && (version == 1) == pred.is_none(), "VALIDATION_FAILED", "version/predecessor inconsistent")?;
        if let Some(p) = &pred {
            ensure(is_id(p, "evi") && *p != id, "VALIDATION_FAILED", "predecessor malformed")?;
        }
        let original = o.str("originalDigest")?;
        ensure(is_hex64(&original), "VALIDATION_FAILED", "originalDigest malformed")?;
        let bytes = o.u64("byteLength")?;
        ensure(bytes > 0 && bytes <= slot.max_item_bytes, "LIMIT_EXCEEDED", "item exceeds the slot byte limit")?;
        let mime = o.str("detectedMime")?;
        ensure(slot.allowed_mime.contains(&mime), "UNSUPPORTED_CONTENT", "detected MIME not allowed for slot")?;
        ensure(o.str("contentClass")? == slot.content_class, "UNSUPPORTED_CONTENT", "content class not allowed for slot")?;
        let r = o.obj("resources", &["pages", "pixels", "decompressedBytes", "decompressionRatioPermille", "parseTimeMs", "parserProfile"], "item resources")?;
        ensure(r.u64("pages")? <= slot.max_pages, "LIMIT_EXCEEDED", "page count over limit")?;
        ensure(r.u64("pixels")? <= slot.max_pixels, "LIMIT_EXCEEDED", "pixel count over limit")?;
        ensure(r.u64("decompressedBytes")? <= slot.max_decompressed_bytes, "LIMIT_EXCEEDED", "decompressed bytes over limit")?;
        ensure(r.u64("decompressionRatioPermille")? <= slot.max_ratio_permille, "LIMIT_EXCEEDED", "decompression ratio over limit")?;
        ensure(r.u64("parseTimeMs")? <= slot.max_parse_time_ms, "LIMIT_EXCEEDED", "parse time over limit")?;
        let profile = r.str("parserProfile")?;
        ensure(slot.parser_profiles.contains(&profile), "UNSUPPORTED_CONTENT", "parser profile not allowed")?;
        let up = o.obj("uploader", &["principalId", "organizationId", "capability", "keyVersionId"], "uploader")?;
        let (up_cap, _) = self.check_identity(&up, &slot.uploader_capabilities, "uploader")?;
        let org = up.str("organizationId")?;
        if up_cap != "INSPECTOR" {
            let expected_org = match up_cap.as_str() {
                "BUYER_APPROVER" => Some(&self.terms.buyer.organization_id),
                "SUPPLIER_SIGNER" => Some(&self.terms.supplier.organization_id),
                _ => None,
            };
            match expected_org {
                Some(e) => ensure(org == *e, "SCOPE_MISMATCH", "uploader organization differs from the bound party")?,
                None => ensure(
                    org == self.terms.buyer.organization_id || org == self.terms.supplier.organization_id,
                    "SCOPE_MISMATCH",
                    "uploader must belong to a counterparty organization",
                )?,
            }
        }
        let is = o.obj("issuer", &["principalId", "capability", "keyVersionId", "issuedAt", "signature"], "issuer")?;
        let (is_cap, is_role) = self.check_identity(&is, &slot.issuer_capabilities, "issuer")?;
        ensure(!is_role.is_empty(), "FORBIDDEN", "issuer must be a bound trade party")?;
        let issued = is.u64("issuedAt")?;
        if slot.issued_at_required {
            ensure(issued > 0, "VALIDATION_FAILED", "issuedAt required")?;
        }
        ensure(issued <= attested_at.saturating_add(MAX_SKEW_MS), "NOT_YET_VALID", "issuedAt after attestation time")?;
        let issuance = Value::Struct(alloc::vec![
            ("tradeId".into(), Value::Str(self.terms.trade_id.clone())),
            ("slotId".into(), Value::Str(slot.slot_id.clone())),
            ("originalDigest".into(), Value::Str(original.clone())),
            ("issuedAt".into(), Value::U64(issued)),
            ("issuerPrincipalId".into(), Value::Str(is.str("principalId")?)),
            ("issuerKeyVersionId".into(), Value::Str(is.str("keyVersionId")?)),
            ("issuerCapability".into(), Value::Str(is_cap)),
        ]);
        let (_, d) = digest_hex(domains::EVIDENCE_ISSUANCE, &issuance)?;
        if self.revoked_roles.contains(is_role) {
            return err("KEY_REVOKED", "issuer key is revoked");
        }
        verify(ctx.verifier, &self.terms.key_of(is_role)?, &d, &is.str("signature")?).map_err(|e| Error { code: e.code, message: format!("issuer signature: {}", e.message) })?;
        let fresh = o.u64("freshUntil")?;
        ensure(fresh == issued.saturating_add(slot.freshness_ms), "VALIDATION_FAILED", "freshUntil must equal issuedAt + slot freshness")?;
        ensure(ctx.now_ms < fresh, "STALE_ITEM", "item is past its freshness deadline")?;
        let derived = o.list("derived")?;
        ensure(derived.len() == slot.required_derived.len(), "VALIDATION_FAILED", "derived artifacts must match the slot's required set")?;
        for (rule, d) in slot.required_derived.iter().zip(derived.iter()) {
            let d = Obj::exact(d, &["artifactClass", "digest", "transformProfile", "sourceDigest"], "derived artifact")?;
            d.expect_str("artifactClass", &rule.artifact_class, "VALIDATION_FAILED")?;
            d.expect_str("transformProfile", &rule.transform_profile, "VALIDATION_FAILED")?;
            ensure(is_hex64(&d.str("digest")?), "VALIDATION_FAILED", "derived digest malformed")?;
            d.expect_str("sourceDigest", &original, "SOURCE_MISMATCH")?;
        }
        Ok((id, pred, bytes, fresh))
    }

    /// Verify the exact bound attestor's signature and every predicate, then derive completeness.
    pub fn submit_manifest_attestation(&mut self, ctx: &Ctx<'_>, payload: &J, signature: &str) -> R<String> {
        let policy = self.evidence.policy.clone().ok_or_else(|| Error { code: "POLICY_NOT_REGISTERED", message: "register the EvidencePolicy first".into() })?;
        let v = decode(payload)?;
        let o = Obj::exact(
            &v,
            &[
                "contractId", "network", "organizationId", "tradeId", "tradeRevision", "tradeDigest", "evidencePolicyId",
                "evidencePolicyRevision", "evidencePolicyDigest", "schema", "manifestRevision", "manifestDigest", "attestor",
                "issuedAt", "expiresAt", "nonce", "slots",
            ],
            "manifest attestation",
        )?;
        self.check_header(&o, ctx)?;
        o.expect_str("network", ctx.network, "WRONG_NETWORK")?;
        o.expect_str("schema", ATTESTATION_SCHEMA, "UNSUPPORTED_VERSION")?;
        o.expect_str("evidencePolicyId", &policy.policy_id, "POLICY_MISMATCH")?;
        ensure(o.u64("evidencePolicyRevision")? == policy.revision, "POLICY_MISMATCH", "stale policy revision")?;
        o.expect_str("evidencePolicyDigest", &policy.digest, "POLICY_MISMATCH")?;
        // The attestor named in the payload must be exactly the binding in the signed revision.
        let b = &self.terms.manifest_attestor;
        let a = o.obj("attestor", &["enrollmentId", "serviceId", "keyVersion", "capability", "scope"], "attestor")?;
        a.expect_str("enrollmentId", &b.enrollment_id, "KEY_NOT_BOUND")?;
        a.expect_str("serviceId", &b.service_id, "KEY_NOT_BOUND")?;
        ensure(a.u64("keyVersion")? == b.key_version, "KEY_NOT_BOUND", "attestor key version is not the bound version")?;
        a.expect_str("capability", "MANIFEST_ATTEST", "SCOPE_MISMATCH")?;
        let sc = a.obj("scope", &["organizationId", "tradeId", "evidencePolicyId", "evidencePolicyRevision"], "attestor scope")?;
        sc.expect_str("organizationId", &b.scope.organization_id, "SCOPE_MISMATCH")?;
        ensure(sc.opt_str("tradeId")? == b.scope.trade_id, "SCOPE_MISMATCH", "attestor trade scope differs")?;
        sc.expect_str("evidencePolicyId", &b.scope.evidence_policy_id, "SCOPE_MISMATCH")?;
        ensure(sc.u64("evidencePolicyRevision")? == b.scope.evidence_policy_revision, "SCOPE_MISMATCH", "attestor policy scope differs")?;
        o.expect_str("organizationId", &b.scope.organization_id, "SCOPE_MISMATCH")?;
        let (issued, expires) = self.check_window(&o, ctx, policy.attestation_lifetime_ms)?;
        let manifest_revision = o.u64("manifestRevision")?;
        if let Some(cur) = &self.evidence.current {
            ensure(manifest_revision > cur.revision, "STALE_MANIFEST", "manifest revision is not newer than the accepted manifest")?;
        }
        ensure(is_nonce(&o.str("nonce")?), "VALIDATION_FAILED", "nonce malformed")?;
        let (hex, d) = digest_hex(domains::MANIFEST_ATTESTATION, &v)?;
        // Signature first: nothing below is trusted unless the bound, unrevoked attestor signed it.
        self.verify_role(ctx, "manifestAttestor", &d, signature)?;

        let slots = o.list("slots")?;
        ensure(slots.len() == policy.slots.len(), "INCOMPLETE", "manifest must carry every policy slot in order")?;
        let mut items = Vec::new();
        let mut seen = BTreeSet::new();
        let mut preds = Vec::new();
        let mut min_fresh = u64::MAX;
        let mut currentness = Vec::new();
        for (rule, sv) in policy.slots.iter().zip(slots.iter()) {
            let s = Obj::exact(sv, &["slotId", "slotPolicyDigest", "itemCount", "currentnessVersion", "items"], "slot facts")?;
            s.expect_str("slotId", &rule.slot_id, "INCOMPLETE")?;
            s.expect_str("slotPolicyDigest", &rule.digest, "POLICY_MISMATCH")?;
            let list = s.list("items")?;
            ensure(s.u64("itemCount")? == list.len() as u64, "VALIDATION_FAILED", "itemCount differs from items")?;
            ensure(list.len() as u64 >= rule.min_items, "INCOMPLETE", "slot below minimum cardinality")?;
            ensure(list.len() as u64 <= rule.max_items, "OVER_CARDINALITY", "slot above maximum cardinality")?;
            let cv = s.u64("currentnessVersion")?;
            ensure(cv >= *self.evidence.slot_currentness.get(&rule.slot_id).unwrap_or(&0), "STALE_MANIFEST", "slot currentness regressed")?;
            currentness.push((rule.slot_id.clone(), cv));
            let mut aggregate = 0u64;
            for iv in list {
                let (id, pred, bytes, fresh) = self.check_item(ctx, rule, iv, issued)?;
                ensure(seen.insert(id.clone()), "VALIDATION_FAILED", "duplicate item in manifest")?;
                aggregate = aggregate.saturating_add(bytes);
                min_fresh = min_fresh.min(fresh);
                if let Some(p) = pred {
                    preds.push(p);
                }
                items.push(id);
            }
            ensure(aggregate <= rule.max_aggregate_bytes, "LIMIT_EXCEEDED", "slot aggregate bytes over limit")?;
        }
        for p in &preds {
            ensure(!seen.contains(p), "STALE_ITEM", "a replaced item is still listed as current")?;
        }
        let manifest = Value::Struct(alloc::vec![
            ("tradeId".into(), Value::Str(self.terms.trade_id.clone())),
            ("tradeRevision".into(), Value::U64(self.terms.revision)),
            ("evidencePolicyId".into(), Value::Str(policy.policy_id.clone())),
            ("evidencePolicyRevision".into(), Value::U64(policy.revision)),
            ("manifestRevision".into(), Value::U64(manifest_revision)),
            ("slots".into(), Value::List(slots.to_vec())),
        ]);
        let (manifest_hex, _) = digest_hex(domains::EVIDENCE_MANIFEST, &manifest)?;
        o.expect_str("manifestDigest", &manifest_hex, "DIGEST_MISMATCH")?;
        self.consume_nonce(domains::MANIFEST_ATTESTATION, &o.str("nonce")?)?;

        // Accept: supersede the previous manifest and its inspection, preserve history.
        if let Some(mut prev) = self.evidence.current.take() {
            if prev.status == ManifestStatus::Valid {
                prev.status = ManifestStatus::Superseded;
            }
            self.evidence.history.push(prev);
        }
        if let Some(i) = self.evidence.inspection.as_mut() {
            i.invalidated = true;
        }
        for p in preds {
            self.evidence.superseded_items.insert(p);
        }
        for id in &items {
            self.evidence.accepted_items.insert(id.clone());
        }
        for (slot, cv) in currentness {
            self.evidence.slot_currentness.insert(slot, cv);
        }
        self.evidence.current = Some(ManifestRecord {
            revision: manifest_revision,
            digest: manifest_hex.clone(),
            attestation_digest: hex,
            accepted_at: ctx.now_ms,
            expires_at: expires,
            min_fresh_until: min_fresh,
            items,
            status: ManifestStatus::Valid,
            consumed: false,
        });
        Ok(manifest_hex)
    }

    /// Independent inspector decision over the current, usable, contract-accepted manifest.
    pub fn submit_inspection(&mut self, ctx: &Ctx<'_>, payload: &J, signature: &str) -> R<String> {
        let v = decode(payload)?;
        let o = Obj::exact(
            &v,
            &[
                "contractId", "tradeId", "tradeRevision", "tradeDigest", "milestoneId", "evidencePolicyId", "evidencePolicyRevision",
                "manifestRevision", "manifestDigest", "decision", "reasonCodes", "inspectorPrincipalId", "inspectorKeyVersionId",
                "schema", "issuedAt", "expiresAt", "nonce",
            ],
            "inspection attestation",
        )?;
        self.check_header(&o, ctx)?;
        o.expect_str("schema", INSPECTION_SCHEMA, "UNSUPPORTED_VERSION")?;
        o.expect_str("milestoneId", &self.terms.milestone_id, "SCOPE_MISMATCH")?;
        o.expect_str("evidencePolicyId", &self.terms.evidence_policy.id, "POLICY_MISMATCH")?;
        ensure(o.u64("evidencePolicyRevision")? == self.terms.evidence_policy.revision, "POLICY_MISMATCH", "stale policy revision")?;
        o.expect_str("inspectorPrincipalId", &self.terms.inspector.principal_id, "KEY_NOT_BOUND")?;
        o.expect_str("inspectorKeyVersionId", &self.terms.inspector.key_version_id, "KEY_NOT_BOUND")?;
        let (_, expires) = self.check_window(&o, ctx, MAX_INSPECTION_LIFETIME_MS)?;
        let decision = o.str("decision")?;
        ensure(matches!(decision.as_str(), "PASS" | "FAIL" | "REVIEW"), "VALIDATION_FAILED", "decision must be PASS, FAIL or REVIEW")?;
        let reasons = o.str_list("reasonCodes")?;
        ensure(reasons.len() <= 16 && reasons.iter().all(|r| code_ok(r)), "VALIDATION_FAILED", "reason codes malformed")?;
        let m = self.evidence.usable(ctx.now_ms).ok_or_else(|| Error { code: "MANIFEST_NOT_CURRENT", message: "no current, complete, unexpired contract-accepted manifest".into() })?;
        o.expect_str("manifestDigest", &m.digest, "STALE_MANIFEST")?;
        ensure(o.u64("manifestRevision")? == m.revision, "STALE_MANIFEST", "inspection binds another manifest revision")?;
        let (m_digest, m_rev) = (m.digest.clone(), m.revision);
        let (hex, d) = digest_hex(domains::INSPECTION_ATTESTATION, &v)?;
        self.verify_role(ctx, "inspector", &d, signature)?;
        self.consume_nonce(domains::INSPECTION_ATTESTATION, &o.str("nonce")?)?;
        self.evidence.inspection = Some(InspectionRecord {
            decision,
            reason_codes: reasons,
            manifest_digest: m_digest,
            manifest_revision: m_rev,
            digest: hex.clone(),
            recorded_at: ctx.now_ms,
            expires_at: expires,
            invalidated: false,
        });
        Ok(hex)
    }
}
