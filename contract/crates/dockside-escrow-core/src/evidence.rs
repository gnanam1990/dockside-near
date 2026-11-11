//! Evidence commitments. M02 only reserves the record; the EvidencePolicy, ManifestAttestation
//! and inspection verification are implemented by M03.

use alloc::collections::BTreeSet;
use alloc::string::String;
use borsh::{BorshDeserialize, BorshSerialize};

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct EvidenceState {}

impl EvidenceState {
    /// Digest of the current contract-accepted manifest, if any (none before M03).
    pub fn current_digest(&self, _now_ms: u64, _revoked: &BTreeSet<String>) -> Option<String> {
        None
    }

    pub fn invalidate_unconsumed(&mut self, _role: &str, _now_ms: u64) {}
}
