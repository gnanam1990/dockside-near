// The run-all journey: one trade through the deployed escrow with real transactions.
//
//   register_trade -> register_evidence_policy -> fund (buyer's own account) ->
//   submit_manifest_attestation -> submit_inspection (PASS) -> create_release_intent ->
//   approve_release -> execute_release -> PAID at the bound supplier
//
// Dockside payloads are built and signed by the `dockside-journey-mirror` process with
// principal keys derived from a fresh random seed (they are not NEAR keys and are not stored).
// Relayed calls are signed by near-cli-rs with the relayer's function-call key file; funding is
// signed with the buyer's own key from the near-cli-rs keychain. After every transaction the
// mirror replays it at the receipt's block time and the contract's ledger view must equal it.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { isFailure, nearCli, successValue, ToolError } from "./near-tools.mjs";

const HOUR = 3_600_000;

class MirrorProcess {
  constructor(bin) {
    this.child = spawn(bin, [], { stdio: ["pipe", "pipe", "inherit"] });
    this.lines = createInterface({ input: this.child.stdout })[Symbol.asyncIterator]();
  }

  async send(req) {
    this.child.stdin.write(`${JSON.stringify(req)}\n`);
    const { value, done } = await this.lines.next();
    if (done) throw new ToolError("MIRROR_EXITED", "journey mirror exited");
    return JSON.parse(value);
  }

  async must(req) {
    const r = await this.send(req);
    if (!r.ok)
      throw new ToolError(
        "MIRROR_REFUSED",
        `${req.op} ${req.what ?? req.method}: ${r.code} ${r.message ?? ""}`,
      );
    return r;
  }

  close() {
    this.child.stdin.end();
  }
}

/** JSON equality that ignores object key order (the contract and the mirror order keys differently). */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}
const sameJson = (a, b) => canonical(a) === canonical(b);

export async function runJourney(o) {
  const { rpc, profile, accounts, near, relayerKeyFile, mirrorBin, outDir, amountYocto, log } = o;
  mkdirSync(join(outDir, "args"), { recursive: true });
  const mirror = new MirrorProcess(mirrorBin);
  const steps = [];
  try {
    const t0 = await rpc.blockTimeMs();
    const init = await mirror.must({
      op: "init",
      accounts: { contract: accounts.escrow, buyer: accounts.buyer, supplier: accounts.supplier },
      seed: randomBytes(32).toString("hex"),
      trade: `journey-${t0}`,
      amountYocto: String(amountYocto),
      delayMs: HOUR,
      t0,
      minDepositYocto: o.minDepositYocto ?? null,
    });
    const tradeId = init.tradeId;
    log(`trade ${tradeId}`);

    const submit = async (what, extra = {}) => {
      const now = await rpc.blockTimeMs();
      const b = await mirror.must({ op: "build", what, now, label: "j", ...extra });
      const argsFile = join(outDir, "args", `${steps.length + 1}-${b.method}.json`);
      writeFileSync(argsFile, JSON.stringify(b.args));
      const funder = b.method === "fund";
      const signer = funder ? accounts.buyer : accounts.relayer;
      const signing = funder ? ["sign-with-keychain"] : ["sign-with-access-key-file", relayerKeyFile];
      const r = near([
        "contract",
        "call-function",
        "as-transaction",
        accounts.escrow,
        b.method,
        "file-args",
        argsFile,
        "prepaid-gas",
        "100.0 Tgas",
        "attached-deposit",
        `${b.deposit} yoctoNEAR`,
        "sign-as",
        signer,
        "network-config",
        profile.cliNetwork,
        ...signing,
        "send",
      ]);
      if (!r.txHash)
        throw new ToolError(
          "SUBMIT_FAILED",
          `${b.method}: near-cli-rs printed no transaction id\n${tail(r.clean)}`,
        );
      const tx = await rpc.txStatus(r.txHash, signer);
      const outcomes = tx.receipts_outcome;
      const mainIdx = outcomes.findIndex((x) => x.outcome.executor_id === accounts.escrow);
      if (mainIdx < 0) throw new ToolError("SUBMIT_FAILED", `${b.method}: no receipt ran on the escrow`);
      const main = outcomes[mainIdx];
      if (isFailure(main.outcome.status) || r.status !== 0) {
        throw new ToolError(
          "CONTRACT_REFUSED",
          `${b.method} ${r.txHash}: ${JSON.stringify(main.outcome.status)}`,
        );
      }
      const at = await rpc.blockTimeMs(main.block_hash);
      const applied = await mirror.must({
        op: "apply",
        method: b.method,
        args: b.args,
        now: at,
        predecessor: signer,
        deposit: b.deposit,
      });
      let value = successValue(main.outcome.status);
      let mirrored = applied.value;
      if (b.method === "execute_release") {
        const to = applied.value.transfer.to;
        const transfer = outcomes.slice(mainIdx + 1).find((x) => x.outcome.executor_id === to);
        // The settlement callback is the next escrow receipt that returns a value (or fails);
        // runtime refunds of a failed transfer and of unused gas return nothing.
        const cb = outcomes
          .slice(mainIdx + 1)
          .find(
            (x) =>
              x.outcome.executor_id === accounts.escrow &&
              (isFailure(x.outcome.status) || successValue(x.outcome.status) !== null),
          );
        if (!transfer || !cb)
          throw new ToolError("SUBMIT_FAILED", "release transfer or settlement receipt missing");
        const cbAt = await rpc.blockTimeMs(cb.block_hash);
        const settled = await mirror.must({
          op: "apply",
          method: "on_release_transfer",
          args: {
            trade_id: tradeId,
            release_intent_id: extra.intentId,
            attempt_id: applied.value.attempt_id,
          },
          now: cbAt,
          predecessor: accounts.escrow,
          deposit: "0",
          promiseOk: !isFailure(transfer.outcome.status),
        });
        value = successValue(cb.outcome.status);
        mirrored = settled.value;
      }
      if (!sameJson(value, mirrored)) {
        throw new ToolError(
          "MIRROR_MISMATCH",
          `${b.method}: chain returned ${JSON.stringify(value)}, mirror ${JSON.stringify(mirrored)}`,
        );
      }
      const ledger = await rpc.view(accounts.escrow, "get_ledger", { trade_id: tradeId });
      const hostLedger = (
        await mirror.must({ op: "view", method: "get_ledger", args: { trade_id: tradeId }, now: at })
      ).value;
      if (!sameJson(ledger, hostLedger)) {
        writeFileSync(
          join(outDir, "mismatch.json"),
          JSON.stringify({ method: b.method, chain: ledger, mirror: hostLedger }, null, 2),
        );
        throw new ToolError(
          "MIRROR_MISMATCH",
          `get_ledger after ${b.method} differs from the core's (see mismatch.json)`,
        );
      }
      steps.push({
        step: what,
        method: b.method,
        signer,
        txHash: r.txHash,
        blockHash: main.block_hash,
        blockTimeMs: at,
        returned: value,
      });
      log(`${b.method.padEnd(28)} ${r.txHash}`);
      return value;
    };

    await submit("register");
    await submit("policy");
    await submit("fund");
    await submit("attestation");
    await submit("inspection");
    const intent = await submit("intent");
    const intentId = intent.releaseIntentId;
    await submit("approval", { intentId });
    const supplierBefore = BigInt((await rpc.viewAccount(accounts.supplier)).amount);
    const paid = await submit("execute_release", { intentId });
    const supplierAfter = BigInt((await rpc.viewAccount(accounts.supplier)).amount);
    const release = await rpc.view(accounts.escrow, "get_release", { trade_id: tradeId });
    const ledger = await rpc.view(accounts.escrow, "get_ledger", { trade_id: tradeId });
    const delta = supplierAfter - supplierBefore;
    const checks = {
      settledTrue: paid === true,
      releasePaid: JSON.stringify(release).includes('"PAID"'),
      supplierDeltaYocto: delta.toString(),
      supplierReceivedExactAmount: delta === BigInt(amountYocto),
      ledgerConservation: ledger.conservation === true,
      releasedTotal: ledger.totals.released,
    };
    const ok =
      checks.settledTrue &&
      checks.releasePaid &&
      checks.supplierReceivedExactAmount &&
      checks.ledgerConservation;
    return { ok, tradeId, releaseIntentId: intentId, steps, checks, release, ledger };
  } finally {
    mirror.close();
  }
}

function tail(text) {
  return text.split("\n").slice(-15).join("\n");
}

/** near-cli-rs bound to one binary. */
export function nearRunner(bin) {
  return (args) => nearCli(bin, args);
}
