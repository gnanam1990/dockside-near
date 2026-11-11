use crate::error::{err, R};
use alloc::vec::Vec;

/// Signature verification is supplied by the host: `env::ed25519_verify` on chain,
/// ed25519-dalek in host tests. The message is always the 32-byte DCE-1 digest.
pub trait Verifier {
    fn ed25519_verify(&self, signature: &[u8; 64], message: &[u8; 32], public_key: &[u8; 32]) -> bool;
}

fn b58(body: &str) -> R<Vec<u8>> {
    if body.is_empty() || body.len() > 128 {
        return err("INVALID_KEY", "base58 length out of range");
    }
    bs58::decode(body)
        .into_vec()
        .map_err(|_| crate::error::Error {
            code: "INVALID_KEY",
            message: "invalid base58".into(),
        })
}

/// `ed25519:<base58 32 bytes>` (NEAR key text form).
pub fn parse_public_key(s: &str) -> R<[u8; 32]> {
    let body = s
        .strip_prefix("ed25519:")
        .ok_or_else(|| crate::error::Error {
            code: "INVALID_KEY",
            message: "public key must be ed25519:<base58>".into(),
        })?;
    let v = b58(body)?;
    if bs58::encode(&v).into_string() != body {
        return err("INVALID_KEY", "public key is not canonical base58");
    }
    v.try_into().map_err(|_| crate::error::Error {
        code: "INVALID_KEY",
        message: "ed25519 public key must be 32 bytes".into(),
    })
}

/// `ed25519:<base58 64 bytes>`.
pub fn parse_signature(s: &str) -> R<[u8; 64]> {
    let body = s
        .strip_prefix("ed25519:")
        .ok_or_else(|| crate::error::Error {
            code: "SIGNATURE_INVALID",
            message: "signature must be ed25519:<base58>".into(),
        })?;
    let v = b58(body).map_err(|_| crate::error::Error {
        code: "SIGNATURE_INVALID",
        message: "signature is not base58".into(),
    })?;
    v.try_into().map_err(|_| crate::error::Error {
        code: "SIGNATURE_INVALID",
        message: "ed25519 signature must be 64 bytes".into(),
    })
}

pub fn verify(v: &dyn Verifier, public_key: &[u8; 32], digest: &[u8; 32], signature: &str) -> R<()> {
    let sig = parse_signature(signature)?;
    if !v.ed25519_verify(&sig, digest, public_key) {
        return err("SIGNATURE_INVALID", "signature does not verify for the bound key and domain");
    }
    Ok(())
}
