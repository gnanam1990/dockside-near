//! Harness for escrow tests on a real local near-sandbox node (nearcore 2.14.0, sandbox build).
//!
//! `Net::start` runs one sandbox node per test with a `testnet` genesis account, so party
//! accounts are ordinary `<name>.testnet` accounts created by real create-account transactions
//! (the contract's testnet corridor only accepts `.testnet` names). Its consensus config makes
//! one fast-forwarded block advance block time by one hour, so refund cooling periods and the
//! 72-hour asset-recovery window pass by `Net::hours`.
//!
//! `Dock::call` submits a real transaction, reads the block time of the receipt that executed
//! it, replays the same call on the host `Mirror` and asserts that the chain and the core agree
//! on success, failure code, return value and the ledger, refund and asset views.

use anyhow::{anyhow, bail, Context, Result};
use dockside_fixtures::mirror::{Call, Mirror};
use dockside_fixtures::{Accounts, Fixture, J};
use ed25519_dalek::SigningKey;
use near_sandbox::{GenesisAccount, Sandbox, SandboxConfig};
use near_workspaces::network::ValidatorKey;
use near_workspaces::result::{ExecutionFinalResult, ExecutionOutcome};
use near_workspaces::types::{Gas, NearToken, SecretKey};
use near_workspaces::{Account, AccountId, CryptoHash, Worker};
use serde_json::json;
use std::str::FromStr;

pub const NEAR: u128 = dockside_fixtures::NEAR;
pub const TGAS_300: u64 = 300;

fn sha256(b: &[u8]) -> [u8; 32] {
    use sha2::Digest;
    sha2::Sha256::digest(b).into()
}

/// NEAR secret key text for a key derived from `label` (never leaves the test process).
fn derived_secret(label: &str) -> (String, String) {
    let sk = SigningKey::from_bytes(&sha256(format!("dockside-sandbox-account/{label}").as_bytes()));
    let mut kp = sk.to_bytes().to_vec();
    kp.extend_from_slice(&sk.verifying_key().to_bytes());
    (
        format!("ed25519:{}", bs58::encode(kp).into_string()),
        format!("ed25519:{}", bs58::encode(sk.verifying_key().to_bytes()).into_string()),
    )
}

/// NEAR code hash: base58(sha256(wasm)).
pub fn code_hash(wasm: &[u8]) -> String {
    bs58::encode(sha256(wasm)).into_string()
}

pub fn sha256_hex(b: &[u8]) -> String {
    hex::encode(sha256(b))
}

fn read_wasm(env: &str, default: &str) -> Result<Vec<u8>> {
    let path = std::env::var(env).unwrap_or_else(|_| format!("{}/{default}", env!("CARGO_MANIFEST_DIR")));
    std::fs::read(&path).with_context(|| format!("read {path} (set {env})"))
}

/// The escrow wasm under test: `DOCKSIDE_ESCROW_WASM`, by default the contract workspace build.
/// With `DOCKSIDE_ESCROW_WASM_SHA256` set (the build manifest's digest) a different file fails.
pub fn escrow_wasm() -> Result<Vec<u8>> {
    let w = read_wasm("DOCKSIDE_ESCROW_WASM", "../../target/wasm32-unknown-unknown/release/dockside_escrow.wasm")?;
    if let Ok(want) = std::env::var("DOCKSIDE_ESCROW_WASM_SHA256") {
        let have = sha256_hex(&w);
        if have != want {
            bail!("escrow wasm sha256 {have} differs from the expected {want}");
        }
    }
    Ok(w)
}

/// The NEP-141 test token wasm (this workspace's `dockside-test-token`).
pub fn token_wasm() -> Result<Vec<u8>> {
    read_wasm("DOCKSIDE_TEST_TOKEN_WASM", "../target/wasm32-unknown-unknown/release/dockside_test_token.wasm")
}

pub struct Net {
    pub worker: Worker<near_workspaces::network::Sandbox>,
    pub testnet: Account,
    _sandbox: Sandbox,
}

impl Net {
    pub async fn start() -> Result<Net> {
        let (sk, pk) = derived_secret("testnet");
        let config = SandboxConfig {
            // One fast-forwarded block = (min + max block production delay) / 2 = 3600 s.
            additional_config: Some(json!({
                "consensus": {
                    "min_block_production_delay": { "secs": 0, "nanos": 200_000_000 },
                    "max_block_production_delay": { "secs": 7199, "nanos": 800_000_000 },
                    "max_block_wait_delay": { "secs": 7206, "nanos": 0 },
                }
            })),
            additional_accounts: vec![GenesisAccount {
                account_id: "testnet".parse()?,
                public_key: pk,
                private_key: sk.clone(),
                balance: NearToken::from_near(1_000_000),
            }],
            ..Default::default()
        };
        let sandbox = Sandbox::start_sandbox_with_config(config).await.map_err(|e| anyhow!("start sandbox: {e}"))?;
        let worker = near_workspaces::sandbox()
            .rpc_addr(&sandbox.rpc_addr)
            .validator_key(ValidatorKey::HomeDir(sandbox.home_dir.path().to_path_buf()))
            .await?;
        let testnet = Account::from_secret_key("testnet".parse()?, SecretKey::from_str(&sk)?, &worker);
        Ok(Net { worker, testnet, _sandbox: sandbox })
    }

    /// Create `<name>.testnet` with a real create-account transaction signed by `testnet`.
    pub async fn account(&self, name: &str, near: u128) -> Result<Account> {
        let (sk, _) = derived_secret(name);
        let r = self
            .testnet
            .create_subaccount(name)
            .initial_balance(NearToken::from_near(near))
            .keys(SecretKey::from_str(&sk)?)
            .transact()
            .await?;
        if !r.is_success() {
            bail!("create {name}.testnet failed: {:?}", r.details.failures());
        }
        Ok(r.result)
    }

    pub async fn block_ms(&self, hash: CryptoHash) -> Result<u64> {
        Ok(self.worker.view_block().block_hash(hash).await?.timestamp() / 1_000_000)
    }

    /// Latest block time in ms.
    pub async fn now_ms(&self) -> Result<u64> {
        Ok(self.worker.view_block().await?.timestamp() / 1_000_000)
    }

    /// Advance block time by at least `n` hours with fast-forwarded blocks (about one hour each
    /// with this node's consensus config), then wait until the latest block carries the new time.
    /// nearcore derives each skipped block's time from the configured block production delays, so
    /// the jump is approximate; it is repeated until the target time is reached.
    pub async fn hours(&self, n: u64) -> Result<()> {
        const HOUR_MS: u64 = 3_600_000;
        let target = self.now_ms().await? + n * HOUR_MS;
        for _ in 0..20 {
            let now = self.now_ms().await?;
            if now >= target {
                return Ok(());
            }
            let blocks = (target - now).div_ceil(HOUR_MS * 9 / 10).max(1);
            let height = self.worker.view_block().await?.height();
            self.worker.fast_forward(blocks).await?;
            for _ in 0..150 {
                if self.worker.view_block().await?.height() >= height + blocks {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
        }
        bail!("block time did not reach {target} (now {})", self.now_ms().await?)
    }

    pub async fn balance(&self, id: &AccountId) -> Result<u128> {
        Ok(self.worker.view_account(id).await?.balance.as_yoctonear())
    }

    pub async fn code_hash_of(&self, id: &AccountId) -> Result<String> {
        match self.worker.view_account(id).await?.contract_state {
            near_workspaces::ContractState::LocalHash(h) => Ok(h.to_string()),
            other => bail!("{id} has no locally deployed code: {other:?}"),
        }
    }
}

/// `DOCKSIDE:<CODE>:` from a contract panic, or the raw error text.
pub fn panic_code(text: &str) -> String {
    match text.find("DOCKSIDE:") {
        Some(i) => text[i + 9..].split(':').next().unwrap_or_default().to_string(),
        None => text.to_string(),
    }
}

fn outcome_error(o: &ExecutionOutcome) -> String {
    match o.clone().into_result() {
        Ok(_) => String::new(),
        Err(e) => format!("{e:?}"),
    }
}

fn outcome_json(o: &ExecutionOutcome) -> J {
    match o.clone().into_result() {
        Ok(near_workspaces::result::ValueOrReceiptId::Value(v)) => {
            let raw = v.raw_bytes().unwrap_or_default();
            if raw.is_empty() {
                J::Null
            } else {
                serde_json::from_slice(&raw).unwrap_or(J::Null)
            }
        }
        _ => J::Null,
    }
}

/// One deployed escrow with its host mirror and the fixture its payloads are built from.
pub struct Dock {
    pub net: Net,
    pub escrow: Account,
    pub mirror: Mirror,
    pub fx: Fixture,
    pub buyer: Account,
    pub supplier: Account,
    pub treasury: Account,
    pub alt: Account,
    pub relayer: Account,
}

/// What a successful call returned on chain, and when its receipts ran.
#[derive(Debug)]
pub struct Sent {
    pub value: J,
    pub at_ms: u64,
    pub result: ExecutionFinalResult,
}

impl Dock {
    /// A fresh sandbox, the five party accounts, the escrow account with the wasm deployed and
    /// initialised (`new("near-testnet", null)`), and a fixture for `amount_yocto`.
    pub async fn start(seed: &str, amount_yocto: u128, delay_ms: u64) -> Result<Dock> {
        let net = Net::start().await?;
        let escrow = net.account("dockside-escrow", 50).await?;
        let buyer = net.account("acme-buyer", 100).await?;
        let supplier = net.account("harbor-supplier", 10).await?;
        let treasury = net.account("treasury-acme", 100).await?;
        let alt = net.account("harbor-payouts", 10).await?;
        let relayer = net.account("relayer", 50).await?;
        let wasm = escrow_wasm()?;
        let d = escrow.deploy(&wasm).await?;
        if !d.is_success() {
            bail!("deploy failed: {:?}", d.details.failures());
        }
        let init = escrow
            .call(escrow.id(), "new")
            .args_json(json!({ "network": "near-testnet", "min_deposit_yocto": null }))
            .transact()
            .await?;
        if !init.is_success() {
            bail!("init failed: {:?}", init.failures());
        }
        let t0 = net.now_ms().await?;
        let accounts = Accounts {
            contract: escrow.id().to_string(),
            buyer: buyer.id().to_string(),
            supplier: supplier.id().to_string(),
            treasury: treasury.id().to_string(),
            alt_destination: alt.id().to_string(),
        };
        let fx = Fixture::new(accounts, seed, "trade-1", amount_yocto, delay_ms, t0);
        let mirror = Mirror::new(escrow.id().as_str(), None);
        Ok(Dock { net, escrow, mirror, fx, buyer, supplier, treasury, alt, relayer })
    }

    pub fn trade_id(&self) -> String {
        self.fx.trade_id()
    }

    pub fn rec(&self) -> &dockside_escrow_core::TradeRecord {
        self.mirror.trade(&self.fx.trade_id())
    }

    pub async fn now(&self) -> Result<u64> {
        self.net.now_ms().await
    }

    /// Submit `method(args)` signed by `signer`, replay it on the mirror at the receipt's block
    /// time and compare. `Err(code)` is a contract refusal that the mirror refused identically.
    pub async fn call(&mut self, signer: &Account, method: &str, args: J, deposit: u128) -> Result<std::result::Result<Sent, String>> {
        let result = signer
            .call(self.escrow.id(), method)
            .args_json(&args)
            .deposit(NearToken::from_yoctonear(deposit))
            .gas(Gas::from_tgas(TGAS_300))
            .transact()
            .await?;
        let outcomes = result.receipt_outcomes().to_vec();
        let main_i = outcomes
            .iter()
            .position(|o| o.executor_id == *self.escrow.id())
            .ok_or_else(|| anyhow!("{method}: no receipt ran on the escrow"))?;
        let main = &outcomes[main_i];
        let at_ms = self.net.block_ms(main.block_hash).await?;
        let pred = signer.id().to_string();
        let call = Call::by(&pred, at_ms).with_deposit(deposit);
        if main.is_failure() {
            let code = panic_code(&outcome_error(main));
            let mut probe = self.mirror.clone();
            match probe.apply(method, &args, call) {
                Err(e) if e.code == code => {}
                Err(e) => bail!("{method}: chain refused with {code}, mirror with {}", e.code),
                Ok(v) => bail!("{method}: chain refused with {code}, mirror accepted ({v})"),
            }
            return Ok(Err(code));
        }
        let mirrored = self.mirror.apply(method, &args, call).map_err(|e| anyhow!("{method}: chain accepted, mirror refused: {e}"))?;
        let callback = match method {
            "execute_release" => Some(("on_release_transfer", json!({
                "trade_id": args["trade_id"], "release_intent_id": args["release_intent_id"], "attempt_id": mirrored["attempt_id"],
            }), mirrored["transfer"]["to"].as_str().unwrap_or_default().to_string())),
            "execute_refund" => Some(("on_refund_transfer", json!({
                "trade_id": args["trade_id"], "refund_intent_id": args["refund_intent_id"],
            }), mirrored["transfer"]["to"].as_str().unwrap_or_default().to_string())),
            "execute_asset_recovery" => Some(("on_asset_recovery_transfer", json!({
                "asset_index": args["asset_index"], "recovery_id": args["recovery_id"],
            }), mirrored["ft_transfer"]["token"].as_str().unwrap_or_default().to_string())),
            _ => None,
        };
        let value = if let Some((cb, cb_args, receiver)) = callback {
            let transfer = outcomes
                .iter()
                .skip(main_i + 1)
                .find(|o| o.executor_id.as_str() == receiver)
                .ok_or_else(|| anyhow!("{method}: no receipt ran on {receiver}"))?;
            let cb_outcome = outcomes
                .iter()
                .skip(main_i + 1)
                .find(|o| o.executor_id == *self.escrow.id())
                .ok_or_else(|| anyhow!("{method}: settlement callback did not run"))?;
            if cb_outcome.is_failure() {
                bail!("{method}: settlement callback failed: {}", outcome_error(cb_outcome));
            }
            let cb_at = self.net.block_ms(cb_outcome.block_hash).await?;
            let contract = self.escrow.id().to_string();
            let settled = Call::by(&contract, cb_at).settled(transfer.is_success());
            let m = self.mirror.apply(cb, &cb_args, settled).map_err(|e| anyhow!("{cb}: mirror refused: {e}"))?;
            let chain = outcome_json(cb_outcome);
            if chain != m {
                bail!("{cb}: chain returned {chain}, mirror {m}");
            }
            json!({ "scheduled": mirrored, "settled": chain })
        } else {
            let chain = outcome_json(main);
            if chain != mirrored {
                bail!("{method}: chain returned {chain}, mirror {mirrored}");
            }
            chain
        };
        self.compare(&args).await?;
        Ok(Ok(Sent { value, at_ms, result }))
    }

    /// Like `call`, but the call must succeed.
    pub async fn ok(&mut self, signer: &Account, method: &str, args: J, deposit: u128) -> Result<Sent> {
        match self.call(signer, method, args, deposit).await? {
            Ok(s) => Ok(s),
            Err(code) => bail!("{method} refused: {code}"),
        }
    }

    /// Like `call`, but the call must be refused; returns the contract's failure code.
    pub async fn refused(&mut self, signer: &Account, method: &str, args: J, deposit: u128) -> Result<String> {
        match self.call(signer, method, args, deposit).await? {
            Ok(s) => bail!("{method} unexpectedly succeeded: {}", s.value),
            Err(code) => Ok(code),
        }
    }

    pub async fn view(&self, method: &str, args: J) -> Result<J> {
        Ok(self.net.worker.view(self.escrow.id(), method).args_json(args).await?.json::<J>()?)
    }

    /// The contract's ledger, refund and asset views must equal the core's on the mirror.
    pub async fn compare(&self, args: &J) -> Result<()> {
        if let Some(t) = args.get("trade_id").and_then(|t| t.as_str()) {
            if self.mirror.trades.contains_key(t) {
                for m in ["get_ledger", "get_refunds"] {
                    let a = json!({ "trade_id": t });
                    let (chain, host) = (self.view(m, a.clone()).await?, self.mirror.view(m, &a, 0).map_err(|e| anyhow!("{e}"))?);
                    if chain != host {
                        bail!("{m} differs\nchain: {chain}\nmirror: {host}");
                    }
                }
            }
        }
        if let Some(i) = args.get("asset_index").and_then(|t| t.as_u64()) {
            let a = json!({ "asset_index": i });
            let (chain, host) = (self.view("get_unexpected_asset", a.clone()).await?, self.mirror.view("get_unexpected_asset", &a, 0).map_err(|e| anyhow!("{e}"))?);
            if chain != host {
                bail!("get_unexpected_asset differs\nchain: {chain}\nmirror: {host}");
            }
        }
        Ok(())
    }

    /// Record, on the mirror, an `ft_on_transfer` the token contract delivered to the escrow in
    /// `result` (a sender's `ft_transfer_call`).
    pub async fn observe_ft_on_transfer(&mut self, result: &ExecutionFinalResult, token: &AccountId, sender: &AccountId, amount: u128, msg: &str) -> Result<()> {
        let o = result
            .receipt_outcomes()
            .iter()
            .find(|o| o.executor_id == *self.escrow.id())
            .ok_or_else(|| anyhow!("ft_on_transfer did not reach the escrow"))?;
        if o.is_failure() {
            bail!("ft_on_transfer failed: {}", outcome_error(o));
        }
        let at = self.net.block_ms(o.block_hash).await?;
        let args = json!({ "sender_id": sender, "amount": amount.to_string(), "msg": msg });
        let tok = token.to_string();
        self.mirror.apply("ft_on_transfer", &args, Call::by(&tok, at)).map_err(|e| anyhow!("mirror ft_on_transfer: {e}"))?;
        let index = (self.mirror.unexpected.len() - 1) as u64;
        self.compare(&json!({ "asset_index": index })).await
    }
}
