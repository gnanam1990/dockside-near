// Dockside proof page. Everything shown is read from NEAR by this browser when the page loads:
// the expected values come from proof-manifest.json (generated from the committed run records),
// the actual values from the public RPC endpoints listed in it. No server of ours is involved, and
// chain data is only ever written to the page as text.
import { formatNear, verdict, verifyNetwork } from "./lib/verify.mjs";

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
  release: "Release journey: funded, evidence accepted, paid to the supplier",
  hold: "Hold journey: policy hold set, release blocked, hold resolved, paid to the supplier",
  refund: "Refund journey: mutual cancel and excess funding, both returned to the funder",
};
const STATUS_TEXT = { PASS: "Pass", FAIL: "Fail", ERROR: "Not readable" };

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

const external = (href, text, cls) =>
  el("a", { href, target: "_blank", rel: "noopener noreferrer", class: cls, text });
const mono = (text) => el("span", { class: "mono", text });
const badge = (status) =>
  el("span", {
    class: `badge badge-${status.toLowerCase()}`,
    "data-status": status,
    text: STATUS_TEXT[status],
  });
const fill = (template, key, value) => template.replace(`{${key}}`, value);

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

function section(title, ...children) {
  return el("section", { class: "panel" }, el("h3", { text: title }), children);
}

function renderNotDeployed(panel, network) {
  panel.replaceChildren(
    el(
      "div",
      { class: "verdict verdict-none", "data-verdict": "NOT_DEPLOYED", role: "status" },
      el("p", { class: "verdict-title", text: "Not deployed yet" }),
      el("p", {
        text: `There is no Dockside deployment on ${network.label}, so there is nothing to verify and no claim is made for this network. No request was sent.`,
      }),
      el("p", {
        class: "muted",
        text: "This tab fills in when a run record of a deployment on this network is committed under docs/evidence/ and listed in scripts/proof/sources.json.",
      }),
    ),
  );
}

function renderChecking(panel, network) {
  panel.replaceChildren(
    el(
      "div",
      { class: "verdict verdict-busy", "data-verdict": "CHECKING", role: "status" },
      el("p", { class: "verdict-title", text: "Reading NEAR…" }),
      el("p", {
        text: `Asking ${new URL(network.rpc[0]).host} for the contract, its config, ${network.journeys.length} trades and their transactions.`,
      }),
    ),
  );
}

function renderResult(panel, network, result, rerun) {
  const v = verdict(result);
  const s = result.summary;
  const d = network.deployment;
  const ex = network.explorer;
  const by = (group) => result.rows.filter((r) => r.group === group);
  const problems = s.fail + s.error;
  const head = el(
    "div",
    { class: `verdict verdict-${v.toLowerCase()}`, "data-verdict": v, role: "status" },
    el("p", {
      class: "verdict-title",
      text:
        v === "PASS" ? `Pass: all ${s.total} checks` : `Fail: ${problems} of ${s.total} checks did not pass`,
    }),
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
    el("button", { type: "button", class: "btn", id: "rerun", text: "Read again" }),
  );
  head.querySelector("#rerun").addEventListener("click", rerun);

  const parts = [head];
  parts.push(
    section(
      "Deployment",
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
        "Contract config",
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
    parts.push(
      el(
        "section",
        { class: "panel", "data-trade": t.tradeId },
        el("h3", {}, `Trade ${i + 1}: `, mono(t.tradeId)),
        el("p", { class: "muted", text: KIND[t.kind] ?? t.kind }),
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
  const tabs = document.getElementById("tabs");
  const panel = document.getElementById("panel");
  let manifest;
  try {
    const res = await fetch("./proof-manifest.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    manifest = await res.json();
  } catch (e) {
    panel.replaceChildren(
      el(
        "div",
        { class: "verdict verdict-fail", "data-verdict": "FAIL", role: "alert" },
        el("p", { class: "verdict-title", text: "The proof manifest could not be loaded" }),
        el("p", { text: String(e.message) }),
      ),
    );
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
    if (id === runId && current === name) renderResult(panel, network, result, () => show(name));
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
