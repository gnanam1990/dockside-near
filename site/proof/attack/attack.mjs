// Dockside attack console (M53). The page reads everything it shows from NEAR in this browser:
// the trade's ledger, release state and holds, the demo key's nonce (the attempt counter), and
// each attempt's transaction. The relay (same origin on the hosted app, or the configured URL)
// only sends an attempt and returns its hash; when no relay answers, the page replays attempts
// recorded in attack-demo.json by reading those transactions from the chain. Chain data is only
// ever written to the page as text.
import {
  ATTACKS,
  attemptCount,
  explorerTx,
  formatNear,
  fundsState,
  judgeAttempt,
  keyScope,
  recordedFor,
} from "../lib/attack-read.mjs";
import { createRpc } from "../lib/near-rpc.mjs";

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    node.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}
const mono = (text) => el("span", { class: "mono", text });
const external = (href, text) => el("a", { href, target: "_blank", rel: "noopener noreferrer", text });

const state = { config: null, rpc: null, relay: null, busy: false };

async function loadConfig() {
  const res = await fetch("./attack-demo.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`attack-demo.json: HTTP ${res.status}`);
  return res.json();
}

/** Same-origin relay first (the hosted app), then the configured one; null means replay only. */
async function findRelay(config) {
  const candidates = ["./api"];
  if (typeof config.relay === "string" && /^https:\/\//.test(config.relay))
    candidates.push(config.relay.replace(/\/$/, ""));
  for (const base of candidates) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);
      const r = await fetch(`${base}/status`, { signal: ctl.signal, cache: "no-store" });
      clearTimeout(timer);
      if (!r.ok) continue;
      const s = await r.json();
      if (s && s.enabled === true) return { base, status: s };
    } catch {
      // not reachable: try the next one
    }
  }
  return null;
}

async function readTrade() {
  const c = state.config;
  const args = { trade_id: c.tradeId };
  const [ledger, release, holds, key] = await Promise.all([
    state.rpc.callView(c.escrow, "get_ledger", args),
    state.rpc.callView(c.escrow, "get_release", args),
    state.rpc.callView(c.escrow, "get_holds", args),
    state.rpc.viewAccessKey(c.attacker.accountId, c.attacker.publicKey),
  ]);
  return { ledger, release, holds, key };
}

function renderTrade(read, error) {
  const c = state.config;
  const section = document.getElementById("trade");
  section.replaceChildren(el("h2", { id: "trade-title", text: "The payment" }));
  section.setAttribute("aria-busy", "false");
  if (error) {
    section.append(
      el(
        "div",
        { class: "verdict verdict-none", "data-state": "unreadable" },
        el("p", { class: "verdict-title", text: "The trade could not be read from NEAR" }),
        el("p", { text: error }),
        el("button", { class: "btn", type: "button", id: "reread", text: "Read again" }),
      ),
    );
    document.getElementById("reread").addEventListener("click", () => refresh());
    return;
  }
  const f = fundsState(c, read);
  const count = attemptCount(read.key, c);
  const scope = keyScope(read.key, c);
  section.append(
    el(
      "div",
      {
        class: `verdict ${f.unchanged ? "verdict-pass" : "verdict-fail"}`,
        "data-state": f.unchanged ? "intact" : "changed",
      },
      el("p", {
        class: "verdict-title",
        text: f.unchanged ? "The money has not moved" : "The trade is not in its demo state",
      }),
      el(
        "p",
        {},
        "Attempts so far: ",
        el("strong", { id: "attempt-count", text: count === null ? "unreadable" : count.toString() }),
        ". ",
        f.unchanged
          ? `All ${formatNear(c.amountYocto)} is still funded and reserved for the bound supplier; nothing was released or refunded.`
          : "Read the rows below: the page compares every value with the demo's starting state.",
      ),
    ),
    el(
      "dl",
      { class: "facts" },
      el("dt", { text: "Escrow contract" }),
      el("dd", {}, mono(c.escrow)),
      el("dt", { text: "Trade" }),
      el("dd", {}, mono(c.tradeId)),
      el("dt", { text: "Pays (bound supplier)" }),
      el("dd", {}, mono(f.payoutDestination ?? "unreadable")),
      el("dt", { text: "Release" }),
      el("dd", { text: `${f.intentState ?? "none"}; blocked by ${f.blockers.join(", ") || "nothing"}` }),
      el("dt", { text: "Attacker account" }),
      el(
        "dd",
        {},
        mono(c.attacker.accountId),
        scope.restrictedToEscrow
          ? " (function-call key for the escrow only, no deposits)"
          : " (key scope could not be confirmed)",
      ),
    ),
    el(
      "div",
      { class: "table-wrap", role: "region", "aria-label": "Trade ledger", tabindex: "0" },
      el(
        "table",
        { class: "ledger" },
        el("caption", { class: "sr-only", text: "Trade ledger read from NEAR" }),
        el(
          "thead",
          {},
          el(
            "tr",
            {},
            el("th", { scope: "col", text: "Bucket" }),
            el("th", { scope: "col", text: "Demo start" }),
            el("th", { scope: "col", text: "Now (read from NEAR)" }),
          ),
        ),
        el(
          "tbody",
          {},
          f.rows.map((r) =>
            el(
              "tr",
              { "data-row": r.id, "data-ok": String(r.ok) },
              el("th", { scope: "row", text: r.label }),
              el("td", { class: "num", text: formatNear(r.expected) }),
              el("td", { class: `num ${r.ok ? "" : "bad"}`, text: formatNear(r.actual) }),
            ),
          ),
        ),
      ),
    ),
  );
}

function setMode() {
  const mode = document.getElementById("mode");
  if (state.relay) {
    mode.dataset.mode = "live";
    mode.textContent =
      "Live: each button sends a real transaction now. One attempt per visitor every 20 seconds.";
  } else {
    mode.dataset.mode = "replay";
    mode.textContent =
      "The relay is not reachable, so the buttons replay attempts that were already sent: your browser reads each recorded transaction from NEAR.";
  }
}

function resultView(attack, judged, txHash, note) {
  const c = state.config;
  const refused = judged.refused && judged.ranOnEscrow && judged.receiverOk && judged.signerOk;
  return el(
    "div",
    { class: `result ${refused ? "result-refused" : "result-other"}`, "data-code": judged.code ?? "" },
    el(
      "p",
      { class: "result-title" },
      refused ? "Refused by the contract: " : "Not a refusal: ",
      el("strong", {
        class: "mono",
        text: judged.code ?? (judged.refused ? "no DOCKSIDE code" : "SUCCEEDED"),
      }),
    ),
    judged.message ? el("p", { class: "result-message", text: judged.message }) : null,
    judged.blockers.length > 1
      ? el("p", { class: "muted", text: `Every blocker the contract listed: ${judged.blockers.join(", ")}` })
      : null,
    el(
      "p",
      { class: "muted" },
      "Transaction ",
      external(explorerTx(c, txHash), txHash),
      ` signed by ${judged.signer ?? "?"}, read from NEAR by this browser.`,
      note ? ` ${note}` : "",
      judged.code && judged.code !== attack.expect
        ? ` (Expected within the first 24 hours: ${attack.expect}.)`
        : "",
    ),
  );
}

async function readAttempt(attack, txHash, signer) {
  const tx = await state.rpc.txStatus(txHash, signer);
  const judged = judgeAttempt(tx, { escrow: state.config.escrow, signer, method: attack.method });
  return judged;
}

async function onTry(attack, button, out) {
  if (state.busy) return;
  state.busy = true;
  button.disabled = true;
  out.replaceChildren(
    el("p", {
      class: "muted",
      text: state.relay ? "Sending the transaction…" : "Reading the recorded transaction…",
    }),
  );
  try {
    const c = state.config;
    if (state.relay) {
      const r = await fetch(`${state.relay.base}/attempt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ attack: attack.id }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        const e = body?.error ?? {};
        const wait = e.retryAfterMs ? ` Try again in ${Math.ceil(e.retryAfterMs / 1000)} s.` : "";
        out.replaceChildren(
          el("p", {
            class: "result-note",
            text: `${e.code ?? `HTTP ${r.status}`}: ${e.message ?? "the relay refused"}.${wait}`,
          }),
        );
        return;
      }
      const judged = await readAttempt(attack, body.txHash, c.attacker.accountId);
      const agrees = judged.code === body.code;
      out.replaceChildren(
        resultView(
          attack,
          judged,
          body.txHash,
          agrees ? "" : "The relay reported another code; this page shows what NEAR says.",
        ),
      );
    } else {
      const rec = recordedFor(c, attack.id);
      if (!rec) {
        out.replaceChildren(
          el("p", { class: "result-note", text: "No recorded attempt of this attack yet." }),
        );
        return;
      }
      const judged = await readAttempt(attack, rec.txHash, rec.signer ?? c.attacker.accountId);
      out.replaceChildren(
        resultView(attack, judged, rec.txHash, "Recorded attempt, replayed from the chain."),
      );
    }
    await refresh();
  } catch (e) {
    out.replaceChildren(
      el("p", { class: "result-note", text: `Could not read the transaction from NEAR: ${e.message}` }),
    );
  } finally {
    state.busy = false;
    button.disabled = false;
  }
}

function renderAttacks() {
  const list = document.getElementById("attack-list");
  list.replaceChildren(
    ...ATTACKS.map((a) => {
      const out = el("div", { class: "attack-out", "aria-live": "polite", id: `out-${a.id}` });
      const canReplay = !!recordedFor(state.config, a.id);
      const button = el("button", {
        class: "btn",
        type: "button",
        "data-attack": a.id,
        text: state.relay ? "Try it" : "Replay recorded attempt",
        disabled: !state.relay && !canReplay,
      });
      button.addEventListener("click", () => onTry(a, button, out));
      return el(
        "li",
        { class: "attack", "data-attack": a.id },
        el("h3", { text: a.title }),
        el("p", { text: a.what }),
        el("p", { class: "muted" }, "Calls ", mono(a.method), "."),
        button,
        out,
      );
    }),
  );
}

async function refresh() {
  try {
    renderTrade(await readTrade(), null);
  } catch (e) {
    renderTrade(null, e.message);
  }
}

async function main() {
  try {
    state.config = await loadConfig();
  } catch (e) {
    renderTrade(null, e.message);
    return;
  }
  const c = state.config;
  if (c.status !== "LIVE") {
    const section = document.getElementById("trade");
    section.setAttribute("aria-busy", "false");
    section.replaceChildren(
      el("h2", { id: "trade-title", text: "The payment" }),
      el(
        "div",
        { class: "verdict verdict-none", "data-state": "not-set-up" },
        el("p", { class: "verdict-title", text: "The demo trade has not been created yet" }),
        el("p", {
          text: "The operator creates it with run-all's attack-demo journey; this page then reads it from NEAR. No request was sent.",
        }),
      ),
    );
    document.getElementById("mode").textContent = "";
    return;
  }
  state.rpc = createRpc({ endpoints: c.rpc });
  state.relay = await findRelay(c);
  setMode();
  renderAttacks();
  await refresh();
}

main();
