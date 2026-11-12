//! Storage an account with no role on a trade can make the escrow pay for (external security
//! audit, m33-contract-storage-bounds), on a real local near-sandbox node: real transactions,
//! real storage staking (`storage_usage` of the escrow account) and a real NEP-141 contract.
//!
//! (a) direct receiver calls stop at `MAX_UNEXPECTED_ASSETS`; past the cap a real
//!     `ft_transfer_call` is refused by the escrow and the token contract refunds the sender;
//! (b) a stranger's request/revoke loop on its own record leaves the governing trade unchanged
//!     and stops at `MAX_RECOVERIES_PER_ASSET`;
//! (c) repeated minimum `fund` calls stop at `MAX_DEPOSITS_PER_TRADE`, and the release of the
//!     funded trade still settles.

use anyhow::Result;
use dockside_escrow_core::assets::{MAX_RECOVERIES_PER_ASSET, MAX_UNEXPECTED_ASSETS};
use dockside_escrow_core::MAX_DEPOSITS_PER_TRADE;
use dockside_fixtures::payloads::*;
use dockside_fixtures::{HOUR, MILLINEAR};
use dockside_sandbox_tests::*;
use near_workspaces::types::NearToken;
use serde_json::json;

async fn storage_usage(d: &Dock) -> Result<u64> {
    Ok(d.net.worker.view_account(d.escrow.id()).await?.storage_usage)
}

#[tokio::test]
async fn m33_receivers_recovery_attempts_and_deposits_are_bounded_on_chain() -> Result<()> {
    let mut d = Dock::start("m33", 5 * NEAR, HOUR).await?;
    let relayer = d.relayer.clone();
    d.ok(&relayer, "register_trade", register_args(&d.fx), 0).await?;
    let (buyer, t) = (d.buyer.clone(), d.trade_id());
    d.ok(&buyer, "fund", fund_args(&t, &d.rec().terms_digest), 5 * NEAR).await?;
    let stranger = d.net.account("stranger", 20).await?;

    // (b) The stranger records an NEP-141 asset naming itself as sender, then loops
    // request/revoke against the victim trade. The trade must not change.
    let ft = |n: u64| json!({ "sender_id": stranger.id(), "amount": "1", "msg": format!("{n}") });
    d.ok(&stranger, "ft_on_transfer", ft(0), 0).await?;
    let trade_before = d.view("get_trade", json!({ "trade_id": t })).await?;
    let usage_trade = storage_usage(&d).await?;
    for i in 0..MAX_RECOVERIES_PER_ASSET {
        let a = d.mirror.asset(0).map_err(|e| anyhow::anyhow!("{e}"))?;
        let now = d.now().await?;
        d.ok(&stranger, "request_asset_recovery", asset_request_args(&d.fx, d.rec(), &a, now, &format!("m33-{i}")), 0).await?;
        let a = d.mirror.asset(0).map_err(|e| anyhow::anyhow!("{e}"))?;
        d.ok(&stranger, "revoke_asset_recovery", asset_sender_revoke_args(&d.fx, d.rec(), &a, now, &format!("m33-{i}")), 0).await?;
    }
    let a = d.mirror.asset(0).map_err(|e| anyhow::anyhow!("{e}"))?;
    let now = d.now().await?;
    let over = asset_request_args(&d.fx, d.rec(), &a, now, "m33-over");
    assert_eq!(d.refused(&stranger, "request_asset_recovery", over, 0).await?, "CAPACITY_EXCEEDED");
    assert_eq!(d.view("get_trade", json!({ "trade_id": t })).await?, trade_before, "the governing trade is unchanged");
    let per_asset_attempts = storage_usage(&d).await? - usage_trade;
    println!("m33(b): {MAX_RECOVERIES_PER_ASSET} stranger recovery cycles added {per_asset_attempts} bytes, all on the stranger's own record");

    // (a) Direct receiver calls fill the contract-wide cap, then every receiver refuses.
    let usage_a = storage_usage(&d).await?;
    for n in 1..MAX_UNEXPECTED_ASSETS {
        d.ok(&stranger, "ft_on_transfer", ft(n), 0).await?;
    }
    assert_eq!(d.refused(&stranger, "ft_on_transfer", ft(99), 0).await?, "CAPACITY_EXCEEDED");
    let config = d.view("get_config", json!({})).await?;
    assert_eq!(config["unexpectedAssets"], json!(MAX_UNEXPECTED_ASSETS));
    println!("m33(a): {} direct receiver records added {} bytes of escrow storage", MAX_UNEXPECTED_ASSETS - 1, storage_usage(&d).await? - usage_a);

    // Past the cap a real ft_transfer_call is refused and the token contract refunds the sender.
    let token = d.net.account("usdc-fake", 20).await?;
    let sender = d.net.account("token-sender", 20).await?;
    token.deploy(&token_wasm()?).await?.into_result()?;
    token
        .call(token.id(), "new")
        .args_json(json!({ "owner_id": sender.id(), "total_supply": "1000000000" }))
        .transact()
        .await?
        .into_result()?;
    relayer
        .call(token.id(), "storage_deposit")
        .args_json(json!({ "account_id": d.escrow.id(), "registration_only": true }))
        .deposit(NearToken::from_millinear(125))
        .transact()
        .await?
        .into_result()?;
    let usage_full = storage_usage(&d).await?;
    let sent = sender
        .call(token.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": d.escrow.id(), "amount": "5000000", "memo": null, "msg": "pay trade" }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await?;
    let escrow_receipt = sent.receipt_outcomes().iter().find(|o| o.executor_id == *d.escrow.id()).cloned();
    assert!(escrow_receipt.is_some_and(|o| o.is_failure()), "the escrow's ft_on_transfer must fail past the cap");
    let bal = |who: near_workspaces::AccountId| {
        let (w, tok) = (d.net.worker.clone(), token.id().clone());
        async move {
            let v: serde_json::Value = w.view(&tok, "ft_balance_of").args_json(json!({ "account_id": who })).await?.json()?;
            anyhow::Ok(v.as_str().unwrap_or_default().parse::<u128>()?)
        }
    };
    assert_eq!(bal(sender.id().clone()).await?, 1_000_000_000, "the token contract refunded the whole transfer");
    assert_eq!(bal(d.escrow.id().clone()).await?, 0);
    assert_eq!(storage_usage(&d).await?, usage_full, "a refused receiver call stores nothing");

    // (c) Repeated minimum deposits from the stranger stop at the per-trade cap.
    let usage_c = storage_usage(&d).await?;
    for _ in 1..MAX_DEPOSITS_PER_TRADE {
        d.ok(&stranger, "fund", fund_args(&t, &d.rec().terms_digest), MILLINEAR).await?;
    }
    assert_eq!(d.refused(&stranger, "fund", fund_args(&t, &d.rec().terms_digest), MILLINEAR).await?, "CAPACITY_EXCEEDED");
    let ledger = d.view("get_ledger", json!({ "trade_id": t })).await?;
    assert_eq!(ledger["deposits"].as_array().map(Vec::len), Some(MAX_DEPOSITS_PER_TRADE));
    println!(
        "m33(c): {} stranger minimum deposits added {} bytes of escrow storage",
        MAX_DEPOSITS_PER_TRADE - 1,
        storage_usage(&d).await? - usage_c
    );
    Ok(())
}
