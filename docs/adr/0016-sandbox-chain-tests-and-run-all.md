# ADR-0016 — Real-chain tests on near-sandbox and the one-command testnet run

- Decision status: accepted (M16)
- Date: 2026-11-12, Dockside platform team (M16)
- Affected IDs: T-007, T-008, T-009, T-019, T-020, T-021, T-022, T-031, T-042, T-043, T-045, T-051;
  REAL-PRODUCT-GATE items 1, 2, 9, 10
- Relates to: ADR-0004 decision 13 (local verification strategy), ADR-0011, ADR-0014, ADR-0015

## Context

Until M16 every contract test ran either on the host (the core crate) or on the M02 simulated NEAR
host in TypeScript, which executes the compiled wasm but is not nearcore: no real receipts, gas,
access keys, promise scheduling or wasm export guards. BUILD-STATUS listed near-workspaces /
near-sandbox tests and near-sdk `unit-testing` host tests as NOT_RUN, and the testnet deployment as
a list of manual near-cli-rs commands nobody had run. ADR-0015 made a Linux container available;
M16 uses it to run the deployable wasm on a real local nearcore node and to give the user one
command for everything after account creation.

## Decisions

1. **A separate cargo workspace, `contract/integration/`.** It holds `dockside-fixtures`
   (parameterised payload builders and a host mirror of the contract dispatcher),
   `dockside-sandbox-tests` (near-sdk `unit-testing` tests, near-workspaces tests, the run-all
   validation) and `dockside-test-token` (NEP-141). It has its own `Cargo.lock`, so the contract
   workspace's lockfile and the deployable wasm's digest do not change when test dependencies do
   (near-workspaces 0.24.0, near-sandbox 0.4.0, near-sdk 5.30.1 `unit-testing`, tokio 1.54.1; the
   fixtures need ed25519-dalek 2.2.0, which near-crypto requires). The wasm digest after M16 is the
   M13 digest `65b3a00d…`.
2. **The sandbox suite runs in `node:22-trixie-slim`; the deployable wasm stays the bookworm build.**
   The official near-sandbox 2.14.0 binary needs glibc 2.38 or newer, which bookworm (2.36) lacks.
   `scripts/sandbox/container-sandbox.sh` takes the wasm and manifest that
   `scripts/container-reproduce.sh` (bookworm, ADR-0015) exported, checks the wasm against the
   manifest, rebuilds the contract from the commit under test and requires the identical digest, and
   only then runs the tests against that exact file. The rebuild in trixie gives the same digest as
   bookworm.
3. **Binaries are downloaded from their official sources and pinned by SHA-256.** near-sandbox 2.14.0
   from NEAR's release bucket (`build.nearprotocol.com/nearcore/Linux-x86_64/2.14.0/`, the location
   the official near-sandbox crate installs from; the near-sandbox GitHub releases carry no
   binaries), SHA-256 `a0ba0042…e691`. near-cli-rs 0.31.1 from its GitHub release, SHA-256
   `8b92f4f7…9e21` (equal to the release's published `.sha256`). The near-workspaces build script is
   kept from downloading anything (`NEAR_SANDBOX_BIN_PATH`).
4. **Accounts are real `.testnet` accounts on the local chain.** The contract's testnet corridor
   accepts only `.testnet` names, so each sandbox node gets a `testnet` genesis account and every
   party account is created by a real create-account transaction signed by it. Keys are derived
   from labels inside the test process and exist only on that node.
5. **Chain time is moved by fast-forwarding blocks.** The node's consensus config sets the block
   production delays so one skipped block is worth about an hour of block time; `Net::hours(n)`
   repeats the fast-forward until the latest block carries the target time (nearcore derives the jump
   from the configured delays, so it is approximate). The 1-hour refund cooling, the destination
   change delay and the 72-hour asset-recovery window run on chain time.
6. **Every accepted call is replayed on a host mirror and compared.** `Mirror::apply` runs the same
   `dockside-escrow-core` function the contract runs, with the predecessor and the block time of the
   receipt that executed it (and the promise outcome for settlement callbacks). A refusal must carry
   the same failure code on both; a success must return the same value; after every call
   `get_ledger`, `get_refunds` and `get_unexpected_asset` must be equal. The mirror is never the
   authority: it builds payloads that depend on recorded state and checks the contract.
7. **near-sdk `unit-testing` covers the wrapper, the sandbox covers the exports.** The unit tests call
   the `#[near]` methods under the mocked blockchain (initialiser, attached deposits, block time,
   scheduled receipts, settlement with a successful and a failed promise, the NEP-141 receiver).
   `#[payable]` and `#[private]` are enforced by the generated wasm exports, not the Rust methods, so
   they are tested on the sandbox. Five wrapper mutants were built and run; all five are killed, two
   of them only on the sandbox (docs/evidence/M16/mutants.txt).
8. **`scripts/testnet-deploy/run-all`: shell orchestration, near-cli-rs signing, node checks.** The
   script verifies the wasm against the manifest, preflights the accounts, deploys **and initialises
   in one transaction** (the listed order "deploy, verify, initialise" would leave a window in which
   anyone could call `new` on the uninitialised contract, since `new` is not private; the code hash and
   the initialised config are verified right after), adds a function-call key for the relayer
   restricted to the escrow (any method, `1 NEAR` allowance; near-cli-rs generates and saves it, the
   relayed calls are signed with `sign-with-access-key-file`), and runs the journey. Account keys stay
   in the user's near-cli-rs keychain; the script never reads, prints or stores a private key. The
   journey's Dockside principal keys come from a fresh 256-bit seed per run, so nobody can derive
   them and sign for that trade.
9. **The journey's payloads are built by a Rust process, not re-implemented in JavaScript.**
   `dockside-journey-mirror` (pure Rust, builds on the Windows host without a C toolchain) speaks JSON
   lines; the node driver owns RPC and near-cli-rs. This keeps one implementation of the signed
   evidence and release payloads and gives run-all the same mirror check as the tests.
10. **run-all is validated against the sandbox only.** `run_all_on_sandbox.rs` creates the accounts,
    fills a temporary near-cli-rs keychain and runs the script with `--network sandbox`. The script
    accepts only `testnet` (https, not a mainnet host) and `sandbox` (loopback RPC); it was never run
    with `--network testnet` in this build. `--network` has no default.
11. **Claims.** The near-workspaces / near-sandbox and near-sdk `unit-testing` rows move from NOT_RUN to
    PASS (local nearcore). Nothing ran on NEAR testnet, so every testnet column stays BLOCKED or
    NOT_RUN and the product claim stays `IMPLEMENTED_UNVERIFIED`. The sandbox is a single-node local
    chain: it proves the wasm, receipts, access keys and the script on nearcore, not testnet's
    protocol version, validators, faucet or RPC providers.

## Consequences

- `pnpm run contract:sandbox` (scripts/sandbox/run.mjs) runs the whole real-chain suite in Docker;
  it needs `.data/repro/` from the reproduction first. `DOCKSIDE_DOCKER` selects the docker command
  (for example Docker Engine inside WSL 2).
- The testnet steps in docs/USER-NEXT-STEPS.md §3 can be done with `run-all --network testnet`;
  the consolidation stage should point there.
- Flip conditions: if testnet's protocol version rejects the wasm, pin the sandbox to the testnet
  nearcore release and rerun; if near-cli-rs changes its output, `parseTxHash` and
  `parseSavedKeyFile` (unit-tested) are the two places to adjust.
