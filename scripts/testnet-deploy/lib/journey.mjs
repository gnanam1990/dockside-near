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
//   refusal six calls the contract must reject, each sent as a real transaction that must fail
//           with its expected DOCKSIDE code and change nothing (REFUSALS below), placed along one
//           trade that then completes: the hold journey with the trade amount in two deposits
//   attack-demo  the attack console's demo trade (M53): register, policy, fund, attest, inspect,
//           intent and the buyer's approval, then a deterministic-policy hold SET after the
//           approval and never resolved. The journey ends there on purpose: the value stays
//           reserved for the bound supplier, the release is blocked by the hold, and the trade is
//           left for anyone to attack from an account that has no authority over it
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

const HOUR = 3_600_000;
export const JOURNEYS = ["paid", "hold", "refund", "refusal", "attack-demo"];
/** Lifetime of the attack demo's hold: inside the trade's 30-day expiry, far beyond any demo. */
export const DEMO_HOLD_TTL_MS = 28 * 24 * HOUR;
/** Excess the refund journey deposits on top of the trade amount (0.01 NEAR). */
export const DEFAULT_EXCESS_YOCTO = 10n ** 22n;
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

/**
 * The calls the refusal journey sends that the contract must reject, in journey order. Each is
 * built so that only the named thing is wrong:
 *
 * - fund_wrong_terms: the buyer's own deposit, naming the digest of the same terms with the payout
 *   moved to the relayer account instead of the registered revision's digest;
 * - relayer_refund: the PARTIAL_FUNDING_RETURN request the funder could send from its own account
 *   at that moment (its whole PARTIAL value), sent by the relayer;
 * - replayed_nonce: the inspection attestation the contract has just accepted, byte for byte;
 * - payout_redirect: a release intent signed with the bound buyer key that names the relayer
 *   account (and that account's digest) as the destination;
 * - release_while_held: `execute_release` of the real intent while the deterministic-policy hold
 *   is ACTIVE (no approval exists yet either; the contract reports the hold first);
 * - unbound_approval: the approval the buyer would sign at that moment, signed with a run key the
 *   terms do not bind.
 */
export const REFUSALS = [
  {
    id: "refuse:fund_wrong_terms",
    method: "fund",
    expect: "STALE_REVISION",
    title: "funding with a wrong terms digest",
  },
  {
    id: "refuse:relayer_refund",
    method: "request_refund",
    expect: "FORBIDDEN",
    title: "a relayer attempting a funder-only refund",
  },
  {
    id: "refuse:replayed_nonce",
    method: "submit_inspection",
    expect: "NONCE_REPLAYED",
    title: "a replayed nonce (the accepted inspection sent again)",
  },
  {
    id: "refuse:payout_redirect",
    method: "create_release_intent",
    expect: "DESTINATION_MISMATCH",
    title: "payout redirected to an unbound account",
  },
  {
    id: "refuse:release_while_held",
    method: "execute_release",
    expect: "HOLD_ACTIVE",
    title: "release while a hold is active",
  },
  {
    id: "refuse:unbound_approval",
    method: "approve_release",
    expect: "SIGNATURE_INVALID",
    title: "approval signed by an unbound key",
  },
];
const refusal = (name, step) => {
  const r = REFUSALS.find((x) => x.id === `refuse:${name}`);
  return { id: r.id, kind: "refuse", expect: r.expect, ...step };
};

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
  refusal: [
    { id: "register", what: "register" },
    { id: "policy", what: "policy" },
    refusal("fund_wrong_terms", {
      what: "fund_other_terms",
      extra: (_d, p, a) => ({ redirect: a.relayer, depositYocto: String(p.first) }),
    }),
    { id: "fund:1", what: "fund", extra: (_d, p) => ({ depositYocto: String(p.first) }) },
    refusal("relayer_refund", { what: "refund_partial", label: "refused", as: "relayer" }),
    { id: "fund:2", what: "fund", extra: (_d, p) => ({ depositYocto: String(p.rest) }) },
    { id: "attestation", what: "attestation" },
    { id: "inspection", what: "inspection" },
    refusal("replayed_nonce", { replay: "inspection" }),
    { id: "hold_set", what: "hold_set", extra: () => ({ hold: "h1", issuer: "POLICY_SETTER" }) },
    refusal("payout_redirect", {
      what: "intent",
      label: "redirect",
      extra: (_d, _p, a) => ({ destination: a.relayer }),
    }),
    { id: "intent", what: "intent" },
    { id: "observe:held", kind: "observe" },
    refusal("release_while_held", { what: "execute_release", extra: (d) => ({ intentId: intentOf(d) }) }),
    { id: "hold_resolve", what: "hold_resolve", extra: () => ({ hold: "h1", code: "RELEASE_HOLD" }) },
    refusal("unbound_approval", {
      what: "approval",
      label: "unbound",
      extra: (d) => ({ intentId: intentOf(d), signKey: "intruder" }),
    }),
    { id: "approval", what: "approval", extra: (d) => ({ intentId: intentOf(d) }) },
    { id: "execute_release", what: "execute_release", extra: (d) => ({ intentId: intentOf(d) }) },
  ],
  // Approved first, then held: the approval exists (and can be replayed), and the hold set after
  // it blocks the release. No resolution and no execution follow.
  "attack-demo": [
    { id: "register", what: "register" },
    { id: "policy", what: "policy" },
    { id: "fund", what: "fund" },
    { id: "attestation", what: "attestation" },
    { id: "inspection", what: "inspection" },
    { id: "intent", what: "intent" },
    { id: "approval", what: "approval", extra: (d) => ({ intentId: intentOf(d) }) },
    {
      id: "hold_set",
      what: "hold_set",
      extra: () => ({ hold: "h1", issuer: "POLICY_SETTER", ttlMs: DEMO_HOLD_TTL_MS }),
    },
    { id: "observe:held", kind: "observe" },
  ],
};

/** The views a refused call must leave exactly as they were. */
const TRADE_VIEWS = ["get_trade", "get_ledger", "get_refunds", "get_evidence", "get_holds", "get_release"];

/**
 * The contract's own refusal in a failed receipt status: the wrapper panics with
 * `DOCKSIDE:<CODE>: <message>`. `code` is null for a success or any other failure.
 */
export function contractRefusal(status) {
  const failure = status && typeof status === "object" ? status.Failure : undefined;
  const text = failure?.ActionError?.kind?.FunctionCallError?.ExecutionError;
  if (typeof text !== "string")
    return { code: null, message: null, error: JSON.stringify(failure ?? status ?? null) };
  const m = /DOCKSIDE:([A-Z0-9_]+): (.*)$/s.exec(text);
  return { code: m ? m[1] : null, message: m ? m[2] : null, error: text };
}

export function planMethods(journey) {
  const plan = PLANS[journey];
  if (!plan) throw new ToolError("USAGE", `--journey must be one of ${JOURNEYS.join(", ")}`);
  return plan;
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
    // The refusal journey funds in two deposits; each must be one the contract accepts.
    if (o.journey === "refusal" && BigInt(o.amountYocto) / 2n < BigInt(o.minDepositYocto ?? 0))
      throw new ToolError(
        "USAGE",
        `the refusal journey funds the trade in two deposits; half of --amount-yocto is below the contract's minimum deposit ${o.minDepositYocto}`,
      );
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
      amountYocto: String(o.amountYocto),
      excessYocto: String(o.journey === "refund" ? (o.excessYocto ?? DEFAULT_EXCESS_YOCTO) : 0n),
      minDepositYocto: o.minDepositYocto ?? null,
    };
    writeSeed(outDir, seed);
  }
  const journey = seed.journey;
  const plan = planMethods(journey);
  const amount = BigInt(seed.amountYocto);
  // `first` and `rest`: the two deposits of the refusal journey.
  const params = { amount, excess: BigInt(seed.excessYocto), first: amount / 2n, rest: amount - amount / 2n };
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
      minDepositYocto: seed.minDepositYocto,
    });
    const tradeId = init.tradeId;
    log(`${journey} journey, trade ${tradeId}${o.resume ? " (resumed)" : ""}`);

    // Resume: replay every completed transaction on the mirror, then the chain must agree.
    for (const s of state.steps) for (const a of s.mirror ?? []) await mirror.must({ op: "apply", ...a });
    if (state.steps.some((s) => s.txHash))
      await compareViews(rpc, mirror, accounts, tradeId, null, outDir, "resume");
    if (state.steps.length > 0) log(`${state.steps.length} completed step(s) replayed`);
    if (state.supplierStartYocto === undefined) {
      state.supplierStartYocto = (await rpc.viewAccount(accounts.supplier)).amount;
      state.relayerStartYocto = (await rpc.viewAccount(accounts.relayer)).amount;
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
        if (!p.txHash && !isTheCall(tx, p, accounts.escrow))
          throw new ToolError(
            "PENDING_MISMATCH",
            `--pending-tx ${txHash} is not ${p.method} with the arguments in ${p.argsFile}, signed by ${p.signer}`,
          );
        const main = tx.receipts_outcome.find((x) => x.outcome.executor_id === accounts.escrow);
        if (main && p.refuse) {
          log(`settling ${p.method} ${txHash} sent before the interruption (must be refused)`);
          await finalizeRefusal(p, txHash, tx);
        } else if (main && !isFailure(main.outcome.status)) {
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
      const apply = async (a) => {
        applies.push(a);
        return (await mirror.must({ op: "apply", ...a })).value;
      };
      let mirrored = await apply({
        method: p.method,
        args: p.args,
        now: at,
        predecessor: p.signer,
        deposit: p.deposit,
      });
      let value = successValue(main.outcome.status);
      const callback = { execute_release: "on_release_transfer", execute_refund: "on_refund_transfer" }[
        p.method
      ];
      if (callback) {
        const to = mirrored.transfer.to;
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
            : { trade_id: tradeId, refund_intent_id: p.args.refund_intent_id };
        mirrored = await apply({
          method: callback,
          args: cbArgs,
          now: await rpc.blockTimeMs(cb.block_hash),
          predecessor: accounts.escrow,
          deposit: "0",
          promiseOk: !isFailure(transfer.outcome.status),
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
        step.payeeAfterYocto = (await rpc.viewAccount(p.payee)).amount;
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
      if (s.kind === "refuse") await refuse(s);
      else await submit(s);
    }

    /** One call through near-cli-rs, signed by the buyer's keychain key or the relayer key file. */
    async function send(b, who) {
      const signer = who === "funder" ? accounts.buyer : accounts.relayer;
      const signing =
        who === "funder" ? ["sign-with-keychain"] : ["sign-with-access-key-file", relayerKeyFile];
      const r = await near([
        "contract",
        "call-function",
        "as-transaction",
        accounts.escrow,
        b.method,
        "file-args",
        state.pending.argsFile,
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
      return r;
    }

    function argsFileFor(method) {
      return join(outDir, "args", `${state.steps.length + 1}-${method}.json`);
    }

    async function tradeViews() {
      const out = {};
      for (const v of TRADE_VIEWS) out[v] = await rpc.view(accounts.escrow, v, { trade_id: tradeId });
      return out;
    }

    /** Every trade view of the contract equals the core's view of the mirror, which never applied a refused call. */
    async function viewsEqualCore() {
      for (let attempt = 0; attempt < 2; attempt++) {
        // Views read the clock; a second pass covers a block boundary between the two reads.
        const now = await rpc.blockTimeMs();
        let same = true;
        for (const v of TRADE_VIEWS) {
          const chain = await rpc.view(accounts.escrow, v, { trade_id: tradeId });
          const host = (await mirror.must({ op: "view", method: v, args: { trade_id: tradeId }, now })).value;
          same = same && sameJson(chain, host);
        }
        if (same) return true;
      }
      return false;
    }

    /**
     * A call the contract must reject. The core must refuse it with the expected code before it
     * is sent; it is then sent as a real transaction, which must fail on the escrow with that
     * code and the core's exact message, and leave every view of the trade as it was.
     */
    async function refuse(s) {
      const now = await rpc.blockTimeMs();
      let b;
      if (s.replay) {
        const src = state.steps.find((x) => x.step === s.replay && x.txHash && !x.refused);
        if (!src) throw new ToolError("JOURNEY_FAILED", `${s.id}: step ${s.replay} is not recorded`);
        const sent = src.mirror[0];
        b = {
          method: sent.method,
          args: sent.args,
          deposit: sent.deposit ?? "0",
          signer: src.signer === accounts.buyer ? "funder" : "relayer",
        };
      } else {
        const extra = s.extra ? s.extra(state.steps, params, accounts) : {};
        b = await mirror.must({ op: "build", what: s.what, now, label: s.label ?? "j", ...extra });
      }
      const who = s.as ?? b.signer;
      const signer = who === "funder" ? accounts.buyer : accounts.relayer;
      const call = { method: b.method, args: b.args, predecessor: signer, deposit: b.deposit };
      const pre = await mirror.send({ op: "probe", ...call, now });
      if (pre.ok || pre.code !== s.expect)
        throw new ToolError(
          "REFUSAL_NOT_EXPECTED",
          `${s.id}: the core answers ${pre.ok ? "accepted" : pre.code} to ${b.method}, not ${s.expect}; nothing was sent`,
        );
      const argsFile = argsFileFor(b.method);
      writeFileSync(argsFile, JSON.stringify(b.args));
      state.pending = {
        step: s.id,
        refuse: s.expect,
        method: b.method,
        args: b.args,
        deposit: b.deposit,
        signer,
        argsFile,
        startedAt: new Date().toISOString(),
        before: await tradeViews(),
        signerBeforeYocto: (await rpc.viewAccount(signer)).amount,
      };
      save();
      const r = await send(b, who);
      return finalizeRefusal(state.pending, r.txHash, await rpc.txStatus(r.txHash, signer));
    }

    async function finalizeRefusal(p, txHash, tx) {
      const onEscrow = tx.receipts_outcome.filter((x) => x.outcome.executor_id === accounts.escrow);
      const main = onEscrow[0];
      if (!main) throw new ToolError("SUBMIT_FAILED", `${p.method}: no receipt ran on the escrow`);
      if (!isFailure(main.outcome.status))
        throw new ToolError(
          "REFUSAL_ACCEPTED",
          `${p.step}: ${p.method} ${txHash} had to be refused with ${p.refuse} and the contract accepted it`,
        );
      const got = contractRefusal(main.outcome.status);
      if (got.code !== p.refuse)
        throw new ToolError(
          "REFUSAL_MISMATCH",
          `${p.step}: ${p.method} ${txHash} expected ${p.refuse}, the contract answered ${got.error}`,
        );
      if (onEscrow.length !== 1)
        throw new ToolError(
          "REFUSAL_MISMATCH",
          `${p.step}: ${txHash} ran ${onEscrow.length} receipts on the escrow`,
        );
      // The same call on the core, at the block time the contract saw: same code, same message.
      const at = await rpc.blockTimeMs(main.block_hash);
      const host = await mirror.send({
        op: "probe",
        method: p.method,
        args: p.args,
        now: at,
        predecessor: p.signer,
        deposit: p.deposit,
      });
      if (host.ok || host.code !== got.code || host.message !== got.message)
        throw new ToolError(
          "MIRROR_MISMATCH",
          `${p.step}: chain answered ${got.error}, the core ${host.ok ? "accepted" : `${host.code}: ${host.message}`}`,
        );
      await compareViews(rpc, mirror, accounts, tradeId, at, outDir, `${p.method} (refused)`);
      const after = await tradeViews();
      const sameAsBefore = sameJson(p.before, after);
      const equalCore = await viewsEqualCore();
      // `before` can be hours old when an interrupted run is settled; the core's views decide then.
      if (!sameAsBefore && !equalCore) {
        writeFileSync(
          join(outDir, "mismatch.json"),
          JSON.stringify({ after: `${p.method} (refused)`, before: p.before, now: after }, null, 2),
        );
        throw new ToolError(
          "REFUSAL_CHANGED_STATE",
          `${p.step}: the trade's views differ after the refused ${p.method} ${txHash} (see mismatch.json)`,
        );
      }
      state.steps.push({
        step: p.step,
        method: p.method,
        signer: p.signer,
        txHash,
        blockHash: main.block_hash,
        blockTimeMs: at,
        refused: { expected: p.refuse, code: got.code, message: got.message, error: got.error },
        stateUnchanged: true,
        viewsSameAsBefore: sameAsBefore,
        viewsEqualCore: equalCore,
        depositYocto: p.deposit,
        signerBeforeYocto: p.signerBeforeYocto,
        signerAfterYocto: (await rpc.viewAccount(p.signer)).amount,
      });
      state.pending = null;
      save();
      log(`${p.method.padEnd(28)} ${txHash} REFUSED ${got.code}`);
    }

    async function submit(s) {
      const now = await rpc.blockTimeMs();
      const extra = s.extra ? s.extra(state.steps, params, accounts) : {};
      const b = await mirror.must({ op: "build", what: s.what, now, label: s.label ?? "j", ...extra });
      const argsFile = argsFileFor(b.method);
      writeFileSync(argsFile, JSON.stringify(b.args));
      const signer = b.signer === "funder" ? accounts.buyer : accounts.relayer;
      const payee = { execute_release: accounts.supplier, execute_refund: accounts.buyer }[b.method];
      state.pending = {
        step: s.id,
        method: b.method,
        args: b.args,
        deposit: b.deposit,
        signer,
        argsFile,
        startedAt: new Date().toISOString(),
        ...(payee ? { payee, payeeBeforeYocto: (await rpc.viewAccount(payee)).amount } : {}),
      };
      save();
      const r = await send(b, b.signer);
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

    return { paused: false, ...(await checks({ rpc, accounts, journey, tradeId, state, params })) };
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

async function checks({ rpc, accounts, journey, tradeId, state, params }) {
  // Accepted transactions; the refusal journey's refused ones are checked on their own below.
  const steps = state.steps.filter((s) => s.txHash && !s.refused);
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
    const supplierNow = big((await rpc.viewAccount(accounts.supplier)).amount);
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
  if (journey === "attack-demo")
    return demoChecks({ rpc, accounts, tradeId, state, params, ledger, release, base });
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
  if (journey === "hold" || journey === "refusal") {
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
  if (journey === "refusal") {
    const refused = state.steps.filter((s) => s.refused);
    c.refusals = refused.map((s) => ({
      step: s.step,
      what: REFUSALS.find((r) => r.id === s.step)?.title ?? null,
      method: s.method,
      signer: s.signer,
      expected: s.refused.expected,
      code: s.refused.code,
      message: s.refused.message,
      txHash: s.txHash,
      stateUnchanged: s.stateUnchanged === true,
    }));
    c.allRefusedWithExpectedCode =
      refused.length === REFUSALS.length &&
      REFUSALS.every(
        (r, i) =>
          refused[i].step === r.id && refused[i].method === r.method && refused[i].refused.code === r.expect,
      );
    c.refusalsChangedNothing = refused.length > 0 && refused.every((s) => s.stateUnchanged === true);
    // The deposit attached to the refused funding call is back with the buyer (it paid the fee only).
    const fund = refused.find((s) => s.method === "fund");
    c.refusedDepositReturned =
      !!fund &&
      big(fund.depositYocto) > 0n &&
      big(fund.signerBeforeYocto) - big(fund.signerAfterYocto) < big(fund.depositYocto);
    // Nothing reached the account the redirected calls named, and the supplier got the amount once.
    c.relayerReceivedNothing =
      big((await rpc.viewAccount(accounts.relayer)).amount) <= big(state.relayerStartYocto);
    c.supplierTotalDeltaYocto = (
      big((await rpc.viewAccount(accounts.supplier)).amount) - big(state.supplierStartYocto)
    ).toString();
    const buyer = ledger.funders[accounts.buyer] ?? {};
    c.fundedExactlyTheTradeAmount =
      big(buyer.funded) === params.amount && big(buyer.released) === params.amount;
    ok =
      ok &&
      c.allRefusedWithExpectedCode &&
      c.refusalsChangedNothing &&
      c.refusedDepositReturned &&
      c.relayerReceivedNothing &&
      big(c.supplierTotalDeltaYocto) === params.amount &&
      c.fundedExactlyTheTradeAmount;
  }
  return { ok, ...out, checks: c };
}

/**
 * The attack demo's end state: fully funded, the whole amount reserved by one approved intent that
 * pays the bound supplier, one ACTIVE deterministic-policy hold blocking the release, nothing
 * released or refunded.
 */
async function demoChecks({ rpc, accounts, tradeId, state, params, ledger, release, base }) {
  const holds = await rpc.view(accounts.escrow, "get_holds", { trade_id: tradeId });
  const refunds = await rpc.view(accounts.escrow, "get_refunds", { trade_id: tradeId });
  const held = state.observed["observe:held"] ?? {};
  const live = release.intents.find((i) => i.releaseIntentId === release.liveIntent) ?? {};
  const buyer = ledger.funders[accounts.buyer] ?? {};
  const approval = state.steps.find((s) => s.step === "approval" && s.txHash);
  const c = {
    holdActive: holds.length === 1 && holds[0].status === "ACTIVE" && holds[0].resolution === null,
    deterministicPolicyHold: holds[0]?.issuerRole === "POLICY_SETTER" && typeof holds[0]?.ruleId === "string",
    holdExpiresAt: holds[0]?.expiresAt ?? null,
    releaseBlockedByHold:
      (held.blockers ?? []).includes("HOLD_ACTIVE") && release.blockers.includes("HOLD_ACTIVE"),
    approvalRecorded: live.state === "DIRECT_TESTNET_AUTHORIZED" && live.approval !== null && !!approval,
    approvalTxHash: approval?.txHash ?? null,
    intentPaysBoundSupplier:
      live.destination === accounts.supplier && release.payoutDestination === accounts.supplier,
    fundedExactlyTheTradeAmount: big(buyer.funded) === params.amount,
    reservedExactlyTheTradeAmount: big(buyer.reserved) === params.amount,
    nothingReleased: big(ledger.totals.released) === 0n && !JSON.stringify(release).includes('"PAID"'),
    nothingRefunded: refunds.length === 0 && big(ledger.totals.refunded) === 0n,
    ledgerConservation: ledger.conservation === true,
  };
  const ok =
    c.holdActive &&
    c.deterministicPolicyHold &&
    c.releaseBlockedByHold &&
    c.approvalRecorded &&
    c.intentPaysBoundSupplier &&
    c.fundedExactlyTheTradeAmount &&
    c.reservedExactlyTheTradeAmount &&
    c.nothingReleased &&
    c.nothingRefunded &&
    c.ledgerConservation;
  return { ok, ...base, release, holds, checks: c };
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
