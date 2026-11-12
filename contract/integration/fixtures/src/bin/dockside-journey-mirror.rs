//! Payload builder and host mirror for `scripts/testnet-deploy/journey.mjs`.
//!
//! One JSON request per stdin line, one JSON response per stdout line. The journey driver owns
//! the network side (RPC, near-cli-rs, block times); this process owns the Dockside payloads and
//! signs them with keys derived from the run's seed. It never sees a NEAR account key.
//!
//! Requests:
//!   {"op":"init","accounts":{...},"seed":"<hex>","trade":"<label>","amountYocto":"<u128>","delayMs":<u64>,"t0":<ms>}
//!   {"op":"build","what":"register|policy|fund|attestation|inspection|intent|approval|execute_release","now":<ms>,"label":"<n>","intentId":"<rli_>"}
//!   {"op":"apply","method":"<m>","args":{...},"now":<ms>,"predecessor":"<acct>","deposit":"<u128>","promiseOk":<bool|null>}
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
    let fx = Fixture::new(accounts, &seed, &text(req, "trade")?, yocto(req, "amountYocto")?, num(req, "delayMs")?, num(req, "t0")?);
    let mirror = Mirror::new(&fx.accounts.contract, match req.get("minDepositYocto") {
        Some(J::String(s)) => Some(s.parse().map_err(|_| "minDepositYocto")?),
        _ => None,
    });
    Ok(State { fx, mirror })
}

fn build(st: &State, req: &J) -> Result<J, String> {
    let what = text(req, "what")?;
    let now = num(req, "now").unwrap_or(st.fx.t0);
    let label = text(req, "label").unwrap_or_else(|_| "j".into());
    let t = st.fx.trade_id();
    let rec = || st.mirror.trades.get(&t).ok_or_else(|| "trade not registered on the mirror".to_string());
    let (method, args, deposit) = match what.as_str() {
        "register" => ("register_trade", register_args(&st.fx), 0),
        "policy" => ("register_evidence_policy", policy_args(rec()?), 0),
        "fund" => ("fund", fund_args(&t), st.fx.amount_yocto),
        "attestation" => ("submit_manifest_attestation", attestation_args(&st.fx, rec()?, next_manifest_revision(rec()?), now, &label), 0),
        "inspection" => ("submit_inspection", inspection_args(&st.fx, rec()?, "PASS", now, &label), 0),
        "intent" => ("create_release_intent", intent_args(&st.fx, rec()?, now, &label), 0),
        "approval" => ("approve_release", approval_args(&st.fx, rec()?, &text(req, "intentId")?, now, &label), 0),
        "execute_release" => ("execute_release", execute_release_args(rec()?, &text(req, "intentId")?), 0),
        other => return Err(format!("unknown payload {other}")),
    };
    Ok(json!({ "ok": true, "method": method, "args": args, "deposit": deposit.to_string(), "tradeId": t }))
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
        "apply" => {
            let (Ok(method), Ok(pred)) = (text(req, "method"), text(req, "predecessor")) else {
                return fail("apply needs method and predecessor".into());
            };
            let Ok(deposit) = yocto(req, "deposit") else { return fail("deposit".into()) };
            let mut call = Call::by(&pred, num(req, "now").unwrap_or(0)).with_deposit(deposit);
            if let Some(ok) = req.get("promiseOk").and_then(|x| x.as_bool()) {
                call = call.settled(ok);
            }
            match st.mirror.apply(&method, req.get("args").unwrap_or(&J::Null), call) {
                Ok(v) => json!({ "ok": true, "value": v }),
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
