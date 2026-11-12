//! Unexpected assets (T-051) and their separate recovery policy (REFUND-POLICY.md,
//! `UNEXPECTED_ASSET_RECOVERY` under `dockside-refund-v1` revision 1).
//!
//! Token/NFT transfers are not native-NEAR funding. They are recorded in a separate, auditable
//! list and never touch the native ledger, the refund state machine or the conservation
//! equation. The claimed sender is whatever the token contract reported and is labelled as
//! *claimed*; no original funder is fabricated and nothing is withdrawable unilaterally.
//!
//! Recovery is a separate protocol, enforced here:
//! 1. the claimed sender proves control by submitting the request from its own account (the
//!    transaction signer is the proof); the recipient is always that proven sender;
//! 2. the bound risk/policy principal of the governing trade approves the exact request, amount,
//!    recipient and asset-specific capability over a read-only validation digest; that signature
//!    is the final required authorization and starts a 72-hour challenge window;
//! 3. buyer, supplier, risk/policy or another claimant may challenge before the window closes,
//!    and the claimed sender or risk/policy may revoke before execution; either returns the asset
//!    to review and a new request is the only way forward;
//! 4. after the window anyone may execute through the compiled adapter. Only NEP-141 has one
//!    (`ft_transfer` with exactly one yoctoNEAR supplied by the executor, never escrow value);
//!    NFTs and multi-tokens stay `UNRECOVERABLE_OR_REVIEW`. After submit the asset is locked
//!    until the transfer outcome settles it: success is RECOVERED, an authoritative failed
//!    transfer is FAILED and returns the asset to review without any retry of that recovery.
//!
//! The governing trade supplies only authority (its bound keys and its nonce set); recovery never
//! reads or writes that trade's native ledger or refund intents.

use crate::domains;
use crate::error::{ensure, err, R};
use crate::refund::HOUR_MS;
use crate::trade::{digest_hex, Ctx, TradeRecord};
use crate::typed::{decode, is_hex64, is_id, Obj};
use alloc::string::String;
use alloc::vec::Vec;
use borsh::{BorshDeserialize, BorshSerialize};
use serde_json::Value as J;

pub const REVIEW_STATE: &str = "ASSET_RECOVERY_REVIEW";
pub const UNRECOVERABLE_STATE: &str = "UNRECOVERABLE_OR_REVIEW";
pub const RECOVERY_REASON: &str = "UNEXPECTED_ASSET_RECOVERY";
pub const CHALLENGE_72H_MS: u64 = 72 * HOUR_MS;
pub const MAX_REQUEST_LIFETIME_MS: u64 = 7 * 24 * HOUR_MS;
/// The NEP-141 adapter: `ft_transfer` of the exact observed amount with exactly one yoctoNEAR.
pub const NEP141_CAPABILITY: &str = "NEP141_FT_TRANSFER";
pub const ADAPTER_DEPOSIT_YOCTO: u128 = 1;

/// The asset-specific recovery capability compiled into this contract, if any.
pub fn capability_for(standard: &str) -> Option<&'static str> {
    match standard {
        "NEP-141" => Some(NEP141_CAPABILITY),
        _ => None,
    }
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecoveryState {
    Requested,
    ChallengePeriod,
    Submitted,
    Recovered,
    Failed,
    Challenged,
    Revoked,
}

impl RecoveryState {
    pub fn as_str(&self) -> &'static str {
        match self {
            RecoveryState::Requested => "REQUESTED",
            RecoveryState::ChallengePeriod => "CHALLENGE_PERIOD",
            RecoveryState::Submitted => "SUBMITTED",
            RecoveryState::Recovered => "RECOVERED",
            RecoveryState::Failed => "FAILED",
            RecoveryState::Challenged => "CHALLENGED",
            RecoveryState::Revoked => "REVOKED",
        }
    }
    pub fn is_live(&self) -> bool {
        matches!(self, RecoveryState::Requested | RecoveryState::ChallengePeriod | RecoveryState::Submitted)
    }
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct RecoveryChallenge {
    pub role: String,
    pub account: Option<String>,
    pub reason_code: String,
    pub evidence_digest: String,
    pub digest: String,
    pub at: u64,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct AssetRecovery {
    pub id: String,
    /// Trade whose bound principals govern approval and challenge (authority only).
    pub trade_id: String,
    pub trade_revision: u64,
    pub recipient: String,
    pub amount: String,
    pub capability: String,
    pub request_digest: String,
    pub evidence_digest: String,
    pub state: RecoveryState,
    pub requested_at: u64,
    pub request_expires_at: u64,
    pub approval_digest: Option<String>,
    pub validation_digest: Option<String>,
    pub approved_at: Option<u64>,
    pub deadline: Option<u64>,
    pub challenge: Option<RecoveryChallenge>,
    pub revoked_by: Option<String>,
    pub executor: Option<String>,
    pub history: Vec<(String, u64)>,
}

impl AssetRecovery {
    fn to(&mut self, s: RecoveryState, now: u64) {
        self.state = s;
        self.history.push((s.as_str().into(), now));
    }
}

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
    /// Every recovery attempt, oldest first; at most one is live.
    pub recoveries: Vec<AssetRecovery>,
}

impl UnexpectedAsset {
    pub fn live(&self) -> Option<&AssetRecovery> {
        self.recoveries.iter().find(|r| r.state.is_live())
    }

    fn rest_state(&self) -> String {
        if capability_for(&self.standard).is_some() {
            REVIEW_STATE.into()
        } else {
            UNRECOVERABLE_STATE.into()
        }
    }

    fn find(&self, id: &str) -> R<usize> {
        self.recoveries
            .iter()
            .position(|r| r.id == id)
            .ok_or_else(|| crate::error::Error { code: "NOT_FOUND", message: "asset recovery not found".into() })
    }
}

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
    let mut a = UnexpectedAsset {
        index,
        standard: standard.into(),
        asset_contract: asset_contract.into(),
        token_id,
        observed_amount,
        claimed_sender: claimed_sender.into(),
        msg_digest: sha256_hex(msg.as_bytes()),
        observed_at: now_ms,
        state: String::new(),
        recoveries: Vec::new(),
    };
    a.state = a.rest_state();
    Ok(a)
}

/* ------------------------------- recovery protocol ------------------------------- */

/// The recovery a signed payload names, after checking it is governed by `rec` and that the
/// payload binds `rec`'s current revision and the exact request digest.
fn governed(a: &UnexpectedAsset, rec: &TradeRecord, o: &Obj<'_>, ctx: &Ctx<'_>) -> R<usize> {
    let i = a.find(&o.str("recoveryId")?)?;
    ensure(a.recoveries[i].trade_id == rec.terms.trade_id, "SCOPE_MISMATCH", "another trade governs this recovery")?;
    rec.check_header(o, ctx)?;
    Ok(i)
}

fn check_request_digest(r: &AssetRecovery, o: &Obj<'_>) -> R<()> {
    o.expect_str("requestDigest", &r.request_digest, "VALIDATION_FAILED")
}

/// Step 1: the claimed sender's own transaction requests recovery to itself.
pub fn request_recovery(a: &mut UnexpectedAsset, rec: &mut TradeRecord, ctx: &Ctx<'_>, payload: &J) -> R<String> {
    let v = decode(payload)?;
    let o = Obj::exact(
        &v,
        &[
            "contractId", "tradeId", "tradeRevision", "tradeDigest", "recoveryId", "policyId", "policyRevision", "reason",
            "assetIndex", "standard", "assetContract", "tokenId", "amount", "claimedSender", "recipient", "evidenceDigest",
            "issuedAt", "expiresAt", "nonce",
        ],
        "asset recovery request",
    )?;
    rec.check_header(&o, ctx)?;
    ensure(a.live().is_none() && a.state != "RECOVERED", "INVALID_STATE", "the asset already has a live or completed recovery")?;
    o.expect_str("policyId", crate::terms::REFUND_POLICY_ID, "POLICY_MISMATCH")?;
    ensure(o.u64("policyRevision")? == crate::terms::REFUND_POLICY_REVISION, "POLICY_MISMATCH", "recovery policy revision mismatch")?;
    o.expect_str("reason", RECOVERY_REASON, "POLICY_MISMATCH")?;
    let (_, expires) = rec.check_window(&o, ctx, MAX_REQUEST_LIFETIME_MS)?;
    let id = o.str("recoveryId")?;
    ensure(is_id(&id, "arc"), "VALIDATION_FAILED", "recoveryId malformed")?;
    ensure(a.find(&id).is_err(), "INVALID_STATE", "recoveryId already used")?;
    ensure(o.u64("assetIndex")? == a.index, "ASSET_MISMATCH", "request names another asset record")?;
    o.expect_str("standard", &a.standard, "ASSET_MISMATCH")?;
    o.expect_str("assetContract", &a.asset_contract, "ASSET_MISMATCH")?;
    ensure(o.opt_str("tokenId")? == a.token_id, "ASSET_MISMATCH", "token id differs from the observed record")?;
    o.expect_str("claimedSender", &a.claimed_sender, "ASSET_MISMATCH")?;
    o.expect_str("amount", &a.observed_amount, "AMOUNT_MISMATCH")?;
    o.expect_str("recipient", &a.claimed_sender, "RECIPIENT_NOT_SENDER")?;
    ensure(ctx.predecessor == a.claimed_sender, "FORBIDDEN", "only the claimed sender's own account can request recovery")?;
    let capability = capability_for(&a.standard)
        .ok_or_else(|| crate::error::Error { code: "ADAPTER_UNSAFE", message: "no safe recovery adapter exists for this asset standard".into() })?;
    let evidence = o.str("evidenceDigest")?;
    ensure(is_hex64(&evidence), "VALIDATION_FAILED", "evidenceDigest malformed")?;
    let (hex, _) = digest_hex(domains::ASSET_RECOVERY_REQUEST, &v)?;
    rec.consume_nonce(domains::ASSET_RECOVERY_REQUEST, &o.str("nonce")?)?;
    a.recoveries.push(AssetRecovery {
        id: id.clone(),
        trade_id: rec.terms.trade_id.clone(),
        trade_revision: rec.terms.revision,
        recipient: a.claimed_sender.clone(),
        amount: a.observed_amount.clone(),
        capability: capability.into(),
        request_digest: hex,
        evidence_digest: evidence,
        state: RecoveryState::Requested,
        requested_at: ctx.now_ms,
        request_expires_at: expires,
        approval_digest: None,
        validation_digest: None,
        approved_at: None,
        deadline: None,
        challenge: None,
        revoked_by: None,
        executor: None,
        history: alloc::vec![("REQUESTED".into(), ctx.now_ms)],
    });
    a.state = "RECOVERY_REQUESTED".into();
    Ok(id)
}

/// Step 2: the governing trade's bound risk/policy principal approves; the challenge starts.
pub fn approve_recovery(a: &mut UnexpectedAsset, rec: &mut TradeRecord, ctx: &Ctx<'_>, payload: &J, signature: &str) -> R<u64> {
    let v = decode(payload)?;
    let o = Obj::exact(
        &v,
        &[
            "contractId", "tradeId", "tradeRevision", "tradeDigest", "recoveryId", "requestDigest", "assetIndex", "amount",
            "recipient", "recoveryCapability", "validationDigest", "approverRole", "issuedAt", "expiresAt", "nonce",
        ],
        "asset recovery approval",
    )?;
    let i = governed(a, rec, &o, ctx)?;
    let r = a.recoveries[i].clone();
    ensure(r.state == RecoveryState::Requested, "INVALID_STATE", "recovery is not awaiting approval")?;
    o.expect_str("approverRole", "RISK_RESOLVER", "FORBIDDEN")?;
    check_request_digest(&r, &o)?;
    rec.check_window(&o, ctx, 24 * HOUR_MS)?;
    ensure(ctx.now_ms < r.request_expires_at, "EXPIRED", "the recovery request has expired")?;
    ensure(o.u64("assetIndex")? == a.index, "ASSET_MISMATCH", "approval names another asset record")?;
    o.expect_str("amount", &r.amount, "AMOUNT_MISMATCH")?;
    o.expect_str("recipient", &r.recipient, "RECIPIENT_NOT_SENDER")?;
    o.expect_str("recoveryCapability", &r.capability, "ADAPTER_UNSAFE")?;
    let validation = o.str("validationDigest")?;
    ensure(is_hex64(&validation), "VALIDATION_FAILED", "validationDigest malformed")?;
    let (hex, d) = digest_hex(domains::ASSET_RECOVERY_APPROVAL, &v)?;
    rec.verify_role(ctx, "riskResolver", &d, signature)?;
    rec.consume_nonce(domains::ASSET_RECOVERY_APPROVAL, &o.str("nonce")?)?;
    let deadline = ctx.now_ms + CHALLENGE_72H_MS;
    let r = &mut a.recoveries[i];
    r.approval_digest = Some(hex);
    r.validation_digest = Some(validation);
    r.approved_at = Some(ctx.now_ms);
    r.deadline = Some(deadline);
    r.to(RecoveryState::ChallengePeriod, ctx.now_ms);
    a.state = "RECOVERY_CHALLENGE_PERIOD".into();
    Ok(deadline)
}

/// Challenge by the buyer, supplier or risk/policy principal (signed with the bound key) or by
/// another claimant's own account. The recovery ends and the asset returns to review.
pub fn challenge_recovery(a: &mut UnexpectedAsset, rec: &mut TradeRecord, ctx: &Ctx<'_>, payload: &J, signature: Option<&str>) -> R<()> {
    let v = decode(payload)?;
    let o = Obj::exact(
        &v,
        &[
            "contractId", "tradeId", "tradeRevision", "tradeDigest", "recoveryId", "requestDigest", "challengerRole",
            "challengerAccount", "reasonCode", "evidenceDigest", "issuedAt", "expiresAt", "nonce",
        ],
        "asset recovery challenge",
    )?;
    let i = governed(a, rec, &o, ctx)?;
    let r = a.recoveries[i].clone();
    let role = o.str("challengerRole")?;
    let key = match role.as_str() {
        "BUYER" => Some("buyer"),
        "SUPPLIER" => Some("supplier"),
        "RISK_RESOLVER" => Some("riskResolver"),
        "CLAIMANT" => None,
        _ => return err("FORBIDDEN", "role holds no challenge right on asset recovery"),
    };
    let open = r.state == RecoveryState::Requested
        || (r.state == RecoveryState::ChallengePeriod && r.deadline.is_some_and(|dl| ctx.now_ms < dl));
    ensure(open, "INVALID_STATE", "the challenge window is closed")?;
    check_request_digest(&r, &o)?;
    rec.check_window(&o, ctx, 24 * HOUR_MS)?;
    let reason = o.str("reasonCode")?;
    ensure(!reason.is_empty() && reason.len() <= 64, "VALIDATION_FAILED", "reasonCode required")?;
    let evidence = o.str("evidenceDigest")?;
    ensure(is_hex64(&evidence), "VALIDATION_FAILED", "evidenceDigest malformed")?;
    let account = o.opt_str("challengerAccount")?;
    let (hex, d) = digest_hex(domains::ASSET_RECOVERY_CHALLENGE, &v)?;
    match key {
        Some(k) => {
            ensure(account.is_none(), "VALIDATION_FAILED", "a bound party challenges by key, not by account")?;
            let s = signature.ok_or_else(|| crate::error::Error { code: "SIGNATURE_INVALID", message: "signature required".into() })?;
            rec.verify_role(ctx, k, &d, s)?;
        }
        None => {
            ensure(signature.is_none(), "VALIDATION_FAILED", "a claimant challenges from its own account, unsigned")?;
            let acct = account.clone().unwrap_or_default();
            ensure(!acct.is_empty() && ctx.predecessor == acct, "FORBIDDEN", "a claimant challenge must come from the claimant's own account")?;
            ensure(acct != r.recipient, "FORBIDDEN", "the recipient cannot challenge its own recovery")?;
        }
    }
    rec.consume_nonce(domains::ASSET_RECOVERY_CHALLENGE, &o.str("nonce")?)?;
    let rest = a.rest_state();
    let r = &mut a.recoveries[i];
    r.challenge = Some(RecoveryChallenge { role, account, reason_code: reason, evidence_digest: evidence, digest: hex, at: ctx.now_ms });
    r.to(RecoveryState::Challenged, ctx.now_ms);
    a.state = rest;
    Ok(())
}

/// Revocation before execution by the claimed sender's own account or the risk/policy key.
pub fn revoke_recovery(a: &mut UnexpectedAsset, rec: &mut TradeRecord, ctx: &Ctx<'_>, payload: &J, signature: Option<&str>) -> R<()> {
    let v = decode(payload)?;
    let o = Obj::exact(
        &v,
        &["contractId", "tradeId", "tradeRevision", "tradeDigest", "recoveryId", "requestDigest", "revokerRole", "issuedAt", "expiresAt", "nonce"],
        "asset recovery revoke",
    )?;
    let i = governed(a, rec, &o, ctx)?;
    let r = a.recoveries[i].clone();
    ensure(
        matches!(r.state, RecoveryState::Requested | RecoveryState::ChallengePeriod),
        "INVALID_STATE",
        "revocation is allowed only before execution",
    )?;
    check_request_digest(&r, &o)?;
    rec.check_window(&o, ctx, 24 * HOUR_MS)?;
    let role = o.str("revokerRole")?;
    let (_, d) = digest_hex(domains::ASSET_RECOVERY_REVOKE, &v)?;
    match role.as_str() {
        "CLAIMED_SENDER" => {
            ensure(ctx.predecessor == r.recipient && signature.is_none(), "FORBIDDEN", "only the claimed sender's own account revokes in that role")?;
        }
        "RISK_RESOLVER" => {
            let s = signature.ok_or_else(|| crate::error::Error { code: "SIGNATURE_INVALID", message: "signature required".into() })?;
            rec.verify_role(ctx, "riskResolver", &d, s)?;
        }
        _ => return err("FORBIDDEN", "only the claimed sender or the risk/policy principal may revoke"),
    }
    rec.consume_nonce(domains::ASSET_RECOVERY_REVOKE, &o.str("nonce")?)?;
    let rest = a.rest_state();
    let r = &mut a.recoveries[i];
    r.revoked_by = Some(role);
    r.to(RecoveryState::Revoked, ctx.now_ms);
    a.state = rest;
    Ok(())
}

/// Step 4: after the unchallenged window, lock the asset and return the adapter transfer
/// (asset contract, proven recipient, exact amount). `attached` must be the adapter deposit.
pub fn begin_recovery(a: &mut UnexpectedAsset, ctx: &Ctx<'_>, id: &str, attached: u128) -> R<(String, String, u128)> {
    let i = a.find(id)?;
    let r = &a.recoveries[i];
    ensure(r.state == RecoveryState::ChallengePeriod, "INVALID_STATE", "recovery is not approved and unchallenged")?;
    ensure(r.challenge.is_none(), "INVALID_STATE", "a challenged recovery stays in review")?;
    ensure(r.deadline.is_some_and(|dl| ctx.now_ms >= dl), "DELAY_NOT_ELAPSED", "the 72-hour challenge window has not elapsed")?;
    ensure(attached == ADAPTER_DEPOSIT_YOCTO, "INVALID_AMOUNT", "the NEP-141 adapter needs exactly one yoctoNEAR from the executor")?;
    ensure(capability_for(&a.standard) == Some(r.capability.as_str()), "ADAPTER_UNSAFE", "no safe recovery adapter for this asset")?;
    let amount: u128 = r
        .amount
        .parse()
        .map_err(|_| crate::error::Error { code: "VALIDATION_FAILED", message: "recorded amount is not a u128".into() })?;
    ensure(amount > 0, "INVALID_AMOUNT", "nothing to recover")?;
    let out = (a.asset_contract.clone(), r.recipient.clone(), amount);
    let r = &mut a.recoveries[i];
    r.executor = Some(ctx.predecessor.into());
    r.to(RecoveryState::Submitted, ctx.now_ms);
    a.state = "RECOVERY_SUBMITTED".into();
    Ok(out)
}

/// Adapter outcome. Returns the executor (whose deposit the host returns on failure).
pub fn complete_recovery(a: &mut UnexpectedAsset, ctx: &Ctx<'_>, id: &str, transferred: bool) -> R<String> {
    let i = a.find(id)?;
    ensure(a.recoveries[i].state == RecoveryState::Submitted, "INVALID_STATE", "no recovery outcome is pending")?;
    let rest = a.rest_state();
    let r = &mut a.recoveries[i];
    let executor = r.executor.clone().unwrap_or_default();
    if transferred {
        r.to(RecoveryState::Recovered, ctx.now_ms);
        a.state = "RECOVERED".into();
    } else {
        r.to(RecoveryState::Failed, ctx.now_ms);
        a.state = rest;
    }
    Ok(executor)
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
