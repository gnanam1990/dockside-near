//! Dockside escrow authority logic.
//!
//! Pure Rust with no NEAR SDK dependency: the NEAR contract (`dockside-escrow`) supplies the
//! host context (block time, predecessor, contract id, `env::ed25519_verify`) and persists the
//! `TradeRecord`s; host tests supply ed25519-dalek. Every authority decision lives here so the
//! same code is exercised by host tests and compiled into the wasm contract.
#![no_std]
extern crate alloc;

pub mod assets;
pub mod crypto;
pub mod destination;
pub mod domains;
pub mod error;
pub mod evidence;
pub mod holds;
pub mod ledger;
pub mod rebinding;
pub mod refund;
pub mod release;
pub mod terms;
pub mod trade;
pub mod typed;
pub mod views;

pub use error::{Error, R};
pub use trade::{register, Ctx, Limits, TradeRecord};

use error::{ensure, R as Res};
use ledger::DepositOutcome;
use refund::RefundState;

/// Minimum native deposit; covers the storage the deposit record consumes.
pub const DEFAULT_MIN_DEPOSIT_YOCTO: u128 = 1_000_000_000_000_000_000_000; // 0.001 NEAR

/// Ceiling on the per-trade deposit history. `fund` is permissionless and every deposit stays in
/// the trade record that each later mutation loads and rewrites, so the history must be bounded
/// (external security audit, m33).
pub const MAX_DEPOSITS_PER_TRADE: usize = 64;
/// Past [`MAX_DEPOSITS_PER_TRADE`], a deposit that completes an under-funded trade is still
/// accepted (up to this many extra), so a full history cannot block the buyer's funding.
pub const MAX_COMPLETING_DEPOSITS_OVER_LIMIT: usize = 8;

/// Minimum NEP-141 deposit in the token's base units (0.01 USDC at 6 decimals). A token deposit
/// attaches no NEAR, so this only keeps dust out of the bounded deposit history.
pub const DEFAULT_MIN_DEPOSIT_NEP141: u128 = 10_000;

/// The `msg` of an `ft_transfer_call` that funds a trade: `{"tradeId":"trd_...","termsDigest":"<hex64>"}`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FundingMessage {
    pub trade_id: alloc::string::String,
    pub terms_digest: alloc::string::String,
}

/// Decide what a token transfer's `msg` asks for. `None`: not a funding message (the transfer is
/// an unexpected asset, recorded and never credited). `Some(Err)`: a funding message that is
/// malformed, which the receiver refuses by returning the whole amount. `Some(Ok)`: fund the
/// named trade revision.
pub fn funding_message(msg: &str) -> Option<Res<FundingMessage>> {
    let v: serde_json::Value = serde_json::from_str(msg).ok()?;
    let o = v.as_object()?;
    if !o.contains_key("tradeId") {
        return None;
    }
    let text = |k: &str| o.get(k).and_then(|x| x.as_str()).unwrap_or_default();
    let (trade_id, terms_digest) = (text("tradeId"), text("termsDigest"));
    Some(
        ensure(o.len() == 2 && o.contains_key("termsDigest"), "VALIDATION_FAILED", "a funding message carries exactly tradeId and termsDigest")
            .and_then(|_| ensure(typed::is_id(trade_id, "trd"), "VALIDATION_FAILED", "tradeId malformed"))
            .and_then(|_| ensure(typed::is_hex64(terms_digest), "VALIDATION_FAILED", "termsDigest must be 64 lowercase hex characters"))
            .map(|_| FundingMessage { trade_id: trade_id.into(), terms_digest: terms_digest.into() }),
    )
}

impl TradeRecord {
    /// `fund` for the exact revision the funder agreed to: a deposit names the trade revision
    /// digest, so a record registered first under the same trade id with other terms (a squatted
    /// trade id) or a superseded revision refuses it and the attached deposit is returned.
    pub fn fund_exact(&mut self, ctx: &Ctx<'_>, terms_digest: &str, amount: u128, min_deposit: u128) -> Res<DepositOutcome> {
        ensure(typed::is_hex64(terms_digest), "VALIDATION_FAILED", "termsDigest must be 64 lowercase hex characters")?;
        ensure(terms_digest == self.terms_digest, "STALE_REVISION", "deposit names another trade revision digest")?;
        self.fund(ctx, amount, min_deposit)
    }

    /// Accept native NEAR from `ctx.predecessor` (the original funder of this deposit). A trade
    /// whose asset is a NEP-141 token refuses native NEAR.
    pub fn fund(&mut self, ctx: &Ctx<'_>, amount: u128, min_deposit: u128) -> Res<DepositOutcome> {
        ensure(self.terms.asset.is_native(), "ASSET_MISMATCH", "this trade is funded in its NEP-141 token, by ft_transfer_call")?;
        self.accept_deposit(ctx, ctx.predecessor, amount, min_deposit)
    }

    /// Accept `amount` base units of the trade's NEP-141 token from `sender`. `ctx.predecessor`
    /// is the contract that called `ft_on_transfer`: only the token the signed terms name can
    /// credit this trade, and the deposit must name the active revision digest.
    pub fn fund_token(&mut self, ctx: &Ctx<'_>, sender: &str, terms_digest: &str, amount: u128, min_deposit: u128) -> Res<DepositOutcome> {
        ensure(typed::is_hex64(terms_digest), "VALIDATION_FAILED", "termsDigest must be 64 lowercase hex characters")?;
        ensure(
            self.terms.asset.token() == Some(ctx.predecessor),
            "ASSET_MISMATCH",
            "the calling contract is not the token this trade's signed terms name",
        )?;
        ensure(terms_digest == self.terms_digest, "STALE_REVISION", "deposit names another trade revision digest")?;
        self.accept_deposit(ctx, sender, amount, min_deposit)
    }

    fn accept_deposit(&mut self, ctx: &Ctx<'_>, funder: &str, amount: u128, min_deposit: u128) -> Res<DepositOutcome> {
        ensure(amount >= min_deposit, "INVALID_AMOUNT", "deposit below the minimum")?;
        ensure(ctx.now_ms < self.terms.expires_at, "EXPIRED", "trade has expired; funding is closed")?;
        ensure(
            !self.live_refunds().any(|r| r.source_bucket != ledger::Bucket::Quarantined && r.state != RefundState::Revoked),
            "FUNDING_FROZEN",
            "funding is frozen while a refund of accepted value is unresolved",
        )?;
        let cap = ctx.limits.cap_for(&self.terms.asset);
        ensure(
            cap == 0 || self.ledger.held().checked_add(amount).is_some_and(|held| held <= cap),
            "CAP_EXCEEDED",
            "the deposit would take the value this trade holds above the deployment cap",
        )?;
        let n = self.ledger.deposits.len();
        if n >= MAX_DEPOSITS_PER_TRADE {
            let room = self.ledger.required.saturating_sub(self.ledger.committed());
            let completes = room > 0 && amount >= room;
            ensure(
                completes && n < MAX_DEPOSITS_PER_TRADE + MAX_COMPLETING_DEPOSITS_OVER_LIMIT,
                "CAPACITY_EXCEEDED",
                "this trade holds the maximum number of deposits; only a deposit that completes the amount is accepted",
            )?;
        }
        self.ledger.deposit(funder, amount, ctx.now_ms)
    }
}
