//! Host replay of the escrow contract's dispatcher (`contract/crates/dockside-escrow/src/lib.rs`).
//!
//! Every method takes the exact JSON arguments sent to the chain and runs the same
//! `dockside-escrow-core` function the contract runs, with the block time and predecessor of the
//! receipt that executed it. A failed call leaves the mirror unchanged, like a panic reverts the
//! contract. The mirror is never the authority: it only lets payloads that depend on recorded
//! state be built off chain, and lets tests check that the contract's views equal the core's.

use dockside_escrow_core::assets::{self, UnexpectedAsset};
use dockside_escrow_core::refund::RefundSignatures;
use dockside_escrow_core::{funding_message, views, Ctx, Error, Limits, TradeRecord, DEFAULT_MIN_DEPOSIT_NEP141, DEFAULT_MIN_DEPOSIT_YOCTO};
use serde_json::{json, Value as J};
use std::collections::BTreeMap;

use crate::{Dalek, NETWORK};

/// Execution context of one receipt.
#[derive(Clone, Copy, Debug)]
pub struct Call<'a> {
    pub now_ms: u64,
    pub predecessor: &'a str,
    pub deposit: u128,
    /// For private callbacks: whether the awaited promise succeeded. For `on_payee_storage` it
    /// is whether the token's `storage_balance_of` answered with a balance (registered).
    pub promise_ok: Option<bool>,
}

impl<'a> Call<'a> {
    pub fn by(predecessor: &'a str, now_ms: u64) -> Call<'a> {
        Call { now_ms, predecessor, deposit: 0, promise_ok: None }
    }
    pub fn with_deposit(mut self, deposit: u128) -> Call<'a> {
        self.deposit = deposit;
        self
    }
    pub fn settled(mut self, ok: bool) -> Call<'a> {
        self.promise_ok = Some(ok);
        self
    }
}

#[derive(Clone, Debug)]
pub struct Mirror {
    pub contract: String,
    pub network: String,
    pub min_deposit: u128,
    pub min_deposit_nep141: u128,
    /// The deployment limits `new` fixed (caps and the pinned NEP-141 token).
    pub limits: Limits,
    pub trades: BTreeMap<String, TradeRecord>,
    pub trade_ids: Vec<String>,
    pub unexpected: Vec<UnexpectedAsset>,
}

fn err(code: &'static str, message: &str) -> Error {
    Error { code, message: message.into() }
}

fn arg_str(a: &J, k: &str) -> Result<String, Error> {
    a.get(k).and_then(|v| v.as_str()).map(str::to_string).ok_or_else(|| err("VALIDATION_FAILED", k))
}

fn arg_opt_str(a: &J, k: &str) -> Option<String> {
    a.get(k).and_then(|v| v.as_str()).map(str::to_string)
}

fn arg_u64(a: &J, k: &str) -> Result<u64, Error> {
    a.get(k).and_then(|v| v.as_u64()).ok_or_else(|| err("VALIDATION_FAILED", k))
}

fn arg(a: &J, k: &str) -> Result<J, Error> {
    a.get(k).cloned().ok_or_else(|| err("VALIDATION_FAILED", k))
}

impl Mirror {
    /// The state `new("near-testnet", min_deposit_yocto)` initialises: no caps, no pinned token.
    pub fn new(contract: &str, min_deposit: Option<u128>) -> Mirror {
        Mirror::configured(contract, NETWORK, min_deposit, None, Limits::default())
    }

    /// The state `new(network, min_deposit_yocto, max_trade_amount, nep141_token,
    /// min_deposit_nep141)` initialises. `limits` is what `Limits::configure` returned for the
    /// same arguments.
    pub fn configured(contract: &str, network: &str, min_deposit: Option<u128>, min_deposit_nep141: Option<u128>, limits: Limits) -> Mirror {
        Mirror {
            contract: contract.to_string(),
            network: network.to_string(),
            min_deposit: min_deposit.unwrap_or(DEFAULT_MIN_DEPOSIT_YOCTO),
            min_deposit_nep141: min_deposit_nep141.unwrap_or(DEFAULT_MIN_DEPOSIT_NEP141),
            limits,
            trades: BTreeMap::new(),
            trade_ids: Vec::new(),
            unexpected: Vec::new(),
        }
    }

    pub fn trade(&self, trade_id: &str) -> &TradeRecord {
        &self.trades[trade_id]
    }

    fn ctx<'a>(&'a self, c: &Call<'a>) -> Ctx<'a> {
        Ctx { now_ms: c.now_ms, predecessor: c.predecessor, contract_id: &self.contract, network: &self.network, verifier: &Dalek, limits: &self.limits }
    }

    fn mutate<T>(&mut self, trade_id: &str, c: &Call<'_>, f: impl FnOnce(&mut TradeRecord, &Ctx<'_>) -> Result<T, Error>) -> Result<T, Error> {
        let mut t = self.trades.get(trade_id).cloned().ok_or_else(|| err("NOT_FOUND", "trade not found"))?;
        let out = {
            let ctx = self.ctx(c);
            f(&mut t, &ctx)?
        };
        t.ledger.check_conservation()?;
        self.trades.insert(trade_id.to_string(), t);
        Ok(out)
    }

    fn govern<T>(&mut self, index: u64, trade_id: &str, c: &Call<'_>, f: impl FnOnce(&mut UnexpectedAsset, &mut TradeRecord, &Ctx<'_>) -> Result<T, Error>) -> Result<T, Error> {
        let mut a = self.asset(index)?;
        let mut t = self.trades.get(trade_id).cloned().ok_or_else(|| err("NOT_FOUND", "trade not found"))?;
        let ledger = t.ledger.clone();
        let out = {
            let ctx = self.ctx(c);
            f(&mut a, &mut t, &ctx)?
        };
        if t.ledger != ledger {
            return Err(err("INTERNAL", "asset recovery must not change native value"));
        }
        t.ledger.check_conservation()?;
        self.trades.insert(trade_id.to_string(), t);
        self.unexpected[index as usize] = a;
        Ok(out)
    }

    pub fn asset(&self, index: u64) -> Result<UnexpectedAsset, Error> {
        self.unexpected.get(index as usize).cloned().ok_or_else(|| err("NOT_FOUND", "unexpected asset not found"))
    }

    /// Replay one contract method. Returns the method's JSON return value; promise-returning
    /// methods return the transfer the contract scheduled, and their private callbacks take the
    /// promise outcome in `Call::promise_ok`.
    pub fn apply(&mut self, method: &str, a: &J, c: Call<'_>) -> Result<J, Error> {
        match method {
            "register_trade" => {
                let terms = arg(a, "terms")?;
                let (bs, ss) = (arg_str(a, "buyer_signature")?, arg_str(a, "supplier_signature")?);
                let t = dockside_escrow_core::register(&self.ctx(&c), &terms, &bs, &ss)?;
                let id = t.terms.trade_id.clone();
                if self.trades.contains_key(&id) {
                    return Err(err("INVALID_STATE", "trade already registered"));
                }
                let digest = t.terms_digest.clone();
                self.trades.insert(id.clone(), t);
                self.trade_ids.push(id);
                Ok(J::String(digest))
            }
            "fund" => {
                let min = self.min_deposit;
                let digest = arg_str(a, "terms_digest")?;
                let o = self.mutate(&arg_str(a, "trade_id")?, &c, |t, ctx| t.fund_exact(ctx, &digest, c.deposit, min))?;
                Ok(json!({
                    "index": o.index, "accepted": o.accepted.to_string(),
                    "quarantined": o.quarantined.to_string(), "fullyFunded": o.fully_funded,
                }))
            }
            "register_evidence_policy" => {
                let p = arg(a, "policy")?;
                self.mutate(&arg_str(a, "trade_id")?, &c, |t, _| t.register_evidence_policy(&p)).map(J::String)
            }
            "submit_manifest_attestation" | "submit_inspection" | "set_hold" | "resolve_hold" | "approve_release" => {
                let (p, sig) = (arg(a, "payload")?, arg_str(a, "signature")?);
                self.mutate(&arg_str(a, "trade_id")?, &c, |t, ctx| match method {
                    "submit_manifest_attestation" => t.submit_manifest_attestation(ctx, &p, &sig),
                    "submit_inspection" => t.submit_inspection(ctx, &p, &sig),
                    "set_hold" => t.set_hold(ctx, &p, &sig),
                    "resolve_hold" => t.resolve_hold(ctx, &p, &sig),
                    _ => t.approve_release(ctx, &p, &sig),
                })
                .map(J::String)
            }
            "request_refund" => {
                let p = arg(a, "payload")?;
                let (b, s, r) = (arg_opt_str(a, "buyer_signature"), arg_opt_str(a, "supplier_signature"), arg_opt_str(a, "risk_signature"));
                self.mutate(&arg_str(a, "trade_id")?, &c, |t, ctx| {
                    t.request_refund(ctx, &p, RefundSignatures { buyer: b.as_deref(), supplier: s.as_deref(), risk: r.as_deref() })
                })
                .map(J::String)
            }
            "cosign_refund" => {
                let (id, role, sig) = (arg_str(a, "refund_intent_id")?, arg_str(a, "role")?, arg_str(a, "signature")?);
                self.mutate(&arg_str(a, "trade_id")?, &c, |t, ctx| t.cosign_refund(ctx, &id, &role, &sig)).map(|_| J::Null)
            }
            "authorize_refund" => {
                let id = arg_str(a, "refund_intent_id")?;
                self.mutate(&arg_str(a, "trade_id")?, &c, |t, ctx| t.authorize_refund(ctx, &id)).map(|_| J::Null)
            }
            "execute_refund" => {
                let id = arg_str(a, "refund_intent_id")?;
                let trade_id = arg_str(a, "trade_id")?;
                let (to, amount) = self.mutate(&trade_id, &c, |t, ctx| t.begin_refund(ctx, &id))?;
                Ok(json!({ "transfer": self.transfer(&trade_id, &to, amount) }))
            }
            "on_refund_transfer" => {
                let ok = self.callback(&c)?;
                let id = arg_str(a, "refund_intent_id")?;
                self.mutate(&arg_str(a, "trade_id")?, &c, |t, ctx| t.complete_refund(ctx, &id, ok)).map(|_| J::Bool(ok))
            }
            "create_release_intent" => {
                let (p, sig) = (arg(a, "payload")?, arg_str(a, "buyer_signature")?);
                let (id, joined) = self.mutate(&arg_str(a, "trade_id")?, &c, |t, ctx| t.create_release_intent(ctx, &p, &sig))?;
                Ok(json!({ "releaseIntentId": id, "joined": joined }))
            }
            "execute_release" => {
                let id = arg_str(a, "release_intent_id")?;
                let trade_id = arg_str(a, "trade_id")?;
                let (to, amount, attempt) = self.mutate(&trade_id, &c, |t, ctx| t.execute_release(ctx, &id))?;
                Ok(json!({ "transfer": self.transfer(&trade_id, &to, amount), "attempt_id": attempt }))
            }
            "on_release_transfer" => {
                let ok = self.callback(&c)?;
                let (id, attempt) = (arg_str(a, "release_intent_id")?, arg_str(a, "attempt_id")?);
                self.mutate(&arg_str(a, "trade_id")?, &c, |t, ctx| t.complete_release(ctx, &id, &attempt, ok)).map(|_| J::Bool(ok))
            }
            "submit_cancel_consent" => {
                let (cancel, consent, sig) = (arg(a, "cancel")?, arg(a, "consent")?, arg_str(a, "signature")?);
                self.mutate(&arg_str(a, "trade_id")?, &c, |t, ctx| t.submit_cancel_consent(ctx, &cancel, &consent, &sig)).map(|s| J::String(s.into()))
            }
            "propose_destination_change" => {
                let (succ, role, sig) = (arg(a, "successor_terms")?, arg_str(a, "proposer_role")?, arg_str(a, "signature")?);
                self.mutate(&arg_str(a, "trade_id")?, &c, |t, ctx| t.propose_destination_change(ctx, &succ, &role, &sig)).map(J::String)
            }
            "consent_destination_change" => {
                let (d, role, sig) = (arg_str(a, "successor_digest")?, arg_str(a, "role")?, arg_str(a, "signature")?);
                self.mutate(&arg_str(a, "trade_id")?, &c, |t, ctx| t.consent_destination_change(ctx, &d, &role, &sig)).map(|x| json!(x))
            }
            "revoke_destination_change" => {
                let (payload, sig) = (arg(a, "payload")?, arg_str(a, "signature")?);
                self.mutate(&arg_str(a, "trade_id")?, &c, |t, ctx| t.revoke_destination_change(ctx, &payload, &sig)).map(|_| J::Null)
            }
            "activate_destination_change" => {
                let d = arg_str(a, "successor_digest")?;
                let (digest, succ) = self.mutate(&arg_str(a, "trade_id")?, &c, |t, ctx| t.activate_destination_change(ctx, &d))?;
                Ok(json!({ "termsDigest": digest, "successorIntent": succ }))
            }
            "ft_on_transfer" => {
                let (amount, sender, msg) = (arg_str(a, "amount")?, arg_str(a, "sender_id")?, arg_str(a, "msg")?);
                let Some(request) = funding_message(&msg) else {
                    let index = self.unexpected.len() as u64;
                    assets::ensure_capacity(index, 1)?;
                    let asset = assets::record(index, "NEP-141", c.predecessor, None, amount, &sender, &msg, c.now_ms)?;
                    self.unexpected.push(asset);
                    return Ok(J::String("0".into()));
                };
                // A refused funding is not a failed call: nothing changes and the receiver
                // returns the whole amount to the sender.
                let units: u128 = amount.parse().map_err(|_| err("VALIDATION_FAILED", "amount"))?;
                let min = self.min_deposit_nep141;
                let funded = request.and_then(|m| self.mutate(&m.trade_id, &c, |t, ctx| t.fund_token(ctx, &sender, &m.terms_digest, units, min)));
                Ok(J::String(if funded.is_ok() { "0".into() } else { amount }))
            }
            "check_payee_storage" => {
                let (trade_id, account) = (arg_str(a, "trade_id")?, arg_str(a, "account_id")?);
                let token = self.trades.get(&trade_id).ok_or_else(|| err("NOT_FOUND", "trade not found"))?.payee_check_target(&account)?;
                Ok(json!({ "storage_balance_of": { "token": token, "account": account } }))
            }
            "on_payee_storage" => {
                let registered = self.callback(&c)?;
                let account = arg_str(a, "account_id")?;
                self.mutate(&arg_str(a, "trade_id")?, &c, |t, _| t.record_payee_storage(&account, registered)).map(J::Bool)
            }
            "request_asset_recovery" => {
                let (i, p) = (arg_u64(a, "asset_index")?, arg(a, "payload")?);
                self.govern(i, &arg_str(a, "trade_id")?, &c, |x, t, ctx| assets::request_recovery(x, t, ctx, &p)).map(J::String)
            }
            "approve_asset_recovery" => {
                let (i, p, sig) = (arg_u64(a, "asset_index")?, arg(a, "payload")?, arg_str(a, "signature")?);
                self.govern(i, &arg_str(a, "trade_id")?, &c, |x, t, ctx| assets::approve_recovery(x, t, ctx, &p, &sig)).map(|d| json!(d))
            }
            "revoke_asset_recovery" => {
                let (i, p, sig) = (arg_u64(a, "asset_index")?, arg(a, "payload")?, arg_opt_str(a, "signature"));
                self.govern(i, &arg_str(a, "trade_id")?, &c, |x, t, ctx| assets::revoke_recovery(x, t, ctx, &p, sig.as_deref())).map(|_| J::Null)
            }
            "execute_asset_recovery" => {
                let (i, id) = (arg_u64(a, "asset_index")?, arg_str(a, "recovery_id")?);
                let mut x = self.asset(i)?;
                let (token, to, amount) = assets::begin_recovery(&mut x, &self.ctx(&c), &id, c.deposit)?;
                self.unexpected[i as usize] = x;
                Ok(json!({ "ft_transfer": { "token": token, "to": to, "amount": amount.to_string() } }))
            }
            "on_asset_recovery_transfer" => {
                let ok = self.callback(&c)?;
                let (i, id) = (arg_u64(a, "asset_index")?, arg_str(a, "recovery_id")?);
                let mut x = self.asset(i)?;
                assets::complete_recovery(&mut x, &self.ctx(&c), &id, ok)?;
                self.unexpected[i as usize] = x;
                Ok(J::Bool(ok))
            }
            _ => Err(err("VALIDATION_FAILED", "method not mirrored")),
        }
    }

    /// The transfer `execute_release` / `execute_refund` schedules: native NEAR to `to`, or
    /// `ft_transfer` on the trade's token (then `token` names the contract that runs it).
    fn transfer(&self, trade_id: &str, to: &str, amount: u128) -> J {
        match self.trades[trade_id].terms.asset.token() {
            None => json!({ "to": to, "amount": amount.to_string() }),
            Some(token) => json!({ "to": to, "amount": amount.to_string(), "token": token }),
        }
    }

    /// Why a funding `ft_on_transfer` would be refused (`None`: it would be accepted, or `msg` is
    /// not a funding message). The mirror is not changed.
    pub fn funding_refusal(&self, a: &J, c: Call<'_>) -> Option<Error> {
        let (amount, sender, msg) = (arg_str(a, "amount").ok()?, arg_str(a, "sender_id").ok()?, arg_str(a, "msg").ok()?);
        let request = funding_message(&msg)?;
        let units: u128 = amount.parse().ok()?;
        let min = self.min_deposit_nep141;
        let mut probe = self.clone();
        request.and_then(|m| probe.mutate(&m.trade_id, &c, |t, ctx| t.fund_token(ctx, &sender, &m.terms_digest, units, min))).err()
    }

    fn callback(&self, c: &Call<'_>) -> Result<bool, Error> {
        if c.predecessor != self.contract {
            return Err(err("FORBIDDEN", "Method is private"));
        }
        c.promise_ok.ok_or_else(|| err("INTERNAL", "callback without a promise outcome"))
    }

    /// The contract's own view of the same state (`get_*`).
    pub fn view(&self, method: &str, a: &J, now_ms: u64) -> Result<J, Error> {
        let trade = |a: &J| -> Result<&TradeRecord, Error> {
            let id = arg_str(a, "trade_id")?;
            self.trades.get(&id).ok_or_else(|| err("NOT_FOUND", "trade not found"))
        };
        Ok(match method {
            "get_trade" => views::trade(trade(a)?, now_ms),
            "get_ledger" => views::ledger(trade(a)?),
            "get_refunds" => views::refunds(trade(a)?),
            "get_evidence" => views::evidence(trade(a)?, now_ms),
            "get_release" => views::release(trade(a)?, now_ms),
            "get_holds" => views::holds(trade(a)?, now_ms),
            "get_unexpected_asset" => views::unexpected(&self.asset(arg_u64(a, "asset_index")?)?),
            "get_config" => {
                let limits = views::limits(&self.limits);
                json!({
                    "network": self.network, "minDepositYocto": self.min_deposit.to_string(),
                    "minDepositNep141": self.min_deposit_nep141.to_string(),
                    "maxTradeAmount": limits["maxTradeAmount"], "nep141Token": limits["nep141Token"],
                    "trades": self.trade_ids.len(), "unexpectedAssets": self.unexpected.len(),
                    "refundPolicy": {"id": "dockside-refund-v1", "revision": 1},
                })
            }
            _ => return Err(err("VALIDATION_FAILED", "view not mirrored")),
        })
    }
}
