// Steps of scripts/testnet-deploy/run-all that need JSON, hashing or RPC. Each subcommand prints
// one JSON document (or one value for `profile`) and exits 0, or prints `run-all: <CODE>: ...`
// to stderr and exits 2. Read-only except `journey`, which submits transactions through
// near-cli-rs (signed from the user's keychain and the relayer's function-call key file), and
// `near-run`, which runs one near-cli-rs command for the shell script.
//
// Every subcommand that reads the chain takes the RPC URL from --rpc-url and, as fallbacks for
// read-only calls, the comma-separated --fallback-rpc-urls or DOCKSIDE_FALLBACK_RPC_URLS.
//
//   node tool.mjs near-cli                      the near-cli-rs binary to spawn (NEAR_CLI resolved)
//   node tool.mjs near-run --near <bin> --out <file> [--attempts <n>] -- <near-cli-rs arguments>
//   node tool.mjs profile --network <testnet|sandbox> [--rpc-url <url>] --field <cliNetwork|rpcUrl>
//   node tool.mjs accounts
//   node tool.mjs resume-rpc-url --dir <run dir> [--rpc-url <url>]   the RPC URL a resumed run uses:
//                         the recorded one, or the override checked against the recorded network
//   node tool.mjs verify-artifact --wasm <file> --manifest <file>
//   node tool.mjs preflight --network <n> [--rpc-url <url>] --wasm <file> --amount-yocto <n> [--skip-deploy]
//                           [--journey <paid|hold|refund|refusal|attack-demo>] [--excess-yocto <n>]
//   node tool.mjs tx-hash --file <near-cli output>
//   node tool.mjs verify-deployment --network <n> [--rpc-url <url>] --code-hash <base58>
//   node tool.mjs relayer-key-file --file <near-cli add-key output>
//   node tool.mjs verify-relayer-key --network <n> [--rpc-url <url>] --key-file <file>
//   node tool.mjs journey --network <n> [--rpc-url <url>] --near <bin> --key-file <file> --mirror <bin> --out <dir>
//                         (--journey <paid|hold|refund|refusal|attack-demo> --amount-yocto <n> [--excess-yocto <n>] | --resume)
//                         [--no-wait] [--stop-after <n>] [--pending-tx <hash|none>]
//       exits 3 (PAUSED) when the journey stops before its end (--stop-after, or --no-wait in a
//       cooling period); `--resume` with the same --out finishes it from journey-seed.json and
//       journey-state.json.
//   node tool.mjs run-params --dir <run dir> --field <name>   one field of <run dir>/run-params.json
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_EXCESS_YOCTO, JOURNEYS, nearRunner, runJourney } from "./lib/journey.mjs";
import {
  accountsFromEnv,
  CONTRACT_NETWORK,
  describeNearFailure,
  networkProfile,
  parseAddedKey,
  parseFallbackRpcUrls,
  parseSavedKeyFile,
  parseTxHash,
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

function flags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) out._.push(a);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) out[a.slice(2)] = argv[++i];
    else out[a.slice(2)] = true;
  }
  return out;
}

function need(f, k) {
  if (typeof f[k] !== "string" || !f[k]) throw new ToolError("USAGE", `--${k} is required`);
  return f[k];
}

function amount(f) {
  const v = need(f, "amount-yocto");
  if (!/^[1-9][0-9]{0,38}$/.test(v))
    throw new ToolError("USAGE", "--amount-yocto must be a positive integer");
  return BigInt(v);
}

function excess(f) {
  const v = f["excess-yocto"];
  if (v === undefined) return DEFAULT_EXCESS_YOCTO;
  if (typeof v !== "string" || !/^[1-9][0-9]{0,38}$/.test(v))
    throw new ToolError("USAGE", "--excess-yocto must be a positive integer");
  return BigInt(v);
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
  const profile = () =>
    networkProfile(
      f.network,
      f["rpc-url"],
      parseFallbackRpcUrls(f["fallback-rpc-urls"] ?? process.env.DOCKSIDE_FALLBACK_RPC_URLS),
    );
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
      return print(p[field]);
    }
    case "accounts":
      return print(accountsFromEnv(process.env));
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
      const amt = amount(f);
      const p = profile();
      const accts = accountsFromEnv(process.env);
      const rpc = new Rpc(p.rpcUrls);
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
      if (!f["skip-deploy"] && escrowCode !== empty) {
        throw new ToolError(
          "ESCROW_NOT_EMPTY",
          `${accts.escrow} already has code ${escrowCode}; use --skip-deploy to reuse a deployment`,
        );
      }
      if (f["skip-deploy"] && escrowCode !== wasm.nearCodeHash) {
        throw new ToolError(
          "CODE_HASH_MISMATCH",
          `${accts.escrow} runs ${escrowCode}, not the manifest's ${wasm.nearCodeHash}`,
        );
      }
      const storage = BigInt(wasm.bytes) * YOCTO_PER_BYTE + NEAR;
      if (!f["skip-deploy"] && BigInt(views.escrow.amount) < storage) {
        throw new ToolError(
          "INSUFFICIENT_BALANCE",
          `${accts.escrow} needs at least ${storage} yoctoNEAR for code storage plus state`,
        );
      }
      const fee = NEAR / 10n;
      // The refund journey deposits the trade amount plus an excess (EXCESS_FUNDING_RETURN).
      const journey = journeyName(f);
      const deposit = journey === "refund" ? amt + excess(f) : amt;
      if (BigInt(views.buyer.amount) < deposit + fee) {
        throw new ToolError(
          "INSUFFICIENT_BALANCE",
          `${accts.buyer} needs ${journey === "refund" ? "the trade amount plus the excess" : "the trade amount"} plus 0.1 NEAR for fees`,
        );
      }
      if (BigInt(views.relayer.amount) < 2n * NEAR) {
        throw new ToolError(
          "INSUFFICIENT_BALANCE",
          `${accts.relayer} needs at least 2 NEAR (function-call allowance and fees)`,
        );
      }
      return print({
        network: p.network,
        rpcUrl: p.rpcUrl,
        journey,
        depositYocto: deposit.toString(),
        accounts: accts,
        escrowCodeHash: escrowCode,
        balancesYocto: Object.fromEntries(Object.entries(views).map(([k, v]) => [k, v.amount])),
      });
    }
    case "verify-deployment": {
      const p = profile();
      const accts = accountsFromEnv(process.env);
      const rpc = new Rpc(p.rpcUrls);
      const want = need(f, "code-hash");
      const account = await rpc.viewAccount(accts.escrow);
      if (account.code_hash !== want) {
        throw new ToolError(
          "CODE_HASH_MISMATCH",
          `on-chain code hash ${account.code_hash} differs from the manifest's ${want}`,
        );
      }
      const config = await rpc.view(accts.escrow, "get_config", {});
      if (config.network !== CONTRACT_NETWORK)
        throw new ToolError("CONFIG_MISMATCH", `contract network is ${config.network}`);
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
      const accts = accountsFromEnv(process.env);
      const rpc = new Rpc(p.rpcUrls);
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
      if (typeof params[field] !== "string")
        throw new ToolError("NOTHING_TO_RESUME", `${file} has no ${field}`);
      return print(params[field]);
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
      if (f["rpc-url"] === undefined) return print(networkProfile(params.network, params.rpcUrl).rpcUrl);
      if (typeof f["rpc-url"] !== "string" || !f["rpc-url"])
        throw new ToolError("USAGE", "--rpc-url needs a URL");
      return print(networkProfile(params.network, f["rpc-url"]).rpcUrl);
    }
    case "journey": {
      const p = profile();
      const accts = accountsFromEnv(process.env);
      const rpc = new Rpc(p.rpcUrls);
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
      const excessYocto = resume ? undefined : excess(f);
      const amountYocto = resume ? undefined : amount(f);
      const config = await rpc.view(accts.escrow, "get_config", {});
      const result = await runJourney({
        journey,
        resume,
        wait: !f["no-wait"],
        stopAfter,
        pendingTx,
        excessYocto,
        rpc,
        profile: p,
        accounts: accts,
        near: nearRunner(need(f, "near"), {
          log: (m) => process.stderr.write(`run-all:     ${m}\n`),
        }),
        relayerKeyFile: need(f, "key-file"),
        mirrorBin: need(f, "mirror"),
        outDir: out,
        amountYocto,
        minDepositYocto: config.minDepositYocto,
        log: (m) => process.stderr.write(`run-all:   ${m}\n`),
      });
      writeFileSync(
        join(out, "journey.json"),
        `${JSON.stringify({ network: p.network, contractId: accts.escrow, ...result }, null, 2)}\n`,
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
