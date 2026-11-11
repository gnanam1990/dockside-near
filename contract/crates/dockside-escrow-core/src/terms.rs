//! Contract-side view of a signed trade revision (TradeTerms schema v1).
//!
//! The contract never trusts a projection of the terms: it receives the full canonical
//! terms, checks the exact schema, recomputes the `dockside/trade-revision` digest and
//! verifies both party signatures over it before any of these fields carry authority.

use crate::crypto::parse_public_key;
use crate::error::{ensure, err, R};
use crate::typed::{is_hex64, is_id, Obj};
use alloc::string::String;
use alloc::vec::Vec;
use borsh::{BorshDeserialize, BorshSerialize};
use dockside_canonical::Value;

pub const PROFILE_DIRECT_TESTNET: &str = "dockside-direct-testnet-v1";
pub const REFUND_POLICY_ID: &str = "dockside-refund-v1";
pub const REFUND_POLICY_REVISION: u64 = 1;

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct Party {
    pub organization_id: String,
    pub principal_id: String,
    pub key_version_id: String,
    pub public_key: String,
    pub account_id: String,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct HumanAuthority {
    pub principal_id: String,
    pub key_version_id: String,
    pub public_key: String,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct ServiceScope {
    pub organization_id: String,
    pub trade_id: Option<String>,
    pub evidence_policy_id: String,
    pub evidence_policy_revision: u64,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct ServiceBinding {
    pub enrollment_id: String,
    pub service_id: String,
    pub key_version: u64,
    pub public_key: String,
    pub capability: String,
    pub scope: ServiceScope,
    pub attestation_schema: String,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct EvidencePolicyRef {
    pub id: String,
    pub revision: u64,
    pub digest: String,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct Terms {
    pub trade_id: String,
    pub revision: u64,
    pub predecessor_digest: Option<String>,
    pub network: String,
    pub escrow_contract_id: String,
    pub buyer: Party,
    pub supplier: Party,
    pub amount_yocto: u128,
    pub milestone_id: String,
    pub evidence_policy: EvidencePolicyRef,
    pub inspector: HumanAuthority,
    pub manifest_attestor: ServiceBinding,
    pub policy_setter: ServiceBinding,
    pub risk_resolver: HumanAuthority,
    pub payout_destination: String,
    pub destination_change_delay_ms: u64,
    pub expires_at: u64,
}

/// NEAR account-id grammar (nearcore) plus the corridor's network suffix rule.
pub fn valid_account(s: &str, network: &str, named_only: bool) -> bool {
    let b = s.as_bytes();
    if b.len() < 2 || b.len() > 64 {
        return false;
    }
    let implicit_ed = b.len() == 64 && b.iter().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'));
    let implicit_eth = b.len() == 42 && s.starts_with("0x") && b[2..].iter().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'));
    if implicit_ed || implicit_eth {
        return !named_only;
    }
    let mut prev_sep = true;
    for &c in b {
        let alnum = c.is_ascii_lowercase() || c.is_ascii_digit();
        let sep = c == b'-' || c == b'_' || c == b'.';
        if !(alnum || sep) || (sep && prev_sep) {
            return false;
        }
        prev_sep = sep;
    }
    if prev_sep || !s.contains('.') {
        return false;
    }
    let tla = &s[s.rfind('.').map(|i| i + 1).unwrap_or(0)..];
    match network {
        "near-testnet" => tla == "testnet",
        "near-mainnet" => tla != "testnet",
        _ => false,
    }
}

fn slug(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

fn party(o: &Obj<'_>, name: &str) -> R<Party> {
    let p = o.obj(name, &["organizationId", "principalId", "keyVersionId", "publicKey", "accountId"], "terms.party")?;
    let out = Party {
        organization_id: p.str("organizationId")?,
        principal_id: p.str("principalId")?,
        key_version_id: p.str("keyVersionId")?,
        public_key: p.str("publicKey")?,
        account_id: p.str("accountId")?,
    };
    ensure(is_id(&out.organization_id, "org"), "VALIDATION_FAILED", "party organizationId malformed")?;
    ensure(is_id(&out.principal_id, "prn"), "VALIDATION_FAILED", "party principalId malformed")?;
    ensure(is_id(&out.key_version_id, "key"), "VALIDATION_FAILED", "party keyVersionId malformed")?;
    parse_public_key(&out.public_key)?;
    Ok(out)
}

fn human(o: &Obj<'_>, name: &str, extra: Option<&str>) -> R<HumanAuthority> {
    let mut names: Vec<&str> = alloc::vec!["principalId", "keyVersionId", "publicKey"];
    if extra.is_some() {
        names.push("attestationSchema");
    }
    let h = o.obj(name, &names, "terms.authority")?;
    if let Some(schema) = extra {
        h.expect_str("attestationSchema", schema, "UNSUPPORTED_VERSION")?;
    }
    let out = HumanAuthority {
        principal_id: h.str("principalId")?,
        key_version_id: h.str("keyVersionId")?,
        public_key: h.str("publicKey")?,
    };
    ensure(is_id(&out.principal_id, "prn"), "VALIDATION_FAILED", "authority principalId malformed")?;
    ensure(is_id(&out.key_version_id, "key"), "VALIDATION_FAILED", "authority keyVersionId malformed")?;
    parse_public_key(&out.public_key)?;
    Ok(out)
}

fn service(o: &Obj<'_>, name: &str, capability: &str) -> R<ServiceBinding> {
    let s = o.obj(
        name,
        &["enrollmentId", "serviceId", "keyVersion", "publicKey", "capability", "scope", "attestationSchema"],
        "terms.service",
    )?;
    s.expect_str("capability", capability, "SCOPE_MISMATCH")?;
    let sc = s.obj("scope", &["organizationId", "tradeId", "evidencePolicyId", "evidencePolicyRevision"], "terms.service.scope")?;
    let out = ServiceBinding {
        enrollment_id: s.str("enrollmentId")?,
        service_id: s.str("serviceId")?,
        key_version: s.u64("keyVersion")?,
        public_key: s.str("publicKey")?,
        capability: capability.into(),
        scope: ServiceScope {
            organization_id: sc.str("organizationId")?,
            trade_id: sc.opt_str("tradeId")?,
            evidence_policy_id: sc.str("evidencePolicyId")?,
            evidence_policy_revision: sc.u64("evidencePolicyRevision")?,
        },
        attestation_schema: s.str("attestationSchema")?,
    };
    ensure(is_id(&out.enrollment_id, "svc"), "VALIDATION_FAILED", "service enrollmentId malformed")?;
    ensure(slug(&out.service_id), "VALIDATION_FAILED", "serviceId must be a slug")?;
    ensure(out.key_version >= 1, "VALIDATION_FAILED", "service keyVersion must be >= 1")?;
    parse_public_key(&out.public_key)?;
    Ok(out)
}

/// Parse and validate canonical terms. `network` and `contract_id` come from the contract itself.
pub fn parse_terms(v: &Value, network: &str, contract_id: &str) -> R<Terms> {
    let o = Obj::exact(
        v,
        &[
            "schemaVersion", "profileVersion", "tradeId", "revision", "predecessorDigest", "network",
            "escrowContractId", "buyer", "supplier", "asset", "amountYocto", "milestone", "evidencePolicy",
            "inspector", "manifestAttestor", "policySetter", "riskResolver", "payout", "refundPolicy",
            "delayPolicy", "expiresAt",
        ],
        "terms",
    )?;
    ensure(o.u64("schemaVersion")? == 1, "UNSUPPORTED_VERSION", "terms schemaVersion must be 1")?;
    o.expect_str("profileVersion", PROFILE_DIRECT_TESTNET, "UNSUPPORTED_VERSION")?;
    o.expect_str("network", network, "WRONG_NETWORK")?;
    o.expect_str("escrowContractId", contract_id, "WRONG_CONTRACT")?;
    let asset = o.obj("asset", &["kind", "network"], "terms.asset")?;
    asset.expect_str("kind", "NEAR_NATIVE", "UNSUPPORTED_ASSET")?;
    asset.expect_str("network", network, "WRONG_NETWORK")?;
    let milestone = o.obj("milestone", &["id", "description"], "terms.milestone")?;
    milestone.str("description")?;
    let ep = o.obj("evidencePolicy", &["id", "revision", "digest"], "terms.evidencePolicy")?;
    let payout = o.obj("payout", &["network", "recipientType", "destination"], "terms.payout")?;
    payout.expect_str("network", network, "WRONG_NETWORK")?;
    payout.expect_str("recipientType", "NEAR_ACCOUNT", "UNSUPPORTED_ASSET")?;
    let rp = o.obj("refundPolicy", &["id", "revision"], "terms.refundPolicy")?;
    rp.expect_str("id", REFUND_POLICY_ID, "POLICY_MISMATCH")?;
    ensure(rp.u64("revision")? == REFUND_POLICY_REVISION, "POLICY_MISMATCH", "refund policy revision must be 1")?;
    let dp = o.obj("delayPolicy", &["destinationChangeDelayMs"], "terms.delayPolicy")?;

    let t = Terms {
        trade_id: o.str("tradeId")?,
        revision: o.u64("revision")?,
        predecessor_digest: o.opt_str("predecessorDigest")?,
        network: network.into(),
        escrow_contract_id: contract_id.into(),
        buyer: party(&o, "buyer")?,
        supplier: party(&o, "supplier")?,
        amount_yocto: o.u128("amountYocto")?,
        milestone_id: milestone.str("id")?,
        evidence_policy: EvidencePolicyRef {
            id: ep.str("id")?,
            revision: ep.u64("revision")?,
            digest: ep.str("digest")?,
        },
        inspector: human(&o, "inspector", Some("dockside/inspection-attestation@1"))?,
        manifest_attestor: service(&o, "manifestAttestor", "MANIFEST_ATTEST")?,
        policy_setter: service(&o, "policySetter", "DETERMINISTIC_POLICY_SET")?,
        risk_resolver: human(&o, "riskResolver", None)?,
        payout_destination: payout.str("destination")?,
        destination_change_delay_ms: dp.u64("destinationChangeDelayMs")?,
        expires_at: o.u64("expiresAt")?,
    };
    ensure(is_id(&t.trade_id, "trd"), "VALIDATION_FAILED", "tradeId malformed")?;
    ensure(t.revision >= 1, "VALIDATION_FAILED", "revision must be >= 1")?;
    ensure((t.revision == 1) == t.predecessor_digest.is_none(), "VALIDATION_FAILED", "predecessorDigest must be null exactly for revision 1")?;
    if let Some(p) = &t.predecessor_digest {
        ensure(is_hex64(p), "VALIDATION_FAILED", "predecessorDigest malformed")?;
    }
    ensure(t.amount_yocto > 0, "INVALID_AMOUNT", "amount must be positive")?;
    ensure(slug(&t.milestone_id), "VALIDATION_FAILED", "milestone id must be a slug")?;
    ensure(slug(&t.evidence_policy.id) && t.evidence_policy.revision >= 1 && is_hex64(&t.evidence_policy.digest), "VALIDATION_FAILED", "evidencePolicy reference malformed")?;
    for (acct, named) in [(&t.buyer.account_id, false), (&t.supplier.account_id, false), (&t.payout_destination, true)] {
        ensure(valid_account(acct, network, named), "INVALID_ADDRESS", "account id invalid for network")?;
    }
    // INV-13 structural independence: distinct principals, keys, enrollments and counterparty orgs.
    let principals = [&t.buyer.principal_id, &t.supplier.principal_id, &t.inspector.principal_id, &t.risk_resolver.principal_id];
    for i in 0..principals.len() {
        for j in i + 1..principals.len() {
            ensure(principals[i] != principals[j], "SEPARATION_OF_DUTIES", "authorities must be distinct principals")?;
        }
    }
    let keys = t.all_keys();
    for i in 0..keys.len() {
        for j in i + 1..keys.len() {
            ensure(keys[i].1 != keys[j].1, "SEPARATION_OF_DUTIES", "every authority must use a distinct key")?;
        }
    }
    ensure(t.buyer.organization_id != t.supplier.organization_id, "SEPARATION_OF_DUTIES", "buyer and supplier must be different organizations")?;
    ensure(t.manifest_attestor.enrollment_id != t.policy_setter.enrollment_id, "SEPARATION_OF_DUTIES", "attestor and policy setter must be distinct enrollments")?;
    for s in [&t.manifest_attestor, &t.policy_setter] {
        if let Some(tid) = &s.scope.trade_id {
            ensure(*tid == t.trade_id, "SCOPE_MISMATCH", "service scope is bound to a different trade")?;
        }
        ensure(
            s.scope.evidence_policy_id == t.evidence_policy.id && s.scope.evidence_policy_revision == t.evidence_policy.revision,
            "SCOPE_MISMATCH",
            "service scope does not cover the trade EvidencePolicy",
        )?;
        ensure(
            s.scope.organization_id == t.buyer.organization_id || s.scope.organization_id == t.supplier.organization_id,
            "SCOPE_MISMATCH",
            "service must be scoped to a counterparty organization",
        )?;
    }
    ensure(t.manifest_attestor.attestation_schema == "dockside/manifest-attestation@1", "UNSUPPORTED_VERSION", "attestor schema")?;
    if t.revision != 1 {
        return err("NOT_SUPPORTED", "successor revisions are activated through the destination-change protocol (M04)");
    }
    Ok(t)
}

/// Roles that can hold a bound key in a trade revision.
pub const ROLES: [&str; 6] = ["buyer", "supplier", "inspector", "riskResolver", "manifestAttestor", "policySetter"];

impl Terms {
    pub fn all_keys(&self) -> Vec<(&'static str, &str)> {
        alloc::vec![
            ("buyer", self.buyer.public_key.as_str()),
            ("supplier", self.supplier.public_key.as_str()),
            ("inspector", self.inspector.public_key.as_str()),
            ("riskResolver", self.risk_resolver.public_key.as_str()),
            ("manifestAttestor", self.manifest_attestor.public_key.as_str()),
            ("policySetter", self.policy_setter.public_key.as_str()),
        ]
    }

    pub fn key_of(&self, role: &str) -> R<[u8; 32]> {
        let k = self
            .all_keys()
            .into_iter()
            .find(|(r, _)| *r == role)
            .map(|(_, k)| k)
            .ok_or_else(|| crate::error::Error { code: "VALIDATION_FAILED", message: "unknown role".into() })?;
        parse_public_key(k)
    }
}
