//! Dockside escrow fixtures for real-chain runs (near-sandbox tests and the testnet journey).
//!
//! The payload builders mirror `contract/crates/dockside-escrow-core/tests/common`, but every
//! account, key and clock value is a parameter: the escrow account, the party accounts and the
//! chain time come from the network the payloads are sent to. Keys are real Ed25519 keys derived
//! from a per-run seed, so two runs never share keys or trade ids.
//!
//! `Mirror` replays every accepted call on host copies of the records with the same
//! `dockside-escrow-core` code the contract runs, at the block time of the receipt that executed
//! it. Payloads that depend on recorded state (ledger slices, manifest digest, holds view digest,
//! request digests) are built from the mirror, and tests compare the mirror with the contract's
//! own views after every step.

pub mod mirror;
pub mod payloads;

use dockside_canonical::digest;
use dockside_escrow_core::crypto::Verifier;
use dockside_escrow_core::typed::decode;
use ed25519_dalek::{Signer, SigningKey, Verifier as _, VerifyingKey};
pub use serde_json::{json, Value as J};
use serde_json::Map;

pub const NETWORK: &str = "near-testnet";
pub const HOUR: u64 = 3_600_000;
pub const DAY: u64 = 24 * HOUR;
pub const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
pub const MILLINEAR: u128 = NEAR / 1_000;

pub fn sha256(b: &[u8]) -> [u8; 32] {
    use sha2::Digest;
    sha2::Sha256::digest(b).into()
}

/// Ed25519 verification for host replays (the contract uses `env::ed25519_verify`).
pub struct Dalek;
impl Verifier for Dalek {
    fn ed25519_verify(&self, signature: &[u8; 64], message: &[u8; 32], public_key: &[u8; 32]) -> bool {
        let Ok(vk) = VerifyingKey::from_bytes(public_key) else { return false };
        vk.verify(message, &ed25519_dalek::Signature::from_bytes(signature)).is_ok()
    }
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

/// Replace a field of a typed struct. Path segments are struct fields.
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

pub fn digest_hex(domain: &str, typed: &J) -> String {
    let v = decode(typed).expect("typed payload");
    hex::encode(digest(domain, 1, &v).expect("digest"))
}

/// Accounts a run uses. `contract` is the escrow account; the others are NEAR accounts that
/// sign their own transactions (funders, the token sender) or receive value (supplier,
/// alternate destination).
#[derive(Clone, Debug)]
pub struct Accounts {
    pub contract: String,
    pub buyer: String,
    pub supplier: String,
    /// Second funder (optional on testnet).
    pub treasury: String,
    /// Second supplier-owned destination for the destination change.
    pub alt_destination: String,
}

/// Everything a run's payloads are derived from.
#[derive(Clone, Debug)]
pub struct Fixture {
    pub accounts: Accounts,
    /// Per-run secret seed: keys, ids and nonces are derived from it.
    pub seed: String,
    /// Trade label inside the run (several trades can share one fixture).
    pub trade: String,
    pub amount_yocto: u128,
    pub destination_change_delay_ms: u64,
    /// Chain time (ms) the run started at; terms expiry and evidence issuance derive from it.
    pub t0: u64,
}

impl Fixture {
    pub fn new(accounts: Accounts, seed: &str, trade: &str, amount_yocto: u128, delay_ms: u64, t0: u64) -> Fixture {
        Fixture {
            accounts,
            seed: seed.to_string(),
            trade: trade.to_string(),
            amount_yocto,
            destination_change_delay_ms: delay_ms,
            t0,
        }
    }

    /// The same run and keys, another trade.
    pub fn with_trade(&self, trade: &str, amount_yocto: u128) -> Fixture {
        Fixture { trade: trade.to_string(), amount_yocto, ..self.clone() }
    }

    pub fn key(&self, label: &str) -> SigningKey {
        SigningKey::from_bytes(&sha256(format!("dockside-fixture/{}/{label}", self.seed).as_bytes()))
    }

    pub fn pk(&self, label: &str) -> String {
        format!("ed25519:{}", bs58::encode(self.key(label).verifying_key().to_bytes()).into_string())
    }

    pub fn sign(&self, label: &str, domain: &str, typed: &J) -> String {
        let v = decode(typed).expect("typed payload");
        let d = digest(domain, 1, &v).expect("digest");
        format!("ed25519:{}", bs58::encode(self.key(label).sign(&d).to_bytes()).into_string())
    }

    /// Run-scoped id. Trade-scoped ids include the trade label.
    pub fn id(&self, prefix: &str, label: &str) -> String {
        let h = sha256(format!("{}/{}/{label}", self.seed, self.trade).as_bytes());
        format!("{prefix}_{}", &hex::encode(h)[..32])
    }

    pub fn nonce(&self, label: &str) -> String {
        hex::encode(sha256(format!("nonce/{}/{}/{label}", self.seed, self.trade).as_bytes()))
    }

    pub fn trade_id(&self) -> String {
        self.id("trd", "trade")
    }

    /// Key label and key version id of a bound role.
    pub fn role_key(&self, role: &str) -> (&'static str, String) {
        match role {
            "BUYER_APPROVER" | "BUYER" => ("buyer", self.id("key", "buyer-1")),
            "SUPPLIER_SIGNER" | "SUPPLIER" => ("supplier", self.id("key", "supplier-1")),
            _ => ("risk", self.id("key", "risk-1")),
        }
    }
}
