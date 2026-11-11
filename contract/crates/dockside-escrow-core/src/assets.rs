//! Unexpected assets (T-051): token/NFT transfers are not native-NEAR funding.
//!
//! They are recorded in a separate, auditable `ASSET_RECOVERY_REVIEW` list and never touch
//! the native ledger, refund state machine or conservation equation. The claimed sender is
//! whatever the token contract reported and is labelled as *claimed*; no original funder is
//! fabricated. There is deliberately no withdrawal entry point: recovery needs the separate
//! `UNEXPECTED_ASSET_RECOVERY` policy and an asset-specific safe adapter, neither of which
//! exists yet, so recorded assets stay in review.

use crate::error::{ensure, R};
use alloc::string::String;
use borsh::{BorshDeserialize, BorshSerialize};

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct UnexpectedAsset {
    pub index: u64,
    /// `NEP-141` fungible token, `NEP-171` NFT or `NEP-245` multi-token.
    pub standard: String,
    /// Account that delivered the transfer callback (the token contract as observed).
    pub asset_contract: String,
    pub token_id: Option<String>,
    /// Exact observed amount as a decimal string (u128 for NEP-141/245, "1" for NFTs).
    pub observed_amount: String,
    /// Sender as reported by the token contract. Not proven; never used as an original funder.
    pub claimed_sender: String,
    /// Digest of the untrusted `msg`, stored instead of the text.
    pub msg_digest: String,
    pub observed_at: u64,
    pub state: String,
}

pub const REVIEW_STATE: &str = "ASSET_RECOVERY_REVIEW";

pub fn record(
    index: u64,
    standard: &str,
    asset_contract: &str,
    token_id: Option<String>,
    observed_amount: String,
    claimed_sender: &str,
    msg: &str,
    now_ms: u64,
) -> R<UnexpectedAsset> {
    ensure(asset_contract.len() <= 64 && claimed_sender.len() <= 64, "VALIDATION_FAILED", "account too long")?;
    ensure(token_id.as_ref().is_none_or(|t| t.len() <= 256), "VALIDATION_FAILED", "token id too long")?;
    use sha2_shim::sha256_hex;
    Ok(UnexpectedAsset {
        index,
        standard: standard.into(),
        asset_contract: asset_contract.into(),
        token_id,
        observed_amount,
        claimed_sender: claimed_sender.into(),
        msg_digest: sha256_hex(msg.as_bytes()),
        observed_at: now_ms,
        state: REVIEW_STATE.into(),
    })
}

mod sha2_shim {
    use alloc::string::String;
    /// SHA-256 via the canonical crate (domain-free raw digest of the bytes value).
    pub fn sha256_hex(b: &[u8]) -> String {
        let v = dockside_canonical::Value::Bytes(b.to_vec());
        match dockside_canonical::digest("dockside/untrusted-message", 1, &v) {
            Ok(d) => crate::typed::hex_encode(&d),
            Err(_) => String::from("oversize"),
        }
    }
}
