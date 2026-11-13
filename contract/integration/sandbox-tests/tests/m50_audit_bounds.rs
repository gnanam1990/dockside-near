//! Audit of M50 on a real local near-sandbox node: a stranger that funds another party's token
//! trade with a small excess cannot grow that trade's record without bound by requesting and
//! revoking its own excess return, and a relayer that attaches only as much gas as
//! `execute_release` accepts still leaves the settlement callback enough to settle the release.
//!
//! Before the fix the loop was unbounded (546 bytes per cycle, paid from the escrow's storage
//! balance) and the callback had a fixed 15 Tgas: after about 120 cycles the callback of a
//! minimum-gas relay burnt 13.9 Tgas, a few more cycles left it without gas after the token
//! transfer had gone out, and the intent would have stayed SUBMITTING for good.
use anyhow::Result;
use dockside_escrow_core::refund::MAX_ENDED_FUNDER_RETURNS;
use dockside_fixtures::payloads::*;
use dockside_fixtures::{s, u, HOUR, J};
use dockside_sandbox_tests::*;
use near_workspaces::types::Gas;
use serde_json::json;

#[tokio::test]
async fn m50_a_stranger_cannot_bloat_a_trade_and_a_minimum_gas_relay_still_settles() -> Result<()> {
    let mut d = Dock::start_token("audit-bloat", 5 * USDC, HOUR, json!({})).await?;
    let relayer = d.relayer.clone();
    d.ok(&relayer, "register_trade", register_args(&d.fx), 0).await?;
    d.ok(&relayer, "register_evidence_policy", policy_args(d.rec()), 0).await?;
    let (buyer, stranger) = (d.buyer.clone(), d.treasury.clone());
    assert_eq!(d.ft_fund(&buyer, 5 * USDC).await?.returned, 0);
    assert_eq!(d.ft_fund(&stranger, USDC).await?.returned, 0);
    let att = attestation_args(&d.fx, d.rec(), next_manifest_revision(d.rec()), d.now().await?, "m1");
    d.ok(&relayer, "submit_manifest_attestation", att, 0).await?;
    let ins = inspection_args(&d.fx, d.rec(), "PASS", d.now().await?, "m1");
    d.ok(&relayer, "submit_inspection", ins, 0).await?;
    d.register_storage(d.supplier.id()).await?;
    d.ok(&relayer, "check_payee_storage", check_payee_args(d.rec()), 0).await?;
    let r = d.ok(&relayer, "create_release_intent", intent_args(&d.fx, d.rec(), d.now().await?, "main"), 0).await?;
    let id = r.value["releaseIntentId"].as_str().unwrap().to_string();
    d.ok(&relayer, "approve_release", approval_args(&d.fx, d.rec(), &id, d.now().await?, "main"), 0).await?;

    // The stranger (a funder of 1 USDC excess) loops request/revoke of its own excess return.
    let k: usize = 3 * MAX_ENDED_FUNDER_RETURNS;
    let mut refused = None;
    for i in 0..k {
        let now = d.now().await?;
        let label = format!("loop{i}");
        let p = refund_request(&d.fx, d.rec(), &label, "EXCESS_FUNDING_RETURN", stranger.id().as_str(), USDC, "QUARANTINED", "FUNDER", now);
        let r1 = stranger
            .call(d.escrow.id(), "request_refund")
            .args_json(request_refund_args(&d.fx, d.rec(), &p, &[]))
            .gas(Gas::from_tgas(300))
            .transact()
            .await?;
        if !r1.is_success() {
            refused = Some((i, format!("{:?}", r1.failures())));
            break;
        }
        let rid = refund_id(&d.fx, &label);
        let rv = with_header(
            d.rec(),
            &d.fx.accounts.contract,
            vec![
                ("refundIntentId", s(&rid)),
                ("requestDigest", s(&dockside_fixtures::digest_hex("dockside/refund-request", &p))),
                ("revokerRole", s("FUNDER")),
                ("issuedAt", u(now)),
                ("expiresAt", u(now + HOUR)),
                ("nonce", s(&d.fx.nonce(&format!("rv/{label}")))),
            ],
        );
        let r2 = stranger
            .call(d.escrow.id(), "revoke_refund")
            .args_json(json!({ "trade_id": d.trade_id(), "payload": rv, "signature": J::Null }))
            .gas(Gas::from_tgas(300))
            .transact()
            .await?;
        if !r2.is_success() {
            refused = Some((i, format!("revoke {:?}", r2.failures())));
            break;
        }
    }
    let (cycles, why) = refused.expect("the loop must be refused");
    assert_eq!(cycles, MAX_ENDED_FUNDER_RETURNS, "{why}");
    assert!(why.contains("CAPACITY_EXCEEDED"), "{why}");
    assert_eq!(d.ft_balance(d.escrow.id()).await?, 6 * USDC, "the stranger's excess is still held, nothing moved");

    let supplier_before = d.ft_balance(d.supplier.id()).await?;
    // A relayer attaching the least gas the call accepts (2 Tgas steps).
    let mut settled = None;
    for extra in (2..120).step_by(2) {
        let res = relayer
            .call(d.escrow.id(), "execute_release")
            .args_json(execute_release_args(d.rec(), &id))
            .gas(Gas::from_tgas(35 + extra))
            .transact()
            .await?;
        let outs = res.receipt_outcomes().to_vec();
        let main = outs.iter().find(|o| o.executor_id == *d.escrow.id()).unwrap();
        if main.is_failure() {
            continue;
        }
        settled = Some((35 + extra, outs.iter().filter(|o| o.executor_id == *d.escrow.id()).all(|o| o.is_success())));
        break;
    }
    let (gas, all_ok) = settled.expect("execute_release ran");
    assert!(all_ok, "with {gas} Tgas prepaid a receipt on the escrow failed");
    assert_eq!(d.ft_balance(d.supplier.id()).await? - supplier_before, 5 * USDC);
    let release = d.view("get_release", json!({ "trade_id": d.trade_id() })).await?;
    assert!(release["intents"][0]["state"] == json!("PAID"), "{release}");
    assert!(release["liveIntent"].is_null());
    Ok(())
}
