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

use dockside_escrow::{Escrow, MaxTradeAmount, TokenConfig};
use dockside_fixtures::mirror::{Call, Mirror};
use dockside_fixtures::payloads::*;
use dockside_fixtures::{Accounts, Fixture, HOUR, J, NEAR, USDC};
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
    let mut c = Escrow::new("near-testnet".into(), None, None, None, None);
    let reg = register_args(&fx);
    let digest = c.register_trade(reg["terms"].clone(), s(&reg, "buyer_signature"), s(&reg, "supplier_signature"));
    assert_eq!(J::String(digest.clone()), m.apply("register_trade", &reg, Call::by(RELAYER, T0)).unwrap());
    let t = fx.trade_id();
    let p = policy_args(m.trade(&t));
    c.register_evidence_policy(t.clone(), p["policy"].clone());
    m.apply("register_evidence_policy", &p, Call::by(RELAYER, T0)).unwrap();
    for (who, amount, at_ms) in [(BUYER, 3 * NEAR, T0 + 1_000), (TREASURY, 3 * NEAR, T0 + 2_000)] {
        at(who, at_ms, amount);
        let out = c.fund(t.clone(), digest.clone());
        assert_eq!(out, m.apply("fund", &fund_args(&t, &digest), Call::by(who, at_ms).with_deposit(amount)).unwrap());
    }
    assert_eq!(c.get_ledger(t.clone()), m.view("get_ledger", &json!({ "trade_id": t }), 0).unwrap());
    (c, m, fx)
}

#[test]
#[should_panic(expected = "DOCKSIDE:FUNDED_RAIL_BLOCKED")]
fn new_refuses_an_unknown_network() {
    at(CONTRACT, T0, 0);
    let _ = Escrow::new("near-betanet".into(), None, None, None, None);
}

#[test]
#[should_panic(expected = "DOCKSIDE:CAP_REQUIRED")]
fn new_refuses_mainnet_with_a_zero_cap() {
    at(CONTRACT, T0, 0);
    let _ = Escrow::new("near-mainnet".into(), None, Some(MaxTradeAmount { near_yocto: U128(NEAR), nep141: U128(0) }), None, None);
}

#[test]
#[should_panic(expected = "DOCKSIDE:INVALID_AMOUNT")]
fn new_refuses_a_zero_minimum_token_deposit() {
    at(CONTRACT, T0, 0);
    let _ = Escrow::new("near-testnet".into(), None, None, None, Some(U128(0)));
}

#[test]
fn new_accepts_mainnet_with_default_caps_and_a_pinned_token() {
    at(CONTRACT, T0, 0);
    let usdc = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
    let c = Escrow::new("near-mainnet".into(), None, None, Some(TokenConfig { account_id: id(usdc), decimals: 6 }), None);
    let cfg = c.get_config();
    assert_eq!(cfg["network"], json!("near-mainnet"));
    assert_eq!(cfg["maxTradeAmount"], json!({ "nearYocto": (5 * NEAR).to_string(), "nep141": (25 * USDC).to_string() }));
    assert_eq!(cfg["nep141Token"], json!({ "accountId": usdc, "decimals": 6 }));
    assert_eq!(cfg["minDepositNep141"], json!("10000"));
}

#[test]
fn new_sets_the_testnet_corridor_and_minimum_deposit() {
    at(CONTRACT, T0, 0);
    let c = Escrow::new("near-testnet".into(), Some(U128(5)), None, None, None);
    assert_eq!(c.get_config(), Mirror::new(CONTRACT, Some(5)).view("get_config", &json!({}), 0).unwrap());
    assert_eq!(c.get_config()["maxTradeAmount"], json!({ "nearYocto": "0", "nep141": "0" }));
    assert_eq!(c.get_config()["nep141Token"], J::Null);
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
    let (mut c, m, fx) = funded();
    at(BUYER, T0 + 3_000, 1);
    c.fund(fx.trade_id(), m.trade(&fx.trade_id()).terms_digest.clone());
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

/* ------------------------------ M50: the NEP-141 rail ------------------------------ */

const TOKEN: &str = "usdc.testnet";

/// The receipts the contract scheduled: receiver, then (method, attached yoctoNEAR, JSON args).
fn summary() -> Vec<(String, Vec<(String, u128, J)>)> {
    get_created_receipts()
        .iter()
        .map(|r| {
            let actions = r
                .actions
                .iter()
                .map(|a| match a {
                    MockAction::Transfer { deposit, .. } => ("transfer".to_string(), deposit.as_yoctonear(), J::Null),
                    MockAction::FunctionCallWeight { method_name, attached_deposit, args, .. } => (
                        String::from_utf8_lossy(method_name).to_string(),
                        attached_deposit.as_yoctonear(),
                        serde_json::from_slice(args).expect("json args"),
                    ),
                    _ => ("other".to_string(), 0, J::Null),
                })
                .collect();
            (r.receiver_id.to_string(), actions)
        })
        .collect()
}

/// A registered 5 USDC trade with its policy on a contract capped at 6 USDC per trade.
fn token_trade() -> (Escrow, Mirror, Fixture) {
    let fx = fixture().with_trade("usdc-1", 5 * USDC).with_token(TOKEN, 6);
    let limits = dockside_escrow_core::Limits::configure("near-testnet", Some(5 * NEAR), Some(6 * USDC), Some((TOKEN.into(), 6))).unwrap();
    let mut m = Mirror::configured(CONTRACT, "near-testnet", None, None, limits);
    at(RELAYER, T0, 0);
    let mut c = Escrow::new(
        "near-testnet".into(),
        None,
        Some(MaxTradeAmount { near_yocto: U128(5 * NEAR), nep141: U128(6 * USDC) }),
        Some(TokenConfig { account_id: id(TOKEN), decimals: 6 }),
        None,
    );
    assert_eq!(c.get_config(), m.view("get_config", &json!({}), 0).unwrap());
    let reg = register_args(&fx);
    let digest = c.register_trade(reg["terms"].clone(), s(&reg, "buyer_signature"), s(&reg, "supplier_signature"));
    assert_eq!(J::String(digest), m.apply("register_trade", &reg, Call::by(RELAYER, T0)).unwrap());
    let t = fx.trade_id();
    let p = policy_args(m.trade(&t));
    c.register_evidence_policy(t.clone(), p["policy"].clone());
    m.apply("register_evidence_policy", &p, Call::by(RELAYER, T0)).unwrap();
    (c, m, fx)
}

/// `ft_on_transfer` from `token`, on the contract and on the mirror; both must return the same.
fn deliver(c: &mut Escrow, m: &mut Mirror, token: &str, sender: &str, amount: u128, msg: &str, now: u64) -> u128 {
    at(token, now, 0);
    let returned = c.ft_on_transfer(id(sender), U128(amount), msg.to_string());
    let args = json!({ "sender_id": sender, "amount": amount.to_string(), "msg": msg });
    let mirrored = m.apply("ft_on_transfer", &args, Call::by(token, now)).unwrap();
    assert_eq!(J::String(returned.0.to_string()), mirrored, "{msg}");
    returned.0
}

#[test]
fn ft_on_transfer_funds_the_named_trade_and_returns_every_refused_amount() {
    let (mut c, mut m, fx) = token_trade();
    let t = fx.trade_id();
    let digest = m.trade(&t).terms_digest.clone();
    let good = funding_msg(&t, &digest);
    let empty = c.get_ledger(t.clone());
    let refused = |code: &str| get_logs().iter().any(|l| l.contains("nep141_funding_returned") && l.contains(&format!("\"code\":\"{code}\"")));

    // Wrong token contract, an account calling the receiver directly, wrong digest, unknown
    // trade, a malformed funding message, dust, and an amount over the cap: all returned whole.
    assert_eq!(deliver(&mut c, &mut m, "other-token.testnet", BUYER, 5 * USDC, &good, T0 + 1_000), 5 * USDC);
    assert!(refused("ASSET_MISMATCH"), "{:?}", get_logs());
    assert_eq!(deliver(&mut c, &mut m, BUYER, BUYER, 5 * USDC, &good, T0 + 1_100), 5 * USDC);
    assert!(refused("ASSET_MISMATCH"));
    assert_eq!(deliver(&mut c, &mut m, TOKEN, BUYER, 5 * USDC, &funding_msg(&t, &"00".repeat(32)), T0 + 1_200), 5 * USDC);
    assert!(refused("STALE_REVISION"));
    assert_eq!(deliver(&mut c, &mut m, TOKEN, BUYER, 5 * USDC, &funding_msg("trd_00000000000000000000000000000000", &digest), T0 + 1_300), 5 * USDC);
    assert!(refused("NOT_FOUND"));
    assert_eq!(deliver(&mut c, &mut m, TOKEN, BUYER, 5 * USDC, &format!("{{\"tradeId\":\"{t}\"}}"), T0 + 1_400), 5 * USDC);
    assert!(refused("VALIDATION_FAILED"));
    assert_eq!(deliver(&mut c, &mut m, TOKEN, BUYER, 9_999, &good, T0 + 1_500), 9_999);
    assert!(refused("INVALID_AMOUNT"));
    assert_eq!(deliver(&mut c, &mut m, TOKEN, BUYER, 6 * USDC + 1, &good, T0 + 1_600), 6 * USDC + 1);
    assert!(refused("CAP_EXCEEDED"));
    assert_eq!(c.get_ledger(t.clone()), empty, "a returned deposit leaves the ledger untouched");
    assert_eq!(c.get_unexpected_assets(None, None).len(), 0, "and records no unexpected asset");

    // The named token funds the trade for the sender it reports: nothing is returned.
    assert_eq!(deliver(&mut c, &mut m, TOKEN, BUYER, 3 * USDC, &good, T0 + 2_000), 0);
    assert!(get_logs().iter().any(|l| l.contains("nep141_funding_accepted")), "{:?}", get_logs());
    assert_eq!(deliver(&mut c, &mut m, TOKEN, TREASURY, 3 * USDC, &good, T0 + 3_000), 0);
    let l = c.get_ledger(t.clone());
    assert_eq!(l, m.view("get_ledger", &json!({ "trade_id": t }), 0).unwrap());
    assert_eq!(l["asset"], json!({ "kind": "NEP141", "network": "near-testnet", "tokenAccountId": TOKEN, "decimals": 6 }));
    assert_eq!(l["fullyFunded"], json!(true));
    assert_eq!(l["funders"][BUYER]["available"], json!((3 * USDC).to_string()));
    assert_eq!(l["funders"][TREASURY]["quarantined"], json!(USDC.to_string()));
    // 6 USDC held is the cap: the next unit comes back.
    assert_eq!(deliver(&mut c, &mut m, TOKEN, BUYER, 10_000, &good, T0 + 4_000), 10_000);
    assert!(refused("CAP_EXCEEDED"));

    // The same token without a funding message is an unexpected asset: kept, recorded, never credited.
    assert_eq!(deliver(&mut c, &mut m, TOKEN, BUYER, USDC, "invoice 7", T0 + 5_000), 0);
    assert_eq!(c.get_unexpected_asset(0), m.view("get_unexpected_asset", &json!({ "asset_index": 0 }), 0).unwrap());
    assert_eq!(c.get_ledger(t), l);
}

#[test]
#[should_panic(expected = "DOCKSIDE:ASSET_MISMATCH")]
fn native_near_cannot_fund_a_token_trade() {
    let (mut c, m, fx) = token_trade();
    at(BUYER, T0 + 1_000, NEAR);
    c.fund(fx.trade_id(), m.trade(&fx.trade_id()).terms_digest.clone());
}

#[test]
#[should_panic(expected = "DOCKSIDE:CAP_EXCEEDED")]
fn a_trade_above_the_cap_does_not_register() {
    let (mut c, _m, fx) = token_trade();
    let big = fx.with_trade("usdc-big", 6 * USDC + 1);
    let reg = register_args(&big);
    c.register_trade(reg["terms"].clone(), s(&reg, "buyer_signature"), s(&reg, "supplier_signature"));
}

#[test]
#[should_panic(expected = "DOCKSIDE:UNSUPPORTED_ASSET")]
fn a_trade_naming_another_token_than_the_pinned_one_does_not_register() {
    let (mut c, _m, fx) = token_trade();
    let other = fx.with_trade("usdc-other", USDC).with_token("other-token.testnet", 6);
    let reg = register_args(&other);
    c.register_trade(reg["terms"].clone(), s(&reg, "buyer_signature"), s(&reg, "supplier_signature"));
}

#[test]
fn a_token_release_checks_the_payee_then_schedules_ft_transfer_with_one_yocto() {
    let (mut c, mut m, fx) = token_trade();
    let t = fx.trade_id();
    let good = funding_msg(&t, &m.trade(&t).terms_digest);
    deliver(&mut c, &mut m, TOKEN, BUYER, 5 * USDC, &good, T0 + 1_000);
    let now = T0 + 10_000;

    // The payee check asks the trade's token about the bound destination and nothing else.
    at(RELAYER, now, 0);
    drop(c.check_payee_storage(t.clone(), id(SUPPLIER)));
    assert_eq!(
        summary(),
        vec![
            (TOKEN.to_string(), vec![("storage_balance_of".to_string(), 0, json!({ "account_id": SUPPLIER }))]),
            (CONTRACT.to_string(), vec![("on_payee_storage".to_string(), 0, json!({ "trade_id": t, "account_id": SUPPLIER }))]),
        ]
    );
    let check = json!({ "trade_id": t, "account_id": SUPPLIER });
    m.apply("check_payee_storage", &check, Call::by(RELAYER, now)).unwrap();
    // `null` (not registered) and a failed view both leave the payee unconfirmed.
    for result in [PromiseResult::Successful(b"null".to_vec()), PromiseResult::Failed] {
        at_with(CONTRACT, now + 100, 0, vec![result]);
        assert!(!c.on_payee_storage(t.clone(), id(SUPPLIER)));
    }
    m.apply("on_payee_storage", &check, Call::by(CONTRACT, now + 100).settled(false)).unwrap();
    assert_eq!(c.get_trade(t.clone())["payeeStorage"], json!([]));
    at_with(CONTRACT, now + 200, 0, vec![PromiseResult::Successful(br#"{"total":"1250000000000000000000","available":"0"}"#.to_vec())]);
    assert!(c.on_payee_storage(t.clone(), id(SUPPLIER)));
    m.apply("on_payee_storage", &check, Call::by(CONTRACT, now + 200).settled(true)).unwrap();
    assert_eq!(c.get_trade(t.clone())["payeeStorage"], json!([SUPPLIER]));

    let intent = approved(&mut c, &mut m, &fx, now + 1_000);
    at(RELAYER, now + 2_000, 0);
    drop(c.execute_release(t.clone(), intent.clone()));
    let scheduled = m.apply("execute_release", &execute_release_args(m.trade(&t), &intent), Call::by(RELAYER, now + 2_000)).unwrap();
    assert_eq!(scheduled["transfer"], json!({ "to": SUPPLIER, "amount": (5 * USDC).to_string(), "token": TOKEN }));
    let attempt = s(&scheduled, "attempt_id");
    // One `ft_transfer` of the exact amount on the trade's token with one yoctoNEAR, no native
    // transfer, then the private settlement.
    let memo = format!("dockside release {intent}");
    assert_eq!(
        summary(),
        vec![
            (TOKEN.to_string(), vec![("ft_transfer".to_string(), 1, json!({ "receiver_id": SUPPLIER, "amount": "5000000", "memo": memo }))]),
            (
                CONTRACT.to_string(),
                vec![("on_release_transfer".to_string(), 0, json!({ "trade_id": t, "release_intent_id": intent, "attempt_id": attempt }))]
            ),
        ]
    );
    at_with(CONTRACT, now + 3_000, 0, vec![PromiseResult::Successful(vec![])]);
    assert!(c.on_release_transfer(t.clone(), intent.clone(), attempt.clone()));
    let cb = json!({ "trade_id": t, "release_intent_id": intent, "attempt_id": attempt });
    m.apply("on_release_transfer", &cb, Call::by(CONTRACT, now + 3_000).settled(true)).unwrap();
    let l = c.get_ledger(t.clone());
    assert_eq!(l, m.view("get_ledger", &json!({ "trade_id": t }), 0).unwrap());
    assert_eq!(l["totals"]["released"], json!((5 * USDC).to_string()));
}

#[test]
#[should_panic(expected = "DOCKSIDE:PAYEE_NOT_REGISTERED")]
fn a_token_release_intent_is_refused_until_the_payee_is_confirmed() {
    let (mut c, mut m, fx) = token_trade();
    let t = fx.trade_id();
    let good = funding_msg(&t, &m.trade(&t).terms_digest);
    deliver(&mut c, &mut m, TOKEN, BUYER, 5 * USDC, &good, T0 + 1_000);
    let now = T0 + 10_000;
    let att = attestation_args(&fx, m.trade(&t), 1, now, "m1");
    at(RELAYER, now, 0);
    c.submit_manifest_attestation(t.clone(), att["payload"].clone(), s(&att, "signature"));
    m.apply("submit_manifest_attestation", &att, Call::by(RELAYER, now)).unwrap();
    let ins = inspection_args(&fx, m.trade(&t), "PASS", now, "m1");
    c.submit_inspection(t.clone(), ins["payload"].clone(), s(&ins, "signature"));
    m.apply("submit_inspection", &ins, Call::by(RELAYER, now)).unwrap();
    // Build the intent as if the payee were confirmed; the contract has no such record.
    let mut probe = m.clone();
    probe.trades.get_mut(&t).unwrap().payee_storage.insert(SUPPLIER.into());
    let i = intent_args(&fx, probe.trade(&t), now, "main");
    c.create_release_intent(t, i["payload"].clone(), s(&i, "buyer_signature"));
}

#[test]
#[should_panic(expected = "DOCKSIDE:DESTINATION_MISMATCH")]
fn the_payee_check_cannot_be_pointed_at_another_account() {
    let (mut c, _m, fx) = token_trade();
    at(RELAYER, T0 + 1_000, 0);
    drop(c.check_payee_storage(fx.trade_id(), id("attacker.testnet")));
}

#[test]
fn a_failed_token_refund_restores_the_exact_bucket() {
    let (mut c, mut m, fx) = token_trade();
    let t = fx.trade_id();
    let good = funding_msg(&t, &m.trade(&t).terms_digest);
    deliver(&mut c, &mut m, TOKEN, BUYER, 6 * USDC, &good, T0 + 1_000);
    let now = T0 + 2_000;
    let req = refund_request(&fx, m.trade(&t), "excess", "EXCESS_FUNDING_RETURN", BUYER, USDC, "QUARANTINED", "FUNDER", now);
    let args = request_refund_args(&fx, m.trade(&t), &req, &[]);
    at(BUYER, now, 0);
    c.request_refund(t.clone(), args["payload"].clone(), None, None, None);
    m.apply("request_refund", &args, Call::by(BUYER, now)).unwrap();
    let rid = refund_id(&fx, "excess");
    let later = now + 2 * HOUR;
    let op = refund_op_args(m.trade(&t), &rid);
    at(RELAYER, later, 0);
    c.authorize_refund(t.clone(), rid.clone());
    m.apply("authorize_refund", &op, Call::by(RELAYER, later)).unwrap();
    drop(c.execute_refund(t.clone(), rid.clone()));
    let scheduled = m.apply("execute_refund", &op, Call::by(RELAYER, later)).unwrap();
    assert_eq!(scheduled["transfer"], json!({ "to": BUYER, "amount": USDC.to_string(), "token": TOKEN }));
    let memo = format!("dockside refund {rid}");
    assert_eq!(
        summary()[0],
        (TOKEN.to_string(), vec![("ft_transfer".to_string(), 1, json!({ "receiver_id": BUYER, "amount": "1000000", "memo": memo }))])
    );
    at_with(CONTRACT, later + 1_000, 0, vec![PromiseResult::Failed]);
    assert!(!c.on_refund_transfer(t.clone(), rid.clone()));
    m.apply("on_refund_transfer", &op, Call::by(CONTRACT, later + 1_000).settled(false)).unwrap();
    let l = c.get_ledger(t.clone());
    assert_eq!(l, m.view("get_ledger", &json!({ "trade_id": t }), 0).unwrap());
    assert_eq!(l["funders"][BUYER]["quarantined"], json!(USDC.to_string()));
    assert_eq!(l["funders"][BUYER]["refunded"], json!("0"));
    assert_eq!(c.get_refunds(t)[0]["state"], json!("FAILED"));
}
