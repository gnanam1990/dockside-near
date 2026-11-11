//! Signing/digest domains. Must equal `SIGNING_DOMAINS` in packages/core/src/signing.ts.

pub const TRADE_REVISION: &str = "dockside/trade-revision";
pub const MANIFEST_ATTESTATION: &str = "dockside/manifest-attestation";
pub const INSPECTION_ATTESTATION: &str = "dockside/inspection-attestation";
pub const HOLD_SET: &str = "dockside/hold-set";
pub const HOLD_RESOLVE: &str = "dockside/hold-resolve";
pub const REFUND_REQUEST: &str = "dockside/refund-request";
pub const REFUND_REVOKE: &str = "dockside/refund-revoke";
pub const REFUND_DISPUTE: &str = "dockside/refund-dispute";
pub const BOUND_KEY_REVOCATION: &str = "dockside/bound-key-revocation";
pub const EVIDENCE_POLICY: &str = "dockside/evidence-policy";
pub const EVIDENCE_SLOT_POLICY: &str = "dockside/evidence-slot-policy";
pub const EVIDENCE_MANIFEST: &str = "dockside/evidence-manifest";
pub const EVIDENCE_ISSUANCE: &str = "dockside/evidence-issuance";

pub const BUYER_APPROVAL: &str = "dockside/buyer-approval";
pub const RELEASE_INTENT: &str = "dockside/release-intent";
pub const RELEASE_INTENT_SUCCESSOR: &str = "dockside/release-intent-successor";
pub const CANCEL_RELEASE_INTENT: &str = "dockside/cancel-release-intent";
pub const CANCEL_CONSENT: &str = "dockside/cancel-consent";
pub const REVOKE_CANCEL_CONSENT: &str = "dockside/revoke-cancel-consent";
pub const ABANDON_RELEASE_INTENT: &str = "dockside/abandon-release-intent";
pub const DESTINATION_SNAPSHOT: &str = "dockside/destination-snapshot";
pub const RESERVATION_SOURCE: &str = "dockside/reservation-source";
pub const HOLDS_VIEW: &str = "dockside/holds-view";
pub const DESTINATION_CHANGE_REVOKE: &str = "dockside/destination-change-revoke";
pub const REFUND_AUTHORIZE: &str = "dockside/refund-authorize";

pub const VERSION: u16 = 1;
