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
pub use trade::{register, Ctx, TradeRecord};

use error::{ensure, R as Res};
use ledger::DepositOutcome;
use refund::RefundState;

/// Minimum native deposit; covers the storage the deposit record consumes.
pub const DEFAULT_MIN_DEPOSIT_YOCTO: u128 = 1_000_000_000_000_000_000_000; // 0.001 NEAR

impl TradeRecord {
    /// Accept native NEAR from `ctx.predecessor` (the original funder of this deposit).
    pub fn fund(&mut self, ctx: &Ctx<'_>, amount: u128, min_deposit: u128) -> Res<DepositOutcome> {
        ensure(amount >= min_deposit, "INVALID_AMOUNT", "deposit below the minimum")?;
        ensure(ctx.now_ms < self.terms.expires_at, "EXPIRED", "trade has expired; funding is closed")?;
        ensure(
            !self.live_refunds().any(|r| r.source_bucket != ledger::Bucket::Quarantined && r.state != RefundState::Revoked),
            "FUNDING_FROZEN",
            "funding is frozen while a refund of accepted value is unresolved",
        )?;
        self.ledger.deposit(ctx.predecessor, amount, ctx.now_ms)
    }
}
