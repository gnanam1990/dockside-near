//! M50: the NEP-141 rail and the network guard on a real local near-sandbox node.
//!
//! The trade asset is a real NEP-141 contract (`usdc.testnet`, the workspace's test token built
//! from near-contract-standards, 6 decimals). Every step is a real signed transaction: funding is
//! the funder's own `ft_transfer_call`, release and refund are the escrow's `ft_transfer` with a
//! private settlement callback, and the payee check is a cross-contract `storage_balance_of`.
//! After every step the harness compares the contract's views with the host mirror and checks
//! that the escrow's token balance is exactly what its ledgers and records say it holds.
//!
//! Covered: paid; hold then paid; mutual-cancel refund with the excess return; a failed transfer
//! rolled back exactly (release and refund); an unregistered payee; a wrong token; a wrong
//! digest; an unknown trade; a squatted trade id; the cap; replays; the unexpected-asset path for
//! the trade token itself; and the `near-mainnet` label (caps required, its own signed profile).

use anyhow::Result;
use dockside_fixtures::payloads::*;
use dockside_fixtures::{set, Fixture, HOUR, J, MAINNET};
use dockside_sandbox_tests::*;
use near_workspaces::types::NearToken;
use near_workspaces::Account;
use serde_json::json;

/// Register the trade and its evidence policy.
async fn registered(d: &mut Dock) -> Result<()> {
    let relayer = d.relayer.clone();
    let digest = d.ok(&relayer, "register_trade", register_args(&d.fx), 0).await?;
    assert_eq!(digest.value.as_str(), Some(d.rec().terms_digest.as_str()));
    let p = policy_args(d.rec());
    d.ok(&relayer, "register_evidence_policy", p, 0).await?;
    Ok(())
}

async fn attest_and_inspect(d: &mut Dock, label: &str) -> Result<()> {
    let relayer = d.relayer.clone();
    let att = attestation_args(&d.fx, d.rec(), next_manifest_revision(d.rec()), d.now().await?, label);
    d.ok(&relayer, "submit_manifest_attestation", att, 0).await?;
    let ins = inspection_args(&d.fx, d.rec(), "PASS", d.now().await?, label);
    d.ok(&relayer, "submit_inspection", ins, 0).await?;
    Ok(())
}

/// Registered, funded 3 + 2 USDC by the buyer and the treasury, attested and inspected.
async fn funded_and_inspected(d: &mut Dock) -> Result<()> {
    registered(d).await?;
    let (buyer, treasury) = (d.buyer.clone(), d.treasury.clone());
    let f = d.ft_fund(&buyer, 3 * USDC).await?;
    assert_eq!((f.returned, f.refusal.as_deref()), (0, None));
    assert_eq!(d.ft_fund(&treasury, 2 * USDC).await?.returned, 0);
    attest_and_inspect(d, "m1").await
}

/// `check_payee_storage` for the active destination; returns what the token answered.
async fn check_payee(d: &mut Dock) -> Result<bool> {
    let relayer = d.relayer.clone();
    let sent = d.ok(&relayer, "check_payee_storage", check_payee_args(d.rec()), 0).await?;
    Ok(sent.value["settled"] == json!(true))
}

async fn intent(d: &mut Dock, label: &str) -> Result<String> {
    let relayer = d.relayer.clone();
    let args = intent_args(&d.fx, d.rec(), d.now().await?, label);
    let r = d.ok(&relayer, "create_release_intent", args, 0).await?;
    Ok(r.value["releaseIntentId"].as_str().expect("intent id").to_string())
}

async fn approve(d: &mut Dock, intent: &str, label: &str) -> Result<J> {
    let relayer = d.relayer.clone();
    let ap = approval_args(&d.fx, d.rec(), intent, d.now().await?, label);
    d.ok(&relayer, "approve_release", ap.clone(), 0).await?;
    Ok(ap)
}

/// A second NEP-141 contract whose whole supply `owner` holds; the escrow is registered with it.
async fn other_token(d: &Dock, name: &str, owner: &Account) -> Result<Account> {
    let token = d.net.account(name, 20).await?;
    token.deploy(&token_wasm()?).await?.into_result()?;
    token
        .call(token.id(), "new")
        .args_json(json!({ "owner_id": owner.id(), "total_supply": (1_000 * USDC).to_string() }))
        .transact()
        .await?
        .into_result()?;
    storage_deposit(&d.relayer, token.id(), d.escrow.id()).await?;
    Ok(token)
}

async fn balance_on(d: &Dock, token: &Account, who: &near_workspaces::AccountId) -> Result<u128> {
    let v: J = d.net.worker.view(token.id(), "ft_balance_of").args_json(json!({ "account_id": who })).await?.json()?;
    Ok(v.as_str().unwrap_or_default().parse()?)
}

#[tokio::test]
async fn m50_paid_in_the_trade_token_and_every_wrong_funding_is_returned() -> Result<()> {
    let mut d = Dock::start_token("usdc-paid", 5 * USDC, HOUR, json!({})).await?;
    registered(&mut d).await?;
    let (relayer, buyer, treasury) = (d.relayer.clone(), d.buyer.clone(), d.treasury.clone());
    let t = d.trade_id();
    let digest = d.rec().terms_digest.clone();
    let token = d.token_id().clone();
    let ledger_view = d.view("get_ledger", json!({ "trade_id": t })).await?;
    assert_eq!(ledger_view["asset"], json!({ "kind": "NEP141", "network": "near-testnet", "tokenAccountId": token, "decimals": 6 }));
    let buyer_start = d.ft_balance(buyer.id()).await?;

    // Wrong token: a different NEP-141 contract names the right trade and digest.
    let other = other_token(&d, "other-token", &buyer).await?;
    let f = d.ft_send(other.id(), &buyer, 5 * USDC, &funding_msg(&t, &digest)).await?;
    assert_eq!((f.returned, f.refusal.as_deref(), f.used), (5 * USDC, Some("ASSET_MISMATCH"), 0));
    assert_eq!(balance_on(&d, &other, buyer.id()).await?, 1_000 * USDC, "the other token went back to its sender");
    assert_eq!(balance_on(&d, &other, d.escrow.id()).await?, 0);
    // Wrong digest, unknown trade, malformed funding message, dust.
    for (msg, code) in [
        (funding_msg(&t, &"00".repeat(32)), "STALE_REVISION"),
        (funding_msg("trd_00000000000000000000000000000000", &digest), "NOT_FOUND"),
        (format!("{{\"tradeId\":\"{t}\"}}"), "VALIDATION_FAILED"),
        (format!("{{\"tradeId\":\"{t}\",\"termsDigest\":\"{digest}\",\"payTo\":\"attacker.testnet\"}}"), "VALIDATION_FAILED"),
    ] {
        let f = d.ft_send(&token, &buyer, 5 * USDC, &msg).await?;
        assert_eq!((f.returned, f.refusal.as_deref()), (5 * USDC, Some(code)), "{msg}");
    }
    let f = d.ft_send(&token, &buyer, 9_999, &funding_msg(&t, &digest)).await?;
    assert_eq!((f.returned, f.refusal.as_deref()), (9_999, Some("INVALID_AMOUNT")));
    assert_eq!(d.ft_balance(buyer.id()).await?, buyer_start, "every refused amount is back with the sender");
    assert_eq!(d.ft_balance(d.escrow.id()).await?, 0);
    // Native NEAR cannot fund a token trade; the attached deposit returns with the failed call.
    assert_eq!(d.refused(&buyer, "fund", fund_args(&t, &digest), NEAR).await?, "ASSET_MISMATCH");
    // An account calling the receiver directly (no tokens behind it) credits nothing.
    let fake = json!({ "sender_id": buyer.id(), "amount": (5 * USDC).to_string(), "msg": funding_msg(&t, &digest) });
    let r = d.ok(&buyer, "ft_on_transfer", fake, 0).await?;
    assert_eq!(r.value, json!((5 * USDC).to_string()), "the forged call is told to take everything back");
    assert_eq!(d.view("get_ledger", json!({ "trade_id": t })).await?, ledger_view, "nothing was credited");

    // Real funding from two funders: recorded per original funder.
    let f = d.ft_fund(&buyer, 3 * USDC).await?;
    assert_eq!((f.returned, f.used, f.refusal), (0, 3 * USDC, None));
    assert_eq!(d.ft_fund(&treasury, 2 * USDC).await?.returned, 0);
    let ledger = d.view("get_ledger", json!({ "trade_id": t })).await?;
    assert_eq!(ledger["fullyFunded"], json!(true));
    assert_eq!(ledger["funders"][buyer.id().as_str()]["available"], json!((3 * USDC).to_string()));
    assert_eq!(ledger["funders"][treasury.id().as_str()]["available"], json!((2 * USDC).to_string()));
    assert_eq!(d.ft_balance(d.escrow.id()).await?, 5 * USDC);
    attest_and_inspect(&mut d, "m1").await?;

    // Unregistered payee: the value cannot be locked for it.
    let args = intent_args(&d.fx, d.rec(), d.now().await?, "main");
    assert_eq!(d.refused(&relayer, "create_release_intent", args.clone(), 0).await?, "PAYEE_NOT_REGISTERED");
    assert!(!check_payee(&mut d).await?, "the token reports the supplier as not registered");
    assert_eq!(d.refused(&relayer, "create_release_intent", args, 0).await?, "PAYEE_NOT_REGISTERED");
    assert_eq!(d.view("get_ledger", json!({ "trade_id": t })).await?["totals"]["reserved"], json!("0"));
    // The check cannot be pointed at any other account.
    let elsewhere = json!({ "trade_id": t, "account_id": buyer.id() });
    assert_eq!(d.refused(&relayer, "check_payee_storage", elsewhere, 0).await?, "DESTINATION_MISMATCH");
    // Nobody but the escrow itself can record an answer.
    let forged = relayer.call(d.escrow.id(), "on_payee_storage").args_json(check_payee_args(d.rec())).transact().await?;
    assert!(format!("{:?}", forged.failures()).contains("Method on_payee_storage is private"), "{:?}", forged.failures());

    d.register_storage(d.supplier.id()).await?;
    assert!(check_payee(&mut d).await?);
    assert_eq!(d.view("get_trade", json!({ "trade_id": t })).await?["payeeStorage"], json!([d.supplier.id()]));
    let id = intent(&mut d, "main").await?;
    assert_eq!(d.view("get_ledger", json!({ "trade_id": t })).await?["totals"]["reserved"], json!((5 * USDC).to_string()));
    assert_eq!(d.refused(&relayer, "execute_release", execute_release_args(d.rec(), &id), 0).await?, "APPROVAL_MISSING");
    let approval = approve(&mut d, &id, "main").await?;
    // Replay of the buyer approval is refused.
    assert_ne!(d.call(&relayer, "approve_release", approval, 0).await?.err(), None, "a replayed approval is refused");

    let (supplier_before, supplier_near) = (d.ft_balance(d.supplier.id()).await?, d.net.balance(d.supplier.id()).await?);
    let sent = d.ok(&relayer, "execute_release", execute_release_args(d.rec(), &id), 0).await?;
    assert_eq!(sent.value["settled"], json!(true));
    assert_eq!(sent.value["scheduled"]["transfer"], json!({ "to": d.supplier.id(), "amount": (5 * USDC).to_string(), "token": token }));
    assert_eq!(d.ft_balance(d.supplier.id()).await? - supplier_before, 5 * USDC, "the supplier receives exactly the trade amount in the token");
    assert_eq!(d.net.balance(d.supplier.id()).await?, supplier_near, "and no native NEAR");
    assert_eq!(d.ft_balance(d.escrow.id()).await?, 0);
    let release = d.view("get_release", json!({ "trade_id": t })).await?;
    assert!(release.to_string().contains("\"PAID\""), "{release}");
    let ledger = d.view("get_ledger", json!({ "trade_id": t })).await?;
    assert_eq!(ledger["funders"][buyer.id().as_str()]["released"], json!((3 * USDC).to_string()));
    assert_eq!(ledger["funders"][treasury.id().as_str()]["released"], json!((2 * USDC).to_string()));
    assert_eq!(ledger["conservation"], json!(true));

    // Replays after PAID: the release cannot run twice, the settlement cannot be called by
    // anyone, and a new intent finds nothing to lock.
    assert_ne!(d.call(&relayer, "execute_release", execute_release_args(d.rec(), &id), 0).await?.err(), None);
    let cb = json!({ "trade_id": t, "release_intent_id": id, "attempt_id": sent.value["scheduled"]["attempt_id"] });
    let forged = relayer.call(d.escrow.id(), "on_release_transfer").args_json(&cb).transact().await?;
    assert!(format!("{:?}", forged.failures()).contains("Method on_release_transfer is private"), "{:?}", forged.failures());
    let again = intent_args(&d.fx, d.rec(), d.now().await?, "again");
    assert_ne!(d.call(&relayer, "create_release_intent", again, 0).await?.err(), None);
    assert_eq!(d.ft_balance(d.supplier.id()).await? - supplier_before, 5 * USDC, "paid exactly once");
    Ok(())
}

#[tokio::test]
async fn m50_hold_then_paid_in_the_trade_token() -> Result<()> {
    let mut d = Dock::start_token("usdc-hold", 5 * USDC, HOUR, json!({})).await?;
    funded_and_inspected(&mut d).await?;
    let relayer = d.relayer.clone();
    d.register_storage(d.supplier.id()).await?;
    assert!(check_payee(&mut d).await?);
    let hold = hold_set_args(&d.fx, d.rec(), "POLICY_SETTER", d.now().await?, 7 * dockside_fixtures::DAY, "h1");
    d.ok(&relayer, "set_hold", hold, 0).await?;
    let id = intent(&mut d, "main").await?;
    let release = d.view("get_release", json!({ "trade_id": d.trade_id() })).await?;
    assert!(release["blockers"].to_string().contains("HOLD_ACTIVE"), "{release}");
    assert_eq!(d.refused(&relayer, "execute_release", execute_release_args(d.rec(), &id), 0).await?, "HOLD_ACTIVE");
    assert_eq!(d.ft_balance(d.escrow.id()).await?, 5 * USDC, "the held value stays in escrow");
    // Only the risk/policy principal resolves it; the policy service that set it cannot.
    let mut forged = hold_resolve_args(&d.fx, d.rec(), "h1", "RELEASE_HOLD", d.now().await?);
    forged["signature"] = json!(d.fx.sign("policy", "dockside/hold-resolve", &forged["payload"]));
    assert_eq!(d.refused(&relayer, "resolve_hold", forged, 0).await?, "SIGNATURE_INVALID");
    let resolve = hold_resolve_args(&d.fx, d.rec(), "h1", "RELEASE_HOLD", d.now().await?);
    d.ok(&relayer, "resolve_hold", resolve, 0).await?;
    approve(&mut d, &id, "main").await?;
    let before = d.ft_balance(d.supplier.id()).await?;
    let sent = d.ok(&relayer, "execute_release", execute_release_args(d.rec(), &id), 0).await?;
    assert_eq!(sent.value["settled"], json!(true));
    assert_eq!(d.ft_balance(d.supplier.id()).await? - before, 5 * USDC);
    assert_eq!(d.ft_balance(d.escrow.id()).await?, 0);
    Ok(())
}

#[tokio::test]
async fn m50_mutual_cancel_refund_and_excess_return_in_the_trade_token() -> Result<()> {
    let mut d = Dock::start_token("usdc-refund", 5 * USDC, HOUR, json!({})).await?;
    registered(&mut d).await?;
    let (relayer, buyer) = (d.relayer.clone(), d.buyer.clone());
    let t = d.trade_id();
    let start = d.ft_balance(buyer.id()).await?;
    // 6 USDC from the buyer: 5 accepted, 1 quarantined for the same funder.
    let f = d.ft_fund(&buyer, 6 * USDC).await?;
    assert_eq!((f.returned, f.used), (0, 6 * USDC));
    let ledger = d.view("get_ledger", json!({ "trade_id": t })).await?;
    assert_eq!(ledger["funders"][buyer.id().as_str()]["quarantined"], json!(USDC.to_string()));
    assert_eq!(d.ft_balance(buyer.id()).await?, start - 6 * USDC);

    let now = d.now().await?;
    let cancel = refund_request(&d.fx, d.rec(), "cancel", "MUTUAL_CANCEL", buyer.id().as_str(), 5 * USDC, "AVAILABLE", "BUYER", now);
    d.ok(&relayer, "request_refund", request_refund_args(&d.fx, d.rec(), &cancel, &["buyer", "supplier"]), 0).await?;
    let excess = refund_request(&d.fx, d.rec(), "excess", "EXCESS_FUNDING_RETURN", buyer.id().as_str(), USDC, "QUARANTINED", "FUNDER", d.now().await?);
    let excess_args = request_refund_args(&d.fx, d.rec(), &excess, &[]);
    // The excess return is the funder's own transaction; a relayer cannot ask for it.
    assert_eq!(d.refused(&relayer, "request_refund", excess_args.clone(), 0).await?, "FORBIDDEN");
    d.ok(&buyer, "request_refund", excess_args, 0).await?;
    // Funding is frozen while accepted value is being refunded: the tokens come straight back.
    let treasury = d.treasury.clone();
    let f = d.ft_fund(&treasury, USDC).await?;
    assert_eq!((f.returned, f.refusal.as_deref()), (USDC, Some("FUNDING_FROZEN")));

    let (cancel_id, excess_id) = (refund_id(&d.fx, "cancel"), refund_id(&d.fx, "excess"));
    d.net.hours(1).await?;
    for (rid, amount) in [(&cancel_id, 5 * USDC), (&excess_id, USDC)] {
        d.ok(&relayer, "authorize_refund", refund_op_args(d.rec(), rid), 0).await?;
        let before = d.ft_balance(buyer.id()).await?;
        let r = d.ok(&relayer, "execute_refund", refund_op_args(d.rec(), rid), 0).await?;
        assert_eq!(r.value["settled"], json!(true));
        assert_eq!(r.value["scheduled"]["transfer"]["to"], json!(buyer.id()));
        assert_eq!(d.ft_balance(buyer.id()).await? - before, amount, "the original funder receives exactly the refund");
        // Replay: a settled refund cannot be executed again.
        assert_eq!(d.refused(&relayer, "execute_refund", refund_op_args(d.rec(), rid), 0).await?, "INVALID_STATE");
    }
    assert_eq!(d.ft_balance(buyer.id()).await?, start, "every unit is back with the buyer");
    assert_eq!(d.ft_balance(d.escrow.id()).await?, 0);
    assert_eq!(d.ft_balance(d.supplier.id()).await.unwrap_or(0), 0, "the supplier received nothing");
    let ledger = d.view("get_ledger", json!({ "trade_id": t })).await?;
    assert_eq!(ledger["funders"][buyer.id().as_str()]["refunded"], json!((6 * USDC).to_string()));
    assert_eq!(ledger["totals"]["released"], json!("0"));
    assert_eq!(ledger["conservation"], json!(true));
    Ok(())
}

#[tokio::test]
async fn m50_a_failed_token_transfer_rolls_the_ledger_back_exactly() -> Result<()> {
    let mut d = Dock::start_token("usdc-rollback", 5 * USDC, HOUR, json!({})).await?;
    funded_and_inspected(&mut d).await?;
    let (relayer, supplier, treasury) = (d.relayer.clone(), d.supplier.clone(), d.treasury.clone());
    let t = d.trade_id();
    let token = d.token_id().clone();
    d.register_storage(supplier.id()).await?;
    assert!(check_payee(&mut d).await?);
    let id = intent(&mut d, "main").await?;
    approve(&mut d, &id, "main").await?;
    let locked = d.view("get_ledger", json!({ "trade_id": t })).await?;
    assert_eq!(locked["totals"]["reserved"], json!((5 * USDC).to_string()));

    // The payee unregisters from the token after the check: `ft_transfer` now fails there.
    supplier.call(&token, "storage_unregister").args_json(json!({ "force": null })).deposit(NearToken::from_yoctonear(1)).transact().await?.into_result()?;
    let sent = d.ok(&relayer, "execute_release", execute_release_args(d.rec(), &id), 0).await?;
    assert_eq!(sent.value["settled"], json!(false), "the settlement saw the failed ft_transfer");
    let release = d.view("get_release", json!({ "trade_id": t })).await?;
    assert!(release.to_string().contains("\"FAILED\""), "{release}");
    let ledger = d.view("get_ledger", json!({ "trade_id": t })).await?;
    assert_eq!(ledger["totals"]["reserved"], json!("0"));
    assert_eq!(ledger["totals"]["released"], json!("0"));
    assert_eq!(ledger["funders"][d.buyer.id().as_str()]["available"], json!((3 * USDC).to_string()));
    assert_eq!(ledger["funders"][treasury.id().as_str()]["available"], json!((2 * USDC).to_string()));
    assert_eq!(d.ft_balance(d.escrow.id()).await?, 5 * USDC, "no token left the escrow");

    // The stale confirmation is withdrawn by the next check, and the value cannot be locked
    // again until the payee is really registered.
    assert!(!check_payee(&mut d).await?);
    attest_and_inspect(&mut d, "m2").await?;
    let args = intent_args(&d.fx, d.rec(), d.now().await?, "second");
    assert_eq!(d.refused(&relayer, "create_release_intent", args, 0).await?, "PAYEE_NOT_REGISTERED");
    d.register_storage(supplier.id()).await?;
    assert!(check_payee(&mut d).await?);
    let id2 = intent(&mut d, "second").await?;
    approve(&mut d, &id2, "second").await?;
    let sent = d.ok(&relayer, "execute_release", execute_release_args(d.rec(), &id2), 0).await?;
    assert_eq!(sent.value["settled"], json!(true));
    assert_eq!(d.ft_balance(supplier.id()).await?, 5 * USDC);
    assert_eq!(d.ft_balance(d.escrow.id()).await?, 0);

    // The same rollback for a refund: a funder that left the token cannot be paid, the exact
    // bucket is restored and nothing leaves the escrow.
    let mut e = Dock::start_token("usdc-refund-rollback", 5 * USDC, HOUR, json!({})).await?;
    registered(&mut e).await?;
    let (relayer, buyer, treasury) = (e.relayer.clone(), e.buyer.clone(), e.treasury.clone());
    let token = e.token_id().clone();
    assert_eq!(e.ft_fund(&buyer, 5 * USDC).await?.returned, 0);
    assert_eq!(e.ft_fund(&treasury, USDC).await?.returned, 0, "excess from a second funder is quarantined for it");
    let req = refund_request(&e.fx, e.rec(), "excess", "EXCESS_FUNDING_RETURN", treasury.id().as_str(), USDC, "QUARANTINED", "FUNDER", e.now().await?);
    e.ok(&treasury, "request_refund", request_refund_args(&e.fx, e.rec(), &req, &[]), 0).await?;
    let rid = refund_id(&e.fx, "excess");
    e.net.hours(1).await?;
    e.ok(&relayer, "authorize_refund", refund_op_args(e.rec(), &rid), 0).await?;
    // The treasury empties its token account and unregisters.
    let rest = e.ft_balance(treasury.id()).await?;
    treasury
        .call(&token, "ft_transfer")
        .args_json(json!({ "receiver_id": buyer.id(), "amount": rest.to_string() }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    treasury.call(&token, "storage_unregister").args_json(json!({ "force": null })).deposit(NearToken::from_yoctonear(1)).transact().await?.into_result()?;
    let r = e.ok(&relayer, "execute_refund", refund_op_args(e.rec(), &rid), 0).await?;
    assert_eq!(r.value["settled"], json!(false));
    let ledger = e.view("get_ledger", json!({ "trade_id": e.trade_id() })).await?;
    assert_eq!(ledger["funders"][treasury.id().as_str()]["quarantined"], json!(USDC.to_string()));
    assert_eq!(ledger["funders"][treasury.id().as_str()]["refunded"], json!("0"));
    assert_eq!(ledger["funders"][treasury.id().as_str()]["refundLocked"], json!("0"));
    assert_eq!(e.view("get_refunds", json!({ "trade_id": e.trade_id() })).await?[0]["state"], json!("FAILED"));
    assert_eq!(e.ft_balance(e.escrow.id()).await?, 6 * USDC);
    Ok(())
}

#[tokio::test]
async fn m50_cap_and_pinned_token_bound_what_a_trade_can_hold() -> Result<()> {
    let init = json!({
        "max_trade_amount": { "near_yocto": (5 * NEAR).to_string(), "nep141": (6 * USDC).to_string() },
        "nep141_token": { "account_id": "$TOKEN", "decimals": 6 },
    });
    let mut d = Dock::start_token("usdc-cap", 5 * USDC, HOUR, init).await?;
    let (relayer, buyer, treasury) = (d.relayer.clone(), d.buyer.clone(), d.treasury.clone());
    let cfg = d.view("get_config", json!({})).await?;
    assert_eq!(cfg["maxTradeAmount"], json!({ "nearYocto": (5 * NEAR).to_string(), "nep141": (6 * USDC).to_string() }));
    assert_eq!(cfg["nep141Token"], json!({ "accountId": d.token_id(), "decimals": 6 }));

    // A trade above the cap, a trade in another token and a native trade above its cap do not register.
    let big = d.fx.with_trade("too-big", 6 * USDC + 1);
    assert_eq!(d.refused(&relayer, "register_trade", register_args(&big), 0).await?, "CAP_EXCEEDED");
    let other = d.fx.with_trade("other-token", USDC).with_token("other-token.testnet", 6);
    assert_eq!(d.refused(&relayer, "register_trade", register_args(&other), 0).await?, "UNSUPPORTED_ASSET");
    let decimals = d.fx.with_trade("other-decimals", USDC).with_token(d.token_id().as_str(), 18);
    assert_eq!(d.refused(&relayer, "register_trade", register_args(&decimals), 0).await?, "UNSUPPORTED_ASSET");
    let mut native = d.fx.with_trade("native-big", 5 * NEAR + 1);
    native.token = None;
    assert_eq!(d.refused(&relayer, "register_trade", register_args(&native), 0).await?, "CAP_EXCEEDED");

    registered(&mut d).await?;
    let start = d.ft_balance(buyer.id()).await?;
    // More than the cap in one deposit comes back whole.
    let f = d.ft_fund(&buyer, 6 * USDC + 1).await?;
    assert_eq!((f.returned, f.refusal.as_deref(), f.used), (6 * USDC + 1, Some("CAP_EXCEEDED"), 0));
    assert_eq!(d.ft_balance(buyer.id()).await?, start);
    assert_eq!(d.ft_fund(&buyer, 5 * USDC).await?.returned, 0);
    // 5 held: 1 more is the cap, 1 unit beyond it is returned.
    let f = d.ft_fund(&treasury, USDC + 1).await?;
    assert_eq!((f.returned, f.refusal.as_deref()), (USDC + 1, Some("CAP_EXCEEDED")));
    assert_eq!(d.ft_fund(&treasury, USDC).await?.returned, 0);
    let f = d.ft_fund(&treasury, 10_000).await?;
    assert_eq!((f.returned, f.refusal.as_deref()), (10_000, Some("CAP_EXCEEDED")));
    assert_eq!(d.ft_balance(d.escrow.id()).await?, 6 * USDC);
    let ledger = d.view("get_ledger", json!({ "trade_id": d.trade_id() })).await?;
    assert_eq!(ledger["funders"][treasury.id().as_str()]["quarantined"], json!(USDC.to_string()));
    Ok(())
}

#[tokio::test]
async fn m50_a_squatted_trade_id_cannot_take_the_honest_funding() -> Result<()> {
    let mut d = Dock::start_token("usdc-squat", 5 * USDC, HOUR, json!({})).await?;
    let (relayer, buyer) = (d.relayer.clone(), d.buyer.clone());
    let honest = d.fx.clone();
    let honest_id = honest.trade_id();
    let honest_terms = terms(&honest);
    let honest_digest = dockside_fixtures::digest_hex("dockside/trade-revision", &honest_terms);

    // The squatter registers the honest trade id first, with its own keys and itself as payee.
    let mut squat = Fixture::new(honest.accounts.clone(), "squatter-seed", "trade-1", 5 * USDC, HOUR, honest.t0).with_token(d.token_id().as_str(), 6);
    squat.accounts.supplier = d.alt.id().to_string();
    let mut t = terms(&squat);
    set(&mut t, &["tradeId"], dockside_fixtures::s(&honest_id));
    set(&mut t, &["policySetter", "scope", "tradeId"], dockside_fixtures::s(&honest_id));
    let args = json!({
        "terms": t,
        "buyer_signature": squat.sign("buyer", "dockside/trade-revision", &t),
        "supplier_signature": squat.sign("supplier", "dockside/trade-revision", &t),
    });
    d.ok(&relayer, "register_trade", args, 0).await?;
    assert_ne!(d.mirror.trade(&honest_id).terms_digest, honest_digest);
    // The honest registration is refused, and the honest buyer's funding, which names the digest
    // it signed, is returned instead of landing in the squatter's trade.
    assert_eq!(d.refused(&relayer, "register_trade", register_args(&honest), 0).await?, "INVALID_STATE");
    let start = d.ft_balance(buyer.id()).await?;
    let token = d.token_id().clone();
    let f = d.ft_send(&token, &buyer, 5 * USDC, &funding_msg(&honest_id, &honest_digest)).await?;
    assert_eq!((f.returned, f.refusal.as_deref()), (5 * USDC, Some("STALE_REVISION")));
    assert_eq!(d.ft_balance(buyer.id()).await?, start);
    assert_eq!(d.ft_balance(d.escrow.id()).await?, 0);
    let ledger = d.view("get_ledger", json!({ "trade_id": honest_id })).await?;
    assert_eq!(ledger["deposits"], json!([]));
    Ok(())
}

#[tokio::test]
async fn m50_the_trade_token_without_a_funding_message_is_recorded_never_credited_and_recoverable() -> Result<()> {
    let mut d = Dock::start_token("usdc-unexpected", 5 * USDC, HOUR, json!({})).await?;
    registered(&mut d).await?;
    let (relayer, buyer, treasury) = (d.relayer.clone(), d.buyer.clone(), d.treasury.clone());
    let t = d.trade_id();
    let token = d.token_id().clone();
    assert_eq!(d.ft_fund(&buyer, 5 * USDC).await?.returned, 0);
    let ledger = d.view("get_ledger", json!({ "trade_id": t })).await?;

    // The treasury sends the trade's own token with a free-text memo: kept, recorded, not credited.
    let start = d.ft_balance(treasury.id()).await?;
    let f = d.ft_send(&token, &treasury, 2 * USDC, "invoice 7").await?;
    assert_eq!((f.returned, f.refusal, f.used), (0, None, 2 * USDC));
    assert_eq!(d.view("get_ledger", json!({ "trade_id": t })).await?, ledger, "the trade ledger did not move");
    assert_eq!(d.ft_balance(d.escrow.id()).await?, 7 * USDC, "5 held by the trade plus 2 unexpected");
    let asset = d.mirror.asset(0).map_err(|e| anyhow::anyhow!("{e}"))?;
    assert_eq!((asset.asset_contract.as_str(), asset.claimed_sender.as_str()), (token.as_str(), treasury.id().as_str()));

    // Recovery returns exactly the recorded amount to the proven sender; the trade value stays.
    let req = asset_request_args(&d.fx, d.rec(), &asset, d.now().await?, "a");
    assert_eq!(d.refused(&relayer, "request_asset_recovery", req.clone(), 0).await?, "FORBIDDEN");
    d.ok(&treasury, "request_asset_recovery", req, 0).await?;
    let asset = d.mirror.asset(0).map_err(|e| anyhow::anyhow!("{e}"))?;
    let ap = asset_approval_args(&d.fx, d.rec(), &asset, d.now().await?, "a");
    d.ok(&relayer, "approve_asset_recovery", ap, 0).await?;
    let asset = d.mirror.asset(0).map_err(|e| anyhow::anyhow!("{e}"))?;
    let exec = execute_asset_recovery_args(&asset);
    assert_eq!(d.refused(&relayer, "execute_asset_recovery", exec.clone(), 1).await?, "DELAY_NOT_ELAPSED");
    d.net.hours(72).await?;
    let r = d.ok(&relayer, "execute_asset_recovery", exec.clone(), 1).await?;
    assert_eq!(r.value["settled"], json!(true));
    assert_eq!(d.ft_balance(treasury.id()).await?, start, "the sender has its tokens back");
    assert_eq!(d.ft_balance(d.escrow.id()).await?, 5 * USDC, "the trade's value is untouched");
    assert_eq!(d.view("get_ledger", json!({ "trade_id": t })).await?, ledger);
    // The recovered record cannot pay out a second time from the trade's tokens.
    assert_ne!(d.call(&relayer, "execute_asset_recovery", exec, 1).await?.err(), None);
    assert_eq!(d.ft_balance(d.escrow.id()).await?, 5 * USDC);
    Ok(())
}

#[tokio::test]
async fn m50_mainnet_label_needs_caps_and_runs_the_token_trade_under_its_own_profile() -> Result<()> {
    // Local sandbox only: accounts are <name>.mainnet-sim and the contract is initialised with the
    // near-mainnet label. Omitted caps take the defaults: 5 NEAR and 25 USDC in base units.
    let init = json!({ "network": MAINNET, "nep141_token": { "account_id": "$TOKEN", "decimals": 6 } });
    let mut d = Dock::start_mainnet_label("usdc-mainnet-label", 5 * USDC, HOUR, true, init).await?;
    let (relayer, buyer) = (d.relayer.clone(), d.buyer.clone());
    let cfg = d.view("get_config", json!({})).await?;
    assert_eq!(cfg["network"], json!(MAINNET));
    assert_eq!(cfg["maxTradeAmount"], json!({ "nearYocto": (5 * NEAR).to_string(), "nep141": (25 * USDC).to_string() }));

    // Testnet terms, a trade above 25 USDC, a native trade above 5 NEAR and another token are refused.
    let testnet_terms = d.fx.clone().on_network("near-testnet");
    assert_eq!(d.refused(&relayer, "register_trade", register_args(&testnet_terms), 0).await?, "WRONG_NETWORK");
    let big = d.fx.with_trade("too-big", 25 * USDC + 1);
    assert_eq!(d.refused(&relayer, "register_trade", register_args(&big), 0).await?, "CAP_EXCEEDED");
    let mut native = d.fx.with_trade("native-big", 5 * NEAR + 1);
    native.token = None;
    assert_eq!(d.refused(&relayer, "register_trade", register_args(&native), 0).await?, "CAP_EXCEEDED");
    let other = d.fx.with_trade("other", USDC).with_token("usdt.mainnet-sim", 6);
    assert_eq!(d.refused(&relayer, "register_trade", register_args(&other), 0).await?, "UNSUPPORTED_ASSET");

    registered(&mut d).await?;
    let t = d.trade_id();
    assert_eq!(terms(&d.fx)["struct"]["profileVersion"]["str"], json!("dockside-direct-mainnet-v1"));
    // The cap bounds what the trade may hold: 25 USDC + 1 unit comes back whole.
    let f = d.ft_fund(&buyer, 25 * USDC + 1).await?;
    assert_eq!((f.returned, f.refusal.as_deref()), (25 * USDC + 1, Some("CAP_EXCEEDED")));
    assert_eq!(d.ft_fund(&buyer, 5 * USDC).await?.returned, 0);
    attest_and_inspect(&mut d, "m1").await?;
    d.register_storage(d.supplier.id()).await?;
    assert!(check_payee(&mut d).await?);
    // An intent naming the testnet execution profile is refused on a mainnet-label contract.
    let mut wrong = intent_args(&d.fx, d.rec(), d.now().await?, "wrong-profile");
    set(&mut wrong["payload"], &["executionProfile"], dockside_fixtures::s("DIRECT_TESTNET"));
    wrong["buyer_signature"] = json!(d.fx.sign("buyer", "dockside/release-intent", &wrong["payload"]));
    assert_eq!(d.refused(&relayer, "create_release_intent", wrong, 0).await?, "UNSUPPORTED_VERSION");
    let id = intent(&mut d, "main").await?;
    approve(&mut d, &id, "main").await?;
    let sent = d.ok(&relayer, "execute_release", execute_release_args(d.rec(), &id), 0).await?;
    assert_eq!(sent.value["settled"], json!(true));
    assert_eq!(d.ft_balance(d.supplier.id()).await?, 5 * USDC);
    let release = d.view("get_release", json!({ "trade_id": t })).await?;
    assert!(release.to_string().contains("\"PAID\"") && release.to_string().contains("DIRECT_MAINNET"), "{release}");

    // A mainnet-label contract without a pinned token accepts no NEP-141 trade, and a native
    // trade is capped at 5 NEAR per trade including its excess.
    let mut n = Dock::start_mainnet_label("native-mainnet-label", 2 * NEAR, HOUR, false, json!({ "network": MAINNET })).await?;
    let (relayer, buyer) = (n.relayer.clone(), n.buyer.clone());
    let token_trade = n.fx.with_trade("no-token", USDC).with_token("usdc.mainnet-sim", 6);
    assert_eq!(n.refused(&relayer, "register_trade", register_args(&token_trade), 0).await?, "UNSUPPORTED_ASSET");
    n.ok(&relayer, "register_trade", register_args(&n.fx), 0).await?;
    let (t, digest) = (n.trade_id(), n.rec().terms_digest.clone());
    assert_eq!(n.refused(&buyer, "fund", fund_args(&t, &digest), 5 * NEAR + 1).await?, "CAP_EXCEEDED");
    n.ok(&buyer, "fund", fund_args(&t, &digest), 2 * NEAR).await?;
    assert_eq!(n.refused(&buyer, "fund", fund_args(&t, &digest), 3 * NEAR + 1).await?, "CAP_EXCEEDED");
    let x = n.ok(&buyer, "fund", fund_args(&t, &digest), 3 * NEAR).await?;
    assert_eq!(x.value["quarantined"], json!((3 * NEAR).to_string()));
    Ok(())
}
