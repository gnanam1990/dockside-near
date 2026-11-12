// Steps of scripts/testnet-deploy/run-all that need JSON, hashing or RPC. Each subcommand prints
// one JSON document (or one value for `profile`) and exits 0, or prints `run-all: <CODE>: ...`
// to stderr and exits 2. Read-only except `journey`, which submits transactions through
// near-cli-rs (signed from the user's keychain and the relayer's function-call key file).
//
//   node tool.mjs profile --network <testnet|sandbox> [--rpc-url <url>] --field <cliNetwork|rpcUrl>
//   node tool.mjs accounts
//   node tool.mjs verify-artifact --wasm <file> --manifest <file>
//   node tool.mjs preflight --network <n> [--rpc-url <url>] --wasm <file> --amount-yocto <n> [--skip-deploy]
//   node tool.mjs tx-hash --file <near-cli output>
//   node tool.mjs verify-deployment --network <n> [--rpc-url <url>] --code-hash <base58>
//   node tool.mjs relayer-key-file --file <near-cli add-key output>
//   node tool.mjs verify-relayer-key --network <n> [--rpc-url <url>] --key-file <file>
//   node tool.mjs journey --network <n> [--rpc-url <url>] --near <bin> --key-file <file> --mirror <bin> --out <dir> --amount-yocto <n>
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nearRunner, runJourney } from "./lib/journey.mjs";
import {
  accountsFromEnv,
  CONTRACT_NETWORK,
  networkProfile,
  parseAddedKey,
  parseSavedKeyFile,
  parseTxHash,
  Rpc,
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

const print = (v) => process.stdout.write(`${typeof v === "string" ? v : JSON.stringify(v, null, 2)}\n`);

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const f = flags(rest);
  const profile = () => networkProfile(f.network, f["rpc-url"]);
  switch (cmd) {
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
      const rpc = new Rpc(p.rpcUrl);
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
      if (BigInt(views.buyer.amount) < amt + fee) {
        throw new ToolError(
          "INSUFFICIENT_BALANCE",
          `${accts.buyer} needs the trade amount plus 0.1 NEAR for fees`,
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
        accounts: accts,
        escrowCodeHash: escrowCode,
        balancesYocto: Object.fromEntries(Object.entries(views).map(([k, v]) => [k, v.amount])),
      });
    }
    case "verify-deployment": {
      const p = profile();
      const accts = accountsFromEnv(process.env);
      const rpc = new Rpc(p.rpcUrl);
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
      const rpc = new Rpc(p.rpcUrl);
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
    case "journey": {
      const p = profile();
      const accts = accountsFromEnv(process.env);
      const rpc = new Rpc(p.rpcUrl);
      const out = need(f, "out");
      const config = await rpc.view(accts.escrow, "get_config", {});
      const result = await runJourney({
        rpc,
        profile: p,
        accounts: accts,
        near: nearRunner(need(f, "near")),
        relayerKeyFile: need(f, "key-file"),
        mirrorBin: need(f, "mirror"),
        outDir: out,
        amountYocto: amount(f),
        minDepositYocto: config.minDepositYocto,
        log: (m) => process.stderr.write(`run-all:   ${m}\n`),
      });
      writeFileSync(
        join(out, "journey.json"),
        `${JSON.stringify({ network: p.network, contractId: accts.escrow, ...result }, null, 2)}\n`,
      );
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
