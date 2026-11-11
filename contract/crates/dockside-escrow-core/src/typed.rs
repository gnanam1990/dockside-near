//! Typed-JSON boundary decoding.
//!
//! Every signed payload crosses the contract boundary as the typed JSON form produced by
//! `toTypedJson` in packages/core (`{"str":..}`, `{"u64":".."}`, `{"u128":".."}`, ...).
//! The contract decodes it into a DCE-1 [`Value`], recomputes the digest itself and then
//! reads fields through [`Obj`], which enforces the exact field set (unknown or missing
//! fields fail closed, so e.g. a caller-supplied `complete: true` is rejected).

use crate::error::{err, R};
use alloc::borrow::ToOwned;
use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;
use dockside_canonical::Value;
use serde_json::Value as J;

pub const MAX_TYPED_DEPTH: usize = 24;

fn canonical_uint(s: &str) -> bool {
    !s.is_empty() && s.len() <= 39 && s.bytes().all(|b| b.is_ascii_digit()) && (s == "0" || !s.starts_with('0'))
}

pub fn decode(j: &J) -> R<Value> {
    decode_at(j, 0)
}

fn decode_at(j: &J, depth: usize) -> R<Value> {
    if depth > MAX_TYPED_DEPTH {
        return err("LIMIT_EXCEEDED", "typed json nested too deeply");
    }
    let o = match j.as_object() {
        Some(o) if o.len() == 1 => o,
        _ => return err("VALIDATION_FAILED", "typed json node must be an object with exactly one tag"),
    };
    let (tag, v) = o.iter().next().expect("len 1");
    Ok(match tag.as_str() {
        "null" => {
            if !v.is_null() {
                return err("VALIDATION_FAILED", "null tag must carry null");
            }
            Value::Null
        }
        "str" => Value::Str(v.as_str().ok_or_else(|| bad("str tag must carry a string"))?.to_owned()),
        "u64" => {
            let s = v.as_str().ok_or_else(|| bad("u64 tag must carry a decimal string"))?;
            if !canonical_uint(s) {
                return err("NON_CANONICAL", "u64 must be a canonical decimal string");
            }
            Value::U64(s.parse().map_err(|_| bad("u64 out of range"))?)
        }
        "u128" => {
            let s = v.as_str().ok_or_else(|| bad("u128 tag must carry a decimal string"))?;
            if !canonical_uint(s) {
                return err("NON_CANONICAL", "u128 must be a canonical decimal string");
            }
            Value::U128(s.parse().map_err(|_| bad("u128 out of range"))?)
        }
        "bool" => Value::Bool(v.as_bool().ok_or_else(|| bad("bool tag must carry a boolean"))?),
        "bytes" => {
            let s = v.as_str().ok_or_else(|| bad("bytes tag must carry hex"))?;
            Value::Bytes(hex_decode(s)?)
        }
        "list" => {
            let a = v.as_array().ok_or_else(|| bad("list tag must carry an array"))?;
            let mut out = Vec::with_capacity(a.len());
            for x in a {
                out.push(decode_at(x, depth + 1)?);
            }
            Value::List(out)
        }
        "struct" => {
            let m = v.as_object().ok_or_else(|| bad("struct tag must carry an object"))?;
            let mut out = Vec::with_capacity(m.len());
            for (k, x) in m {
                out.push((k.clone(), decode_at(x, depth + 1)?));
            }
            Value::Struct(out)
        }
        other => return err("VALIDATION_FAILED", format!("unknown typed json tag {other}")),
    })
}

fn bad(m: &str) -> crate::error::Error {
    crate::error::Error {
        code: "VALIDATION_FAILED",
        message: m.into(),
    }
}

pub fn hex_decode(s: &str) -> R<Vec<u8>> {
    let b = s.as_bytes();
    if b.len() % 2 != 0 {
        return err("NON_CANONICAL", "hex must be even-length");
    }
    let nib = |c: u8| -> R<u8> {
        match c {
            b'0'..=b'9' => Ok(c - b'0'),
            b'a'..=b'f' => Ok(c - b'a' + 10),
            _ => err("NON_CANONICAL", "hex must be lowercase"),
        }
    };
    let mut out = Vec::with_capacity(b.len() / 2);
    for i in (0..b.len()).step_by(2) {
        out.push((nib(b[i])? << 4) | nib(b[i + 1])?);
    }
    Ok(out)
}

pub fn hex_encode(b: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(b.len() * 2);
    for x in b {
        s.push(H[(x >> 4) as usize] as char);
        s.push(H[(x & 15) as usize] as char);
    }
    s
}

/// Exact-field-set view of a canonical struct.
pub struct Obj<'a> {
    fields: &'a [(String, Value)],
    ctx: &'static str,
}

impl<'a> Obj<'a> {
    /// The struct must contain exactly `names` (no more, no fewer).
    pub fn exact(v: &'a Value, names: &[&str], ctx: &'static str) -> R<Obj<'a>> {
        let fields = match v {
            Value::Struct(f) => f.as_slice(),
            _ => return err("VALIDATION_FAILED", format!("{ctx}: expected a struct")),
        };
        for (k, _) in fields {
            if !names.contains(&k.as_str()) {
                return err("UNKNOWN_FIELD", format!("{ctx}: unknown field {k}"));
            }
        }
        for n in names {
            if fields.iter().filter(|(k, _)| k == n).count() != 1 {
                return err("VALIDATION_FAILED", format!("{ctx}: missing or duplicate field {n}"));
            }
        }
        Ok(Obj { fields, ctx })
    }

    pub fn get(&self, n: &str) -> &'a Value {
        &self.fields.iter().find(|(k, _)| k == n).expect("exact() checked presence").1
    }

    fn wrong<T>(&self, n: &str, ty: &str) -> R<T> {
        err("VALIDATION_FAILED", format!("{}: field {n} must be {ty}", self.ctx))
    }

    pub fn str(&self, n: &str) -> R<String> {
        match self.get(n) {
            Value::Str(s) => Ok(s.clone()),
            _ => self.wrong(n, "a string"),
        }
    }

    pub fn opt_str(&self, n: &str) -> R<Option<String>> {
        match self.get(n) {
            Value::Null => Ok(None),
            Value::Str(s) => Ok(Some(s.clone())),
            _ => self.wrong(n, "a string or null"),
        }
    }

    pub fn u64(&self, n: &str) -> R<u64> {
        match self.get(n) {
            Value::U64(x) => Ok(*x),
            _ => self.wrong(n, "u64"),
        }
    }

    pub fn opt_u64(&self, n: &str) -> R<Option<u64>> {
        match self.get(n) {
            Value::Null => Ok(None),
            Value::U64(x) => Ok(Some(*x)),
            _ => self.wrong(n, "u64 or null"),
        }
    }

    pub fn u128(&self, n: &str) -> R<u128> {
        match self.get(n) {
            Value::U128(x) => Ok(*x),
            _ => self.wrong(n, "u128"),
        }
    }

    pub fn bool(&self, n: &str) -> R<bool> {
        match self.get(n) {
            Value::Bool(x) => Ok(*x),
            _ => self.wrong(n, "bool"),
        }
    }

    pub fn list(&self, n: &str) -> R<&'a [Value]> {
        match self.get(n) {
            Value::List(x) => Ok(x.as_slice()),
            _ => self.wrong(n, "a list"),
        }
    }

    pub fn str_list(&self, n: &str) -> R<Vec<String>> {
        let mut out = Vec::new();
        for v in self.list(n)? {
            match v {
                Value::Str(s) => out.push(s.clone()),
                _ => return self.wrong(n, "a list of strings"),
            }
        }
        Ok(out)
    }

    pub fn obj(&self, n: &str, names: &[&str], ctx: &'static str) -> R<Obj<'a>> {
        Obj::exact(self.get(n), names, ctx)
    }

    /// `str` field that must equal `expected`.
    pub fn expect_str(&self, n: &str, expected: &str, code: &'static str) -> R<()> {
        if self.str(n)? != expected {
            return err(code, format!("{}: field {n} does not match", self.ctx));
        }
        Ok(())
    }
}

pub fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub fn is_nonce(s: &str) -> bool {
    (32..=64).contains(&s.len()) && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// `<prefix>_<32 lowercase hex>` identifiers, as minted by packages/core `randomIds`.
pub fn is_id(s: &str, prefix: &str) -> bool {
    s.len() == prefix.len() + 33
        && s.starts_with(prefix)
        && s.as_bytes()[prefix.len()] == b'_'
        && s[prefix.len() + 1..].bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}
