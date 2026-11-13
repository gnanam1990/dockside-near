// Dockside proof page. Everything shown is read from NEAR by this browser when the page loads:
// the expected values come from proof-manifest.json (generated from the committed run records),
// the actual values from the public RPC endpoints listed in it. No server of ours is involved, and
// chain data is only ever written to the page as text.
import { formatNear, verdict, verifyNetwork } from "./lib/verify.mjs";
import { arrive, badge, el, external, icon, mono, mountNav, VERDICT_ICON } from "./lib/ui.mjs";

const BUCKETS = [
  ["funded", "Funded"],
  ["partial", "Partial"],
  ["available", "Available"],
  ["reserved", "Reserved"],
  ["released", "Released"],
  ["refundLocked", "Refund locked"],
  ["refunded", "Refunded"],
  ["quarantined", "Quarantined"],
  ["fees", "Fees"],
];
const KIND = {
  release: { name: "Release journey", steps: ["Funded", "Evidence accepted", "Paid to the supplier"] },
  hold: {
    name: "Hold journey",
    steps: ["Policy hold set", "Release blocked", "Hold resolved", "Paid to the supplier"],
  },
  refund: {
    name: "Refund journey",
    steps: ["Mutual cancel and excess funding", "Both returned to the funder"],
  },
};
const fill = (template, key, value) => template.replace(`{${key}}`, value);
const pad = (n) => String(n).padStart(2, "0");

/** A table that scrolls sideways on narrow screens must be reachable by keyboard. */
const scrollRegion = (label) => ({ class: "table-wrap", role: "region", "aria-label": label, tabindex: "0" });

function checksTable(rows, caption) {
  return el(
    "div",
    scrollRegion(caption),
    el(
      "table",
      { class: "checks" },
      el("caption", { class: "sr-only", text: caption }),
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          el("th", { scope: "col", text: "Check" }),
          el("th", { scope: "col", text: "Expected (manifest)" }),
          el("th", { scope: "col", text: "Actual (read from NEAR)" }),
          el("th", { scope: "col", text: "Result" }),
        ),
      ),
      el(
        "tbody",
        {},
        rows.map((r) =>
          el(
            "tr",
            { "data-check": r.id, "data-status": r.status },
            el(
              "th",
              { scope: "row" },
              r.title,
              r.detail ? el("div", { class: "detail mono", text: r.detail }) : null,
              r.link ? el("div", { class: "detail" }, external(r.link, "Open in explorer")) : null,
            ),
            el("td", { class: "mono", text: r.expected }),
            el("td", { class: "mono", text: r.actual }),
            el("td", {}, badge(r.status)),
          ),
        ),
      ),
    ),
  );
}

function txTable(rows, tradeId) {
  return el(
    "div",
    scrollRegion(`Transactions of trade ${tradeId}`),
    el(
      "table",
      { class: "checks" },
      el("caption", { class: "sr-only", text: `Transactions of trade ${tradeId}` }),
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          el("th", { scope: "col", text: "Step" }),
          el("th", { scope: "col", text: "Transaction" }),
          el("th", { scope: "col", text: "Read from NEAR" }),
          el("th", { scope: "col", text: "Result" }),
        ),
      ),
      el(
        "tbody",
        {},
        rows.map((r) =>
          el(
            "tr",
            { "data-check": r.id, "data-status": r.status },
            el("th", { scope: "row", text: r.title }),
            el("td", {}, r.link ? external(r.link, r.txHash, "mono") : mono(r.txHash)),
            el("td", { class: "mono", text: r.actual }),
            el("td", {}, badge(r.status)),
          ),
        ),
      ),
    ),
  );
}

function ledgerTable(ledger) {
  const funders = Object.entries(ledger.funders ?? {});
  const line = (label, f, cls) =>
    el(
      "tr",
      { class: cls },
      el("th", { scope: "row", class: "mono", text: label }),
      BUCKETS.map(([k]) => el("td", { class: "mono num", title: `${f[k]} yoctoNEAR`, text: amount(f[k]) })),
    );
  return el(
    "div",
    scrollRegion("Ledger buckets"),
    el(
      "table",
      { class: "ledger" },
      el("caption", { class: "sr-only", text: "Ledger buckets in NEAR, read from get_ledger" }),
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          el("th", { scope: "col", text: "Funder" }),
          BUCKETS.map(([, label]) => el("th", { scope: "col", class: "num", text: label })),
        ),
      ),
      el(
        "tbody",
        {},
        funders.map(([account, f]) => line(account, f)),
        line("Total", ledger.totals, "total"),
      ),
    ),
  );
}

function amount(yocto) {
  try {
    return formatNear(yocto).replace(" NEAR", "");
  } catch {
    return String(yocto);
  }
}

function facts(pairs) {
  return el(
    "dl",
    { class: "facts" },
    pairs.filter(Boolean).map(([k, v]) => el("div", {}, el("dt", { text: k }), el("dd", {}, v))),
  );
}

/** Pass count of a group of rows, as words and as an icon-led tally. */
function tally(rows) {
  const pass = rows.filter((r) => r.status === "PASS").length;
  const ok = pass === rows.length;
  return el(
    "span",
    { class: `tally ${ok ? "tally-ok" : "tally-bad"}` },
    icon(ok ? "circle-check" : "circle-x", { size: 16 }),
    `${pass} of ${rows.length} pass`,
  );
}

/** A numbered section of the proof: its number, title, pass tally and contents. */
function section({ id, num, title, rows, attrs = {} }, ...children) {
  return el(
    "section",
    { class: "panel", id, "aria-labelledby": `${id}-title`, ...attrs },
    el(
      "div",
      { class: "sec-head" },
      el("span", { class: "sec-num", "aria-hidden": "true", text: pad(num) }),
      el("h3", { id: `${id}-title` }, title),
      rows.length > 0 ? tally(rows) : null,
    ),
    children,
  );
}

/** One verdict shape for every state of the panel: icon, title, sentences, actions. */
function verdictBox(kind, verdictValue, title, lines, actions) {
  return arrive(
    el(
      "div",
      { class: `verdict verdict-${kind}`, "data-verdict": verdictValue, role: "status" },
      el("div", { class: "verdict-mark", "aria-hidden": "true" }, icon(VERDICT_ICON[kind], { size: 26 })),
      el("div", { class: "verdict-body" }, el("p", { class: "verdict-title", text: title }), lines),
      actions ? el("div", { class: "verdict-actions" }, actions) : null,
    ),
  );
}

/**
 * The check map: every check is one mark, grouped by the section it belongs to, each group a link to
 * its section. The marks are a picture of the counts beside them, so they are hidden from assistive
 * technology; the link text carries the same numbers.
 */
function checkMap(groups) {
  return el(
    "nav",
    { class: "checkmap", "aria-label": "Checks by section" },
    el("p", { class: "checkmap-title", "aria-hidden": "true", text: "Checks by section" }),
    el(
      "ol",
      {},
      groups.map((g) => {
        const pass = g.rows.filter((r) => r.status === "PASS").length;
        const bad = pass !== g.rows.length;
        return el(
          "li",
          { class: bad ? "checkmap-has-problem" : null },
          el(
            "a",
            { href: `#${g.id}` },
            el(
              "span",
              { class: "checkmap-head" },
              el("span", { text: g.label }),
              el(
                "span",
                { class: "checkmap-count" },
                `${pass}/${g.rows.length}`,
                el("span", { class: "sr-only", text: " pass" }),
              ),
            ),
            el(
              "span",
              { class: "ticks", "aria-hidden": "true" },
              g.rows.map((r) => el("span", { class: `tick tick-${r.status.toLowerCase()}` })),
            ),
          ),
        );
      }),
    ),
  );
}

function renderNotDeployed(panel, network) {
  panel.replaceChildren(
    verdictBox("none", "NOT_DEPLOYED", "Not deployed yet", [
      el("p", {
        text: `There is no Dockside deployment on ${network.label}, so there is nothing to verify and no claim is made for this network. No request was sent.`,
      }),
      el("p", {
        class: "muted",
        text: "This tab fills in when a run record of a deployment on this network is committed under docs/evidence/ and listed in scripts/proof/sources.json.",
      }),
    ]),
  );
}

function renderChecking(panel, network) {
  panel.replaceChildren(
    verdictBox("busy", "CHECKING", "Reading NEAR…", [
      el("p", {
        text: `Asking ${new URL(network.rpc[0]).host} for the contract, its config, ${network.journeys.length} trades and their transactions.`,
      }),
    ]),
  );
}

function renderResult(panel, network, result, rerun, networkName) {
  const v = verdict(result);
  const s = result.summary;
  const d = network.deployment;
  const ex = network.explorer;
  const by = (group) => result.rows.filter((r) => r.group === group);
  const problems = s.fail + s.error;
  const rerunButton = el(
    "button",
    { type: "button", class: "btn", id: "rerun" },
    icon("refresh-cw", { size: 18 }),
    "Read again",
  );
  rerunButton.addEventListener("click", rerun);
  const head = verdictBox(
    v === "PASS" ? "pass" : "fail",
    v,
    v === "PASS" ? `Pass: all ${s.total} checks` : `Fail: ${problems} of ${s.total} checks did not pass`,
    [
      el(
        "p",
        {},
        result.block
          ? `Read at final block ${result.block.height} (${new Date(result.block.timestampMs).toISOString()}) with ${result.rpcCalls} read-only requests. `
          : "The RPC endpoints could not be reached. ",
        s.error > 0
          ? `${s.error} value(s) could not be read; an unreadable value is never counted as a pass.`
          : "",
      ),
    ],
    rerunButton,
  );

  const tradeRows = (t) => [...by(`trade:${t.tradeId}`), ...by(`tx:${t.tradeId}`)];
  const groups = [{ id: "sec-deployment", label: "Deployment", rows: by("deployment") }];
  if (by("config").length > 0)
    groups.push({ id: "sec-config", label: "Contract config", rows: by("config") });
  for (const [i, t] of result.trades.entries())
    groups.push({ id: `trade-${i + 1}`, label: `Trade ${i + 1}`, rows: tradeRows(t) });

  const parts = [el("div", { class: "verdict-block" }, head, checkMap(groups))];
  let num = 1;
  parts.push(
    section(
      { id: "sec-deployment", num: num++, title: "Deployment", rows: by("deployment") },
      facts([
        ["Escrow account", external(fill(ex.account, "account", d.contractId), d.contractId, "mono")],
        ["Code hash in the manifest", mono(d.artifact.nearCodeHash)],
        ["SHA-256 of the wasm", mono(d.artifact.sha256)],
        ["Built from commit", mono(d.artifact.commit)],
        ["RPC endpoints", mono(network.rpc.map((u) => new URL(u).host).join(", "))],
      ]),
      checksTable(by("deployment"), "Deployment checks"),
    ),
  );
  if (by("config").length > 0) {
    parts.push(
      section(
        { id: "sec-config", num: num++, title: "Contract config", rows: by("config") },
        result.config
          ? el("p", {
              class: "muted",
              text: `get_config: ${result.config.trades} trades, ${result.config.unexpectedAssets} unexpected assets.`,
            })
          : null,
        checksTable(by("config"), "Config checks"),
      ),
    );
  }
  for (const [i, t] of result.trades.entries()) {
    const j = network.journeys[i];
    const kind = KIND[t.kind];
    parts.push(
      section(
        {
          id: `trade-${i + 1}`,
          num: num++,
          title: [`Trade ${i + 1}: `, mono(t.tradeId)],
          rows: tradeRows(t),
          attrs: { "data-trade": t.tradeId },
        },
        kind
          ? el(
              "div",
              { class: "journey" },
              el("span", { class: "journey-name", text: `${kind.name}:` }),
              el(
                "ol",
                { class: "steps" },
                kind.steps.map((step) => el("li", { text: step })),
              ),
            )
          : el("p", { class: "muted", text: t.kind }),
        t.kind === "refund"
          ? null
          : el(
              "a",
              {
                class: "receipt-link",
                href: `./receipt.html?trade=${encodeURIComponent(t.tradeId)}&network=${encodeURIComponent(networkName)}`,
                "data-receipt": t.tradeId,
              },
              icon("receipt", { size: 18 }),
              "Payment receipt, verified in your browser",
            ),
        t.trade
          ? facts([
              ["Amount", mono(`${formatNear(t.trade.amountYocto)}`)],
              ["Buyer", mono(t.trade.buyerAccount)],
              ["Supplier", mono(t.trade.supplierAccount)],
              ["Terms digest", mono(t.trade.termsDigest)],
              ["Run record", mono(j.evidence)],
            ])
          : null,
        t.ledger ? el("h4", { text: "Ledger (NEAR), read from get_ledger" }) : null,
        t.ledger ? ledgerTable(t.ledger) : null,
        el("h4", { text: "Ledger and outcome checks" }),
        checksTable(by(`trade:${t.tradeId}`), `Checks of trade ${t.tradeId}`),
        el("h4", { text: `Transactions (${by(`tx:${t.tradeId}`).length})` }),
        txTable(by(`tx:${t.tradeId}`), t.tradeId),
      ),
    );
  }
  panel.replaceChildren(...parts);
}

async function main() {
  mountNav("proof");
  const tabs = document.getElementById("tabs");
  const panel = document.getElementById("panel");
  let manifest;
  try {
    const res = await fetch("./proof-manifest.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    manifest = await res.json();
  } catch (e) {
    const box = verdictBox("fail", "FAIL", "The proof manifest could not be loaded", [
      el("p", { text: String(e.message) }),
    ]);
    box.setAttribute("role", "alert");
    panel.replaceChildren(box);
    return;
  }
  const names = Object.keys(manifest.networks);
  let current = null;
  let runId = 0;

  async function show(name) {
    current = name;
    const network = manifest.networks[name];
    for (const b of tabs.querySelectorAll("button")) {
      const on = b.dataset.network === name;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
    }
    panel.setAttribute("aria-labelledby", `tab-${name}`);
    if (location.hash.slice(1) !== name) history.replaceState(null, "", `#${name}`);
    if (!network.deployment) {
      renderNotDeployed(panel, network);
      return;
    }
    const id = ++runId;
    renderChecking(panel, network);
    const result = await verifyNetwork(network);
    if (id === runId && current === name) renderResult(panel, network, result, () => show(name), name);
  }

  tabs.replaceChildren(
    ...names.map((name) => {
      const network = manifest.networks[name];
      const b = el(
        "button",
        { type: "button", role: "tab", id: `tab-${name}`, "data-network": name, "aria-controls": "panel" },
        network.label,
        network.deployment ? null : el("span", { class: "tab-note", text: "not deployed yet" }),
      );
      b.addEventListener("click", () => show(name));
      return b;
    }),
  );
  tabs.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const i = names.indexOf(current);
    const next = names[(i + (e.key === "ArrowRight" ? 1 : names.length - 1)) % names.length];
    tabs.querySelector(`[data-network="${next}"]`).focus();
    show(next);
  });
  // The tab is part of the address (#testnet, #mainnet), so a tab can be linked to.
  const fromHash = () => {
    const wanted = location.hash.slice(1);
    return names.includes(wanted) ? wanted : names[0];
  };
  window.addEventListener("hashchange", () => {
    if (fromHash() !== current) show(fromHash());
  });
  await show(fromHash());
}

main();
