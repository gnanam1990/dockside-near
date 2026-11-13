// The run-all journeys: one trade through the deployed escrow with real transactions.
//
//   paid    register_trade -> register_evidence_policy -> fund (buyer's own account) ->
//           submit_manifest_attestation -> submit_inspection (PASS) -> create_release_intent ->
//           approve_release -> execute_release -> PAID at the bound supplier
//   hold    as paid, with a deterministic-policy hold SET after the inspection (the release is
//           blocked: HOLD_ACTIVE) and RESOLVED by the risk/policy principal with RELEASE_HOLD
//           before the approval -> PAID
//   refund  register_trade -> fund (trade amount plus an excess, buyer's own account) ->
//           request_refund MUTUAL_CANCEL (buyer and supplier sign the one request) ->
//           request_refund EXCESS_FUNDING_RETURN (the buyer's own account) -> one-hour cooling
//           on chain time -> authorize_refund and execute_refund for both -> REFUNDED, every
//           yoctoNEAR back with the buyer
//
// With a NEP-141 trade asset (`--asset usdc --token <id>`, M50) the same journeys run in the token:
// `fund` is the buyer's own `ft_transfer_call` on the token contract (the escrow's `ft_on_transfer`
// is what the mirror replays; a funding the contract returns is a failed step), `payee_storage`
// (`check_payee_storage`) confirms the supplier's token registration before the intent locks the
// value, and the release and the refunds are checked against token balances.
//
// Dockside payloads are built and signed by the `dockside-journey-mirror` process with
// principal keys derived from a per-run random seed (they are not NEAR keys). The seed is kept in
// the run directory (`journey-seed.json`, mode 0600, under the git-ignored .data/) so an
// interrupted journey can be finished later with `--resume`; `journey-state.json` records every
// completed step and the exact mirror replay of it. Relayed calls are signed by near-cli-rs with
// the relayer's function-call key file; funding and the funder's own excess return are signed
// with the buyer's own key from the near-cli-rs keychain. After every transaction the mirror
// replays it at the receipt's block time and the contract's views must equal the core's.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  classifyNearFailure,
  describeNearFailure,
  isFailure,
  runNear,
  successValue,
  ToolError,
} from "./near-tools.mjs";

import { DEFAULT_EXCESS_UNITS, DEFAULT_EXCESS_YOCTO } from "./plan.mjs";

const HOUR = 3_600_000;
export const JOURNEYS = ["paid", "hold", "refund"];
/** Excess the refund journey deposits on top of the trade amount (0.01 NEAR, or 1 USDC). */
export { DEFAULT_EXCESS_YOCTO };
export const SEED_FILE = "journey-seed.json";
export const STATE_FILE = "journey-state.json";
/** A cooling period longer than this is not one the journeys create; refuse to sit in it. */
const MAX_WAIT_MS = 2 * HOUR;

/**
 * The steps of each journey. `tx` steps submit one transaction built by the mirror; `observe`
 * steps record chain views the checks need; `wait` holds until the live refund deadlines pass on
 * chain time. `extra(done)` adds builder fields from the completed steps.
 */
const intentOf = (done) => done.find((s) => s.step === "intent")?.returned?.releaseIntentId;
const refundOf = (label) => (done) => done.find((s) => s.step === `refund:${label}`)?.returned;
const PLANS = {
  paid: [
    { id: "register", what: "register" },
    { id: "policy", what: "policy" },
    { id: "fund", what: "fund" },
    { id: "attestation", what: "attestation" },
    { id: "inspection", what: "inspection" },
    { id: "intent", what: "intent" },
    { id: "approval", what: "approval", extra: (d) => ({ intentId: intentOf(d) }) },
    { id: "execute_release", what: "execute_release", extra: (d) => ({ intentId: intentOf(d) }) },
  ],
  hold: [
    { id: "register", what: "register" },
    { id: "policy", what: "policy" },
    { id: "fund", what: "fund" },
    { id: "attestation", what: "attestation" },
    { id: "inspection", what: "inspection" },
    { id: "hold_set", what: "hold_set", extra: () => ({ hold: "h1", issuer: "POLICY_SETTER" }) },
    { id: "intent", what: "intent" },
    { id: "observe:held", kind: "observe" },
    { id: "hold_resolve", what: "hold_resolve", extra: () => ({ hold: "h1", code: "RELEASE_HOLD" }) },
    { id: "approval", what: "approval", extra: (d) => ({ intentId: intentOf(d) }) },
    { id: "execute_release", what: "execute_release", extra: (d) => ({ intentId: intentOf(d) }) },
  ],
  refund: [
    { id: "register", what: "register" },
    { id: "fund", what: "fund", extra: (_d, p) => ({ depositYocto: String(p.amount + p.excess) }) },
    { id: "refund:cancel", what: "refund_mutual_cancel", label: "cancel" },
    { id: "refund:excess", what: "refund_excess", label: "excess" },
    { id: "wait:cooling", kind: "wait" },
    { id: "authorize:cancel", what: "authorize_refund", extra: (d) => ({ refundId: refundOf("cancel")(d) }) },
    { id: "execute:cancel", what: "execute_refund", extra: (d) => ({ refundId: refundOf("cancel")(d) }) },
    { id: "authorize:excess", what: "authorize_refund", extra: (d) => ({ refundId: refundOf("excess")(d) }) },
    { id: "execute:excess", what: "execute_refund", extra: (d) => ({ refundId: refundOf("excess")(d) }) },
  ],
};

/**
 * The steps of `journey` for `asset`. A NEP-141 release first confirms the payee's registration
 * with the token (`check_payee_storage`), right before the intent locks the value.
 */
export function planMethods(journey, asset) {
  const plan = PLANS[journey];
  if (!plan) throw new ToolError("USAGE", `--journey must be one of ${JOURNEYS.join(", ")}`);
  if (asset?.kind !== "nep141") return plan;
  const i = plan.findIndex((s) => s.id === "intent");
  if (i < 0) return plan;
  return [...plan.slice(0, i), { id: "payee_storage", what: "payee_storage" }, ...plan.slice(i)];
}

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

/** Write a file in one step (a crash leaves the old or the new file, never half of one). */
function writeAtomic(file, text, mode) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text, mode ? { mode } : undefined);
  if (mode) chmodSync(tmp, mode);
  renameSync(tmp, file);
}

/** The per-run seed file: written once, before the first transaction, readable by the owner only. */
export function writeSeed(outDir, seed) {
  const file = join(outDir, SEED_FILE);
  if (existsSync(file)) throw new ToolError("RUN_EXISTS", `${file} exists; use --resume ${outDir}`);
  writeFileSync(file, `${JSON.stringify(seed, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(file, 0o600);
  return file;
}

export function readSeed(outDir) {
  const file = join(outDir, SEED_FILE);
  if (!existsSync(file))
    throw new ToolError("NOTHING_TO_RESUME", `${file} is missing: no journey was started in ${outDir}`);
  chmodSync(file, 0o600);
  const s = JSON.parse(readFileSync(file, "utf8"));
  if (s.schema !== "dockside/journey-seed@1" || typeof s.seed !== "string" || s.seed.length < 64)
    throw new ToolError("SEED_INVALID", `${file} is not a journey seed file`);
  return s;
}

function loadState(outDir) {
  const file = join(outDir, STATE_FILE);
  if (!existsSync(file))
    return { schema: "dockside/journey-state@1", steps: [], pending: null, observed: {} };
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * Run (or, with `resume`, continue) one journey. Returns `{ ok, paused, ... }`; a paused journey
 * (`stopAfter` reached, or the refund cooling period still running with `wait: false`) is
 * finished later by calling this again with `resume: true` on the same `outDir`.
 */
export async function runJourney(o) {
  const { rpc, profile, accounts, near, relayerKeyFile, mirrorBin, outDir, log } = o;
  mkdirSync(join(outDir, "args"), { recursive: true });
  let seed;
  if (o.resume) {
    seed = readSeed(outDir);
    for (const k of ["escrow", "buyer", "supplier", "relayer"]) {
      if (seed.accounts[k] !== accounts[k])
        throw new ToolError(
          "RESUME_MISMATCH",
          `the run's ${k} account is ${seed.accounts[k]}, the environment names ${accounts[k]}`,
        );
    }
  } else {
    planMethods(o.journey);
    const token = o.asset?.kind === "nep141";
    const t0 = await rpc.blockTimeMs();
    seed = {
      schema: "dockside/journey-seed@1",
      note: "Per-run Dockside principal key seed (test keys for this one trade, not NEAR keys). Keep private; needed to finish the trade with run-all --resume.",
      journey: o.journey,
      network: profile.network,
      accounts,
      seed: randomBytes(32).toString("hex"),
      trade: `journey-${t0}`,
      t0,
      // Base units of the asset: yoctoNEAR, or the token's units (the names predate M50).
      amountYocto: String(o.amountYocto),
      excessYocto: String(
        o.journey === "refund"
          ? (o.excessYocto ?? (token ? DEFAULT_EXCESS_UNITS : DEFAULT_EXCESS_YOCTO))
          : 0n,
      ),
      contractNetwork: profile.contractNetwork,
      asset: token ? { kind: "nep141", token: o.asset.token } : { kind: "near", token: null },
    };
    writeSeed(outDir, seed);
  }
  const journey = seed.journey;
  const asset = seed.asset ?? { kind: "near", token: null };
  const tokenId = asset.kind === "nep141" ? asset.token.accountId : null;
  if ((seed.contractNetwork ?? "near-testnet") !== profile.contractNetwork)
    throw new ToolError(
      "RESUME_MISMATCH",
      `the run's contract label is ${seed.contractNetwork ?? "near-testnet"}, this invocation uses ${profile.contractNetwork}`,
    );
  const plan = planMethods(journey, asset);
  const params = { amount: BigInt(seed.amountYocto), excess: BigInt(seed.excessYocto) };
  /** What `account` holds of the trade asset, in base units. */
  const balanceOf = async (account) =>
    tokenId ? await rpc.ftBalance(tokenId, account) : (await rpc.viewAccount(account)).amount;
  const state = loadState(outDir);
  const save = () => writeAtomic(join(outDir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);

  const mirror = new MirrorProcess(mirrorBin);
  try {
    const init = await mirror.must({
      op: "init",
      accounts: { contract: accounts.escrow, buyer: accounts.buyer, supplier: accounts.supplier },
      seed: seed.seed,
      trade: seed.trade,
      amountYocto: seed.amountYocto,
      delayMs: HOUR,
      t0: seed.t0,
      token: asset.token,
      // The deployed contract's own configuration: the mirror refuses what the contract refuses.
      config: o.config ?? null,
      minDepositYocto: seed.minDepositYocto ?? null,
    });
    const tradeId = init.tradeId;
    log(`${journey} journey, trade ${tradeId}${o.resume ? " (resumed)" : ""}`);

    // Resume: replay every completed transaction on the mirror, then the chain must agree.
    for (const s of state.steps) for (const a of s.mirror ?? []) await mirror.must({ op: "apply", ...a });
    if (state.steps.some((s) => s.txHash))
      await compareViews(rpc, mirror, accounts, tradeId, null, outDir, "resume");
    if (state.steps.length > 0) log(`${state.steps.length} completed step(s) replayed`);
    if (state.supplierStartYocto === undefined) {
      state.supplierStartYocto = await balanceOf(accounts.supplier);
      save();
    }

    const txCount = () => state.steps.filter((s) => s.txHash).length;
    const paused = (why, extra = {}) => ({
      ok: false,
      paused: true,
      why,
      journey,
      tradeId,
      steps: state.steps,
      completed: state.steps.length,
      of: plan.length,
      next: plan[state.steps.length]?.id ?? null,
      ...extra,
    });

    // A transaction sent before an interruption: settle it before anything else.
    if (state.pending) {
      const p = state.pending;
      const txHash = p.txHash ?? (o.pendingTx && o.pendingTx !== "none" ? o.pendingTx : null);
      if (txHash) {
        const tx = await rpc.txStatus(txHash, p.signer);
        if (!p.txHash && !isTheCall(tx, p, p.receiver ?? accounts.escrow))
          throw new ToolError(
            "PENDING_MISMATCH",
            `--pending-tx ${txHash} is not ${p.method} with the arguments in ${p.argsFile}, signed by ${p.signer}`,
          );
        const main = tx.receipts_outcome.find((x) => x.outcome.executor_id === accounts.escrow);
        if (main && !isFailure(main.outcome.status)) {
          log(`settling ${p.method} ${txHash} sent before the interruption`);
          await finalize(p, txHash, tx);
        } else {
          log(`${p.method} ${txHash} did not change the escrow; building it again`);
          state.pending = null;
          save();
        }
      } else if (p.notSent || o.pendingTx === "none") {
        state.pending = null;
        save();
      } else {
        throw new ToolError(
          "PENDING_UNKNOWN",
          `${p.method} (signer ${p.signer}) was being sent when the run stopped and its transaction id is unknown. ` +
            `Look it up for ${p.signer} in the explorer, then rerun with --resume ${outDir} --pending-tx <hash>, ` +
            "or --pending-tx none if no such transaction reached the escrow",
        );
      }
    }

    async function finalize(p, txHash, tx) {
      const outcomes = tx.receipts_outcome;
      const mainIdx = outcomes.findIndex((x) => x.outcome.executor_id === accounts.escrow);
      if (mainIdx < 0) throw new ToolError("SUBMIT_FAILED", `${p.method}: no receipt ran on the escrow`);
      const main = outcomes[mainIdx];
      if (isFailure(main.outcome.status)) {
        throw new ToolError(
          "CONTRACT_REFUSED",
          `${p.method} ${txHash}: ${JSON.stringify(main.outcome.status)}`,
        );
      }
      const at = await rpc.blockTimeMs(main.block_hash);
      const applies = [];
      const applyFull = async (a) => {
        applies.push(a);
        return mirror.must({ op: "apply", ...a });
      };
      const apply = async (a) => (await applyFull(a)).value;
      let mirrored;
      let value = successValue(main.outcome.status);
      if (p.onEscrow) {
        // A token funding: the escrow ran the `ft_on_transfer` the token delivered. It returns
        // the units it gives back; anything but "0" means the contract refused the funding.
        const r = await applyFull({
          method: p.onEscrow.method,
          args: p.onEscrow.args,
          now: at,
          predecessor: p.receiver,
          deposit: "0",
        });
        mirrored = r.value;
        if (value !== "0" || r.refusal) {
          // Nothing was credited and the token returned the amount: the step did not happen.
          applies.pop();
          state.pending = null;
          save();
          throw new ToolError(
            "CONTRACT_REFUSED",
            `${p.method} ${txHash}: the escrow returned ${value} of ${p.onEscrow.args.amount} units` +
              (r.refusal ? ` (${r.refusal.code}: ${r.refusal.message})` : ""),
          );
        }
        const used = successValue(tx.status);
        if (used !== p.onEscrow.args.amount)
          throw new ToolError(
            "SUBMIT_FAILED",
            `${p.method} ${txHash}: the token reports ${used} units used, not ${p.onEscrow.args.amount}`,
          );
      } else {
        mirrored = await apply({
          method: p.method,
          args: p.args,
          now: at,
          predecessor: p.signer,
          deposit: p.deposit,
        });
      }
      const callback = {
        execute_release: "on_release_transfer",
        execute_refund: "on_refund_transfer",
        check_payee_storage: "on_payee_storage",
      }[p.method];
      if (callback) {
        // The contract that runs the scheduled call: the token for a NEP-141 transfer or the
        // storage check, the recipient itself for native NEAR.
        const to = mirrored.storage_balance_of?.token ?? mirrored.transfer.token ?? mirrored.transfer.to;
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
          throw new ToolError("SUBMIT_FAILED", `${p.method}: transfer or settlement receipt missing`);
        const cbArgs =
          p.method === "execute_release"
            ? {
                trade_id: tradeId,
                release_intent_id: p.args.release_intent_id,
                attempt_id: mirrored.attempt_id,
              }
            : p.method === "check_payee_storage"
              ? { trade_id: tradeId, account_id: p.args.account_id }
              : { trade_id: tradeId, refund_intent_id: p.args.refund_intent_id };
        // For the payee check the outcome that matters is the token's answer: a storage balance
        // (registered) or null.
        const answer = isFailure(transfer.outcome.status) ? null : successValue(transfer.outcome.status);
        const promiseOk =
          p.method === "check_payee_storage"
            ? answer !== null && typeof answer === "object"
            : !isFailure(transfer.outcome.status);
        mirrored = await apply({
          method: callback,
          args: cbArgs,
          now: await rpc.blockTimeMs(cb.block_hash),
          predecessor: accounts.escrow,
          deposit: "0",
          promiseOk,
        });
        value = successValue(cb.outcome.status);
      }
      if (!sameJson(value, mirrored)) {
        throw new ToolError(
          "MIRROR_MISMATCH",
          `${p.method}: chain returned ${JSON.stringify(value)}, mirror ${JSON.stringify(mirrored)}`,
        );
      }
      await compareViews(rpc, mirror, accounts, tradeId, at, outDir, p.method);
      if (p.method === "check_payee_storage" && value !== true)
        throw new ToolError(
          "PAYEE_NOT_REGISTERED",
          `${p.args.account_id} is not registered with ${tokenId} (storage_deposit); the value cannot be locked for it`,
        );
      const step = {
        step: p.step,
        method: p.method,
        signer: p.signer,
        txHash,
        blockHash: main.block_hash,
        blockTimeMs: at,
        returned: value,
        mirror: applies,
      };
      if (p.payee) {
        step.payee = p.payee;
        step.payeeBeforeYocto = p.payeeBeforeYocto;
        step.payeeAfterYocto = await balanceOf(p.payee);
      }
      state.steps.push(step);
      state.pending = null;
      save();
      log(`${p.method.padEnd(28)} ${txHash}`);
      return value;
    }

    for (let i = state.steps.length; i < plan.length; i++) {
      if (o.stopAfter !== undefined && txCount() >= o.stopAfter)
        return paused(`stopped after ${txCount()} transaction(s) (--stop-after)`);
      const s = plan[i];
      if (s.kind === "observe") {
        const now = await rpc.blockTimeMs();
        const holds = await rpc.view(accounts.escrow, "get_holds", { trade_id: tradeId });
        const release = await rpc.view(accounts.escrow, "get_release", { trade_id: tradeId });
        state.observed[s.id] = { atMs: now, holds, blockers: release.blockers };
        state.steps.push({ step: s.id, kind: "observe", atMs: now });
        save();
        log(`observed holds ${holds.map((h) => h.status).join(",")}, blockers ${release.blockers.join(",")}`);
        continue;
      }
      if (s.kind === "wait") {
        const refunds = await rpc.view(accounts.escrow, "get_refunds", { trade_id: tradeId });
        const deadline = Math.max(
          0,
          ...refunds.filter((r) => r.state === "TIMELOCKED" && r.deadline).map((r) => r.deadline),
        );
        let now = await rpc.blockTimeMs();
        if (deadline - now > MAX_WAIT_MS)
          throw new ToolError(
            "WAIT_TOO_LONG",
            `cooling ends at ${new Date(deadline).toISOString()}, beyond ${MAX_WAIT_MS / HOUR} h`,
          );
        if (now < deadline && !o.wait)
          return paused(`cooling period runs until ${new Date(deadline).toISOString()} (chain time)`, {
            resumeAfterMs: deadline,
          });
        let lastLog = 0;
        while (now < deadline) {
          if (Date.now() - lastLog > 5 * 60_000) {
            log(
              `waiting for the cooling period: ${Math.ceil((deadline - now) / 60_000)} min of chain time left`,
            );
            lastLog = Date.now();
          }
          await new Promise((r) => setTimeout(r, Math.min(30_000, Math.max(2_000, deadline - now))));
          now = await rpc.blockTimeMs();
        }
        state.steps.push({ step: s.id, kind: "wait", deadlineMs: deadline, passedAtMs: now });
        save();
        log(`cooling period over at chain time ${new Date(now).toISOString()}`);
        continue;
      }
      await submit(s);
    }

    async function submit(s) {
      const now = await rpc.blockTimeMs();
      const extra = s.extra ? s.extra(state.steps, params) : {};
      const b = await mirror.must({ op: "build", what: s.what, now, label: s.label ?? "j", ...extra });
      const argsFile = join(outDir, "args", `${state.steps.length + 1}-${b.method}.json`);
      writeFileSync(argsFile, JSON.stringify(b.args));
      const signer = b.signer === "funder" ? accounts.buyer : accounts.relayer;
      const signing =
        b.signer === "funder" ? ["sign-with-keychain"] : ["sign-with-access-key-file", relayerKeyFile];
      const payee = { execute_release: accounts.supplier, execute_refund: accounts.buyer }[b.method];
      // A token funding is sent to the token contract; everything else to the escrow.
      const toToken = b.receiver === "token";
      if (toToken && b.token !== tokenId)
        throw new ToolError(
          "MIRROR_MISMATCH",
          `the mirror funds through ${b.token}, the run uses ${tokenId}`,
        );
      const receiver = toToken ? tokenId : accounts.escrow;
      state.pending = {
        step: s.id,
        method: b.method,
        args: b.args,
        deposit: b.deposit,
        signer,
        receiver,
        ...(toToken ? { onEscrow: b.onEscrow } : {}),
        argsFile,
        startedAt: new Date().toISOString(),
        ...(payee ? { payee, payeeBeforeYocto: await balanceOf(payee) } : {}),
      };
      save();
      const r = await near([
        "contract",
        "call-function",
        "as-transaction",
        receiver,
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
      if (r.txHash) {
        state.pending.txHash = r.txHash;
        save();
      } else {
        const kind = classifyNearFailure(r.text ?? r.clean ?? "").kind;
        // Expired (never included) or stopped at a question: nothing was sent.
        if (kind === "EXPIRED" || kind === "PROMPT") {
          state.pending.notSent = true;
          save();
        }
        throw new ToolError(
          "SUBMIT_FAILED",
          `${b.method}: ${describeNearFailure(r)}\n${tail(r.clean ?? "")}`,
        );
      }
      const tx = await rpc.txStatus(r.txHash, signer);
      if (r.status !== 0) {
        const main = tx.receipts_outcome.find((x) => x.outcome.executor_id === accounts.escrow);
        throw new ToolError(
          "CONTRACT_REFUSED",
          `${b.method} ${r.txHash}: ${JSON.stringify(main?.outcome.status ?? null)}`,
        );
      }
      return finalize(state.pending, r.txHash, tx);
    }

    return {
      paused: false,
      asset,
      ...(await checks({ rpc, accounts, journey, tradeId, state, params, balanceOf })),
    };
  } finally {
    mirror.close();
  }
}

/** A transaction id the user supplied must be exactly the call that was in flight. */
function isTheCall(tx, p, escrow) {
  const t = tx.transaction ?? {};
  const call = (t.actions ?? []).map((a) => a?.FunctionCall).find(Boolean);
  if (!call || t.signer_id !== p.signer || t.receiver_id !== escrow || call.method_name !== p.method)
    return false;
  try {
    return sameJson(JSON.parse(Buffer.from(call.args, "base64").toString("utf8")), p.args);
  } catch {
    return false;
  }
}

/** The contract's own views must equal the core's after every transaction. */
async function compareViews(rpc, mirror, accounts, tradeId, at, outDir, what) {
  const now = at ?? (await rpc.blockTimeMs());
  for (const view of ["get_ledger", "get_refunds"]) {
    const chain = await rpc.view(accounts.escrow, view, { trade_id: tradeId });
    const host = (await mirror.must({ op: "view", method: view, args: { trade_id: tradeId }, now })).value;
    if (!sameJson(chain, host)) {
      writeFileSync(
        join(outDir, "mismatch.json"),
        JSON.stringify({ after: what, view, chain, mirror: host }, null, 2),
      );
      throw new ToolError(
        "MIRROR_MISMATCH",
        `${view} after ${what} differs from the core's (see mismatch.json)`,
      );
    }
  }
}

const big = (x) => BigInt(x ?? 0);

async function checks({ rpc, accounts, journey, tradeId, state, params, balanceOf }) {
  const steps = state.steps.filter((s) => s.txHash);
  const ledger = await rpc.view(accounts.escrow, "get_ledger", { trade_id: tradeId });
  const intentId = steps.find((s) => s.step === "intent")?.returned?.releaseIntentId ?? null;
  const base = { journey, tradeId, releaseIntentId: intentId, steps: state.steps, ledger };
  if (journey === "refund") {
    const refunds = await rpc.view(accounts.escrow, "get_refunds", { trade_id: tradeId });
    const buyer = ledger.funders[accounts.buyer] ?? {};
    const executes = steps.filter((s) => s.method === "execute_refund");
    const byId = Object.fromEntries(refunds.map((r) => [r.refundIntentId, r]));
    const received = executes.map((s) => {
      const r = byId[s.mirror[0].args.refund_intent_id];
      const delta = big(s.payeeAfterYocto) - big(s.payeeBeforeYocto);
      return {
        refundIntentId: r?.refundIntentId,
        reason: r?.reason,
        amount: r?.amount,
        deltaYocto: delta.toString(),
        exact: r ? delta === big(r.amount) : false,
      };
    });
    const supplierNow = big(await balanceOf(accounts.supplier));
    const funded = params.amount + params.excess;
    const c = {
      refundsRefunded: refunds.length === 2 && refunds.every((r) => r.state === "REFUNDED"),
      reasons: refunds.map((r) => r.reason).sort(),
      buyerReceived: received,
      buyerReceivedExactAmounts: received.length === 2 && received.every((x) => x.exact),
      buyerFundedYocto: buyer.funded,
      buyerRefundedYocto: buyer.refunded,
      buyerRefundedEverything: big(buyer.funded) === funded && big(buyer.refunded) === funded,
      buyerNothingLeft: ["partial", "available", "reserved", "released", "refundLocked", "quarantined"].every(
        (k) => big(buyer[k]) === 0n,
      ),
      releasedTotal: ledger.totals.released,
      supplierUnchanged: supplierNow === big(state.supplierStartYocto),
      ledgerConservation: ledger.conservation === true,
    };
    const ok =
      c.refundsRefunded &&
      c.buyerReceivedExactAmounts &&
      c.buyerRefundedEverything &&
      c.buyerNothingLeft &&
      big(c.releasedTotal) === 0n &&
      c.supplierUnchanged &&
      c.ledgerConservation &&
      c.reasons.join() === "EXCESS_FUNDING_RETURN,MUTUAL_CANCEL";
    return { ok, ...base, checks: c, refunds };
  }
  const release = await rpc.view(accounts.escrow, "get_release", { trade_id: tradeId });
  const exec = steps.find((s) => s.method === "execute_release");
  const delta = exec ? big(exec.payeeAfterYocto) - big(exec.payeeBeforeYocto) : 0n;
  const c = {
    settledTrue: exec?.returned === true,
    releasePaid: JSON.stringify(release).includes('"PAID"'),
    supplierDeltaYocto: delta.toString(),
    supplierReceivedExactAmount: delta === params.amount,
    ledgerConservation: ledger.conservation === true,
    releasedTotal: ledger.totals.released,
  };
  let ok = c.settledTrue && c.releasePaid && c.supplierReceivedExactAmount && c.ledgerConservation;
  const out = { ...base, release };
  if (journey === "hold") {
    const holds = await rpc.view(accounts.escrow, "get_holds", { trade_id: tradeId });
    const held = state.observed["observe:held"] ?? {};
    const h = holds[0] ?? {};
    c.holdWasActive = (held.holds ?? []).length === 1 && held.holds[0].status === "ACTIVE";
    c.releaseBlockedByHold = (held.blockers ?? []).includes("HOLD_ACTIVE");
    c.holdSetBy = `${h.issuerRole}${h.ruleId ? ` (${h.ruleId})` : ""}`;
    c.holdResolved = holds.length === 1 && h.status === "RESOLVED" && h.resolution?.code === "RELEASE_HOLD";
    c.deterministicPolicyHold = h.issuerRole === "POLICY_SETTER" && typeof h.ruleId === "string";
    ok = ok && c.holdWasActive && c.releaseBlockedByHold && c.holdResolved && c.deterministicPolicyHold;
    out.holds = holds;
  }
  return { ok, ...out, checks: c };
}

function tail(text) {
  return text.split("\n").slice(-15).join("\n");
}

/**
 * near-cli-rs bound to one binary: stdin closed, and an expired transaction (never included)
 * signed again up to `attempts` times.
 */
export function nearRunner(bin, { attempts = 3, log = () => {} } = {}) {
  return (args) => runNear(bin, args, { attempts, log });
}
