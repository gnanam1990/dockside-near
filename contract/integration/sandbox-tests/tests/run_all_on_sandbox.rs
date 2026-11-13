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
