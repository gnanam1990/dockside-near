//! Per-funder ledger of the trade asset, native NEAR or one NEP-141 token (FR-02, INV-02, INV-12).
//! Amounts are base units of that asset; the bucket rules are the same for both.
//!
//! Every accepted deposit records its original funder. Value sits in exactly one bucket:
//!
//! * `partial`      accepted toward the trade amount while the trade is under-funded (never releasable)
//! * `available`    accepted value of a fully funded trade
//! * `reserved`     locked by a release intent (M04)
//! * `released`     transferred to the bound supplier
//! * `refundLocked` locked by a live refund intent (recorded with its exact source bucket)
//! * `refunded`     returned to the original funder
//! * `quarantined`  excess beyond the trade amount, returnable only to the same funder
//! * `fees`         separately accounted fees (none in the direct testnet corridor)
//!
//! Conservation per funder and per trade: `funded = sum(buckets)`. Unexpected assets never
//! enter this ledger (see `assets`).

use crate::error::{ensure, err, R};
use alloc::collections::BTreeMap;
use alloc::string::String;
use alloc::vec::Vec;
use borsh::{BorshDeserialize, BorshSerialize};

#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Bucket {
    Partial,
    Available,
    Quarantined,
}

impl Bucket {
    pub fn as_str(&self) -> &'static str {
        match self {
            Bucket::Partial => "PARTIAL",
            Bucket::Available => "AVAILABLE",
            Bucket::Quarantined => "QUARANTINED",
        }
    }
    pub fn parse(s: &str) -> R<Bucket> {
        match s {
            "PARTIAL" => Ok(Bucket::Partial),
            "AVAILABLE" => Ok(Bucket::Available),
            "QUARANTINED" => Ok(Bucket::Quarantined),
            _ => err("VALIDATION_FAILED", "unknown source bucket"),
        }
    }
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct FunderLedger {
    pub funded: u128,
    pub partial: u128,
    pub available: u128,
    pub reserved: u128,
    pub released: u128,
    pub refund_locked: u128,
    pub refunded: u128,
    pub quarantined: u128,
    pub fees: u128,
    /// Detection time (ms) of the most recent excess slice; clock origin for EXCESS_FUNDING_RETURN.
    pub excess_detected_at: Option<u64>,
}

impl FunderLedger {
    pub fn bucket_sum(&self) -> Option<u128> {
        [self.partial, self.available, self.reserved, self.released, self.refund_locked, self.refunded, self.quarantined, self.fees]
            .iter()
            .try_fold(0u128, |a, b| a.checked_add(*b))
    }

    pub fn bucket_mut(&mut self, b: Bucket) -> &mut u128 {
        match b {
            Bucket::Partial => &mut self.partial,
            Bucket::Available => &mut self.available,
            Bucket::Quarantined => &mut self.quarantined,
        }
    }

    pub fn bucket(&self, b: Bucket) -> u128 {
        match b {
            Bucket::Partial => self.partial,
            Bucket::Available => self.available,
            Bucket::Quarantined => self.quarantined,
        }
    }
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct Deposit {
    pub index: u64,
    pub funder: String,
    pub amount: u128,
    pub accepted: u128,
    pub quarantined: u128,
    pub at_ms: u64,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct Ledger {
    pub required: u128,
    pub funders: BTreeMap<String, FunderLedger>,
    pub deposits: Vec<Deposit>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DepositOutcome {
    pub index: u64,
    pub accepted: u128,
    pub quarantined: u128,
    pub fully_funded: bool,
}

impl Ledger {
    pub fn new(required: u128) -> Ledger {
        Ledger { required, funders: BTreeMap::new(), deposits: Vec::new() }
    }

    fn sum(&self, f: impl Fn(&FunderLedger) -> u128) -> u128 {
        self.funders.values().map(f).fold(0u128, |a, b| a.saturating_add(b))
    }

    /// Value that counts toward the trade amount (quarantined/refunded/refund-locked do not).
    pub fn committed(&self) -> u128 {
        self.sum(|f| f.partial + f.available + f.reserved + f.released)
    }

    /// Value this trade still holds in escrow: every deposit minus what was released or refunded.
    pub fn held(&self) -> u128 {
        self.sum(|f| f.funded.saturating_sub(f.released).saturating_sub(f.refunded))
    }

    pub fn total_available(&self) -> u128 {
        self.sum(|f| f.available)
    }

    pub fn fully_funded(&self) -> bool {
        self.committed() >= self.required && self.sum(|f| f.partial) == 0
    }

    pub fn funder(&self, a: &str) -> FunderLedger {
        self.funders.get(a).cloned().unwrap_or_default()
    }

    /// Accept a native NEAR deposit from `funder`. Under-funded value is PARTIAL; the deposit
    /// that completes the amount promotes every PARTIAL slice to AVAILABLE; anything beyond
    /// the amount is QUARANTINED for the same funder.
    pub fn deposit(&mut self, funder: &str, amount: u128, now_ms: u64) -> R<DepositOutcome> {
        ensure(amount > 0, "INVALID_AMOUNT", "deposit must be positive")?;
        let committed = self.committed();
        let room = self.required.saturating_sub(committed);
        let accepted = amount.min(room);
        let excess = amount - accepted;
        let index = self.deposits.len() as u64;
        {
            let f = self.funders.entry(funder.into()).or_default();
            f.funded = f.funded.checked_add(amount).ok_or_else(overflow)?;
            if excess > 0 {
                f.quarantined += excess;
                f.excess_detected_at = Some(now_ms);
            }
        }
        let completes = accepted > 0 && committed + accepted == self.required;
        if accepted > 0 {
            if completes {
                for f in self.funders.values_mut() {
                    f.available += f.partial;
                    f.partial = 0;
                }
                self.funders.get_mut(funder).expect("inserted").available += accepted;
            } else {
                self.funders.get_mut(funder).expect("inserted").partial += accepted;
            }
        }
        self.deposits.push(Deposit { index, funder: funder.into(), amount, accepted, quarantined: excess, at_ms: now_ms });
        self.check_conservation()?;
        Ok(DepositOutcome { index, accepted, quarantined: excess, fully_funded: self.fully_funded() })
    }

    /// Move `amount` of `funder`'s `bucket` into the refund lock.
    pub fn lock_for_refund(&mut self, funder: &str, bucket: Bucket, amount: u128) -> R<()> {
        let f = self.funders.get_mut(funder).ok_or_else(|| crate::error::Error { code: "NOTHING_ELIGIBLE", message: "no native deposit from this funder".into() })?;
        let b = f.bucket_mut(bucket);
        ensure(*b >= amount && amount > 0, "NOTHING_ELIGIBLE", "source bucket does not hold the eligible amount")?;
        *b -= amount;
        f.refund_locked += amount;
        self.check_conservation()
    }

    /// Pre-execution revocation or authoritative FAILED: restore the exact recorded bucket.
    pub fn restore_from_refund(&mut self, funder: &str, bucket: Bucket, amount: u128) -> R<()> {
        let f = self.funders.get_mut(funder).ok_or_else(|| crate::error::Error { code: "INTERNAL", message: "funder missing".into() })?;
        ensure(f.refund_locked >= amount, "CONSERVATION_VIOLATION", "refund lock underflow")?;
        f.refund_locked -= amount;
        *f.bucket_mut(bucket) += amount;
        self.check_conservation()
    }

    pub fn settle_refund(&mut self, funder: &str, amount: u128) -> R<()> {
        let f = self.funders.get_mut(funder).ok_or_else(|| crate::error::Error { code: "INTERNAL", message: "funder missing".into() })?;
        ensure(f.refund_locked >= amount, "CONSERVATION_VIOLATION", "refund lock underflow")?;
        f.refund_locked -= amount;
        f.refunded += amount;
        // A trade that drops below its amount is no longer releasable: AVAILABLE becomes PARTIAL.
        if self.committed() < self.required && self.sum(|x| x.reserved + x.released) == 0 {
            for x in self.funders.values_mut() {
                x.partial += x.available;
                x.available = 0;
            }
        }
        self.check_conservation()
    }

    /// Reserve every funder's AVAILABLE value for one release intent (exact per-funder slices).
    pub fn reserve_available(&mut self) -> R<Vec<(String, u128)>> {
        let mut slices = Vec::new();
        for (k, f) in self.funders.iter_mut() {
            if f.available > 0 {
                slices.push((k.clone(), f.available));
                f.reserved = f.reserved.checked_add(f.available).ok_or_else(overflow)?;
                f.available = 0;
            }
        }
        ensure(!slices.is_empty(), "NOTHING_ELIGIBLE", "no available value to reserve")?;
        self.check_conservation()?;
        Ok(slices)
    }

    /// The slices a reservation of all AVAILABLE value would take, without mutating.
    pub fn available_slices(&self) -> Vec<(String, u128)> {
        self.funders.iter().filter(|(_, f)| f.available > 0).map(|(k, f)| (k.clone(), f.available)).collect()
    }

    /// Pre-submit exit or authoritative no-transfer FAILED: reserved -> available, exact slices.
    pub fn restore_reserved(&mut self, slices: &[(String, u128)]) -> R<()> {
        for (k, a) in slices {
            let f = self.funders.get_mut(k).ok_or_else(|| crate::error::Error { code: "CONSERVATION_VIOLATION", message: "reserved funder missing".into() })?;
            ensure(f.reserved >= *a, "CONSERVATION_VIOLATION", "reservation underflow")?;
            f.reserved -= a;
            f.available += a;
        }
        self.check_conservation()
    }

    /// PAID: reserved -> released, exact slices.
    pub fn settle_release(&mut self, slices: &[(String, u128)]) -> R<()> {
        for (k, a) in slices {
            let f = self.funders.get_mut(k).ok_or_else(|| crate::error::Error { code: "CONSERVATION_VIOLATION", message: "reserved funder missing".into() })?;
            ensure(f.reserved >= *a, "CONSERVATION_VIOLATION", "reservation underflow")?;
            f.reserved -= a;
            f.released += a;
        }
        self.check_conservation()
    }

    /// True when exactly these slices are reserved and nothing else is.
    pub fn reservation_matches(&self, slices: &[(String, u128)]) -> bool {
        let total: u128 = self.sum(|f| f.reserved);
        let want: u128 = slices.iter().map(|(_, a)| *a).fold(0u128, |a, b| a.saturating_add(b));
        total == want && slices.iter().all(|(k, a)| self.funders.get(k).is_some_and(|f| f.reserved >= *a))
    }

    pub fn check_conservation(&self) -> R<()> {
        let mut funded = 0u128;
        for f in self.funders.values() {
            let s = f.bucket_sum().ok_or_else(overflow)?;
            if s != f.funded {
                return err("CONSERVATION_VIOLATION", "funder buckets do not sum to funded");
            }
            funded = funded.checked_add(f.funded).ok_or_else(overflow)?;
        }
        let dep: u128 = self.deposits.iter().map(|d| d.amount).fold(0u128, |a, b| a.saturating_add(b));
        if dep != funded {
            return err("CONSERVATION_VIOLATION", "deposits do not sum to funded");
        }
        if self.committed() > self.required {
            return err("CONSERVATION_VIOLATION", "committed value exceeds trade amount");
        }
        Ok(())
    }
}

fn overflow() -> crate::error::Error {
    crate::error::Error { code: "INVALID_AMOUNT", message: "amount overflow".into() }
}
