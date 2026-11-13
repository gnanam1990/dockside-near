//! M47 refusal journey on the host mirror: the payloads `run-all --journey refusal` sends, replayed
//! on the same `dockside-escrow-core` code the contract runs. Six calls must be refused, each with
//! its exact code and without changing any record, and the trade must then complete normally.
//! The same journey runs with real transactions on a near-sandbox node in
//! `sandbox-tests/tests/run_all_on_sandbox.rs`.

use dockside_fixtures::mirror::{Call, Mirror};
use dockside_fixtures::payloads::*;
use dockside_fixtures::{Accounts, Fixture, HOUR, J, MILLINEAR};
use serde_json::json;

const ESCROW: &str = "escrow.testnet";
const BUYER: &str = "buyer.testnet";
const SUPPLIER: &str = "supplier.testnet";
const RELAYER: &str = "relayer.testnet";
const T0: u64 = 1_800_000_000_000;
const AMOUNT: u128 = 50 * MILLINEAR;

struct World {
    fx: Fixture,
    m: Mirror,
    now: u64,
}

impl World {
    fn new() -> World {
        let accounts = Accounts {
            contract: ESCROW.into(),
            buyer: BUYER.into(),
            supplier: SUPPLIER.into(),
            treasury: BUYER.into(),
            alt_destination: SUPPLIER.into(),
        };
        let fx = Fixture::new(accounts, &"5a".repeat(32), "m47", AMOUNT, HOUR, T0);
        World { fx, m: Mirror::new(ESCROW, None), now: T0 }
    }

    fn rec(&self) -> &dockside_escrow_core::TradeRecord {
        self.m.trade(&self.fx.trade_id())
    }

    fn tick(&mut self) -> u64 {
        self.now += 1_500;
        self.now
    }

    fn views(&self) -> J {
        let a = json!({ "trade_id": self.fx.trade_id() });
        json!(["get_trade", "get_ledger", "get_refunds", "get_evidence", "get_holds", "get_release"]
            .iter()
            .map(|v| self.m.view(v, &a, self.now).expect("view"))
            .collect::<Vec<J>>())
    }

    fn ok(&mut self, by: &str, method: &str, args: J, deposit: u128) -> J {
        let now = self.tick();
        self.m.apply(method, &args, Call::by(by, now).with_deposit(deposit)).unwrap_or_else(|e| panic!("{method}: {e}"))
    }

    /// The call must fail with exactly `code` and leave every view as it was.
    fn refused(&mut self, by: &str, method: &str, args: J, deposit: u128, code: &str) -> String {
        let now = self.tick();
        let before = self.views();
        let e = self.m.apply(method, &args, Call::by(by, now).with_deposit(deposit)).expect_err(method);
        assert_eq!(e.code, code, "{method}: {}", e.message);
        assert_eq!(self.views(), before, "{method} refused with {code} must change nothing");
        e.message
    }
}

#[test]
fn six_refusals_change_nothing_and_the_trade_is_then_paid() {
    let mut w = World::new();
    let t = w.fx.trade_id();
    let (first, rest) = (AMOUNT / 2, AMOUNT - AMOUNT / 2);

    w.ok(RELAYER, "register_trade", register_args(&w.fx), 0);
    let a = policy_args(w.rec());
    w.ok(RELAYER, "register_evidence_policy", a, 0);

    // 1. Funding that names other terms (the same trade paying out to another account).
    let other = redirected_terms_digest(&w.fx, RELAYER);
    assert_ne!(other, w.rec().terms_digest);
    w.refused(BUYER, "fund", fund_args(&t, &other), first, "STALE_REVISION");
    assert_eq!(w.rec().ledger.funder(BUYER).partial, 0);

    let a = fund_args(&t, &w.rec().terms_digest);
    w.ok(BUYER, "fund", a.clone(), first);
    assert_eq!(w.rec().ledger.funder(BUYER).partial, first);

    // 2. The return of partial funding belongs to the original funder's own account. The request
    //    is the one the funder could send; only the caller differs.
    let now = w.now;
    let p = partial_return_request(&w.fx, w.rec(), "refused", BUYER, now);
    let req = request_refund_args(&w.fx, w.rec(), &p, &[]);
    w.refused(RELAYER, "request_refund", req.clone(), 0, "FORBIDDEN");
    assert!(w.rec().refunds.is_empty());

    w.ok(BUYER, "fund", a, rest);
    assert!(w.rec().ledger.fully_funded());

    let now = w.now;
    let att = attestation_args(&w.fx, w.rec(), next_manifest_revision(w.rec()), now, "j");
    w.ok(RELAYER, "submit_manifest_attestation", att, 0);
    let now = w.now;
    let ins = inspection_args(&w.fx, w.rec(), "PASS", now, "j");
    w.ok(RELAYER, "submit_inspection", ins.clone(), 0);

    // 3. The accepted inspection, byte for byte, a second time.
    w.refused(RELAYER, "submit_inspection", ins, 0, "NONCE_REPLAYED");

    let now = w.now;
    let hold = hold_set_args(&w.fx, w.rec(), "POLICY_SETTER", now, 7 * 24 * HOUR, "h1");
    w.ok(RELAYER, "set_hold", hold, 0);

    // 4. A release intent, signed by the bound buyer key, that pays another account.
    let now = w.now;
    let redirect = intent_args_to(&w.fx, w.rec(), now, "redirect", RELAYER);
    w.refused(RELAYER, "create_release_intent", redirect, 0, "DESTINATION_MISMATCH");
    assert!(w.rec().release.intents.is_empty());

    let now = w.now;
    let intent = intent_args(&w.fx, w.rec(), now, "j");
    let made = w.ok(RELAYER, "create_release_intent", intent, 0);
    let intent_id = made["releaseIntentId"].as_str().expect("intent id").to_string();

    // 5. Release while the hold is ACTIVE.
    let exec = execute_release_args(w.rec(), &intent_id);
    let msg = w.refused(RELAYER, "execute_release", exec.clone(), 0, "HOLD_ACTIVE");
    assert!(msg.contains("HOLD_ACTIVE"), "{msg}");

    let now = w.now;
    let resolve = hold_resolve_args(&w.fx, w.rec(), "h1", "RELEASE_HOLD", now);
    w.ok(RELAYER, "resolve_hold", resolve, 0);

    // 6. The approval the buyer would sign, signed by a key the terms do not bind.
    let now = w.now;
    let forged = approval_args_signed_by(&w.fx, w.rec(), &intent_id, now, "unbound", "intruder");
    assert_ne!(w.fx.pk("intruder"), w.fx.pk("buyer"));
    w.refused(RELAYER, "approve_release", forged, 0, "SIGNATURE_INVALID");

    let now = w.now;
    let approval = approval_args(&w.fx, w.rec(), &intent_id, now, "j");
    w.ok(RELAYER, "approve_release", approval, 0);
    let out = w.ok(RELAYER, "execute_release", exec, 0);
    assert_eq!(out["transfer"], json!({ "to": SUPPLIER, "amount": AMOUNT.to_string() }));
    let now = w.tick();
    let settle = json!({ "trade_id": t, "release_intent_id": intent_id, "attempt_id": out["attempt_id"] });
    assert_eq!(w.m.apply("on_release_transfer", &settle, Call::by(ESCROW, now).settled(true)).expect("settle"), json!(true));

    let ledger = w.m.view("get_ledger", &json!({ "trade_id": t }), w.now).expect("ledger");
    assert_eq!(ledger["totals"]["released"], json!(AMOUNT.to_string()));
    assert_eq!(ledger["conservation"], json!(true));
    assert!(w.m.view("get_release", &json!({ "trade_id": t }), w.now).expect("release").to_string().contains("\"PAID\""));
}

/// The refused funder-only request is refused for its caller alone: the same request from the
/// funder's own account is accepted.
#[test]
fn the_refused_partial_return_is_valid_from_the_funder() {
    let mut w = World::new();
    let t = w.fx.trade_id();
    w.ok(RELAYER, "register_trade", register_args(&w.fx), 0);
    let a = fund_args(&t, &w.rec().terms_digest);
    w.ok(BUYER, "fund", a, AMOUNT / 2);
    let now = w.now;
    let p = partial_return_request(&w.fx, w.rec(), "refused", BUYER, now);
    let req = request_refund_args(&w.fx, w.rec(), &p, &[]);
    w.refused(RELAYER, "request_refund", req.clone(), 0, "FORBIDDEN");
    w.refused(SUPPLIER, "request_refund", req.clone(), 0, "FORBIDDEN");
    w.ok(BUYER, "request_refund", req, 0);
    assert_eq!(w.rec().refunds.len(), 1);
}
