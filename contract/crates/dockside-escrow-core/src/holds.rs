//! On-chain HoldRecords (FR-12, FR-13, INV-10, INV-11).
//!
//! SET: signed by the enrolled deterministic-policy service (with a versioned rule id) or by
//! the separate risk/policy principal. RESOLVE: signed only by the risk/policy principal.
//! Expiry never clears a hold; it reports `EXPIRED_UNRESOLVED` and keeps blocking.
//! There is no entry point that accepts model output; a model has no bound key.

use crate::domains;
use crate::error::{ensure, err, R};
use crate::trade::{digest_hex, Ctx, TradeRecord};
use crate::typed::{decode, is_hex64, is_id, Obj};
use alloc::string::String;
use borsh::{BorshDeserialize, BorshSerialize};
use serde_json::Value as J;

pub const MAX_HOLD_LIFETIME_MS: u64 = 90 * 24 * 3600_000;
pub const MAX_RESOLUTION_LIFETIME_MS: u64 = 24 * 3600_000;
pub const RESOLUTION_CODES: [&str; 3] = ["RELEASE_HOLD", "RESOLVE_TO_REFUND", "RETRY_INSPECTION"];

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct Resolution {
    pub code: String,
    pub evidence_digest: String,
    pub resolved_at: u64,
    pub digest: String,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct Hold {
    pub id: String,
    pub reason_code: String,
    pub issuer_role: String,
    pub rule_id: Option<String>,
    pub manifest_digest: Option<String>,
    pub issued_at: u64,
    pub expires_at: u64,
    pub recorded_at: u64,
    pub set_digest: String,
    pub resolution: Option<Resolution>,
}

impl Hold {
    pub fn status(&self, now_ms: u64) -> &'static str {
        if self.resolution.is_some() {
            "RESOLVED"
        } else if now_ms >= self.expires_at {
            "EXPIRED_UNRESOLVED"
        } else {
            "ACTIVE"
        }
    }
}

fn code_ok(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
}

impl TradeRecord {
    pub fn set_hold(&mut self, ctx: &Ctx<'_>, payload: &J, signature: &str) -> R<String> {
        let v = decode(payload)?;
        let o = Obj::exact(
            &v,
            &["contractId", "tradeId", "tradeRevision", "tradeDigest", "holdId", "manifestDigest", "reasonCode", "issuerRole", "ruleId", "schema", "issuedAt", "expiresAt", "nonce"],
            "hold set",
        )?;
        self.check_header(&o, ctx)?;
        o.expect_str("schema", "dockside/hold-set@1", "UNSUPPORTED_VERSION")?;
        let (issued, expires) = self.check_window(&o, ctx, MAX_HOLD_LIFETIME_MS)?;
        let id = o.str("holdId")?;
        ensure(is_id(&id, "hld"), "VALIDATION_FAILED", "holdId malformed")?;
        ensure(!self.holds.contains_key(&id), "INVALID_STATE", "holdId already recorded")?;
        let reason = o.str("reasonCode")?;
        ensure(code_ok(&reason), "VALIDATION_FAILED", "reasonCode malformed")?;
        let manifest = o.opt_str("manifestDigest")?;
        if let Some(m) = &manifest {
            ensure(is_hex64(m), "VALIDATION_FAILED", "manifestDigest malformed")?;
            ensure(Some(m.clone()) == self.current_manifest_digest(ctx.now_ms), "STALE_MANIFEST", "hold binds a manifest that is not current")?;
        }
        let rule = o.opt_str("ruleId")?;
        let role = match o.str("issuerRole")?.as_str() {
            "POLICY_SETTER" => {
                ensure(rule.as_deref().is_some_and(|r| !r.is_empty() && r.len() <= 96), "VALIDATION_FAILED", "deterministic-policy holds must name a versioned rule")?;
                "policySetter"
            }
            "RISK_RESOLVER" => "riskResolver",
            _ => return err("FORBIDDEN", "only the deterministic-policy service or risk/policy principal may SET a hold"),
        };
        let (hex, d) = digest_hex(domains::HOLD_SET, &v)?;
        self.verify_role(ctx, role, &d, signature)?;
        self.consume_nonce(domains::HOLD_SET, &o.str("nonce")?)?;
        self.holds.insert(
            id.clone(),
            Hold {
                id,
                reason_code: reason,
                issuer_role: o.str("issuerRole")?,
                rule_id: rule,
                manifest_digest: manifest,
                issued_at: issued,
                expires_at: expires,
                recorded_at: ctx.now_ms,
                set_digest: hex.clone(),
                resolution: None,
            },
        );
        Ok(hex)
    }

    pub fn resolve_hold(&mut self, ctx: &Ctx<'_>, payload: &J, signature: &str) -> R<String> {
        let v = decode(payload)?;
        let o = Obj::exact(
            &v,
            &["contractId", "tradeId", "tradeRevision", "tradeDigest", "holdId", "holdReasonCode", "manifestDigest", "resolutionCode", "evidenceDigest", "resolverRole", "schema", "issuedAt", "expiresAt", "nonce"],
            "hold resolve",
        )?;
        self.check_header(&o, ctx)?;
        o.expect_str("schema", "dockside/hold-resolve@1", "UNSUPPORTED_VERSION")?;
        o.expect_str("resolverRole", "RISK_RESOLVER", "FORBIDDEN")?;
        self.check_window(&o, ctx, MAX_RESOLUTION_LIFETIME_MS)?;
        let id = o.str("holdId")?;
        let current = self.current_manifest_digest(ctx.now_ms);
        let hold = self.holds.get(&id).ok_or_else(|| crate::error::Error { code: "NOT_FOUND", message: "hold not found".into() })?;
        ensure(hold.resolution.is_none(), "INVALID_STATE", "hold already resolved")?;
        o.expect_str("holdReasonCode", &hold.reason_code, "VALIDATION_FAILED")?;
        ensure(o.opt_str("manifestDigest")? == current, "STALE_MANIFEST", "resolution must bind the current manifest")?;
        let code = o.str("resolutionCode")?;
        ensure(RESOLUTION_CODES.contains(&code.as_str()), "VALIDATION_FAILED", "unknown resolution code")?;
        let evidence = o.str("evidenceDigest")?;
        ensure(is_hex64(&evidence), "VALIDATION_FAILED", "evidenceDigest malformed")?;
        let (hex, d) = digest_hex(domains::HOLD_RESOLVE, &v)?;
        // Only the bound risk/policy principal key can RESOLVE.
        self.verify_role(ctx, "riskResolver", &d, signature)?;
        self.consume_nonce(domains::HOLD_RESOLVE, &o.str("nonce")?)?;
        let hold = self.holds.get_mut(&id).expect("checked");
        hold.resolution = Some(Resolution { code, evidence_digest: evidence, resolved_at: ctx.now_ms, digest: hex.clone() });
        Ok(hex)
    }
}
