//! T-001 cross-language check: the Rust encoder reproduces every TypeScript vector
//! byte-for-byte and verifies the TypeScript-produced Ed25519 signature.

use dockside_canonical::{digest, envelope, Value};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde_json::Value as J;

fn typed(j: &J) -> Value {
    let o = j.as_object().expect("typed node is an object");
    assert_eq!(o.len(), 1, "typed node has exactly one tag");
    let (tag, v) = o.iter().next().unwrap();
    match tag.as_str() {
        "null" => Value::Null,
        "str" => Value::Str(v.as_str().unwrap().to_owned()),
        "u64" => Value::U64(v.as_str().unwrap().parse().unwrap()),
        "u128" => Value::U128(v.as_str().unwrap().parse().unwrap()),
        "bool" => Value::Bool(v.as_bool().unwrap()),
        "bytes" => Value::Bytes(hex::decode(v.as_str().unwrap()).unwrap()),
        "list" => Value::List(v.as_array().unwrap().iter().map(typed).collect()),
        "struct" => Value::Struct(
            v.as_object()
                .unwrap()
                .iter()
                .map(|(k, x)| (k.clone(), typed(x)))
                .collect(),
        ),
        other => panic!("unknown tag {other}"),
    }
}

fn load() -> J {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../fixtures/canonical-vectors.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("vectors file"))
        .expect("vectors json")
}

#[test]
fn reproduces_typescript_vectors() {
    let doc = load();
    let vectors = doc["vectors"].as_array().unwrap();
    assert!(vectors.len() >= 18);
    for v in vectors {
        let name = v["name"].as_str().unwrap();
        let value = typed(&v["value"]);
        let domain = v["domain"].as_str().unwrap();
        let version = v["version"].as_u64().unwrap() as u16;
        let env = envelope(domain, version, &value).unwrap();
        assert_eq!(
            hex::encode(&env),
            v["envelopeHex"].as_str().unwrap(),
            "envelope {name}"
        );
        assert_eq!(
            hex::encode(digest(domain, version, &value).unwrap()),
            v["digestHex"].as_str().unwrap(),
            "digest {name}"
        );
    }
}

#[test]
fn verifies_typescript_signature_over_trade_revision() {
    let doc = load();
    let trade = doc["vectors"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["name"] == "trade-revision-v1")
        .unwrap();
    let value = typed(&trade["value"]);
    let sigs = doc["signatures"].as_array().unwrap();
    assert!(!sigs.is_empty());
    for s in sigs {
        let d = digest(
            s["domain"].as_str().unwrap(),
            s["version"].as_u64().unwrap() as u16,
            &value,
        )
        .unwrap();
        assert_eq!(hex::encode(d), s["digestHex"].as_str().unwrap());
        let pk = bs58::decode(
            s["publicKey"]
                .as_str()
                .unwrap()
                .strip_prefix("ed25519:")
                .unwrap(),
        )
        .into_vec()
        .unwrap();
        let sig = bs58::decode(
            s["signature"]
                .as_str()
                .unwrap()
                .strip_prefix("ed25519:")
                .unwrap(),
        )
        .into_vec()
        .unwrap();
        let key = VerifyingKey::from_bytes(&pk.try_into().unwrap()).unwrap();
        let sig = Signature::from_bytes(&sig.try_into().unwrap());
        assert!(key.verify(&d, &sig).is_ok(), "signature verifies over identical digest");
        // Wrong domain: same payload under the buyer-approval domain must not verify.
        let wrong = digest("dockside/buyer-approval", 1, &value).unwrap();
        assert!(key.verify(&wrong, &sig).is_err());
    }
}
