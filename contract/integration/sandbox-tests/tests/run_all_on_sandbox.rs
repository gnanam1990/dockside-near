//! Validation of `scripts/testnet-deploy/run-all` end to end against a local near-sandbox node
//! (`--network sandbox`), so the one-command testnet flow is known to work before anyone runs it
//! on testnet. It is never pointed at testnet here.
//!
//! The test plays the user's part before the script: it creates the four accounts with real
//! create-account transactions and puts their keys in a temporary near-cli-rs keychain
//! (`~/.near-credentials/sandbox/<account>.json`, the legacy keychain near-cli-rs falls back to).
//! Then it runs the script as the user would and checks the chain itself, not only the script's
//! own report.
//!
//! Needs `DOCKSIDE_NEAR_CLI` (near-cli-rs), `DOCKSIDE_ESCROW_WASM` and `DOCKSIDE_BUILD_MANIFEST`
//! (the container build and its manifest), node and cargo; scripts/sandbox/container-sandbox.sh
//! provides all of them. Ignored by a plain `cargo test` for that reason.

use anyhow::{bail, Context, Result};
use dockside_sandbox_tests::*;
use serde_json::{json, Value as J};
use std::path::{Path, PathBuf};
use std::process::Command;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..").canonicalize().expect("repo root")
}

fn env(k: &str) -> Result<String> {
    std::env::var(k).with_context(|| format!("{k} must be set (scripts/sandbox/container-sandbox.sh sets it)"))
}

struct Keychain {
    home: PathBuf,
}

impl Keychain {
    /// A temporary HOME whose near-cli-rs config has only a `sandbox` connection to `rpc`.
    fn new(rpc: &str) -> Result<Keychain> {
        let home = std::env::temp_dir().join(format!("dockside-run-all-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(home.join(".config/near-cli"))?;
        std::fs::create_dir_all(home.join(".near-credentials/sandbox"))?;
        let creds = home.join(".near-credentials");
        let config = format!(
            "version = \"5\"\ncredentials_home_dir = \"{}\"\n\n[network_connection.sandbox]\nnetwork_name = \"sandbox\"\nrpc_url = \"{rpc}/\"\nwallet_url = \"{rpc}/\"\nexplorer_transaction_url = \"{rpc}/\"\n",
            creds.display()
        );
        std::fs::write(home.join(".config/near-cli/config.toml"), config)?;
        Ok(Keychain { home })
    }

    /// Save an account's full-access key where near-cli-rs `sign-with-keychain` finds it.
    fn save(&self, name: &str, account: &str) -> Result<()> {
        let (sk, pk) = derived_secret(name);
        let key = json!({ "account_id": account, "public_key": pk, "private_key": sk });
        std::fs::write(self.home.join(format!(".near-credentials/sandbox/{account}.json")), key.to_string())?;
        Ok(())
    }
}

impl Drop for Keychain {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.home);
    }
}

struct Run {
    status: i32,
    log: String,
    out: PathBuf,
}

fn run_all(kc: &Keychain, accounts: &[(&str, String)], args: &[&str], out: &str) -> Result<Run> {
    let out = kc.home.join(out);
    let mut full: Vec<String> = args.iter().map(|a| a.to_string()).collect();
    full.extend(["--out".to_string(), out.to_string_lossy().to_string()]);
    run_cmd(kc, accounts, &full, out)
}

/// `run-all --resume <out> [extra]`: everything else comes from the run directory.
fn resume(kc: &Keychain, accounts: &[(&str, String)], out: &Path, extra: &[&str]) -> Result<Run> {
    let mut full = vec!["--resume".to_string(), out.to_string_lossy().to_string()];
    full.extend(extra.iter().map(|a| a.to_string()));
    run_cmd(kc, accounts, &full, out.to_path_buf())
}

fn run_cmd(kc: &Keychain, accounts: &[(&str, String)], args: &[String], out: PathBuf) -> Result<Run> {
    let mut cmd = Command::new("sh");
    cmd.arg(repo_root().join("scripts/testnet-deploy/run-all"))
        .args(args)
        .env("HOME", &kc.home)
        .env("NEAR_CLI", env("DOCKSIDE_NEAR_CLI")?)
        .current_dir(repo_root());
    for (k, v) in accounts {
        cmd.env(k, v);
    }
    let o = cmd.output()?;
    let log = format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr));
    eprintln!("{log}");
    Ok(Run { status: o.status.code().unwrap_or(-1), log, out })
}

fn read(p: &Path) -> Result<J> {
    Ok(serde_json::from_slice(&std::fs::read(p).with_context(|| p.display().to_string())?)?)
}

#[tokio::test]
#[ignore = "needs near-cli-rs, the container-built wasm and its manifest (scripts/sandbox/container-sandbox.sh)"]
async fn run_all_deploys_verifies_configures_the_relayer_and_completes_the_journey_on_sandbox() -> Result<()> {
    let wasm = env("DOCKSIDE_ESCROW_WASM")?;
    let manifest_path = env("DOCKSIDE_BUILD_MANIFEST")?;
    let manifest = read(Path::new(&manifest_path))?;
    let want_hash = manifest["contract"]["nearCodeHash"].as_str().context("manifest code hash")?.to_string();

    let net = Net::start().await?;
    let rpc = net.worker.rpc_addr().trim_end_matches('/').to_string();
    let kc = Keychain::new(&rpc)?;
    // The user's part: four accounts, created by real transactions, keys in the keychain.
    let mut ids = Vec::new();
    for (name, near) in [("run-escrow", 20), ("run-buyer", 10), ("run-supplier", 5), ("run-relayer", 5)] {
        let a = net.account(name, near).await?;
        kc.save(name, a.id().as_str())?;
        ids.push(a.id().clone());
    }
    let accounts = vec![
        ("DOCKSIDE_ESCROW_ACCOUNT", ids[0].to_string()),
        ("DOCKSIDE_BUYER_ACCOUNT", ids[1].to_string()),
        ("DOCKSIDE_SUPPLIER_ACCOUNT", ids[2].to_string()),
        ("DOCKSIDE_RELAYER_ACCOUNT", ids[3].to_string()),
    ];
    let base = ["--network", "sandbox", "--rpc-url", rpc.as_str(), "--wasm", wasm.as_str(), "--manifest", manifest_path.as_str()];

    // Refusals happen before any transaction: mainnet, a non-loopback sandbox RPC, a wrong wasm.
    let r = run_all(&kc, &accounts, &["--network", "mainnet"], "refused-mainnet")?;
    assert_eq!(r.status, 2, "{}", r.log);
    assert!(r.log.contains("NETWORK_REFUSED"));
    let r = run_all(&kc, &accounts, &["--network", "sandbox", "--rpc-url", "http://10.1.2.3:3030"], "refused-host")?;
    assert_eq!(r.status, 2, "{}", r.log);
    assert!(r.log.contains("loopback"));
    let other = kc.home.join("other.wasm");
    std::fs::write(&other, b"\0asm\x01\0\0\0")?;
    let other_s = other.to_string_lossy().to_string();
    let r = run_all(&kc, &accounts, &["--network", "sandbox", "--rpc-url", &rpc, "--wasm", &other_s, "--manifest", &manifest_path], "refused-wasm")?;
    assert_eq!(r.status, 2, "{}", r.log);
    assert!(r.log.contains("WASM_MISMATCH"));
    assert_eq!(net.code_hash_of(&ids[0]).await.ok(), None, "nothing was deployed by a refused run");

    // The real run.
    let supplier_before = net.balance(&ids[2]).await?;
    let amount: u128 = 50_000_000_000_000_000_000_000;
    let r = run_all(&kc, &accounts, &base, "run-1")?;
    if r.status != 0 {
        bail!("run-all failed ({}):\n{}", r.status, r.log);
    }
    let rec = read(&r.out.join("run-record.json"))?;
    assert_eq!(rec["network"], json!("sandbox"));
    assert_eq!(rec["deployment"]["onChainCodeHash"], json!(want_hash));
    assert_eq!(rec["relayer"]["receiverId"], json!(ids[0].as_str()));
    assert_eq!(rec["relayer"]["methodNames"], json!([]));
    assert_eq!(rec["journey"]["ok"], json!(true));
    let txs = rec["journey"]["transactions"].as_array().context("transactions")?;
    let methods: Vec<&str> = txs.iter().filter_map(|t| t["method"].as_str()).collect();
    assert_eq!(
        methods,
        ["register_trade", "register_evidence_policy", "fund", "submit_manifest_attestation", "submit_inspection", "create_release_intent", "approve_release", "execute_release"]
    );
    // Funding was signed by the buyer's own account; everything else by the relayer key.
    for t in txs {
        let want = if t["method"] == json!("fund") { ids[1].as_str() } else { ids[3].as_str() };
        assert_eq!(t["signer"], json!(want));
    }
    // Checked on chain, independently of the script's report.
    assert_eq!(net.code_hash_of(&ids[0]).await?, want_hash);
    assert_eq!(net.balance(&ids[2]).await? - supplier_before, amount, "supplier received exactly the trade amount");
    let trade = rec["journey"]["tradeId"].as_str().context("trade id")?;
    let release: J = net.worker.view(&ids[0], "get_release").args_json(json!({ "trade_id": trade })).await?.json()?;
    assert!(release.to_string().contains("\"PAID\""));
    let keys = net.worker.view_access_keys(&ids[3]).await?;
    assert_eq!(keys.len(), 2, "the relayer has its full-access key and the new function-call key");

    // A second run against the same escrow must not redeploy; reusing the deployment and the
    // relayer key runs a second journey.
    let r = run_all(&kc, &accounts, &base, "run-2-refused")?;
    assert_eq!(r.status, 2, "{}", r.log);
    assert!(r.log.contains("ESCROW_NOT_EMPTY"));
    let key_file = std::fs::read_to_string(kc.home.join("run-1/relayer-key.txt"))?;
    let key_file = key_file
        .lines()
        .filter_map(|l| l.split("saved in a file ").nth(1))
        .find(|p| p.contains("ed25519_"))
        .context("key file path")?
        .trim()
        .to_string();
    let mut again = base.to_vec();
    again.extend(["--skip-deploy", "--relayer-key-file", key_file.as_str()]);
    let r = run_all(&kc, &accounts, &again, "run-3")?;
    if r.status != 0 {
        bail!("run-all --skip-deploy failed ({}):\n{}", r.status, r.log);
    }
    let rec3 = read(&r.out.join("run-record.json"))?;
    assert_eq!(rec3["journey"]["ok"], json!(true));
    assert_ne!(rec3["journey"]["tradeId"], rec["journey"]["tradeId"]);
    assert_eq!(rec3["deployTx"], J::Null);

    // M42 hold journey, stopped on purpose after the hold SET (six transactions) and finished
    // with --resume from the run directory: the deterministic-policy hold blocks the release
    // until the risk/policy principal resolves it, then the trade is PAID.
    let mut hold = again.clone();
    hold.extend(["--journey", "hold", "--stop-after", "6"]);
    let r = run_all(&kc, &accounts, &hold, "run-hold")?;
    assert_eq!(r.status, 3, "{}", r.log);
    assert!(r.log.contains("PAUSED"), "{}", r.log);
    let hold_out = r.out.clone();
    seed_file_is_private(&hold_out)?;
    let paused = read(&hold_out.join("journey.json"))?;
    let hold_trade = paused["tradeId"].as_str().context("trade id")?.to_string();
    let holds: J = net.worker.view(&ids[0], "get_holds").args_json(json!({ "trade_id": hold_trade })).await?.json()?;
    assert_eq!(holds[0]["status"], json!("ACTIVE"), "{holds}");
    // A resumed run takes its settings from the run directory only.
    let r = resume(&kc, &accounts, &hold_out, &["--journey", "paid"])?;
    assert_eq!(r.status, 2, "{}", r.log);
    let supplier_before = net.balance(&ids[2]).await?;
    let r = resume(&kc, &accounts, &hold_out, &[])?;
    if r.status != 0 {
        bail!("run-all --resume (hold) failed ({}):\n{}", r.status, r.log);
    }
    let rec = read(&hold_out.join("run-record.json"))?;
    assert_eq!(rec["journey"]["kind"], json!("hold"));
    assert_eq!(rec["journey"]["ok"], json!(true));
    assert_eq!(rec["journey"]["tradeId"], json!(hold_trade));
    let methods: Vec<String> = rec["journey"]["transactions"]
        .as_array()
        .context("transactions")?
        .iter()
        .filter_map(|t| t["method"].as_str().map(str::to_string))
        .collect();
    assert_eq!(
        methods,
        [
            "register_trade",
            "register_evidence_policy",
            "fund",
            "submit_manifest_attestation",
            "submit_inspection",
            "set_hold",
            "create_release_intent",
            "resolve_hold",
            "approve_release",
            "execute_release"
        ]
    );
    for c in ["holdWasActive", "releaseBlockedByHold", "holdResolved", "deterministicPolicyHold", "supplierReceivedExactAmount"] {
        assert_eq!(rec["journey"]["checks"][c], json!(true), "{c}");
    }
    let holds: J = net.worker.view(&ids[0], "get_holds").args_json(json!({ "trade_id": hold_trade })).await?.json()?;
    assert_eq!(
        (holds[0]["status"].clone(), holds[0]["resolution"]["code"].clone(), holds[0]["issuerRole"].clone()),
        (json!("RESOLVED"), json!("RELEASE_HOLD"), json!("POLICY_SETTER"))
    );
    let release: J = net.worker.view(&ids[0], "get_release").args_json(json!({ "trade_id": hold_trade })).await?.json()?;
    assert!(release.to_string().contains("\"PAID\""));
    assert_eq!(net.balance(&ids[2]).await? - supplier_before, amount, "supplier received exactly the trade amount");

    // M42 refund journey: funded with an excess, MUTUAL_CANCEL and EXCESS_FUNDING_RETURN
    // requested, paused in the one-hour cooling period (--no-wait), the chain clock moved past it,
    // then --resume authorizes and executes both: every yoctoNEAR goes back to the buyer.
    let mut refund = again.clone();
    refund.extend(["--journey", "refund", "--no-wait"]);
    let supplier_before = net.balance(&ids[2]).await?;
    let r = run_all(&kc, &accounts, &refund, "run-refund")?;
    assert_eq!(r.status, 3, "{}", r.log);
    let refund_out = r.out.clone();
    seed_file_is_private(&refund_out)?;
    let refund_trade = read(&refund_out.join("journey.json"))?["tradeId"].as_str().context("trade id")?.to_string();
    let refunds: J = net.worker.view(&ids[0], "get_refunds").args_json(json!({ "trade_id": refund_trade })).await?.json()?;
    assert_eq!(refunds.as_array().map(|r| r.iter().filter(|x| x["state"] == json!("TIMELOCKED")).count()), Some(2), "{refunds}");
    net.hours(1).await?;
    let r = resume(&kc, &accounts, &refund_out, &[])?;
    if r.status != 0 {
        bail!("run-all --resume (refund) failed ({}):\n{}", r.status, r.log);
    }
    let rec = read(&refund_out.join("run-record.json"))?;
    assert_eq!(rec["journey"]["kind"], json!("refund"));
    assert_eq!(rec["journey"]["ok"], json!(true));
    let txs = rec["journey"]["transactions"].as_array().context("transactions")?;
    let methods: Vec<&str> = txs.iter().filter_map(|t| t["method"].as_str()).collect();
    assert_eq!(
        methods,
        ["register_trade", "fund", "request_refund", "request_refund", "authorize_refund", "execute_refund", "authorize_refund", "execute_refund"]
    );
    // The buyer's own account funds and asks for its excess back; the relayer key does the rest.
    for t in txs {
        let own = t["method"] == json!("fund") || t["step"] == json!("refund:excess");
        assert_eq!(t["signer"], json!(if own { ids[1].as_str() } else { ids[3].as_str() }), "{t}");
    }
    let refunds: J = net.worker.view(&ids[0], "get_refunds").args_json(json!({ "trade_id": refund_trade })).await?.json()?;
    let mut reasons: Vec<&str> = refunds
        .as_array()
        .context("refunds")?
        .iter()
        .filter(|x| x["state"] == json!("REFUNDED"))
        .filter_map(|x| x["reason"].as_str())
        .collect();
    reasons.sort();
    assert_eq!(reasons, ["EXCESS_FUNDING_RETURN", "MUTUAL_CANCEL"]);
    let ledger: J = net.worker.view(&ids[0], "get_ledger").args_json(json!({ "trade_id": refund_trade })).await?.json()?;
    let funded = (amount + 10_000_000_000_000_000_000_000).to_string();
    let buyer = &ledger["funders"][ids[1].as_str()];
    assert_eq!((buyer["funded"].clone(), buyer["refunded"].clone()), (json!(funded), json!(funded)), "{ledger}");
    for k in ["partial", "available", "reserved", "released", "refundLocked", "quarantined"] {
        assert_eq!(buyer[k], json!("0"), "{k}");
    }
    assert_eq!(ledger["totals"]["released"], json!("0"));
    assert_eq!(ledger["conservation"], json!(true));
    for c in ["buyerReceivedExactAmounts", "buyerRefundedEverything", "supplierUnchanged"] {
        assert_eq!(rec["journey"]["checks"][c], json!(true), "{c}");
    }
    assert_eq!(net.balance(&ids[2]).await?, supplier_before, "the supplier receives nothing");
    // A journey is never started a second time in the same run directory.
    let r = run_all(&kc, &accounts, &refund, "run-refund")?;
    assert_eq!(r.status, 2, "{}", r.log);
    assert!(r.log.contains("RUN_EXISTS"));
    Ok(())
}

/// The journey key seed is kept in the run directory, readable by the owner only.
fn seed_file_is_private(out: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mode = std::fs::metadata(out.join("journey-seed.json"))?.permissions().mode() & 0o777;
    if mode != 0o600 {
        bail!("journey-seed.json has mode {mode:o}, not 600");
    }
    Ok(())
}

/* ------------------- M50: --asset usdc and the near-mainnet label ------------------- */

/// A real NEP-141 contract `<name>.<root>` (the workspace test token, 6 decimals) whose whole
/// supply of 1000 tokens `owner` holds.
async fn deploy_token(net: &Net, root: &near_workspaces::Account, name: &str, owner: &near_workspaces::AccountId) -> Result<near_workspaces::Account> {
    let token = net.account_under(root, name, 20).await?;
    token.deploy(&token_wasm()?).await?.into_result()?;
    token
        .call(token.id(), "new")
        .args_json(json!({ "owner_id": owner, "total_supply": (1_000 * USDC).to_string() }))
        .transact()
        .await?
        .into_result()?;
    Ok(token)
}

async fn ft_balance(net: &Net, token: &near_workspaces::AccountId, who: &near_workspaces::AccountId) -> Result<u128> {
    let v: J = net.worker.view(token, "ft_balance_of").args_json(json!({ "account_id": who })).await?.json()?;
    Ok(v.as_str().unwrap_or_default().parse()?)
}

async fn registered(net: &Net, token: &near_workspaces::AccountId, who: &near_workspaces::AccountId) -> Result<bool> {
    let v: J = net.worker.view(token, "storage_balance_of").args_json(json!({ "account_id": who })).await?.json()?;
    Ok(!v.is_null())
}

fn methods(rec: &J) -> Vec<String> {
    rec["journey"]["transactions"].as_array().map(|t| t.iter().filter_map(|x| x["method"].as_str().map(str::to_string)).collect()).unwrap_or_default()
}

fn saved_key_file(kc: &Keychain, run: &str) -> Result<String> {
    let text = std::fs::read_to_string(kc.home.join(run).join("relayer-key.txt"))?;
    Ok(text
        .lines()
        .filter_map(|l| l.split("saved in a file ").nth(1))
        .find(|p| p.contains("ed25519_"))
        .context("key file path")?
        .trim()
        .to_string())
}

/// Four accounts under `root`, their keys in the keychain, and the run-all environment.
async fn run_accounts(net: &Net, kc: &Keychain, root: &near_workspaces::Account, prefix: &str) -> Result<(Vec<near_workspaces::AccountId>, Vec<(&'static str, String)>)> {
    let mut ids = Vec::new();
    for (role, near) in [("escrow", 20), ("buyer", 10), ("supplier", 5), ("relayer", 5)] {
        let name = format!("{prefix}-{role}");
        let a = net.account_under(root, &name, near).await?;
        kc.save(&name, a.id().as_str())?;
        ids.push(a.id().clone());
    }
    let env = vec![
        ("DOCKSIDE_ESCROW_ACCOUNT", ids[0].to_string()),
        ("DOCKSIDE_BUYER_ACCOUNT", ids[1].to_string()),
        ("DOCKSIDE_SUPPLIER_ACCOUNT", ids[2].to_string()),
        ("DOCKSIDE_RELAYER_ACCOUNT", ids[3].to_string()),
    ];
    Ok((ids, env))
}

#[tokio::test]
#[ignore = "needs near-cli-rs, the container-built wasm and its manifest (scripts/sandbox/container-sandbox.sh)"]
async fn run_all_runs_the_usdc_journeys_and_the_mainnet_label_on_sandbox() -> Result<()> {
    let wasm = env("DOCKSIDE_ESCROW_WASM")?;
    let manifest_path = env("DOCKSIDE_BUILD_MANIFEST")?;
    let net = Net::start().await?;
    let rpc = net.worker.rpc_addr().trim_end_matches('/').to_string();
    let kc = Keychain::new(&rpc)?;

    /* ---- testnet label: every journey in a real NEP-141 token ---- */
    let (ids, accounts) = run_accounts(&net, &kc, &net.testnet, "usdc").await?;
    let (escrow, buyer, supplier) = (&ids[0], &ids[1], &ids[2]);
    let token = deploy_token(&net, &net.testnet, "run-usdc", buyer).await?;
    let token_id = token.id().to_string();
    let base = [
        "--network",
        "sandbox",
        "--rpc-url",
        rpc.as_str(),
        "--wasm",
        wasm.as_str(),
        "--manifest",
        manifest_path.as_str(),
        "--asset",
        "usdc",
        "--token",
        token_id.as_str(),
        "--cap-token-units",
        "6000000",
    ];

    // Refusals before anything is sent: no token, mixed-up amount flags, wrong decimals.
    let r = run_all(&kc, &accounts, &["--network", "sandbox", "--rpc-url", &rpc, "--asset", "usdc"], "usdc-refused-token")?;
    assert_eq!(r.status, 2, "{}", r.log);
    assert!(r.log.contains("--asset usdc needs --token"), "{}", r.log);
    let mut mixed = base.to_vec();
    mixed.extend(["--amount-yocto", "50000000000000000000000"]);
    let r = run_all(&kc, &accounts, &mixed, "usdc-refused-amount")?;
    assert_eq!(r.status, 2, "{}", r.log);
    assert!(r.log.contains("--amount-units"), "{}", r.log);
    let mut decimals = base.to_vec();
    decimals.extend(["--token-decimals", "18"]);
    let r = run_all(&kc, &accounts, &decimals, "usdc-refused-decimals")?;
    assert_eq!(r.status, 2, "{}", r.log);
    assert!(r.log.contains("TOKEN_INVALID"), "{}", r.log);
    // More than the cap this deployment would get.
    let mut over = base.to_vec();
    over.extend(["--amount-units", "6000001"]);
    let r = run_all(&kc, &accounts, &over, "usdc-refused-cap")?;
    assert_eq!(r.status, 2, "{}", r.log);
    assert!(r.log.contains("EXPOSURE_EXCEEDED"), "{}", r.log);

    // Dry run: the checks and the value plan, and nothing on chain.
    let start = ft_balance(&net, token.id(), buyer).await?;
    let mut dry = base.to_vec();
    dry.push("--dry-run");
    let r = run_all(&kc, &accounts, &dry, "usdc-dry")?;
    assert_eq!(r.status, 0, "{}", r.log);
    assert!(r.log.contains("DRY RUN: nothing was sent"), "{}", r.log);
    assert!(r.log.contains("value plan (nothing has been sent yet)"), "{}", r.log);
    let fund_line = format!("fund the trade (ft_transfer_call on the token): 5000000 units of {token_id} (5 tokens) plus 1 yoctoNEAR; {buyer} -> {escrow}");
    assert!(r.log.contains(&fund_line), "{}", r.log);
    assert!(r.log.contains(&format!("release: 5000000 units of {token_id} (5 tokens); {escrow} -> {supplier}")), "{}", r.log);
    assert!(r.log.contains(&format!("register {supplier} with the token")), "{}", r.log);
    let pre = read(&r.out.join("preflight.json"))?;
    assert_eq!(pre["registrations"], json!([escrow.as_str(), supplier.as_str()]));
    assert_eq!(pre["heldAtMost"], json!("5000000"));
    assert_eq!(net.code_hash_of(escrow).await.ok(), None, "a dry run deploys nothing");
    assert!(!registered(&net, token.id(), escrow).await?, "a dry run registers nobody");
    assert_eq!(ft_balance(&net, token.id(), buyer).await?, start);
    assert_eq!(net.worker.view_access_keys(&ids[3]).await?.len(), 1, "a dry run adds no key");

    // Paid in the token.
    let r = run_all(&kc, &accounts, &base, "usdc-paid")?;
    if r.status != 0 {
        bail!("run-all --asset usdc failed ({}):\n{}", r.status, r.log);
    }
    let rec = read(&r.out.join("run-record.json"))?;
    assert_eq!(rec["journey"]["ok"], json!(true));
    assert_eq!(rec["asset"], json!({ "kind": "nep141", "token": { "accountId": token_id, "decimals": 6 } }));
    assert_eq!(rec["contractNetwork"], json!("near-testnet"));
    assert_eq!(
        methods(&rec),
        [
            "register_trade",
            "register_evidence_policy",
            "ft_transfer_call",
            "submit_manifest_attestation",
            "submit_inspection",
            "check_payee_storage",
            "create_release_intent",
            "approve_release",
            "execute_release"
        ]
    );
    for t in rec["journey"]["transactions"].as_array().context("transactions")? {
        let want = if t["method"] == json!("ft_transfer_call") { buyer.as_str() } else { ids[3].as_str() };
        assert_eq!(t["signer"], json!(want), "{t}");
    }
    let cfg = &rec["deployment"]["config"];
    assert_eq!(cfg["nep141Token"], json!({ "accountId": token_id, "decimals": 6 }));
    assert_eq!(cfg["maxTradeAmount"]["nep141"], json!("6000000"));
    // Checked on chain, independently of what the script reported.
    assert!(registered(&net, token.id(), escrow).await? && registered(&net, token.id(), supplier).await?);
    assert_eq!(ft_balance(&net, token.id(), supplier).await?, 5 * USDC, "the supplier received exactly the trade amount in the token");
    assert_eq!(ft_balance(&net, token.id(), buyer).await?, start - 5 * USDC);
    assert_eq!(ft_balance(&net, token.id(), escrow).await?, 0);
    let trade = rec["journey"]["tradeId"].as_str().context("trade id")?;
    let ledger: J = net.worker.view(escrow, "get_ledger").args_json(json!({ "trade_id": trade })).await?.json()?;
    assert_eq!(ledger["asset"]["tokenAccountId"], json!(token_id));
    assert_eq!(ledger["totals"]["released"], json!("5000000"));

    // Hold then paid, reusing the deployment and the relayer key.
    let key_file = saved_key_file(&kc, "usdc-paid")?;
    let mut again = base.to_vec();
    again.extend(["--skip-deploy", "--relayer-key-file", key_file.as_str()]);
    let mut hold = again.clone();
    hold.extend(["--journey", "hold"]);
    let r = run_all(&kc, &accounts, &hold, "usdc-hold")?;
    if r.status != 0 {
        bail!("run-all --asset usdc --journey hold failed ({}):\n{}", r.status, r.log);
    }
    let rec = read(&r.out.join("run-record.json"))?;
    for c in ["holdWasActive", "releaseBlockedByHold", "holdResolved", "deterministicPolicyHold", "supplierReceivedExactAmount"] {
        assert_eq!(rec["journey"]["checks"][c], json!(true), "{c}");
    }
    assert!(methods(&rec).contains(&"check_payee_storage".to_string()));
    assert_eq!(ft_balance(&net, token.id(), supplier).await?, 10 * USDC);

    // Refund: 5 + 1 excess in, paused in the cooling period, the clock moved, both refunds back.
    let before = ft_balance(&net, token.id(), buyer).await?;
    let mut refund = again.clone();
    refund.extend(["--journey", "refund", "--no-wait"]);
    let r = run_all(&kc, &accounts, &refund, "usdc-refund")?;
    assert_eq!(r.status, 3, "{}", r.log);
    let refund_out = r.out.clone();
    assert_eq!(ft_balance(&net, token.id(), buyer).await?, before - 6 * USDC);
    assert_eq!(ft_balance(&net, token.id(), escrow).await?, 6 * USDC);
    net.hours(1).await?;
    let r = resume(&kc, &accounts, &refund_out, &[])?;
    if r.status != 0 {
        bail!("run-all --resume (usdc refund) failed ({}):\n{}", r.status, r.log);
    }
    let rec = read(&refund_out.join("run-record.json"))?;
    assert_eq!(rec["journey"]["ok"], json!(true));
    assert_eq!(
        methods(&rec),
        ["register_trade", "ft_transfer_call", "request_refund", "request_refund", "authorize_refund", "execute_refund", "authorize_refund", "execute_refund"]
    );
    for c in ["buyerReceivedExactAmounts", "buyerRefundedEverything", "supplierUnchanged", "ledgerConservation"] {
        assert_eq!(rec["journey"]["checks"][c], json!(true), "{c}");
    }
    assert_eq!(ft_balance(&net, token.id(), buyer).await?, before, "every unit is back with the buyer");
    assert_eq!(ft_balance(&net, token.id(), escrow).await?, 0);
    assert_eq!(ft_balance(&net, token.id(), supplier).await?, 10 * USDC, "the supplier received nothing from the refund run");

    // The deployed cap refuses a larger run before anything is sent, and another token is not enabled.
    let mut over = again.clone();
    over.extend(["--amount-units", "6000001"]);
    let r = run_all(&kc, &accounts, &over, "usdc-over-cap")?;
    assert_eq!(r.status, 2, "{}", r.log);
    assert!(r.log.contains("EXPOSURE_EXCEEDED"), "{}", r.log);
    let other = deploy_token(&net, &net.testnet, "run-other", buyer).await?;
    let other_id = other.id().to_string();
    let other_args = [
        "--network",
        "sandbox",
        "--rpc-url",
        rpc.as_str(),
        "--wasm",
        wasm.as_str(),
        "--manifest",
        manifest_path.as_str(),
        "--asset",
        "usdc",
        "--token",
        other_id.as_str(),
        "--skip-deploy",
        "--relayer-key-file",
        key_file.as_str(),
    ];
    let r = run_all(&kc, &accounts, &other_args, "usdc-other-token")?;
    assert_eq!(r.status, 2, "{}", r.log);
    assert!(r.log.contains("TOKEN_NOT_ENABLED"), "{}", r.log);
    assert_eq!(ft_balance(&net, other.id(), buyer).await?, 1_000 * USDC);

    /* ---- near-mainnet label on the local sandbox: the real-funds path ---- */
    let (mids, maccounts) = run_accounts(&net, &kc, &net.mainnet_root, "main").await?;
    let (mescrow, mbuyer, msupplier) = (&mids[0], &mids[1], &mids[2]);
    let mtoken = deploy_token(&net, &net.mainnet_root, "run-usdc", mbuyer).await?;
    let mtoken_id = mtoken.id().to_string();
    let mbase = [
        "--network",
        "sandbox",
        "--contract-network",
        "near-mainnet",
        "--rpc-url",
        rpc.as_str(),
        "--wasm",
        wasm.as_str(),
        "--manifest",
        manifest_path.as_str(),
        "--asset",
        "usdc",
        "--token",
        mtoken_id.as_str(),
    ];
    // Without the flag nothing runs; `--network mainnet` never accepts a local node; testnet
    // names do not fit the mainnet label.
    let r = run_all(&kc, &maccounts, &mbase, "main-refused-flag")?;
    assert_eq!(r.status, 2, "{}", r.log);
    assert!(r.log.contains("NETWORK_REFUSED") && r.log.contains("--i-understand-real-funds"), "{}", r.log);
    let r = run_all(&kc, &maccounts, &["--network", "mainnet", "--i-understand-real-funds", "--rpc-url", &rpc], "main-refused-rpc")?;
    assert_eq!(r.status, 2, "{}", r.log);
    assert!(r.log.contains("NETWORK_REFUSED"), "{}", r.log);
    let mut real = mbase.to_vec();
    real.push("--i-understand-real-funds");
    let r = run_all(&kc, &accounts, &real, "main-refused-accounts")?;
    assert_eq!(r.status, 2, "{}", r.log);
    assert!(r.log.contains("INVALID_ACCOUNT"), "{}", r.log);
    // Above the mainnet default cap (25 USDC): refused by the exposure check.
    let mut over = real.clone();
    over.extend(["--amount-units", "25000001"]);
    let r = run_all(&kc, &maccounts, &over, "main-refused-cap")?;
    assert_eq!(r.status, 2, "{}", r.log);
    assert!(r.log.contains("EXPOSURE_EXCEEDED"), "{}", r.log);
    assert_eq!(net.code_hash_of(mescrow).await.ok(), None, "no refused run deployed anything");

    // The dry preflight prints every amount under the real-funds banner, then the run itself.
    let mut dry = real.clone();
    dry.push("--dry-run");
    let r = run_all(&kc, &maccounts, &dry, "main-dry")?;
    assert_eq!(r.status, 0, "{}", r.log);
    assert!(r.log.contains("REAL FUNDS"), "{}", r.log);
    assert!(r.log.contains("caps: 5000000000000000000000000 yoctoNEAR and 25000000 token units per trade"), "{}", r.log);
    assert!(r.log.contains("this run holds at most 5000000 token base units in escrow"), "{}", r.log);
    assert_eq!(net.code_hash_of(mescrow).await.ok(), None);

    let mstart = ft_balance(&net, mtoken.id(), mbuyer).await?;
    let r = run_all(&kc, &maccounts, &real, "main-paid")?;
    if r.status != 0 {
        bail!("run-all with the near-mainnet label failed ({}):\n{}", r.status, r.log);
    }
    let rec = read(&r.out.join("run-record.json"))?;
    assert_eq!(rec["journey"]["ok"], json!(true));
    assert_eq!(rec["contractNetwork"], json!("near-mainnet"));
    let cfg: J = net.worker.view(mescrow, "get_config").await?.json()?;
    assert_eq!(cfg["network"], json!("near-mainnet"));
    assert_eq!(cfg["maxTradeAmount"], json!({ "nearYocto": "5000000000000000000000000", "nep141": "25000000" }));
    assert_eq!(cfg["nep141Token"], json!({ "accountId": mtoken_id, "decimals": 6 }));
    assert_eq!(ft_balance(&net, mtoken.id(), msupplier).await?, 5 * USDC);
    assert_eq!(ft_balance(&net, mtoken.id(), mbuyer).await?, mstart - 5 * USDC);
    let trade = rec["journey"]["tradeId"].as_str().context("trade id")?;
    let release: J = net.worker.view(mescrow, "get_release").args_json(json!({ "trade_id": trade })).await?.json()?;
    assert!(release.to_string().contains("\"PAID\"") && release.to_string().contains("DIRECT_MAINNET"), "{release}");

    // A refund run stopped in its cooling period cannot be resumed without the flag.
    let mkey = saved_key_file(&kc, "main-paid")?;
    let mut mrefund = real.clone();
    mrefund.extend(["--skip-deploy", "--relayer-key-file", mkey.as_str(), "--journey", "refund", "--no-wait"]);
    let r = run_all(&kc, &maccounts, &mrefund, "main-refund")?;
    assert_eq!(r.status, 3, "{}", r.log);
    let out = r.out.clone();
    net.hours(1).await?;
    let r = resume(&kc, &maccounts, &out, &[])?;
    assert_eq!(r.status, 2, "{}", r.log);
    assert!(r.log.contains("--i-understand-real-funds"), "{}", r.log);
    assert_eq!(ft_balance(&net, mtoken.id(), mescrow).await?, 6 * USDC, "nothing moved without the flag");
    let r = resume(&kc, &maccounts, &out, &["--i-understand-real-funds"])?;
    if r.status != 0 {
        bail!("run-all --resume (mainnet label refund) failed ({}):\n{}", r.status, r.log);
    }
    assert_eq!(ft_balance(&net, mtoken.id(), mbuyer).await?, mstart - 5 * USDC, "5 + 1 went back to the buyer");
    assert_eq!(ft_balance(&net, mtoken.id(), mescrow).await?, 0);
    Ok(())
}
