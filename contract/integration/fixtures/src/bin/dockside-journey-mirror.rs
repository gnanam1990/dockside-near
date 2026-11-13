//! Payload builder and host mirror for `scripts/testnet-deploy/journey.mjs`.
//!
//! One JSON request per stdin line, one JSON response per stdout line. The journey driver owns
//! the network side (RPC, near-cli-rs, block times); this process owns the Dockside payloads and
//! signs them with keys derived from the run's seed. It never sees a NEAR account key.
//!
//! Requests:
//!   {"op":"init","accounts":{...},"seed":"<hex>","trade":"<label>","amountYocto":"<u128>","delayMs":<u64>,"t0":<ms>,
//!    "network":"near-testnet|near-mainnet","token":{"accountId":"<id>","decimals":<n>}|null,"config":<get_config>|null}
//!   `amountYocto` is the trade amount in base units of the asset (the token's, with "token").
//!   `config` is the deployed contract's own `get_config`: the mirror takes its network, minimum
//!   deposits, caps and pinned token from it, so it refuses exactly what the contract refuses.
//!   {"op":"build","what":"<payload>","now":<ms>,"label":"<n>",...} where <payload> is one of
//!     register | policy | fund ("depositYocto" overrides the trade amount) | attestation |
//!     inspection | payee_storage | intent | approval ("intentId") | execute_release ("intentId") |
//!     hold_set ("hold", "issuer" POLICY_SETTER|RISK_RESOLVER, "ttlMs") |
//!     hold_resolve ("hold", "code") | refund_mutual_cancel | refund_excess |
//!     authorize_refund ("refundId") | execute_refund ("refundId")
//!   and, for the refusal journey (calls the contract must reject):
//!     fund_other_terms ("redirect": the deposit names the digest of the same terms paying that
//!     account; "depositYocto") | refund_partial (the funder's PARTIAL_FUNDING_RETURN request) |
//!     intent with "destination" (a buyer-signed intent paying that account) |
//!     approval with "signKey" (the approval signed with that run key instead of the bound one)
//!   The response names the method, its arguments, the attached deposit and who signs it:
//!   "signer":"funder" (the buyer's own account, the recorded funder) or "relayer". For a NEP-141
//!   trade `fund` is the funder's `ft_transfer_call` on the token contract ("receiver":"token",
//!   one yoctoNEAR attached); "onEscrow" is then the `ft_on_transfer` the token delivers to the
//!   escrow, which is what the mirror replays.
//!   {"op":"apply","method":"<m>","args":{...},"now":<ms>,"predecessor":"<acct>","deposit":"<u128>","promiseOk":<bool|null>}
//!   {"op":"probe", ...as apply}   the outcome `apply` would have, on a copy: nothing is recorded
//!   {"op":"view","method":"<get_*>","args":{...},"now":<ms>}
//! Responses: {"ok":true,...} or {"ok":false,"code":"<CODE>","message":"..."}.

use dockside_fixtures::mirror::{Call, Mirror};
use dockside_fixtures::payloads::*;
use dockside_fixtures::{Accounts, Fixture, J};
use serde_json::json;
use std::io::{BufRead, Write};

struct State {
    fx: Fixture,
    mirror: Mirror,
}

fn text(v: &J, k: &str) -> Result<String, String> {
    v.get(k).and_then(|x| x.as_str()).map(str::to_string).ok_or_else(|| format!("missing {k}"))
}

fn num(v: &J, k: &str) -> Result<u64, String> {
    v.get(k).and_then(|x| x.as_u64()).ok_or_else(|| format!("missing {k}"))
}

fn yocto(v: &J, k: &str) -> Result<u128, String> {
    match v.get(k) {
        None | Some(J::Null) => Ok(0),
        Some(x) => x.as_str().and_then(|s| s.parse().ok()).ok_or_else(|| format!("{k} must be a decimal string")),
    }
}

fn init(req: &J) -> Result<State, String> {
    let a = req.get("accounts").ok_or("missing accounts")?;
    let accounts = Accounts {
        contract: text(a, "contract")?,
        buyer: text(a, "buyer")?,
        supplier: text(a, "supplier")?,
        treasury: text(a, "treasury").unwrap_or_else(|_| text(a, "buyer").unwrap_or_default()),
        alt_destination: text(a, "altDestination").unwrap_or_else(|_| text(a, "supplier").unwrap_or_default()),
    };
    let seed = text(req, "seed")?;
    if seed.len() < 32 {
        return Err("seed must carry at least 128 bits".into());
    }
    let mut fx = Fixture::new(accounts, &seed, &text(req, "trade")?, yocto(req, "amountYocto")?, num(req, "delayMs")?, num(req, "t0")?);
    let units = |v: &J, k: &str| -> Result<Option<u128>, String> {
        match v.get(k) {
            None | Some(J::Null) => Ok(None),
            Some(J::String(s)) => s.parse().map(Some).map_err(|_| format!("{k} must be a decimal string")),
            Some(_) => Err(format!("{k} must be a decimal string")),
        }
    };
    let token_of = |v: Option<&J>, id_key: &str| -> Result<Option<(String, u64)>, String> {
        match v {
            None | Some(J::Null) => Ok(None),
            Some(t) => Ok(Some((text(t, id_key)?, num(t, "decimals")?))),
        }
    };
    if let Some((token, decimals)) = token_of(req.get("token"), "accountId")? {
        fx = fx.with_token(&token, u8::try_from(decimals).map_err(|_| "token decimals")?);
    }
    let config = req.get("config").filter(|c| !c.is_null());
    let network = match config {
        Some(c) => text(c, "network")?,
        None => text(req, "network").unwrap_or_else(|_| dockside_fixtures::NETWORK.to_string()),
    };
    fx = fx.on_network(&network);
    let mirror = match config {
        Some(c) => {
            let caps = c.get("maxTradeAmount").ok_or("config has no maxTradeAmount")?;
            let limits = dockside_escrow_core::Limits::configure(
                &network,
                Some(units(caps, "nearYocto")?.ok_or("maxTradeAmount.nearYocto")?),
                Some(units(caps, "nep141")?.ok_or("maxTradeAmount.nep141")?),
                token_of(c.get("nep141Token"), "accountId")?,
            )
            .map_err(|e| e.to_string())?;
            Mirror::configured(&fx.accounts.contract, &network, units(c, "minDepositYocto")?, units(c, "minDepositNep141")?, limits)
        }
        None => Mirror::configured(&fx.accounts.contract, &network, units(req, "minDepositYocto")?, None, Default::default()),
    };
    Ok(State { fx, mirror })
}

fn build(st: &State, req: &J) -> Result<J, String> {
    let what = text(req, "what")?;
    let now = num(req, "now").unwrap_or(st.fx.t0);
    let label = text(req, "label").unwrap_or_else(|_| "j".into());
    let t = st.fx.trade_id();
    let rec = || st.mirror.trades.get(&t).ok_or_else(|| "trade not registered on the mirror".to_string());
    let buyer = st.fx.accounts.buyer.clone();
    let funder = |r: &dockside_escrow_core::TradeRecord| r.ledger.funder(&buyer);
    let mut on_escrow = J::Null;
    let (method, args, deposit) = match what.as_str() {
        "register" => ("register_trade", register_args(&st.fx), 0),
        "policy" => ("register_evidence_policy", policy_args(rec()?), 0),
        "fund" => {
            let deposit = match req.get("depositYocto") {
                None | Some(J::Null) => st.fx.amount_yocto,
                _ => yocto(req, "depositYocto")?,
            };
            match &st.fx.token {
                None => ("fund", fund_args(&t, &rec()?.terms_digest), deposit),
                // The funder's own `ft_transfer_call` on the token contract; the escrow sees the
                // token's `ft_on_transfer`.
                Some(_) => {
                    let r = rec()?;
                    on_escrow = json!({
                        "method": "ft_on_transfer",
                        "args": { "sender_id": buyer, "amount": deposit.to_string(), "msg": funding_msg(&t, &r.terms_digest) },
                    });
                    ("ft_transfer_call", ft_fund_args(r, &st.fx.accounts.contract, deposit), 1)
                }
            }
        }
        "payee_storage" => ("check_payee_storage", check_payee_args(rec()?), 0),
        // The trade's own id with the digest of terms that pay `redirect`: not the registered revision.
        "fund_other_terms" => {
            let deposit = match req.get("depositYocto") {
                None | Some(J::Null) => st.fx.amount_yocto,
                _ => yocto(req, "depositYocto")?,
            };
            rec()?;
            let digest = redirected_terms_digest(&st.fx, &text(req, "redirect")?);
            match &st.fx.token {
                None => ("fund", fund_args(&t, &digest), deposit),
                // The same wrong digest in the `msg` of the funder's `ft_transfer_call`: the escrow
                // refuses the funding and the token returns the whole amount.
                Some(_) => {
                    let msg = funding_msg(&t, &digest);
                    on_escrow = json!({
                        "method": "ft_on_transfer",
                        "args": { "sender_id": buyer, "amount": deposit.to_string(), "msg": msg },
                    });
                    let args = json!({ "receiver_id": st.fx.accounts.contract, "amount": deposit.to_string(), "memo": null, "msg": msg });
                    ("ft_transfer_call", args, 1)
                }
            }
        }
        "attestation" => ("submit_manifest_attestation", attestation_args(&st.fx, rec()?, next_manifest_revision(rec()?), now, &label), 0),
        "inspection" => ("submit_inspection", inspection_args(&st.fx, rec()?, "PASS", now, &label), 0),
        "intent" => {
            let r = rec()?;
            let dest = text(req, "destination").unwrap_or_else(|_| r.terms.payout_destination.clone());
            ("create_release_intent", intent_args_to(&st.fx, r, now, &label, &dest), 0)
        }
        "approval" => {
            let key = text(req, "signKey").unwrap_or_else(|_| "buyer".into());
            ("approve_release", approval_args_signed_by(&st.fx, rec()?, &text(req, "intentId")?, now, &label, &key), 0)
        }
        "execute_release" => ("execute_release", execute_release_args(rec()?, &text(req, "intentId")?), 0),
        "hold_set" => {
            let issuer = text(req, "issuer").unwrap_or_else(|_| "POLICY_SETTER".into());
            let ttl = num(req, "ttlMs").unwrap_or(7 * dockside_fixtures::DAY);
            ("set_hold", hold_set_args(&st.fx, rec()?, &issuer, now, ttl, &text(req, "hold")?), 0)
        }
        "hold_resolve" => ("resolve_hold", hold_resolve_args(&st.fx, rec()?, &text(req, "hold")?, &text(req, "code")?, now), 0),
        // MUTUAL_CANCEL of the buyer's AVAILABLE value: buyer-initiated, both parties sign the one
        // request, so the one-hour cooling period starts at once.
        "refund_mutual_cancel" => {
            let r = rec()?;
            let amount = funder(r).available;
            let p = refund_request(&st.fx, r, &label, "MUTUAL_CANCEL", &buyer, amount, "AVAILABLE", "BUYER", now);
            ("request_refund", request_refund_args(&st.fx, r, &p, &["buyer", "supplier"]), 0)
        }
        // EXCESS_FUNDING_RETURN of the buyer's QUARANTINED excess, from the funder's own account.
        "refund_excess" => {
            let r = rec()?;
            let amount = funder(r).quarantined;
            let p = refund_request(&st.fx, r, &label, "EXCESS_FUNDING_RETURN", &buyer, amount, "QUARANTINED", "FUNDER", now);
            ("request_refund", request_refund_args(&st.fx, r, &p, &[]), 0)
        }
        // PARTIAL_FUNDING_RETURN of the buyer's PARTIAL value: only the funder's own account may send it.
        "refund_partial" => {
            let r = rec()?;
            let p = partial_return_request(&st.fx, r, &label, &buyer, now);
            ("request_refund", request_refund_args(&st.fx, r, &p, &[]), 0)
        }
        "authorize_refund" => ("authorize_refund", refund_op_args(rec()?, &text(req, "refundId")?), 0),
        "execute_refund" => ("execute_refund", refund_op_args(rec()?, &text(req, "refundId")?), 0),
        other => return Err(format!("unknown payload {other}")),
    };
    let own = ["fund", "fund_other_terms", "refund_excess", "refund_partial"];
    let signer = if own.contains(&what.as_str()) { "funder" } else { "relayer" };
    let receiver = if method == "ft_transfer_call" { "token" } else { "escrow" };
    Ok(json!({
        "ok": true, "method": method, "args": args, "deposit": deposit.to_string(), "tradeId": t, "signer": signer,
        "receiver": receiver, "onEscrow": on_escrow,
        "token": st.fx.token.as_ref().map(|(id, _)| id.clone()),
    }))
}

fn handle(state: &mut Option<State>, req: &J) -> J {
    let op = req.get("op").and_then(|o| o.as_str()).unwrap_or_default();
    let fail = |m: String| json!({ "ok": false, "code": "BAD_REQUEST", "message": m });
    if op == "init" {
        return match init(req) {
            Ok(s) => {
                let id = s.fx.trade_id();
                *state = Some(s);
                json!({ "ok": true, "tradeId": id })
            }
            Err(e) => fail(e),
        };
    }
    let Some(st) = state.as_mut() else { return fail("init first".into()) };
    match op {
        "build" => build(st, req).unwrap_or_else(fail),
        "apply" | "probe" => {
            let (Ok(method), Ok(pred)) = (text(req, "method"), text(req, "predecessor")) else {
                return fail("apply needs method and predecessor".into());
            };
            let Ok(deposit) = yocto(req, "deposit") else { return fail("deposit".into()) };
            let mut call = Call::by(&pred, num(req, "now").unwrap_or(0)).with_deposit(deposit);
            if let Some(ok) = req.get("promiseOk").and_then(|x| x.as_bool()) {
                call = call.settled(ok);
            }
            let args = req.get("args").unwrap_or(&J::Null);
            // A refused NEP-141 funding is a successful call that returns the amount; say why.
            let refusal = if method == "ft_on_transfer" { st.mirror.funding_refusal(args, call) } else { None };
            // A probe runs on a copy: the mirror keeps only what the chain accepted.
            let mut copy;
            let target = if op == "probe" {
                copy = st.mirror.clone();
                &mut copy
            } else {
                &mut st.mirror
            };
            match target.apply(&method, args, call) {
                Ok(v) => json!({ "ok": true, "value": v, "refusal": refusal.map(|e| json!({ "code": e.code, "message": e.message })) }),
                Err(e) => json!({ "ok": false, "code": e.code, "message": e.message }),
            }
        }
        "view" => {
            let Ok(method) = text(req, "method") else { return fail("view needs method".into()) };
            match st.mirror.view(&method, req.get("args").unwrap_or(&J::Null), num(req, "now").unwrap_or(0)) {
                Ok(v) => json!({ "ok": true, "value": v }),
                Err(e) => json!({ "ok": false, "code": e.code, "message": e.message }),
            }
        }
        other => fail(format!("unknown op {other}")),
    }
}

fn main() {
    let mut state = None;
    let stdin = std::io::stdin();
    let mut out = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let resp = match serde_json::from_str::<J>(&line) {
            Ok(req) => handle(&mut state, &req),
            Err(e) => json!({ "ok": false, "code": "BAD_REQUEST", "message": e.to_string() }),
        };
        if writeln!(out, "{resp}").and_then(|_| out.flush()).is_err() {
            break;
        }
    }
}
