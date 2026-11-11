//! Host harness for escrow-core tests. Keys are real Ed25519 (ed25519-dalek) derived from
//! fixed labels; payloads are built as typed JSON exactly as packages/core emits them and
//! signed over the DCE-1 digest the contract recomputes. Nothing here bypasses the core.
#![allow(dead_code)]

use dockside_canonical::digest;
use dockside_escrow_core::crypto::Verifier;
use dockside_escrow_core::typed::decode;
use dockside_escrow_core::{register, Ctx, TradeRecord};
use ed25519_dalek::{Signer, SigningKey, Verifier as _, VerifyingKey};
pub mod evidence;
pub mod release;
pub use serde_json::{json, Value as J};
use serde_json::Map;

pub const CONTRACT: &str = "dockside-escrow.testnet";
pub const NETWORK: &str = "near-testnet";
pub const T0: u64 = 1_800_000_000_000;
pub const HOUR: u64 = 3_600_000;
pub const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
pub const BUYER_ACCT: &str = "acme-buyer.testnet";
pub const SUPPLIER_ACCT: &str = "harbor-supplier.testnet";
pub const OTHER_FUNDER: &str = "treasury-acme.testnet";

fn sha256(b: &[u8]) -> [u8; 32] {
    use sha2::Digest;
    sha2::Sha256::digest(b).into()
}

pub struct Dalek;
impl Verifier for Dalek {
    fn ed25519_verify(&self, signature: &[u8; 64], message: &[u8; 32], public_key: &[u8; 32]) -> bool {
        let Ok(vk) = VerifyingKey::from_bytes(public_key) else { return false };
        vk.verify(message, &ed25519_dalek::Signature::from_bytes(signature)).is_ok()
    }
}

pub fn key(label: &str) -> SigningKey {
    SigningKey::from_bytes(&sha256(format!("dockside-test/{label}").as_bytes()))
}

pub fn pk(label: &str) -> String {
    format!("ed25519:{}", bs58::encode(key(label).verifying_key().to_bytes()).into_string())
}

pub fn sign_digest(label: &str, d: &[u8; 32]) -> String {
    format!("ed25519:{}", bs58::encode(key(label).sign(d).to_bytes()).into_string())
}

pub fn sign(label: &str, domain: &str, typed: &J) -> String {
    let v = decode(typed).expect("typed payload");
    sign_digest(label, &digest(domain, 1, &v).expect("digest"))
}

pub fn digest_hex(domain: &str, typed: &J) -> String {
    let v = decode(typed).expect("typed payload");
    hex::encode(digest(domain, 1, &v).expect("digest"))
}

/* ---------------- typed JSON builders (mirror packages/core toTypedJson) ---------------- */

pub fn s(x: &str) -> J {
    json!({ "str": x })
}
pub fn u(x: u64) -> J {
    json!({ "u64": x.to_string() })
}
pub fn big(x: u128) -> J {
    json!({ "u128": x.to_string() })
}
pub fn null() -> J {
    json!({ "null": null })
}
pub fn opt(x: Option<&str>) -> J {
    x.map(s).unwrap_or_else(null)
}
pub fn list(xs: Vec<J>) -> J {
    json!({ "list": xs })
}
pub fn st(fields: Vec<(&str, J)>) -> J {
    let mut m = Map::new();
    for (k, v) in fields {
        m.insert(k.to_string(), v);
    }
    json!({ "struct": J::Object(m) })
}

/// Replace a field of a typed struct (for mutation tests). Path segments are struct fields.
pub fn set(v: &mut J, path: &[&str], x: J) {
    let mut cur = v;
    for (i, p) in path.iter().enumerate() {
        let m = cur.get_mut("struct").and_then(|m| m.as_object_mut()).expect("struct");
        if i + 1 == path.len() {
            m.insert(p.to_string(), x);
            return;
        }
        cur = m.get_mut(*p).expect("field");
    }
}

pub fn remove(v: &mut J, field: &str) {
    v.get_mut("struct").and_then(|m| m.as_object_mut()).expect("struct").remove(field);
}

pub fn id(prefix: &str, label: &str) -> String {
    format!("{prefix}_{}", &hex::encode(sha256(label.as_bytes()))[..32])
}

pub fn nonce(label: &str) -> String {
    hex::encode(sha256(format!("nonce/{label}").as_bytes()))
}

pub fn terms_with(amount: u128, expires_at: u64) -> J {
    let buyer_org = id("org", "buyer-org");
    let trade = id("trd", "trade-1");
    let svc = |enr: &str, sid: &str, label: &str, cap: &str, trade_scope: Option<&str>, schema: &str| {
        st(vec![
            ("enrollmentId", s(&id("svc", enr))),
            ("serviceId", s(sid)),
            ("keyVersion", u(1)),
            ("publicKey", s(&pk(label))),
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
    st(vec![
        ("schemaVersion", u(1)),
        ("profileVersion", s("dockside-direct-testnet-v1")),
        ("tradeId", s(&trade)),
        ("revision", u(1)),
        ("predecessorDigest", null()),
        ("network", s(NETWORK)),
        ("escrowContractId", s(CONTRACT)),
        (
            "buyer",
            st(vec![
                ("organizationId", s(&buyer_org)),
                ("principalId", s(&id("prn", "buyer"))),
                ("keyVersionId", s(&id("key", "buyer-1"))),
                ("publicKey", s(&pk("buyer"))),
                ("accountId", s(BUYER_ACCT)),
            ]),
        ),
        (
            "supplier",
            st(vec![
                ("organizationId", s(&id("org", "supplier-org"))),
                ("principalId", s(&id("prn", "supplier"))),
                ("keyVersionId", s(&id("key", "supplier-1"))),
                ("publicKey", s(&pk("supplier"))),
                ("accountId", s(SUPPLIER_ACCT)),
            ]),
        ),
        ("asset", st(vec![("kind", s("NEAR_NATIVE")), ("network", s(NETWORK))])),
        ("amountYocto", big(amount)),
        ("milestone", st(vec![("id", s("shipment-1")), ("description", s("Container loaded"))])),
        (
            "evidencePolicy",
            st(vec![("id", s("commercial-docs")), ("revision", u(1)), ("digest", s(&"ab".repeat(32)))]),
        ),
        (
            "inspector",
            st(vec![
                ("principalId", s(&id("prn", "inspector"))),
                ("keyVersionId", s(&id("key", "inspector-1"))),
                ("publicKey", s(&pk("inspector"))),
                ("attestationSchema", s("dockside/inspection-attestation@1")),
            ]),
        ),
        ("manifestAttestor", svc("attestor", "manifest-attestor", "attestor", "MANIFEST_ATTEST", None, "dockside/manifest-attestation@1")),
        ("policySetter", svc("policy", "deterministic-policy", "policy", "DETERMINISTIC_POLICY_SET", Some(&trade), "dockside/hold-set@1")),
        (
            "riskResolver",
            st(vec![
                ("principalId", s(&id("prn", "risk"))),
                ("keyVersionId", s(&id("key", "risk-1"))),
                ("publicKey", s(&pk("risk"))),
            ]),
        ),
        (
            "payout",
            st(vec![("network", s(NETWORK)), ("recipientType", s("NEAR_ACCOUNT")), ("destination", s(SUPPLIER_ACCT))]),
        ),
        ("refundPolicy", st(vec![("id", s("dockside-refund-v1")), ("revision", u(1))])),
        ("delayPolicy", st(vec![("destinationChangeDelayMs", u(86_400_000))])),
        ("expiresAt", u(expires_at)),
    ])
}

pub fn terms() -> J {
    terms_with(10 * NEAR, T0 + 30 * 24 * HOUR)
}

pub struct World {
    pub now: u64,
    pub caller: String,
}

impl World {
    pub fn new() -> World {
        World { now: T0, caller: BUYER_ACCT.into() }
    }
    pub fn ctx(&self) -> Ctx<'_> {
        Ctx { now_ms: self.now, predecessor: &self.caller, contract_id: CONTRACT, network: NETWORK, verifier: &Dalek }
    }
    pub fn as_caller(&mut self, who: &str) -> &mut World {
        self.caller = who.into();
        self
    }
}

pub fn registered_with(t: &J) -> (World, TradeRecord) {
    let w = World::new();
    let rec = register(&w.ctx(), t, &sign("buyer", "dockside/trade-revision", t), &sign("supplier", "dockside/trade-revision", t))
        .expect("registration");
    (w, rec)
}

pub fn registered() -> (World, TradeRecord) {
    registered_with(&terms())
}

pub fn code<T: std::fmt::Debug>(r: Result<T, dockside_escrow_core::Error>) -> &'static str {
    match r {
        Ok(_) => "OK",
        Err(e) => e.code,
    }
}

/// Common header of every signed trade payload.
pub fn header(rec: &TradeRecord) -> Vec<(&'static str, J)> {
    vec![
        ("contractId", s(CONTRACT)),
        ("tradeId", s(&rec.terms.trade_id)),
        ("tradeRevision", u(rec.terms.revision)),
        ("tradeDigest", s(&rec.terms_digest)),
    ]
}

pub fn with_header(rec: &TradeRecord, mut extra: Vec<(&'static str, J)>) -> J {
    let mut f = header(rec);
    f.append(&mut extra);
    st(f)
}
