// Steps of scripts/testnet-deploy/run-all that need JSON, hashing or RPC. Each subcommand prints
// one JSON document (or one value for `profile`) and exits 0, or prints `run-all: <CODE>: ...`
// to stderr and exits 2. Read-only except `journey`, which submits transactions through
// near-cli-rs (signed from the user's keychain and the relayer's function-call key file), and
// `near-run`, which runs one near-cli-rs command for the shell script.
//
// Every subcommand that reads the chain takes the RPC URL from --rpc-url and, as fallbacks for
// read-only calls, the comma-separated --fallback-rpc-urls or DOCKSIDE_FALLBACK_RPC_URLS.
//
// Network flags (NET below), accepted by every subcommand that names a network:
//   --network <testnet|sandbox|mainnet> [--rpc-url <url>] [--contract-network <near-testnet|near-mainnet>]
//   [--i-understand-real-funds]   required for --network mainnet and for the near-mainnet label
// Asset flags (ASSET below): [--asset <near|usdc>] [--token <account>] [--token-decimals <n>]
//   [--amount-yocto <n> | --amount-units <n>] [--excess-yocto <n> | --excess-units <n>]
//   [--cap-near-yocto <n>] [--cap-token-units <n>] [--max-exposure-near-yocto <n>] [--max-exposure-token-units <n>]
//
//   node tool.mjs near-cli                      the near-cli-rs binary to spawn (NEAR_CLI resolved)
//   node tool.mjs near-run --near <bin> --out <file> [--attempts <n>] -- <near-cli-rs arguments>
//   node tool.mjs profile NET --field <cliNetwork|rpcUrl|contractNetwork|realFunds>
//   node tool.mjs accounts [NET]
//   node tool.mjs check-run NET ASSET [--journey <j>]   every flag of a run, checked without reading
//                         the chain; prints the resolved settings (run-all calls this first)
//   node tool.mjs init-args NET ASSET           the `new` arguments a deployment is initialised with
//   node tool.mjs registrations --file <preflight.json>   "<account> <yoctoNEAR>" per token registration
//   node tool.mjs resume-rpc-url --dir <run dir> [--rpc-url <url>]   the RPC URL a resumed run uses:
//                         the recorded one, or the override checked against the recorded network
//   node tool.mjs verify-artifact --wasm <file> --manifest <file>
//   node tool.mjs preflight NET ASSET --wasm <file> [--skip-deploy] [--journey <paid|hold|refund>]
//                         accounts, balances, token registration, caps and the exposure check; prints
//                         the value plan (every amount, sender and receiver) to stderr
//   node tool.mjs tx-hash --file <near-cli output>
//   node tool.mjs verify-deployment --network <n> [--rpc-url <url>] --code-hash <base58>
//   node tool.mjs relayer-key-file --file <near-cli add-key output>
//   node tool.mjs verify-relayer-key --network <n> [--rpc-url <url>] --key-file <file>
//   node tool.mjs journey --network <n> [--rpc-url <url>] --near <bin> --key-file <file> --mirror <bin> --out <dir>
//                         (--journey <paid|hold|refund> --amount-yocto <n> [--excess-yocto <n>] | --resume)
//                         [--no-wait] [--stop-after <n>] [--pending-tx <hash|none>]
//       exits 3 (PAUSED) when the journey stops before its end (--stop-after, or --no-wait in a
//       cooling period); `--resume` with the same --out finishes it from journey-seed.json and
//       journey-state.json.
//   node tool.mjs run-params --dir <run dir> --field <name>   one field of <run dir>/run-params.json
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { JOURNEYS, nearRunner, runJourney } from "./lib/journey.mjs";
import {
  amountsFromFlags,
  assetFromFlags,
  capsFromConfig,
  capsFromFlags,
  ceilingFromFlags,
  checkExposure,
  initArgs,
  printPlan,
  valuePlan,
} from "./lib/plan.mjs";
import {
  accountsFromEnv,
  describeNearFailure,
  networkProfile,
  parseAddedKey,
  parseFallbackRpcUrls,
  parseSavedKeyFile,
  parseTxHash,
  REAL_FUNDS_FLAG,
  Rpc,
  resolveNearCli,
  runNear,
  ToolError,
  verifyArtifact,
  wasmDigest,
} from "./lib/near-tools.mjs";

const NEAR = 10n ** 24n;
/** Storage staking: 1 NEAR per 100 kB, i.e. 10^19 yoctoNEAR per byte. */
const YOCTO_PER_BYTE = 10n ** 19n;

/** Flags that never take a value, whatever follows them. */
const SWITCHES = new Set(["i-understand-real-funds", "skip-deploy", "resume", "no-wait", "dry-run"]);

function flags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) out._.push(a);
    else if (!SWITCHES.has(a.slice(2)) && i + 1 < argv.length && !argv[i + 1].startsWith("--"))
      out[a.slice(2)] = argv[++i];
    else out[a.slice(2)] = true;
  }
  return out;
}

function need(f, k) {
  if (typeof f[k] !== "string" || !f[k]) throw new ToolError("USAGE", `--${k} is required`);
  return f[k];
}

function journeyName(f) {
  const j = f.journey ?? "paid";
  if (!JOURNEYS.includes(j)) throw new ToolError("USAGE", `--journey must be one of ${JOURNEYS.join(", ")}`);
  return j;
}

const print = (v) => process.stdout.write(`${typeof v === "string" ? v : JSON.stringify(v, null, 2)}\n`);

async function main() {
  const [cmd, ...all] = process.argv.slice(2);
  // `near-run` passes everything after `--` to near-cli-rs untouched.
  const dashes = all.indexOf("--");
  const rest = dashes < 0 ? all : all.slice(0, dashes);
  const passThrough = dashes < 0 ? [] : all.slice(dashes + 1);
  const f = flags(rest);
  const realFundsFlag = REAL_FUNDS_FLAG.slice(2);
  const profile = () =>
    networkProfile(
      f.network,
      typeof f["rpc-url"] === "string" ? f["rpc-url"] : undefined,
      parseFallbackRpcUrls(f["fallback-rpc-urls"] ?? process.env.DOCKSIDE_FALLBACK_RPC_URLS),
      {
        contractNetwork: typeof f["contract-network"] === "string" ? f["contract-network"] : undefined,
        realFunds: f[realFundsFlag] === true,
      },
    );
  const accounts = (p) => accountsFromEnv(process.env, p.contractNetwork);
  /** A node on the wrong chain is refused before anything is read from it. */
  const onChain = async (p) => {
    const rpc = new Rpc(p.rpcUrls);
    if (p.chainId) {
      const id = await rpc.chainId();
      if (id !== p.chainId)
        throw new ToolError("CHAIN_MISMATCH", `${p.rpcUrl} is chain ${id}, not ${p.chainId}`);
    }
    return rpc;
  };
  /** Everything a run is decided by, from its flags alone. */
  const settings = () => {
    const p = profile();
    const journey = journeyName(f);
    const asset = assetFromFlags(f);
    return {
      p,
      journey,
      asset,
      amounts: amountsFromFlags(f, asset, journey),
      deployCaps: capsFromFlags(f, p.contractNetwork),
      ceiling: ceilingFromFlags(f),
    };
  };
  switch (cmd) {
    case "near-cli":
      return print(resolveNearCli());
    case "near-run": {
      const bin = need(f, "near");
      const out = need(f, "out");
      const attempts = Number(f.attempts ?? 3);
      if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5)
        throw new ToolError("USAGE", "--attempts must be 1 to 5");
      if (passThrough.length === 0) throw new ToolError("USAGE", "near-run needs -- <near-cli-rs arguments>");
      const r = await runNear(bin, passThrough, {
        attempts,
        log: (m) => process.stderr.write(`run-all:     ${m}\n`),
      });
      writeFileSync(out, r.log);
      if (r.status !== 0) {
        process.stderr.write(`run-all: NEAR_CLI_FAILED: ${describeNearFailure(r)}
`);
        process.exit(1);
      }
      return print({ txHash: r.txHash, attempts: r.attempts });
    }
    case "profile": {
      const p = profile();
      const field = need(f, "field");
      if (!(field in p)) throw new ToolError("USAGE", `unknown field ${field}`);
      return print(String(p[field]));
    }
    case "accounts":
      return print(f.network === undefined ? accountsFromEnv(process.env) : accounts(profile()));
    case "check-run": {
      const st = settings();
      const accts = accounts(st.p);
      const resolved = {
        network: st.p.network,
        contractNetwork: st.p.contractNetwork,
        realFunds: st.p.realFunds,
        rpcUrl: st.p.rpcUrl,
        accounts: accts,
        journey: st.journey,
        asset: st.asset.kind === "nep141" ? "usdc" : "near",
        token: st.asset.token?.accountId ?? "",
        tokenDecimals: String(st.asset.token?.decimals ?? ""),
        amount: st.amounts.amount.toString(),
        excess: st.amounts.excess.toString(),
      };
      if (f.field === undefined) return print(resolved);
      if (typeof f.field !== "string" || typeof resolved[f.field] !== "string")
        throw new ToolError("USAGE", `unknown field ${f.field}`);
      return print(resolved[f.field]);
    }
    case "init-args": {
      const st = settings();
      return print(JSON.stringify(initArgs({ contractNetwork: st.p.contractNetwork, caps: st.deployCaps, token: st.asset.token })));
    }
    case "registrations": {
      const pre = JSON.parse(readFileSync(need(f, "file"), "utf8"));
      return print((pre.registrations ?? []).map((a) => `${a} ${pre.storageDepositYocto}`).join("\n"));
    }
    case "verify-artifact":
      return print(verifyArtifact(need(f, "wasm"), need(f, "manifest")));
    case "tx-hash": {
      const h = parseTxHash(readFileSync(need(f, "file"), "utf8"));
      if (!h) throw new ToolError("NO_TX", "near-cli-rs printed no transaction id");
      return print(h);
    }
    case "relayer-key-file": {
      const text = readFileSync(need(f, "file"), "utf8");
      const file = parseSavedKeyFile(text);
      if (!file || !parseAddedKey(text))
        throw new ToolError("NO_KEY", "near-cli-rs did not report a saved function-call key");
      return print(file);
    }
    case "preflight": {
      const { p, journey, asset, amounts, deployCaps, ceiling } = settings();
      const accts = accounts(p);
      const rpc = await onChain(p);
      const views = {};
      for (const [role, id] of Object.entries(accts)) {
        try {
          views[role] = await rpc.viewAccount(id);
        } catch (e) {
          throw new ToolError(
            "ACCOUNT_MISSING",
            `${role} account ${id} does not exist on ${p.network}: ${e.message}`,
          );
        }
      }
      const wasm = wasmDigest(need(f, "wasm"));
      const empty = "11111111111111111111111111111111";
      const escrowCode = views.escrow.code_hash;
      const skip = f["skip-deploy"] === true;
      if (!skip && escrowCode !== empty) {
        throw new ToolError(
          "ESCROW_NOT_EMPTY",
          `${accts.escrow} already has code ${escrowCode}; use --skip-deploy to reuse a deployment`,
        );
      }
      if (skip && escrowCode !== wasm.nearCodeHash) {
        throw new ToolError(
          "CODE_HASH_MISMATCH",
          `${accts.escrow} runs ${escrowCode}, not the manifest's ${wasm.nearCodeHash}`,
        );
      }
      // The caps and the pinned token this run meets: the deployed contract's own, or the ones
      // this run initialises it with.
      let caps = deployCaps;
      let pinned = asset.token;
      if (skip) {
        const config = await rpc.view(accts.escrow, "get_config", {});
        if (config.network !== p.contractNetwork)
          throw new ToolError("CONFIG_MISMATCH", `contract network is ${config.network}, not ${p.contractNetwork}`);
        caps = capsFromConfig(config);
        pinned = config.nep141Token ?? null;
        if (asset.kind === "nep141") {
          if (!pinned && p.realFunds)
            throw new ToolError("TOKEN_NOT_ENABLED", `${accts.escrow} was initialised without a NEP-141 token`);
          if (pinned && (pinned.accountId !== asset.token.accountId || pinned.decimals !== asset.token.decimals))
            throw new ToolError(
              "TOKEN_NOT_ENABLED",
              `${accts.escrow} accepts ${pinned.accountId} (${pinned.decimals} decimals), not ${asset.token.accountId} (${asset.token.decimals})`,
            );
        }
      }
      const exposure = checkExposure({ asset, amounts, caps, realFunds: p.realFunds, ceiling });
      const deposit = amounts.amount + amounts.excess;
      const fee = NEAR / 10n;
      const registrations = [];
      let storageDepositYocto = 0n;
      const tokenFacts = {};
      if (asset.kind === "nep141") {
        const token = asset.token.accountId;
        let meta;
        try {
          meta = await rpc.view(token, "ft_metadata", {});
        } catch (e) {
          throw new ToolError("TOKEN_INVALID", `${token} does not answer ft_metadata on ${p.network}: ${e.message}`);
        }
        if (meta.decimals !== asset.token.decimals)
          throw new ToolError(
            "TOKEN_INVALID",
            `${token} has ${meta.decimals} decimals, not ${asset.token.decimals} (--token-decimals)`,
          );
        const registered = async (id) => (await rpc.view(token, "storage_balance_of", { account_id: id })) !== null;
        if (!(await registered(accts.buyer)))
          throw new ToolError("INSUFFICIENT_BALANCE", `${accts.buyer} is not registered with ${token} and holds none of it`);
        const balance = BigInt(await rpc.ftBalance(token, accts.buyer));
        if (balance < deposit)
          throw new ToolError(
            "INSUFFICIENT_BALANCE",
            `${accts.buyer} holds ${balance} units of ${token}; this run deposits ${deposit}`,
          );
        // The escrow must be registered to receive; the supplier to be paid (not in a refund run).
        const mustBeRegistered = journey === "refund" ? [accts.escrow] : [accts.escrow, accts.supplier];
        for (const id of mustBeRegistered) if (!(await registered(id))) registrations.push(id);
        storageDepositYocto = BigInt((await rpc.view(token, "storage_balance_bounds", {})).min);
        Object.assign(tokenFacts, {
          token,
          symbol: meta.symbol,
          decimals: meta.decimals,
          buyerBalance: balance.toString(),
        });
      }
      const storage = BigInt(wasm.bytes) * YOCTO_PER_BYTE + NEAR;
      const registrationCost = BigInt(registrations.length) * storageDepositYocto;
      if (!skip && BigInt(views.escrow.amount) < storage + registrationCost) {
        throw new ToolError(
          "INSUFFICIENT_BALANCE",
          `${accts.escrow} needs at least ${storage + registrationCost} yoctoNEAR for code storage, state and token registration`,
        );
      }
      if (skip && BigInt(views.escrow.amount) < registrationCost + fee) {
        throw new ToolError("INSUFFICIENT_BALANCE", `${accts.escrow} needs ${registrationCost + fee} yoctoNEAR for token registration and fees`);
      }
      // A native run deposits NEAR; a token run only pays fees in NEAR.
      const buyerNear = asset.kind === "nep141" ? fee : deposit + fee;
      if (BigInt(views.buyer.amount) < buyerNear) {
        throw new ToolError(
          "INSUFFICIENT_BALANCE",
          asset.kind === "nep141"
            ? `${accts.buyer} needs 0.1 NEAR for fees`
            : `${accts.buyer} needs ${journey === "refund" ? "the trade amount plus the excess" : "the trade amount"} plus 0.1 NEAR for fees`,
        );
      }
      if (BigInt(views.relayer.amount) < 2n * NEAR) {
        throw new ToolError(
          "INSUFFICIENT_BALANCE",
          `${accts.relayer} needs at least 2 NEAR (function-call allowance and fees)`,
        );
      }
      const plan = valuePlan({
        journey,
        asset,
        amounts,
        accounts: accts,
        deploy: !skip,
        relayerKey: f["relayer-key-file"] === undefined,
        registrations,
        storageDepositYocto,
      });
      const say = (m) => process.stderr.write(`run-all:     ${m}\n`);
      say(`${p.realFunds ? "REAL FUNDS" : "test funds"}: network ${p.network}, contract label ${p.contractNetwork}`);
      say(
        `caps: ${caps ? `${caps.nearYocto} yoctoNEAR and ${caps.nep141} token units per trade` : "none (testnet label)"}; ` +
          `this run holds at most ${exposure.heldAtMost} ${exposure.unit} in escrow`,
      );
      printPlan(plan, say);
      return print({
        network: p.network,
        contractNetwork: p.contractNetwork,
        realFunds: p.realFunds,
        rpcUrl: p.rpcUrl,
        journey,
        asset: asset.kind,
        ...tokenFacts,
        amount: amounts.amount.toString(),
        excess: amounts.excess.toString(),
        depositYocto: asset.kind === "near" ? deposit.toString() : "0",
        deposit: deposit.toString(),
        caps: caps ? { nearYocto: caps.nearYocto.toString(), nep141: caps.nep141.toString() } : null,
        pinnedToken: pinned,
        heldAtMost: exposure.heldAtMost.toString(),
        registrations,
        storageDepositYocto: storageDepositYocto.toString(),
        plan,
        accounts: accts,
        escrowCodeHash: escrowCode,
        balancesYocto: Object.fromEntries(Object.entries(views).map(([k, v]) => [k, v.amount])),
      });
    }
    case "verify-deployment": {
      const p = profile();
      const accts = accounts(p);
      const rpc = await onChain(p);
      const want = need(f, "code-hash");
      const account = await rpc.viewAccount(accts.escrow);
      if (account.code_hash !== want) {
        throw new ToolError(
          "CODE_HASH_MISMATCH",
          `on-chain code hash ${account.code_hash} differs from the manifest's ${want}`,
        );
      }
      const config = await rpc.view(accts.escrow, "get_config", {});
      if (config.network !== p.contractNetwork)
        throw new ToolError("CONFIG_MISMATCH", `contract network is ${config.network}, not ${p.contractNetwork}`);
      // A real-funds contract must be capped, and a token run must find its token enabled.
      const caps = capsFromConfig(config);
      if (p.realFunds && (caps.nearYocto === 0n || caps.nep141 === 0n))
        throw new ToolError("CAP_REQUIRED", `${accts.escrow} reports a zero cap under ${p.contractNetwork}`);
      const asset = assetFromFlags(f);
      if (asset.kind === "nep141") {
        const pinned = config.nep141Token ?? null;
        if ((p.realFunds && !pinned) || (pinned && pinned.accountId !== asset.token.accountId))
          throw new ToolError(
            "TOKEN_NOT_ENABLED",
            `${accts.escrow} accepts ${pinned ? pinned.accountId : "no NEP-141 token"}, not ${asset.token.accountId}`,
          );
      }
      return print({
        contractId: accts.escrow,
        onChainCodeHash: account.code_hash,
        match: true,
        blockHeight: account.block_height,
        config,
      });
    }
    case "verify-relayer-key": {
      const p = profile();
      const accts = accounts(p);
      const rpc = await onChain(p);
      // Only the public half of the key file is read here.
      const publicKey = JSON.parse(readFileSync(need(f, "key-file"), "utf8")).public_key;
      if (typeof publicKey !== "string") throw new ToolError("NO_KEY", "key file has no public_key");
      const k = await rpc.accessKey(accts.relayer, publicKey);
      const fc = k.permission?.FunctionCall;
      if (!fc || fc.receiver_id !== accts.escrow) {
        throw new ToolError(
          "RELAYER_KEY_INVALID",
          `relayer key ${publicKey} is not a function-call key for ${accts.escrow}`,
        );
      }
      return print({
        relayer: accts.relayer,
        publicKey,
        receiverId: fc.receiver_id,
        methodNames: fc.method_names,
        allowance: fc.allowance,
      });
    }
    case "run-params": {
      const file = join(need(f, "dir"), "run-params.json");
      let params;
      try {
        params = JSON.parse(readFileSync(file, "utf8"));
      } catch (e) {
        throw new ToolError("NOTHING_TO_RESUME", `${file}: ${e.message}`);
      }
      const field = need(f, "field");
      // Fields added later (asset, token, contractNetwork) have defaults for older run directories.
      const value = params[field] ?? (typeof f.default === "string" ? f.default : f.default === true ? "" : undefined);
      if (typeof value !== "string") throw new ToolError("NOTHING_TO_RESUME", `${file} has no ${field}`);
      return print(value);
    }
    case "resume-rpc-url": {
      // The RPC URL a resumed run uses: the recorded one, or an explicit --rpc-url checked by the
      // same rules against the run's recorded network (only the endpoint can change on --resume).
      const file = join(need(f, "dir"), "run-params.json");
      let params;
      try {
        params = JSON.parse(readFileSync(file, "utf8"));
      } catch (e) {
        throw new ToolError("NOTHING_TO_RESUME", `${file}: ${e.message}`);
      }
      if (typeof params.network !== "string" || typeof params.rpcUrl !== "string")
        throw new ToolError("NOTHING_TO_RESUME", `${file} has no network or rpcUrl`);
      // The recorded network and contract label decide; the real-funds flag must be given again.
      const opts = { contractNetwork: params.contractNetwork, realFunds: f[realFundsFlag] === true };
      if (f["rpc-url"] === undefined) return print(networkProfile(params.network, params.rpcUrl, [], opts).rpcUrl);
      if (typeof f["rpc-url"] !== "string" || !f["rpc-url"])
        throw new ToolError("USAGE", "--rpc-url needs a URL");
      return print(networkProfile(params.network, f["rpc-url"], [], opts).rpcUrl);
    }
    case "journey": {
      const p = profile();
      const accts = accounts(p);
      const rpc = await onChain(p);
      const out = need(f, "out");
      const resume = f.resume === true;
      let stopAfter;
      if (f["stop-after"] !== undefined) {
        stopAfter = Number(f["stop-after"]);
        if (!Number.isInteger(stopAfter) || stopAfter < 1)
          throw new ToolError("USAGE", "--stop-after must be a positive integer");
      }
      const pendingTx = f["pending-tx"];
      if (
        pendingTx !== undefined &&
        (typeof pendingTx !== "string" || !/^(none|[1-9A-HJ-NP-Za-km-z]{43,44})$/.test(pendingTx))
      )
        throw new ToolError("USAGE", "--pending-tx must be a transaction hash or none");
      // A resumed journey takes these from its seed file; a new one checks them before any call.
      const journey = resume ? undefined : journeyName(f);
      const asset = resume ? undefined : assetFromFlags(f);
      const amounts = resume ? undefined : amountsFromFlags(f, asset, journey);
      const config = await rpc.view(accts.escrow, "get_config", {});
      if (config.network !== p.contractNetwork)
        throw new ToolError("CONFIG_MISMATCH", `contract network is ${config.network}, not ${p.contractNetwork}`);
      const result = await runJourney({
        journey,
        resume,
        wait: !f["no-wait"],
        stopAfter,
        pendingTx,
        asset,
        excessYocto: amounts?.excess,
        rpc,
        profile: p,
        accounts: accts,
        near: nearRunner(need(f, "near"), {
          log: (m) => process.stderr.write(`run-all:     ${m}\n`),
        }),
        relayerKeyFile: need(f, "key-file"),
        mirrorBin: need(f, "mirror"),
        outDir: out,
        amountYocto: amounts?.amount,
        config,
        log: (m) => process.stderr.write(`run-all:   ${m}\n`),
      });
      writeFileSync(
        join(out, "journey.json"),
        `${JSON.stringify({ network: p.network, contractNetwork: p.contractNetwork, contractId: accts.escrow, ...result }, null, 2)}\n`,
      );
      if (result.paused) {
        process.stderr.write(`run-all: PAUSED: ${result.why}; ${result.completed} of ${result.of} steps done, next ${result.next}
`);
        process.exit(3);
      }
      if (!result.ok)
        throw new ToolError("JOURNEY_FAILED", `journey checks failed: ${JSON.stringify(result.checks)}`);
      return print(result.checks);
    }
    default:
      throw new ToolError("USAGE", `unknown subcommand ${cmd ?? ""}`);
  }
}

main().catch((e) => {
  process.stderr.write(`run-all: ${e.code ?? "ERROR"}: ${e.message}\n`);
  process.exit(2);
});
