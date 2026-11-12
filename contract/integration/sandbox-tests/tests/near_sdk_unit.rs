//! near-sdk `unit-testing` host tests of the contract wrapper (`contract/crates/dockside-escrow`).
//!
//! These call the `#[near]` methods themselves under near-sdk's mocked blockchain (near-vm-logic
//! host functions, mocked storage and receipts), so they cover what the core's host tests cannot:
//! the initialiser, attached deposits, block time, the promises the contract schedules for a
//! release and their settlement, and the NEP-141 receiver. Every result is compared with the same
//! call replayed on the host mirror.
//!
//! The `#[payable]` and `#[private]` guards live in the generated wasm exports, not in the Rust
//! methods these tests call, so they are tested on the sandbox node instead (sandbox_escrow.rs).

use dockside_escrow::Escrow;
use dockside_fixtures::mirror::{Call, Mirror};
use dockside_fixtures::payloads::*;
use dockside_fixtures::{Accounts, Fixture, HOUR, J, NEAR};
use near_sdk::json_types::U128;
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, AccountId, NearToken, PromiseResult, RuntimeFeesConfig};
use serde_json::json;

const CONTRACT: &str = "dockside-escrow.testnet";
const BUYER: &str = "acme-buyer.testnet";
const SUPPLIER: &str = "harbor-supplier.testnet";
const TREASURY: &str = "treasury-acme.testnet";
const RELAYER: &str = "relayer.testnet";
const T0: u64 = 1_800_000_000_000;

fn id(s: &str) -> AccountId {
    s.parse().expect("account id")
}

/// Point the mocked chain at a new receipt: caller, block time (ms) and attached deposit.
fn at(predecessor: &str, now_ms: u64, deposit: u128) {
    at_with(predecessor, now_ms, deposit, vec![]);
}

fn at_with(predecessor: &str, now_ms: u64, deposit: u128, promise_results: Vec<PromiseResult>) {
    let ctx = VMContextBuilder::new()
        .current_account_id(id(CONTRACT))
        .predecessor_account_id(id(predecessor))
        .signer_account_id(id(predecessor))
        .block_timestamp(now_ms * 1_000_000)
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .account_balance(NearToken::from_near(1_000))
        .build();
    testing_env!(ctx, near_sdk::test_vm_config(), RuntimeFeesConfig::test(), Default::default(), promise_results);
}

fn fixture() -> Fixture {
    let accounts = Accounts {
        contract: CONTRACT.into(),
        buyer: BUYER.into(),
        supplier: SUPPLIER.into(),
        treasury: TREASURY.into(),
        alt_destination: "harbor-payouts.testnet".into(),
    };
    Fixture::new(accounts, "near-sdk-unit", "trade-1", 5 * NEAR, HOUR, T0)
}

fn s(v: &J, k: &str) -> String {
    v[k].as_str().expect(k).to_string()
}

/// A registered trade with its policy, funded 3 NEAR (buyer) + 3 NEAR (treasury, 1 NEAR excess).
fn funded() -> (Escrow, Mirror, Fixture) {
    let fx = fixture();
    let mut m = Mirror::new(CONTRACT, None);
    at(RELAYER, T0, 0);
    let mut c = Escrow::new("near-testnet".into(), None);
    let reg = register_args(&fx);
    let digest = c.register_trade(reg["terms"].clone(), s(&reg, "buyer_signature"), s(&reg, "supplier_signature"));
    assert_eq!(J::String(digest), m.apply("register_trade", &reg, Call::by(RELAYER, T0)).unwrap());
    let t = fx.trade_id();
    let p = policy_args(m.trade(&t));
    c.register_evidence_policy(t.clone(), p["policy"].clone());
    m.apply("register_evidence_policy", &p, Call::by(RELAYER, T0)).unwrap();
    for (who, amount, at_ms) in [(BUYER, 3 * NEAR, T0 + 1_000), (TREASURY, 3 * NEAR, T0 + 2_000)] {
        at(who, at_ms, amount);
        let out = c.fund(t.clone());
        assert_eq!(out, m.apply("fund", &fund_args(&t), Call::by(who, at_ms).with_deposit(amount)).unwrap());
    }
    assert_eq!(c.get_ledger(t.clone()), m.view("get_ledger", &json!({ "trade_id": t }), 0).unwrap());
    (c, m, fx)
}

#[test]
#[should_panic(expected = "DOCKSIDE:FUNDED_RAIL_BLOCKED")]
fn new_refuses_mainnet() {
    at(CONTRACT, T0, 0);
    let _ = Escrow::new("near-mainnet".into(), None);
}

#[test]
fn new_sets_the_testnet_corridor_and_minimum_deposit() {
    at(CONTRACT, T0, 0);
    let c = Escrow::new("near-testnet".into(), Some(U128(5)));
    assert_eq!(c.get_config(), Mirror::new(CONTRACT, Some(5)).view("get_config", &json!({}), 0).unwrap());
}

#[test]
fn funding_records_each_funder_and_quarantines_the_excess() {
    let (c, _m, fx) = funded();
    let l = c.get_ledger(fx.trade_id());
    assert_eq!(l["fullyFunded"], json!(true));
    assert_eq!(l["funders"][TREASURY]["quarantined"], json!(NEAR.to_string()));
    assert_eq!(l["funders"][BUYER]["available"], json!((3 * NEAR).to_string()));
    assert_eq!(l["deposits"][1]["atMs"], json!(T0 + 2_000), "deposit time is the block time");
    assert_eq!(l["conservation"], json!(true));
}

#[test]
#[should_panic(expected = "DOCKSIDE:INVALID_AMOUNT")]
fn a_deposit_below_the_minimum_is_refused() {
    let (mut c, _m, fx) = funded();
    at(BUYER, T0 + 3_000, 1);
    c.fund(fx.trade_id());
}

/// Attested, inspected, intent locked and approved; returns the release intent id.
fn approved(c: &mut Escrow, m: &mut Mirror, fx: &Fixture, now: u64) -> String {
    let t = fx.trade_id();
    let att = attestation_args(fx, m.trade(&t), 1, now, "m1");
    at(RELAYER, now, 0);
    c.submit_manifest_attestation(t.clone(), att["payload"].clone(), s(&att, "signature"));
    m.apply("submit_manifest_attestation", &att, Call::by(RELAYER, now)).unwrap();
    let ins = inspection_args(fx, m.trade(&t), "PASS", now, "m1");
    c.submit_inspection(t.clone(), ins["payload"].clone(), s(&ins, "signature"));
    m.apply("submit_inspection", &ins, Call::by(RELAYER, now)).unwrap();
    let i = intent_args(fx, m.trade(&t), now, "main");
    let r = c.create_release_intent(t.clone(), i["payload"].clone(), s(&i, "buyer_signature"));
    assert_eq!(r, m.apply("create_release_intent", &i, Call::by(RELAYER, now)).unwrap());
    let intent = s(&r, "releaseIntentId");
    let ap = approval_args(fx, m.trade(&t), &intent, now, "main");
    c.approve_release(t.clone(), ap["payload"].clone(), s(&ap, "signature"));
    m.apply("approve_release", &ap, Call::by(RELAYER, now)).unwrap();
    intent
}

#[test]
fn execute_release_schedules_the_exact_transfer_and_a_private_settlement() {
    let (mut c, mut m, fx) = funded();
    let now = T0 + 10_000;
    let intent = approved(&mut c, &mut m, &fx, now);
    let t = fx.trade_id();
    at(RELAYER, now + 1_000, 0);
    // Dropping the returned promise schedules its receipts, as returning it from the export does.
    drop(c.execute_release(t.clone(), intent.clone()));
    let scheduled = m.apply("execute_release", &execute_release_args(m.trade(&t), &intent), Call::by(RELAYER, now + 1_000)).unwrap();
    // The receipts the contract scheduled: the exact native transfer to the bound supplier, then
    // the settlement callback on the escrow itself.
    let receipts = get_created_receipts();
    let summary: Vec<(String, Vec<String>)> = receipts
        .iter()
        .map(|r| {
            let actions = r
                .actions
                .iter()
                .map(|a| match a {
                    MockAction::Transfer { deposit, .. } => format!("transfer {}", deposit.as_yoctonear()),
                    MockAction::FunctionCallWeight { method_name, attached_deposit, .. } => {
                        format!("call {} {}", String::from_utf8_lossy(method_name), attached_deposit.as_yoctonear())
                    }
                    _ => "other".to_string(),
                })
                .collect();
            (r.receiver_id.to_string(), actions)
        })
        .collect();
    assert_eq!(
        summary,
        vec![
            (SUPPLIER.to_string(), vec![format!("transfer {}", 5 * NEAR)]),
            (CONTRACT.to_string(), vec!["call on_release_transfer 0".to_string()]),
        ]
    );
    // The callback with a successful transfer settles PAID.
    let attempt = s(&scheduled, "attempt_id");
    at_with(CONTRACT, now + 2_000, 0, vec![PromiseResult::Successful(vec![])]);
    assert!(c.on_release_transfer(t.clone(), intent.clone(), attempt.clone()));
    let cb = json!({ "trade_id": t, "release_intent_id": intent, "attempt_id": attempt });
    m.apply("on_release_transfer", &cb, Call::by(CONTRACT, now + 2_000).settled(true)).unwrap();
    assert_eq!(c.get_ledger(t.clone()), m.view("get_ledger", &json!({ "trade_id": t }), 0).unwrap());
    assert!(c.get_release(t.clone()).to_string().contains("\"PAID\""));
}

#[test]
fn a_failed_release_transfer_settles_failed_and_restores_the_value() {
    let (mut c, mut m, fx) = funded();
    let now = T0 + 10_000;
    let intent = approved(&mut c, &mut m, &fx, now);
    let t = fx.trade_id();
    at(RELAYER, now + 1_000, 0);
    let _promise = c.execute_release(t.clone(), intent.clone());
    let scheduled = m.apply("execute_release", &execute_release_args(m.trade(&t), &intent), Call::by(RELAYER, now + 1_000)).unwrap();
    let attempt = s(&scheduled, "attempt_id");
    at_with(CONTRACT, now + 2_000, 0, vec![PromiseResult::Failed]);
    assert!(!c.on_release_transfer(t.clone(), intent.clone(), attempt.clone()));
    let cb = json!({ "trade_id": t, "release_intent_id": intent, "attempt_id": attempt });
    m.apply("on_release_transfer", &cb, Call::by(CONTRACT, now + 2_000).settled(false)).unwrap();
    let l = c.get_ledger(t.clone());
    assert_eq!(l, m.view("get_ledger", &json!({ "trade_id": t }), 0).unwrap());
    assert_eq!(l["totals"]["reserved"], json!("0"));
    assert_eq!(l["totals"]["available"], json!((5 * NEAR).to_string()));
    assert!(c.get_release(t).to_string().contains("\"FAILED\""));
}

#[test]
fn nep141_tokens_are_recorded_for_review_and_never_credited() {
    let (mut c, mut m, fx) = funded();
    let t = fx.trade_id();
    let before = c.get_ledger(t.clone());
    let ft_contract = "usdc-fake.testnet";
    at(ft_contract, T0 + 20_000, 0);
    let kept = c.ft_on_transfer(id("token-sender.testnet"), U128(5_000_000), "pay trade".into());
    assert_eq!(kept.0, 0, "the escrow keeps the tokens; nothing is refunded to the token");
    let args = json!({ "sender_id": "token-sender.testnet", "amount": "5000000", "msg": "pay trade" });
    m.apply("ft_on_transfer", &args, Call::by(ft_contract, T0 + 20_000)).unwrap();
    assert!(get_logs().iter().any(|l| l.starts_with("EVENT_JSON:")), "{:?}", get_logs());
    assert_eq!(c.get_unexpected_asset(0), m.view("get_unexpected_asset", &json!({ "asset_index": 0 }), 0).unwrap());
    assert_eq!(c.get_ledger(t), before, "native ledger unchanged");
    assert_eq!(c.get_unexpected_assets(None, None).len(), 1);
}
