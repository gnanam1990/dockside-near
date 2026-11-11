//! Dockside Canonical Encoding v1 (DCE-1).
//!
//! Byte-identical to `packages/core/src/canonical.ts`; both are checked against
//! `fixtures/canonical-vectors.json`. The NEAR escrow contract (M02+) reconstructs
//! signed payloads with this crate and verifies Ed25519 signatures over
//! `sha256(envelope)`. Strings must already be Unicode NFC: the service boundary
//! normalises before signing, and a non-NFC string simply produces a different digest,
//! so any signature over it fails closed.

use sha2::{Digest, Sha256};

pub const TAG_NULL: u8 = 0x00;
pub const TAG_STRING: u8 = 0x01;
pub const TAG_U64: u8 = 0x02;
pub const TAG_U128: u8 = 0x03;
pub const TAG_BOOL: u8 = 0x04;
pub const TAG_BYTES: u8 = 0x05;
pub const TAG_LIST: u8 = 0x06;
pub const TAG_STRUCT: u8 = 0x07;

pub const MAGIC: &[u8; 9] = b"DOCKSIDE\0";
pub const MAX_DEPTH: usize = 24;
pub const MAX_STRING_BYTES: usize = 64 * 1024;
pub const MAX_LIST_ITEMS: usize = 4096;
pub const MAX_STRUCT_FIELDS: usize = 128;
pub const MAX_FIELD_NAME: usize = 64;
pub const MAX_DOMAIN: usize = 96;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Value {
    Null,
    Str(String),
    U64(u64),
    U128(u128),
    Bool(bool),
    Bytes(Vec<u8>),
    List(Vec<Value>),
    Struct(Vec<(String, Value)>),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EncodeError {
    TooDeep,
    TooLong,
    InvalidFieldName,
    DuplicateField,
    InvalidDomain,
    InvalidVersion,
}

fn valid_field_name(n: &str) -> bool {
    let b = n.as_bytes();
    !b.is_empty()
        && b.len() <= MAX_FIELD_NAME
        && b[0].is_ascii_alphabetic()
        && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_')
}

/// `dockside/<seg>(/<seg>)*` where seg = `[a-z0-9][a-z0-9-]*`.
pub fn valid_domain(d: &str) -> bool {
    if d.len() > MAX_DOMAIN {
        return false;
    }
    let mut parts = d.split('/');
    if parts.next() != Some("dockside") {
        return false;
    }
    let mut any = false;
    for seg in parts {
        any = true;
        let b = seg.as_bytes();
        if b.is_empty() || !(b[0].is_ascii_lowercase() || b[0].is_ascii_digit()) {
            return false;
        }
        if !b
            .iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
        {
            return false;
        }
    }
    any
}

fn put_len(out: &mut Vec<u8>, n: usize) -> Result<(), EncodeError> {
    let n = u32::try_from(n).map_err(|_| EncodeError::TooLong)?;
    out.extend_from_slice(&n.to_be_bytes());
    Ok(())
}

fn encode_into(out: &mut Vec<u8>, v: &Value, depth: usize) -> Result<(), EncodeError> {
    if depth > MAX_DEPTH {
        return Err(EncodeError::TooDeep);
    }
    match v {
        Value::Null => out.push(TAG_NULL),
        Value::Str(s) => {
            if s.len() > MAX_STRING_BYTES {
                return Err(EncodeError::TooLong);
            }
            out.push(TAG_STRING);
            put_len(out, s.len())?;
            out.extend_from_slice(s.as_bytes());
        }
        Value::U64(n) => {
            out.push(TAG_U64);
            out.extend_from_slice(&n.to_be_bytes());
        }
        Value::U128(n) => {
            out.push(TAG_U128);
            out.extend_from_slice(&n.to_be_bytes());
        }
        Value::Bool(b) => {
            out.push(TAG_BOOL);
            out.push(u8::from(*b));
        }
        Value::Bytes(b) => {
            if b.len() > MAX_STRING_BYTES {
                return Err(EncodeError::TooLong);
            }
            out.push(TAG_BYTES);
            put_len(out, b.len())?;
            out.extend_from_slice(b);
        }
        Value::List(items) => {
            if items.len() > MAX_LIST_ITEMS {
                return Err(EncodeError::TooLong);
            }
            out.push(TAG_LIST);
            put_len(out, items.len())?;
            for item in items {
                encode_into(out, item, depth + 1)?;
            }
        }
        Value::Struct(fields) => {
            if fields.len() > MAX_STRUCT_FIELDS {
                return Err(EncodeError::TooLong);
            }
            let mut sorted: Vec<&(String, Value)> = fields.iter().collect();
            sorted.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
            for w in sorted.windows(2) {
                if w[0].0 == w[1].0 {
                    return Err(EncodeError::DuplicateField);
                }
            }
            out.push(TAG_STRUCT);
            put_len(out, sorted.len())?;
            for (name, value) in sorted {
                if !valid_field_name(name) {
                    return Err(EncodeError::InvalidFieldName);
                }
                put_len(out, name.len())?;
                out.extend_from_slice(name.as_bytes());
                encode_into(out, value, depth + 1)?;
            }
        }
    }
    Ok(())
}

/// Encode a bare value (no envelope).
pub fn encode(v: &Value) -> Result<Vec<u8>, EncodeError> {
    let mut out = Vec::new();
    encode_into(&mut out, v, 0)?;
    Ok(out)
}

/// `MAGIC | u32 len | domain | u16 version | value`.
pub fn envelope(domain: &str, version: u16, v: &Value) -> Result<Vec<u8>, EncodeError> {
    if !valid_domain(domain) {
        return Err(EncodeError::InvalidDomain);
    }
    if version == 0 {
        return Err(EncodeError::InvalidVersion);
    }
    let mut out = Vec::with_capacity(64);
    out.extend_from_slice(MAGIC);
    put_len(&mut out, domain.len())?;
    out.extend_from_slice(domain.as_bytes());
    out.extend_from_slice(&version.to_be_bytes());
    encode_into(&mut out, v, 0)?;
    Ok(out)
}

/// `sha256(envelope)`: the 32-byte message every Dockside Ed25519 signature covers.
pub fn digest(domain: &str, version: u16, v: &Value) -> Result<[u8; 32], EncodeError> {
    let env = envelope(domain, version, v)?;
    Ok(Sha256::digest(&env).into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn struct_order_is_bytewise_and_duplicates_fail() {
        let a = Value::Struct(vec![("b".into(), Value::U64(1)), ("a".into(), Value::U64(2))]);
        let b = Value::Struct(vec![("a".into(), Value::U64(2)), ("b".into(), Value::U64(1))]);
        assert_eq!(encode(&a).unwrap(), encode(&b).unwrap());
        let dup = Value::Struct(vec![("a".into(), Value::Null), ("a".into(), Value::Null)]);
        assert_eq!(encode(&dup), Err(EncodeError::DuplicateField));
        let bad = Value::Struct(vec![("bad-name".into(), Value::Null)]);
        assert_eq!(encode(&bad), Err(EncodeError::InvalidFieldName));
    }

    #[test]
    fn domains_are_validated() {
        assert!(valid_domain("dockside/trade-revision"));
        assert!(!valid_domain("dockside"));
        assert!(!valid_domain("other/x"));
        assert!(!valid_domain("dockside/Trade"));
        assert_eq!(
            envelope("dockside/x", 0, &Value::Null),
            Err(EncodeError::InvalidVersion)
        );
    }

    #[test]
    fn type_tags_separate_numeric_forms() {
        let a = encode(&Value::U64(5)).unwrap();
        let b = encode(&Value::U128(5)).unwrap();
        let c = encode(&Value::Str("5".into())).unwrap();
        assert_ne!(a, b);
        assert_ne!(a, c);
        assert_ne!(b, c);
    }

    #[test]
    fn depth_limit() {
        let mut v = Value::Null;
        for _ in 0..30 {
            v = Value::List(vec![v]);
        }
        assert_eq!(encode(&v), Err(EncodeError::TooDeep));
    }
}
