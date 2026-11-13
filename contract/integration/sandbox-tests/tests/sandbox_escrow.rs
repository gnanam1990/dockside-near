//! The container-built escrow wasm on a real local near-sandbox node (nearcore 2.14.0).
//!
//! Every call below is a real signed transaction executed by nearcore's wasm runtime: native NEAR
//! moves between real accounts, promises and private callbacks run as receipts, block time comes
//! from the chain and the NEP-141 token is a real contract. The host mirror replays each accepted
//! call and the harness asserts that the contract's views equal the core's after every step.
//!
//! IDs: T-007 (deploy, fund from recorded funders, read state), T-008 (excess to QUARANTINED and
//! its return), T-009 (refund reasons to the original funder), T-019/T-022 (direct release of the
//! exact locked value to the bound supplier, once), T-020/T-021/T-042 (unilateral destination
//! change refused, dual-consent delayed change redirects the release), T-051 (unexpected NEP-141
//! recovery to the proven sender after the 72-hour window), m31 (a revoked destination consent
//! cannot be replayed from its public arguments), T-031 (a transfer the runtime refunds
//! is the authoritative no-transfer proof: FAILED, value restored), T-045 (on-chain code hash).

use anyhow::Result;
use dockside_fixtures::payloads::*;
use dockside_fixtures::{HOUR, MILLINEAR};
use dockside_sandbox_tests::*;
use near_workspaces::types::NearToken;
use serde_json::json;

fn manifest_expectation() -> Option<(String, String)> {
    let path = std::env::var("DOCKSIDE_BUILD_MANIFEST").ok()?;
    let m: serde_json::Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    Some((m["contract"]["sha256"].as_str()?.to_string(), m["contract"]["nearCodeHash"].as_str()?.to_string()))
}

#[tokio::test]
async fn t045_deployed_code_hash_is_the_built_wasm_and_init_refuses_unknown_networks() -> Result<()> {
    let net = Net::start().await?;
    let wasm = escrow_wasm()?;
    if let Some((sha, hash)) = manifest_expectation() {
        assert_eq!(sha256_hex(&wasm), sha, "wasm differs from the build manifest");
        assert_eq!(code_hash(&wasm), hash, "manifest code hash differs from base58(sha256(wasm))");
    }
    let a = net.account("dockside-escrow", 20).await?;
    a.deploy(&wasm).await?.into_result()?;
    assert_eq!(net.code_hash_of(a.id()).await?, code_hash(&wasm), "on-chain code hash is the built wasm");

    // Every network label but near-testnet and near-mainnet is refused by the initialiser, and
    // near-mainnet is refused without a non-zero cap (M50; the accepted mainnet label is
    // exercised in m50_nep141_rail.rs).
    for network in ["near-sandbox", "mainnet", "near-betanet"] {
        let r = a.call(a.id(), "new").args_json(json!({ "network": network, "min_deposit_yocto": null })).transact().await?;
        assert!(r.is_failure());
        assert!(format!("{:?}", r.failures()).contains("DOCKSIDE:FUNDED_RAIL_BLOCKED"), "{network}");
    }
    for caps in [json!({ "near_yocto": "0", "nep141": "25000000" }), json!({ "near_yocto": "5000000000000000000000000", "nep141": "0" })] {
        let r = a.call(a.id(), "new").args_json(json!({ "network": "near-mainnet", "max_trade_amount": caps })).transact().await?;
        assert!(r.is_failure());
        assert!(format!("{:?}", r.failures()).contains("DOCKSIDE:CAP_REQUIRED"), "{:?}", r.failures());
    }
    let min = (2 * MILLINEAR).to_string();
    a.call(a.id(), "new").args_json(json!({ "network": "near-testnet", "min_deposit_yocto": min })).transact().await?.into_result()?;
    let cfg: serde_json::Value = net.worker.view(a.id(), "get_config").await?.json()?;
    let host = dockside_fixtures::mirror::Mirror::new(a.id().as_str(), Some(2 * MILLINEAR)).view("get_config", &json!({}), 0).map_err(|e| anyhow::anyhow!("{e}"))?;
    assert_eq!(cfg, host);
    // A second initialisation is refused by near-sdk.
    let again = a.call(a.id(), "new").args_json(json!({ "network": "near-testnet", "min_deposit_yocto": null })).transact().await?;
    assert!(again.is_failure());
    assert!(format!("{:?}", again.failures()).contains("already been initialized"));
    Ok(())
}

/// Register, register the policy, fund 3 NEAR (buyer) + 2 NEAR (treasury), attest and inspect.
async fn funded_and_inspected(d: &mut Dock) -> Result<()> {
    let relayer = d.relayer.clone();
    let digest = d.ok(&relayer, "register_trade", register_args(&d.fx), 0).await?;
    assert_eq!(digest.value.as_str(), Some(d.rec().terms_digest.as_str()));
    let p = policy_args(d.rec());
    d.ok(&relayer, "register_evidence_policy", p, 0).await?;
    let (buyer, treasury, t) = (d.buyer.clone(), d.treasury.clone(), d.trade_id());
    let f = d.ok(&buyer, "fund", fund_args(&t, &d.rec().terms_digest), 3 * NEAR).await?;
    assert_eq!(f.value["fullyFunded"], json!(false));
    let f = d.ok(&treasury, "fund", fund_args(&t, &d.rec().terms_digest), 2 * NEAR).await?;
    assert_eq!(f.value["fullyFunded"], json!(true));
    let now = d.now().await?;
    let att = attestation_args(&d.fx, d.rec(), next_manifest_revision(d.rec()), now, "m1");
    d.ok(&relayer, "submit_manifest_attestation", att, 0).await?;
    let ins = inspection_args(&d.fx, d.rec(), "PASS", d.now().await?, "m1");
    d.ok(&relayer, "submit_inspection", ins, 0).await?;
    Ok(())
}

#[tokio::test]
async fn t007_t019_t022_funding_and_direct_release_of_the_exact_value_to_the_bound_supplier() -> Result<()> {
    let mut d = Dock::start("release", 5 * NEAR, HOUR).await?;
    let (relayer, buyer, treasury) = (d.relayer.clone(), d.buyer.clone(), d.treasury.clone());
    let t = d.trade_id();
    let reg = register_args(&d.fx);
    d.ok(&relayer, "register_trade", reg.clone(), 0).await?;
    assert_eq!(d.refused(&relayer, "register_trade", reg.clone(), 0).await?, "INVALID_STATE");
    // Entry points that are not #[payable] refuse attached value (the wasm export's guard).
    let paid = relayer.call(d.escrow.id(), "register_trade").args_json(&reg).deposit(NearToken::from_near(1)).transact().await?;
    assert!(format!("{:?}", paid.failures()).contains("doesn't accept deposit"), "{:?}", paid.failures());
    let p = policy_args(d.rec());
    d.ok(&relayer, "register_evidence_policy", p, 0).await?;
    // A deposit below the minimum and a deposit to an unknown trade are refused; value returns.
    assert_eq!(d.refused(&buyer, "fund", fund_args(&t, &d.rec().terms_digest), 1).await?, "INVALID_AMOUNT");
    assert_eq!(d.refused(&buyer, "fund", fund_args("trd_00000000000000000000000000000000", &d.rec().terms_digest), NEAR).await?, "NOT_FOUND");
    // A deposit naming another revision digest (a trade id squatted with other terms) is refused.
    assert_eq!(d.refused(&buyer, "fund", fund_args(&t, &"00".repeat(32)), NEAR).await?, "STALE_REVISION");
    d.ok(&buyer, "fund", fund_args(&t, &d.rec().terms_digest), 3 * NEAR).await?;
    d.ok(&treasury, "fund", fund_args(&t, &d.rec().terms_digest), 2 * NEAR).await?;
    // Excess from the same funder is QUARANTINED, never counted toward the release.
    let x = d.ok(&treasury, "fund", fund_args(&t, &d.rec().terms_digest), NEAR).await?;
    assert_eq!(x.value["quarantined"], json!(NEAR.to_string()));
    let ledger = d.view("get_ledger", json!({ "trade_id": t })).await?;
    assert_eq!(ledger["totals"]["available"], json!((5 * NEAR).to_string()));
    assert_eq!(ledger["funders"][treasury.id().as_str()]["quarantined"], json!(NEAR.to_string()));
    assert_eq!(ledger["conservation"], json!(true));

    let now = d.now().await?;
    let att = attestation_args(&d.fx, d.rec(), 1, now, "m1");
    d.ok(&relayer, "submit_manifest_attestation", att, 0).await?;
    // Only the bound inspector key decides; another key is refused.
    let mut forged = inspection_args(&d.fx, d.rec(), "PASS", d.now().await?, "forged");
    forged["signature"] = json!(d.fx.sign("buyer", "dockside/inspection-attestation", &forged["payload"]));
    assert_eq!(d.refused(&relayer, "submit_inspection", forged, 0).await?, "SIGNATURE_INVALID");
    let ins = inspection_args(&d.fx, d.rec(), "PASS", d.now().await?, "m1");
    d.ok(&relayer, "submit_inspection", ins, 0).await?;

    let intent = intent_args(&d.fx, d.rec(), d.now().await?, "main");
    let r = d.ok(&relayer, "create_release_intent", intent.clone(), 0).await?;
    let id = r.value["releaseIntentId"].as_str().expect("intent id").to_string();
    assert_eq!(r.value["joined"], json!(false));
    // T-022: an exact duplicate joins the same intent and locks nothing more.
    assert_eq!(d.ok(&relayer, "create_release_intent", intent, 0).await?.value["joined"], json!(true));
    let ledger = d.view("get_ledger", json!({ "trade_id": t })).await?;
    assert_eq!(ledger["totals"]["reserved"], json!((5 * NEAR).to_string()));
    assert_eq!(d.refused(&relayer, "execute_release", execute_release_args(d.rec(), &id), 0).await?, "APPROVAL_MISSING");
    let ap = approval_args(&d.fx, d.rec(), &id, d.now().await?, "main");
    d.ok(&relayer, "approve_release", ap, 0).await?;

    let supplier_before = d.net.balance(d.supplier.id()).await?;
    let sent = d.ok(&relayer, "execute_release", execute_release_args(d.rec(), &id), 0).await?;
    assert_eq!(sent.value["settled"], json!(true));
    assert_eq!(sent.value["scheduled"]["transfer"]["to"], json!(d.supplier.id().as_str()));
    assert_eq!(d.net.balance(d.supplier.id()).await? - supplier_before, 5 * NEAR, "supplier receives exactly the trade amount");
    let release = d.view("get_release", json!({ "trade_id": t })).await?;
    assert!(release.to_string().contains("\"PAID\""), "{release}");
    let ledger = d.view("get_ledger", json!({ "trade_id": t })).await?;
    assert_eq!(ledger["funders"][buyer.id().as_str()]["released"], json!((3 * NEAR).to_string()));
    assert_eq!(ledger["funders"][treasury.id().as_str()]["released"], json!((2 * NEAR).to_string()));
    assert_eq!(ledger["funders"][treasury.id().as_str()]["quarantined"], json!(NEAR.to_string()));
    assert_eq!(ledger["conservation"], json!(true));

    // The private settlement callback cannot be called by anyone else, and nothing releases twice.
    let forged = buyer
        .call(d.escrow.id(), "on_release_transfer")
        .args_json(json!({ "trade_id": t, "release_intent_id": id, "attempt_id": "rla_00000000000000000000000000000000" }))
        .transact()
        .await?;
    assert!(format!("{:?}", forged.failures()).contains("is private"));
    assert_eq!(d.refused(&relayer, "execute_release", execute_release_args(d.rec(), &id), 0).await?, "INVALID_STATE");
    Ok(())
}

#[tokio::test]
async fn t008_t009_refunds_return_exact_value_to_the_original_funder_only() -> Result<()> {
    let mut d = Dock::start("refunds", 5 * NEAR, HOUR).await?;
    let (relayer, buyer, treasury) = (d.relayer.clone(), d.buyer.clone(), d.treasury.clone());
    let t = d.trade_id();
    let reg = register_args(&d.fx);
    d.ok(&relayer, "register_trade", reg, 0).await?;
    d.ok(&buyer, "fund", fund_args(&t, &d.rec().terms_digest), 3 * NEAR).await?;
    d.ok(&treasury, "fund", fund_args(&t, &d.rec().terms_digest), 3 * NEAR).await?;
    // Treasury overfunded by 1 NEAR: QUARANTINED for that funder.
    let ledger = d.view("get_ledger", json!({ "trade_id": t })).await?;
    assert_eq!(ledger["funders"][treasury.id().as_str()]["quarantined"], json!(NEAR.to_string()));

    // T-008 EXCESS_FUNDING_RETURN: only the original funder's own transaction may request it.
    let now = d.now().await?;
    let req = refund_request(&d.fx, d.rec(), "excess", "EXCESS_FUNDING_RETURN", treasury.id().as_str(), NEAR, "QUARANTINED", "FUNDER", now);
    let args = request_refund_args(&d.fx, d.rec(), &req, &[]);
    assert_eq!(d.refused(&relayer, "request_refund", args.clone(), 0).await?, "FORBIDDEN");
    d.ok(&treasury, "request_refund", args, 0).await?;
    let rid = refund_id(&d.fx, "excess");
    // The one-hour cooling period runs on chain time.
    let excess_window = d.rec().refunds[&rid].deadline.expect("timelocked");
    if d.now().await? < excess_window {
        assert_eq!(d.refused(&relayer, "authorize_refund", refund_op_args(d.rec(), &rid), 0).await?, "DELAY_NOT_ELAPSED");
    }
    d.net.hours(1).await?;
    d.ok(&relayer, "authorize_refund", refund_op_args(d.rec(), &rid), 0).await?;
    let before = d.net.balance(treasury.id()).await?;
    let r = d.ok(&relayer, "execute_refund", refund_op_args(d.rec(), &rid), 0).await?;
    assert_eq!(r.value["settled"], json!(true));
    assert_eq!(r.value["scheduled"]["transfer"]["to"], json!(treasury.id().as_str()));
    assert_eq!(d.net.balance(treasury.id()).await? - before, NEAR, "the original funder receives exactly the excess");

    // T-009 MUTUAL_CANCEL: buyer request, supplier cosignature over the same digest, cooling,
    // then each funder's available value returns to that funder.
    let now = d.now().await?;
    let req = refund_request(&d.fx, d.rec(), "cancel-buyer", "MUTUAL_CANCEL", buyer.id().as_str(), 3 * NEAR, "AVAILABLE", "BUYER", now);
    // A request without the initiator's signature is refused.
    assert_eq!(d.refused(&relayer, "request_refund", request_refund_args(&d.fx, d.rec(), &req, &[]), 0).await?, "SIGNATURE_INVALID");
    d.ok(&relayer, "request_refund", request_refund_args(&d.fx, d.rec(), &req, &["buyer"]), 0).await?;
    let rid = refund_id(&d.fx, "cancel-buyer");
    assert_eq!(d.refused(&relayer, "authorize_refund", refund_op_args(d.rec(), &rid), 0).await?, "INVALID_STATE");
    let mut wrong = cosign_refund_args(&d.fx, d.rec(), &req, "SUPPLIER");
    wrong["signature"] = json!(d.fx.sign("risk", "dockside/refund-request", &req));
    assert_eq!(d.refused(&relayer, "cosign_refund", wrong, 0).await?, "SIGNATURE_INVALID");
    d.ok(&relayer, "cosign_refund", cosign_refund_args(&d.fx, d.rec(), &req, "SUPPLIER"), 0).await?;
    d.net.hours(1).await?;
    d.ok(&relayer, "authorize_refund", refund_op_args(d.rec(), &rid), 0).await?;
    let before = d.net.balance(buyer.id()).await?;
    d.ok(&relayer, "execute_refund", refund_op_args(d.rec(), &rid), 0).await?;
    assert_eq!(d.net.balance(buyer.id()).await? - before, 3 * NEAR, "the buyer gets back exactly its own deposit");
    let refunds = d.view("get_refunds", json!({ "trade_id": t })).await?;
    assert_eq!(refunds.as_array().map(|r| r.iter().filter(|x| x["state"] == json!("REFUNDED")).count()), Some(2));
    let ledger = d.view("get_ledger", json!({ "trade_id": t })).await?;
    assert_eq!(ledger["funders"][buyer.id().as_str()]["refunded"], json!((3 * NEAR).to_string()));
    assert_eq!(ledger["funders"][treasury.id().as_str()]["refunded"], json!(NEAR.to_string()));
    assert_eq!(ledger["conservation"], json!(true));
    Ok(())
}

#[tokio::test]
async fn t020_t021_t042_dual_consent_delayed_destination_change_redirects_the_release() -> Result<()> {
    let mut d = Dock::start("destination", 5 * NEAR, HOUR).await?;
    funded_and_inspected(&mut d).await?;
    let relayer = d.relayer.clone();
    let alt = d.alt.id().to_string();
    let intent = intent_args(&d.fx, d.rec(), d.now().await?, "first");
    let first = d.ok(&relayer, "create_release_intent", intent, 0).await?.value["releaseIntentId"].as_str().expect("id").to_string();
    let ap = approval_args(&d.fx, d.rec(), &first, d.now().await?, "first");
    d.ok(&relayer, "approve_release", ap, 0).await?;

    // T-020: a forged proposal (another key) is refused; a unilateral proposal cannot activate.
    let forged = propose_destination_args(&d.fx, d.rec(), &alt, "SUPPLIER", "buyer");
    assert_eq!(d.refused(&relayer, "propose_destination_change", forged, 0).await?, "SIGNATURE_INVALID");
    let p = propose_destination_args(&d.fx, d.rec(), &alt, "SUPPLIER", "supplier");
    d.ok(&relayer, "propose_destination_change", p, 0).await?;
    let act = activate_destination_args(&d.fx, d.rec(), &alt);
    assert_eq!(d.refused(&relayer, "activate_destination_change", act.clone(), 0).await?, "INVALID_STATE");
    let c = consent_destination_args(&d.fx, d.rec(), &alt, "BUYER", "buyer");
    d.ok(&relayer, "consent_destination_change", c, 0).await?;
    // The signed one-hour delay is enforced on chain time.
    assert_eq!(d.refused(&relayer, "activate_destination_change", act.clone(), 0).await?, "DELAY_NOT_ELAPSED");
    d.net.hours(1).await?;
    let a = d.ok(&relayer, "activate_destination_change", act, 0).await?;
    let successor = a.value["successorIntent"].as_str().expect("successor intent").to_string();
    let trade = d.view("get_trade", json!({ "trade_id": d.trade_id() })).await?;
    assert_eq!((trade["revision"].clone(), trade["payoutDestination"].clone()), (json!(2), json!(alt)));

    // T-021: the old intent, approval, manifest and inspection no longer count.
    assert_eq!(d.refused(&relayer, "execute_release", execute_release_args(d.rec(), &first), 0).await?, "INVALID_STATE");
    assert_eq!(d.refused(&relayer, "execute_release", execute_release_args(d.rec(), &successor), 0).await?, "MANIFEST_NOT_CURRENT");
    let att = attestation_args(&d.fx, d.rec(), next_manifest_revision(d.rec()), d.now().await?, "m2");
    d.ok(&relayer, "submit_manifest_attestation", att, 0).await?;
    let ins = inspection_args(&d.fx, d.rec(), "PASS", d.now().await?, "m2");
    d.ok(&relayer, "submit_inspection", ins, 0).await?;
    let ap = approval_args(&d.fx, d.rec(), &successor, d.now().await?, "second");
    d.ok(&relayer, "approve_release", ap, 0).await?;

    // T-042: the release goes to the new bound destination; the old one receives nothing.
    let (alt_before, supplier_before) = (d.net.balance(d.alt.id()).await?, d.net.balance(d.supplier.id()).await?);
    let sent = d.ok(&relayer, "execute_release", execute_release_args(d.rec(), &successor), 0).await?;
    assert_eq!(sent.value["settled"], json!(true));
    assert_eq!(d.net.balance(d.alt.id()).await? - alt_before, 5 * NEAR);
    assert_eq!(d.net.balance(d.supplier.id()).await?, supplier_before);
    Ok(())
}

#[tokio::test]
async fn m31_a_revoked_destination_consent_cannot_be_replayed_from_public_arguments() -> Result<()> {
    // External security audit m31: the consent signatures are public transaction arguments.
    let mut d = Dock::start("dest-replay", 5 * NEAR, HOUR).await?;
    funded_and_inspected(&mut d).await?;
    let relayer = d.relayer.clone();
    let alt = d.alt.id().to_string();
    let propose = propose_destination_args(&d.fx, d.rec(), &alt, "SUPPLIER", "supplier");
    let consent = consent_destination_args(&d.fx, d.rec(), &alt, "BUYER", "buyer");
    let act = activate_destination_args(&d.fx, d.rec(), &alt);
    d.ok(&relayer, "propose_destination_change", propose.clone(), 0).await?;
    d.ok(&relayer, "consent_destination_change", consent.clone(), 0).await?;
    // The buyer withdraws its consent with a signed revocation.
    let rv = revoke_destination_args(&d.fx, d.rec(), &alt, "BUYER", "buyer", d.now().await?, "rv");
    d.ok(&relayer, "revoke_destination_change", rv, 0).await?;
    // Anyone resubmits the same arguments: the proposal comes back, the withdrawn consent does not.
    d.ok(&relayer, "propose_destination_change", propose, 0).await?;
    assert_eq!(d.refused(&relayer, "consent_destination_change", consent, 0).await?, "NONCE_REPLAYED");
    d.net.hours(1).await?;
    assert_eq!(d.refused(&relayer, "activate_destination_change", act, 0).await?, "INVALID_STATE");
    let trade = d.view("get_trade", json!({ "trade_id": d.trade_id() })).await?;
    assert_eq!((trade["revision"].clone(), trade["payoutDestination"].clone()), (json!(1), json!(d.supplier.id().to_string())));
    Ok(())
}

#[tokio::test]
async fn t051_unexpected_nep141_returns_to_the_proven_sender_after_the_72_hour_window() -> Result<()> {
    let mut d = Dock::start("assets", 5 * NEAR, HOUR).await?;
    let relayer = d.relayer.clone();
    let reg = register_args(&d.fx);
    d.ok(&relayer, "register_trade", reg, 0).await?;
    let (buyer, t) = (d.buyer.clone(), d.trade_id());
    d.ok(&buyer, "fund", fund_args(&t, &d.rec().terms_digest), 5 * NEAR).await?;
    let ledger_before = d.view("get_ledger", json!({ "trade_id": t })).await?;

    // A real NEP-141 contract; the sender holds the whole supply.
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
    let amount: u128 = 5_000_000;
    let sent = sender
        .call(token.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": d.escrow.id(), "amount": amount.to_string(), "memo": null, "msg": "pay trade" }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await?;
    assert!(sent.is_success(), "{:?}", sent.failures());
    d.observe_ft_on_transfer(&sent, token.id(), sender.id(), amount, "pay trade").await?;
    let (worker, token_id) = (d.net.worker.clone(), token.id().clone());
    let balance = move |who: near_workspaces::AccountId| {
        let (w, tok) = (worker.clone(), token_id.clone());
        async move {
            let v: serde_json::Value = w.view(&tok, "ft_balance_of").args_json(json!({ "account_id": who })).await?.json()?;
            anyhow::Ok(v.as_str().unwrap_or_default().parse::<u128>()?)
        }
    };
    // Kept and recorded for review, never credited to the native trade value.
    assert_eq!(balance(d.escrow.id().clone()).await?, amount);
    assert_eq!(d.view("get_ledger", json!({ "trade_id": t })).await?, ledger_before);
    let asset = d.mirror.asset(0).map_err(|e| anyhow::anyhow!("{e}"))?;
    assert_eq!(asset.claimed_sender, sender.id().as_str());

    // Proof of control: only the claimed sender's own transaction may request the recovery.
    let req = asset_request_args(&d.fx, d.rec(), &asset, d.now().await?, "a");
    assert_eq!(d.refused(&relayer, "request_asset_recovery", req.clone(), 0).await?, "FORBIDDEN");
    d.ok(&sender, "request_asset_recovery", req, 0).await?;
    let asset = d.mirror.asset(0).map_err(|e| anyhow::anyhow!("{e}"))?;
    let ap = asset_approval_args(&d.fx, d.rec(), &asset, d.now().await?, "a");
    d.ok(&relayer, "approve_asset_recovery", ap, 0).await?;
    let asset = d.mirror.asset(0).map_err(|e| anyhow::anyhow!("{e}"))?;
    let exec = execute_asset_recovery_args(&asset);
    assert_eq!(d.refused(&relayer, "execute_asset_recovery", exec.clone(), 1).await?, "DELAY_NOT_ELAPSED");
    d.net.hours(72).await?;
    // The adapter needs exactly one yoctoNEAR from the executor, never escrow value.
    assert_eq!(d.refused(&relayer, "execute_asset_recovery", exec.clone(), 0).await?, "INVALID_AMOUNT");
    let r = d.ok(&relayer, "execute_asset_recovery", exec, 1).await?;
    assert_eq!(r.value["settled"], json!(true));
    assert_eq!(balance(sender.id().clone()).await?, 1_000_000_000, "the sender has its full supply back");
    assert_eq!(balance(d.escrow.id().clone()).await?, 0);
    let view = d.view("get_unexpected_asset", json!({ "asset_index": 0 })).await?;
    assert_eq!(view["state"], json!("RECOVERED"));
    assert_eq!(d.view("get_ledger", json!({ "trade_id": t })).await?, ledger_before, "native value untouched");
    Ok(())
}

#[tokio::test]
async fn t031_a_native_transfer_the_runtime_refunds_settles_failed_and_restores_the_exact_reservation() -> Result<()> {
    let mut d = Dock::start("ghost", 5 * NEAR, HOUR).await?;
    // The bound supplier destination is a valid name nobody created: nearcore refunds the
    // transfer to the escrow, which is the authoritative no-transfer proof.
    d.fx.accounts.supplier = "ghost-supplier.testnet".into();
    funded_and_inspected(&mut d).await?;
    let relayer = d.relayer.clone();
    let intent = intent_args(&d.fx, d.rec(), d.now().await?, "ghost");
    let id = d.ok(&relayer, "create_release_intent", intent, 0).await?.value["releaseIntentId"].as_str().expect("id").to_string();
    let ap = approval_args(&d.fx, d.rec(), &id, d.now().await?, "ghost");
    d.ok(&relayer, "approve_release", ap, 0).await?;
    let escrow_before = d.net.balance(d.escrow.id()).await?;
    let sent = d.ok(&relayer, "execute_release", execute_release_args(d.rec(), &id), 0).await?;
    assert_eq!(sent.value["settled"], json!(false), "the settlement callback saw the refunded transfer");
    let release = d.view("get_release", json!({ "trade_id": d.trade_id() })).await?;
    assert!(release.to_string().contains("\"FAILED\""), "{release}");
    let ledger = d.view("get_ledger", json!({ "trade_id": d.trade_id() })).await?;
    assert_eq!(ledger["totals"]["reserved"], json!("0"));
    assert_eq!(ledger["totals"]["available"], json!((5 * NEAR).to_string()));
    assert_eq!(ledger["totals"]["released"], json!("0"));
    // The value came back: the escrow's balance moved only by storage and gas rewards, never by
    // the trade amount.
    let escrow_after = d.net.balance(d.escrow.id()).await?;
    assert!(escrow_after.abs_diff(escrow_before) < NEAR / 100, "{escrow_before} -> {escrow_after}");
    Ok(())
}
