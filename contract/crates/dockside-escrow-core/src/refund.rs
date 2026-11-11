//! Direct escrow refunds under `dockside-refund-v1` revision 1 (FR-14, INV-12).
//!
//! Lower-layer rows implemented here: TRADE_EXPIRY, MUTUAL_CANCEL, PARTIAL_FUNDING_RETURN,
//! EXCESS_FUNDING_RETURN. The key-loss rows authorize no refund submit (recovery first).
//! INSPECTION_FAIL and PERMANENT_HOLD need the integrated inspection/hold/release boundary
//! and are rejected here until M04 enables them. Unexpected assets are never a native row.
//!
//! The contract computes the eligible amount and source bucket from its own ledger; the
//! caller's request must restate them exactly (a stale or invented view fails). Value is
//! locked at request time; revocation and authoritative FAILED restore the exact bucket.

use crate::domains;
use crate::error::{ensure, err, R};
use crate::ledger::Bucket;
use crate::trade::{digest_hex, Ctx, TradeRecord};
use crate::typed::{decode, is_hex64, is_id, Obj};
use alloc::string::String;
use alloc::vec::Vec;
use borsh::{BorshDeserialize, BorshSerialize};
use serde_json::Value as J;

pub const HOUR_MS: u64 = 3600_000;
pub const MAX_REQUEST_LIFETIME_MS: u64 = 7 * 24 * HOUR_MS;

pub const NATIVE_REASONS: [&str; 9] = [
    "TRADE_EXPIRY",
    "INSPECTION_FAIL",
    "PERMANENT_HOLD",
    "MUTUAL_CANCEL",
    "BUYER_KEY_LOSS",
    "SUPPLIER_KEY_LOSS",
    "INSPECTOR_KEY_LOSS",
    "PARTIAL_FUNDING_RETURN",
    "EXCESS_FUNDING_RETURN",
];

#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum RefundState {
    Requested,
    Timelocked,
    Authorized,
    Executing,
    Processing,
    Unknown,
    Refunded,
    Failed,
    Review,
    Reconciling,
    Adjudication,
    Revoked,
}

impl RefundState {
    pub fn as_str(&self) -> &'static str {
        match self {
            RefundState::Requested => "REQUESTED",
            RefundState::Timelocked => "TIMELOCKED",
            RefundState::Authorized => "AUTHORIZED",
            RefundState::Executing => "EXECUTING",
            RefundState::Processing => "PROCESSING",
            RefundState::Unknown => "UNKNOWN",
            RefundState::Refunded => "REFUNDED",
            RefundState::Failed => "FAILED",
            RefundState::Review => "REVIEW",
            RefundState::Reconciling => "RECONCILING",
            RefundState::Adjudication => "ADJUDICATION",
            RefundState::Revoked => "REVOKED",
        }
    }
    /// Live intents keep their value locked.
    pub fn is_live(&self) -> bool {
        !matches!(self, RefundState::Refunded | RefundState::Failed | RefundState::Revoked)
    }
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct Dispute {
    pub role: String,
    pub at: u64,
    pub digest: String,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct RefundIntent {
    pub id: String,
    pub reason: String,
    pub funder: String,
    pub amount: u128,
    pub source_bucket: Bucket,
    pub state: RefundState,
    pub request_digest: String,
    pub request_digest_bytes: [u8; 32],
    pub initiator_role: String,
    pub buyer_signed: bool,
    pub supplier_signed: bool,
    pub clock_origin: Option<u64>,
    pub deadline: Option<u64>,
    pub requested_at: u64,
    pub request_expires_at: u64,
    pub dispute: Option<Dispute>,
    pub history: Vec<(String, u64)>,
}

impl RefundIntent {
    fn to(&mut self, s: RefundState, now: u64) {
        self.state = s;
        self.history.push((s.as_str().into(), now));
    }
}

pub struct RefundSignatures<'a> {
    pub buyer: Option<&'a str>,
    pub supplier: Option<&'a str>,
}

fn role_key(role: &str) -> R<&'static str> {
    match role {
        "BUYER" => Ok("buyer"),
        "SUPPLIER" => Ok("supplier"),
        "RISK_RESOLVER" => Ok("riskResolver"),
        _ => err("FORBIDDEN", "role has no authority for this refund action"),
    }
}

impl TradeRecord {
    /// Eligible (bucket, amount) for `funder` under `reason`, from the contract's own ledger.
    pub fn eligible(&self, reason: &str, funder: &str, now_ms: u64) -> R<(Bucket, u128)> {
        let f = self.ledger.funder(funder);
        match reason {
            "PARTIAL_FUNDING_RETURN" => {
                ensure(!self.ledger.fully_funded(), "NOT_ELIGIBLE", "trade is fully funded; partial return no longer applies")?;
                ensure(f.partial > 0, "NOTHING_ELIGIBLE", "funder has no partial funding")?;
                Ok((Bucket::Partial, f.partial))
            }
            "EXCESS_FUNDING_RETURN" => {
                ensure(f.quarantined > 0, "NOTHING_ELIGIBLE", "funder has no quarantined excess")?;
                Ok((Bucket::Quarantined, f.quarantined))
            }
            "TRADE_EXPIRY" | "MUTUAL_CANCEL" => {
                if reason == "TRADE_EXPIRY" {
                    ensure(now_ms >= self.terms.expires_at, "NOT_ELIGIBLE", "trade has not expired")?;
                }
                ensure(f.reserved == 0 && self.ledger.funders.values().all(|x| x.reserved == 0), "VALUE_LOCKED", "a release intent holds value")?;
                if f.available > 0 {
                    Ok((Bucket::Available, f.available))
                } else if f.partial > 0 {
                    Ok((Bucket::Partial, f.partial))
                } else {
                    err("NOTHING_ELIGIBLE", "funder has no unreleased, unlocked accepted value")
                }
            }
            "BUYER_KEY_LOSS" | "SUPPLIER_KEY_LOSS" | "INSPECTOR_KEY_LOSS" => {
                err("NO_REFUND_SUBMIT", "key-loss rows are recovery-first and authorize no refund")
            }
            "INSPECTION_FAIL" | "PERMANENT_HOLD" => {
                err("REASON_NOT_ENABLED", "this row is enabled with the integrated release boundary (M04)")
            }
            "UNEXPECTED_ASSET_RECOVERY" => err("NOT_NATIVE_REFUND", "unexpected assets use the separate asset-recovery review"),
            _ => err("VALIDATION_FAILED", "unknown refund reason"),
        }
    }

    pub fn request_refund(&mut self, ctx: &Ctx<'_>, payload: &J, sigs: RefundSignatures<'_>) -> R<String> {
        let v = decode(payload)?;
        let o = Obj::exact(
            &v,
            &["contractId", "tradeId", "tradeRevision", "tradeDigest", "refundIntentId", "policyId", "policyRevision", "reason", "funder", "amountYocto", "sourceBucket", "initiatorRole", "issuedAt", "expiresAt", "nonce"],
            "refund request",
        )?;
        self.check_header(&o, ctx)?;
        o.expect_str("policyId", crate::terms::REFUND_POLICY_ID, "POLICY_MISMATCH")?;
        ensure(o.u64("policyRevision")? == crate::terms::REFUND_POLICY_REVISION, "POLICY_MISMATCH", "refund policy revision mismatch")?;
        let (_, expires) = self.check_window(&o, ctx, MAX_REQUEST_LIFETIME_MS)?;
        let id = o.str("refundIntentId")?;
        ensure(is_id(&id, "rfd"), "VALIDATION_FAILED", "refundIntentId malformed")?;
        ensure(!self.refunds.contains_key(&id), "INVALID_STATE", "refundIntentId already used")?;
        let reason = o.str("reason")?;
        let funder = o.str("funder")?;
        let (bucket, amount) = self.eligible(&reason, &funder, ctx.now_ms)?;
        ensure(o.u128("amountYocto")? == amount, "STALE_LEDGER", "requested amount differs from the contract-computed eligible amount")?;
        ensure(Bucket::parse(&o.str("sourceBucket")?)? == bucket, "STALE_LEDGER", "source bucket differs from the contract ledger")?;
        ensure(
            !self.live_refunds().any(|r| r.funder == funder && r.source_bucket == bucket),
            "VALUE_LOCKED",
            "a live refund intent already locks this funder slice",
        )?;
        let initiator = o.str("initiatorRole")?;
        let (hex, d) = digest_hex(domains::REFUND_REQUEST, &v)?;
        let mut buyer_signed = false;
        let mut supplier_signed = false;
        match reason.as_str() {
            "PARTIAL_FUNDING_RETURN" | "EXCESS_FUNDING_RETURN" => {
                ensure(initiator == "FUNDER", "FORBIDDEN", "only the original funder initiates this return")?;
                ensure(ctx.predecessor == funder, "FORBIDDEN", "caller is not the original funder")?;
                ensure(sigs.buyer.is_none() && sigs.supplier.is_none(), "VALIDATION_FAILED", "funder returns carry no party signatures")?;
            }
            "TRADE_EXPIRY" | "MUTUAL_CANCEL" => {
                ensure(initiator == "BUYER" || initiator == "SUPPLIER", "FORBIDDEN", "initiator must be the designated buyer or supplier")?;
                if let Some(s) = sigs.buyer {
                    self.verify_role(ctx, "buyer", &d, s)?;
                    buyer_signed = true;
                }
                if let Some(s) = sigs.supplier {
                    self.verify_role(ctx, "supplier", &d, s)?;
                    supplier_signed = true;
                }
                let initiator_signed = if initiator == "BUYER" { buyer_signed } else { supplier_signed };
                ensure(initiator_signed, "SIGNATURE_INVALID", "the designated initiator must sign the request")?;
                if reason == "TRADE_EXPIRY" {
                    ensure(buyer_signed != supplier_signed, "VALIDATION_FAILED", "trade expiry needs only the initiator signature")?;
                }
            }
            _ => return err("INTERNAL", "unreachable reason"),
        }
        self.consume_nonce(domains::REFUND_REQUEST, &o.str("nonce")?)?;
        self.ledger.lock_for_refund(&funder, bucket, amount)?;
        let mut intent = RefundIntent {
            id: id.clone(),
            reason: reason.clone(),
            funder,
            amount,
            source_bucket: bucket,
            state: RefundState::Requested,
            request_digest: hex,
            request_digest_bytes: d,
            initiator_role: initiator,
            buyer_signed,
            supplier_signed,
            clock_origin: None,
            deadline: None,
            requested_at: ctx.now_ms,
            request_expires_at: expires,
            dispute: None,
            history: alloc::vec![("REQUESTED".into(), ctx.now_ms)],
        };
        let origin = match reason.as_str() {
            "TRADE_EXPIRY" => Some((self.terms.expires_at, 24 * HOUR_MS)),
            "PARTIAL_FUNDING_RETURN" => Some((ctx.now_ms, HOUR_MS)),
            "EXCESS_FUNDING_RETURN" => {
                let at = self.ledger.funder(&intent.funder).excess_detected_at.unwrap_or(ctx.now_ms);
                Some((at, HOUR_MS))
            }
            // MUTUAL_CANCEL: the clock starts at the second signature.
            _ if buyer_signed && supplier_signed => Some((ctx.now_ms, HOUR_MS)),
            _ => None,
        };
        if let Some((at, dur)) = origin {
            intent.clock_origin = Some(at);
            intent.deadline = Some(at + dur);
            intent.to(RefundState::Timelocked, ctx.now_ms);
        }
        self.refunds.insert(id.clone(), intent);
        Ok(id)
    }

    /// Second MUTUAL_CANCEL consent over the identical request digest.
    pub fn cosign_refund(&mut self, ctx: &Ctx<'_>, id: &str, role: &str, signature: &str) -> R<()> {
        let r = self.refunds.get(id).ok_or_else(nf)?.clone();
        ensure(r.reason == "MUTUAL_CANCEL", "INVALID_STATE", "only mutual cancellation takes a second consent")?;
        ensure(r.state == RefundState::Requested, "INVALID_STATE", "intent is not awaiting consent")?;
        ensure(ctx.now_ms < r.request_expires_at, "EXPIRED", "cancellation request has expired")?;
        let key = match role {
            "BUYER" if !r.buyer_signed => "buyer",
            "SUPPLIER" if !r.supplier_signed => "supplier",
            _ => return err("INVALID_STATE", "that party has already consented or role is invalid"),
        };
        self.verify_role(ctx, key, &r.request_digest_bytes, signature)?;
        let r = self.refunds.get_mut(id).expect("present");
        if key == "buyer" {
            r.buyer_signed = true;
        } else {
            r.supplier_signed = true;
        }
        r.clock_origin = Some(ctx.now_ms);
        r.deadline = Some(ctx.now_ms + HOUR_MS);
        r.to(RefundState::Timelocked, ctx.now_ms);
        Ok(())
    }

    fn intent_payload<'a>(&self, v: &'a dockside_canonical::Value, names: &[&str], what: &'static str, ctx: &Ctx<'_>) -> R<(Obj<'a>, RefundIntent)> {
        let o = Obj::exact(v, names, what)?;
        self.check_header(&o, ctx)?;
        self.check_window(&o, ctx, 24 * HOUR_MS)?;
        let r = self.refunds.get(&o.str("refundIntentId")?).ok_or_else(nf)?.clone();
        o.expect_str("requestDigest", &r.request_digest, "VALIDATION_FAILED")?;
        Ok((o, r))
    }

    pub fn revoke_refund(&mut self, ctx: &Ctx<'_>, payload: &J, signature: Option<&str>) -> R<()> {
        let v = decode(payload)?;
        let (o, r) = self.intent_payload(
            &v,
            &["contractId", "tradeId", "tradeRevision", "tradeDigest", "refundIntentId", "requestDigest", "revokerRole", "issuedAt", "expiresAt", "nonce"],
            "refund revoke",
            ctx,
        )?;
        let revoker = o.str("revokerRole")?;
        let (_, d) = digest_hex(domains::REFUND_REVOKE, &v)?;
        match r.reason.as_str() {
            "PARTIAL_FUNDING_RETURN" | "EXCESS_FUNDING_RETURN" => {
                ensure(revoker == "FUNDER" && ctx.predecessor == r.funder && signature.is_none(), "FORBIDDEN", "only the original funder may revoke this return")?;
                ensure(
                    matches!(r.state, RefundState::Requested | RefundState::Timelocked | RefundState::Authorized),
                    "INVALID_STATE",
                    "revocation is allowed only before execution",
                )?;
            }
            "TRADE_EXPIRY" => {
                ensure(revoker == r.initiator_role, "FORBIDDEN", "only the initiator may revoke a trade-expiry refund")?;
                ensure(matches!(r.state, RefundState::Requested | RefundState::Timelocked), "INVALID_STATE", "revocation is allowed only before authorization")?;
                self.verify_role(ctx, role_key(&revoker)?, &d, signature.ok_or_else(sig_missing)?)?;
            }
            "MUTUAL_CANCEL" => {
                ensure(revoker == "BUYER" || revoker == "SUPPLIER", "FORBIDDEN", "only a signer may revoke cancellation")?;
                ensure(matches!(r.state, RefundState::Requested | RefundState::Timelocked), "INVALID_STATE", "revocation is allowed only before authorization")?;
                self.verify_role(ctx, role_key(&revoker)?, &d, signature.ok_or_else(sig_missing)?)?;
            }
            _ => return err("INVALID_STATE", "intent cannot be revoked"),
        }
        self.consume_nonce(domains::REFUND_REVOKE, &o.str("nonce")?)?;
        self.ledger.restore_from_refund(&r.funder, r.source_bucket, r.amount)?;
        self.refunds.get_mut(&r.id).expect("present").to(RefundState::Revoked, ctx.now_ms);
        Ok(())
    }

    pub fn dispute_refund(&mut self, ctx: &Ctx<'_>, payload: &J, signature: &str) -> R<()> {
        let v = decode(payload)?;
        let (o, r) = self.intent_payload(
            &v,
            &["contractId", "tradeId", "tradeRevision", "tradeDigest", "refundIntentId", "requestDigest", "disputantRole", "reasonCode", "evidenceDigest", "issuedAt", "expiresAt", "nonce"],
            "refund dispute",
            ctx,
        )?;
        let role = o.str("disputantRole")?;
        ensure(is_hex64(&o.str("evidenceDigest")?), "VALIDATION_FAILED", "evidenceDigest malformed")?;
        let allowed: &[&str] = match r.reason.as_str() {
            "TRADE_EXPIRY" => {
                ensure(r.state == RefundState::Timelocked && r.deadline.is_some_and(|dl| ctx.now_ms < dl), "INVALID_STATE", "dispute window has closed")?;
                &["BUYER", "SUPPLIER"]
            }
            "PARTIAL_FUNDING_RETURN" => &["BUYER", "SUPPLIER"],
            "EXCESS_FUNDING_RETURN" => &["BUYER", "RISK_RESOLVER"],
            _ => return err("DISPUTE_NOT_ALLOWED", "this row has no challenge path; signers revoke instead"),
        };
        ensure(allowed.contains(&role.as_str()), "FORBIDDEN", "role may not dispute this refund")?;
        ensure(matches!(r.state, RefundState::Timelocked | RefundState::Authorized), "INVALID_STATE", "dispute is allowed only before execution")?;
        let (hex, d) = digest_hex(domains::REFUND_DISPUTE, &v)?;
        self.verify_role(ctx, role_key(&role)?, &d, signature)?;
        self.consume_nonce(domains::REFUND_DISPUTE, &o.str("nonce")?)?;
        let ri = self.refunds.get_mut(&r.id).expect("present");
        ri.dispute = Some(Dispute { role, at: ctx.now_ms, digest: hex });
        ri.to(RefundState::Review, ctx.now_ms);
        Ok(())
    }

    /// Deterministic predicates only; anyone may advance a timelocked intent once they hold.
    pub fn authorize_refund(&mut self, ctx: &Ctx<'_>, id: &str) -> R<()> {
        let r = self.refunds.get(id).ok_or_else(nf)?.clone();
        ensure(r.state == RefundState::Timelocked, "INVALID_STATE", "intent is not timelocked")?;
        ensure(r.deadline.is_some_and(|dl| ctx.now_ms >= dl), "DELAY_NOT_ELAPSED", "challenge/cooling period has not elapsed")?;
        ensure(r.dispute.is_none(), "INVALID_STATE", "disputed refund stays in REVIEW")?;
        match r.reason.as_str() {
            "PARTIAL_FUNDING_RETURN" => ensure(!self.ledger.fully_funded(), "NOT_ELIGIBLE", "trade became fully funded")?,
            "TRADE_EXPIRY" | "MUTUAL_CANCEL" => {
                ensure(self.blocking_holds() == 0, "HOLD_ACTIVE", "an active or expired-unresolved hold blocks this refund")?;
                ensure(self.ledger.funders.values().all(|x| x.reserved == 0), "VALUE_LOCKED", "a release intent holds value")?;
            }
            _ => {}
        }
        self.refunds.get_mut(id).expect("present").to(RefundState::Authorized, ctx.now_ms);
        Ok(())
    }

    /// AUTHORIZED -> EXECUTING. Returns the transfer the host must perform: (original funder, amount).
    pub fn begin_refund(&mut self, ctx: &Ctx<'_>, id: &str) -> R<(String, u128)> {
        let r = self.refunds.get_mut(id).ok_or_else(nf)?;
        ensure(r.state == RefundState::Authorized, "INVALID_STATE", "intent is not authorized")?;
        r.to(RefundState::Executing, ctx.now_ms);
        Ok((r.funder.clone(), r.amount))
    }

    /// Transfer receipt outcome. Success settles to REFUNDED; an authoritative failed transfer
    /// (value returned to escrow by the runtime) is FAILED and restores the exact bucket.
    pub fn complete_refund(&mut self, ctx: &Ctx<'_>, id: &str, transferred: bool) -> R<()> {
        let r = self.refunds.get(id).ok_or_else(nf)?.clone();
        ensure(
            matches!(r.state, RefundState::Executing | RefundState::Unknown | RefundState::Processing | RefundState::Reconciling),
            "INVALID_STATE",
            "no execution outcome is pending",
        )?;
        if transferred {
            self.ledger.settle_refund(&r.funder, r.amount)?;
            self.refunds.get_mut(id).expect("present").to(RefundState::Refunded, ctx.now_ms);
        } else {
            self.ledger.restore_from_refund(&r.funder, r.source_bucket, r.amount)?;
            self.refunds.get_mut(id).expect("present").to(RefundState::Failed, ctx.now_ms);
        }
        Ok(())
    }
}

fn nf() -> crate::error::Error {
    crate::error::Error { code: "NOT_FOUND", message: "refund intent not found".into() }
}

fn sig_missing() -> crate::error::Error {
    crate::error::Error { code: "SIGNATURE_INVALID", message: "signature required".into() }
}
