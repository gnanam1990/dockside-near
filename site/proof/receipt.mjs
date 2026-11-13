// Dockside payment receipt page. The page address names the receipt (`/receipt/<trade id>` on the
// hosted app, `receipt.html?trade=<trade id>` on the static proof site); the escrow contract and the
// audited code hash come from proof-manifest.json; every fact shown is read from NEAR by this
// browser and checked by lib/receipt.mjs. Chain data is only ever written to the page as text.
import { encodeQr, qrPathData } from "./lib/qr.mjs";
import { parseReceiptLocation, receiptVerdict, verifyReceipt } from "./lib/receipt.mjs";

const STATUS_TEXT = { PASS: "Pass", FAIL: "Fail", ERROR: "Not readable" };
const SVG = "http://www.w3.org/2000/svg";

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
const mono = (text) => el("span", { class: "mono", text: String(text) });
const badge = (status) =>
  el("span", {
    class: `badge badge-${status.toLowerCase()}`,
    "data-status": status,
    text: STATUS_TEXT[status],
  });
const time = (ms) =>
  typeof ms === "number" ? new Date(ms).toISOString().replace(".000Z", "Z") : "not recorded";

function qrFigure(text) {
  const qr = encodeQr(text);
  const quiet = 4;
  const n = qr.size + 2 * quiet;
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", `${-quiet} ${-quiet} ${n} ${n}`);
  svg.setAttribute("class", "qr");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "QR code of this receipt's address");
  svg.setAttribute("shape-rendering", "crispEdges");
  const bg = document.createElementNS(SVG, "rect");
  for (const [k, v] of Object.entries({ x: -quiet, y: -quiet, width: n, height: n, fill: "#ffffff" }))
    bg.setAttribute(k, String(v));
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", qrPathData(qr));
  path.setAttribute("fill", "#000000");
  svg.append(bg, path);
  return el(
    "figure",
    { class: "qr-figure", "data-qr-version": qr.version },
    svg,
    el("figcaption", {}, el("span", { text: "Scan to verify this receipt again: " }), mono(text)),
  );
}

function checksTable(rows) {
  return el(
    "div",
    { class: "table-wrap", role: "region", "aria-label": "Receipt checks", tabindex: "0" },
    el(
      "table",
      { class: "checks" },
      el("caption", { class: "sr-only", text: "Receipt checks" }),
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          el("th", { scope: "col", text: "Check" }),
          el("th", { scope: "col", text: "Expected" }),
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
            el(
              "th",
              { scope: "row" },
              r.title,
              r.detail ? el("div", { class: "detail mono", text: r.detail }) : null,
              r.link ? el("div", { class: "detail no-print" }, external(r.link, "Open in explorer")) : null,
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

function facts(pairs) {
  return el(
    "dl",
    { class: "facts receipt-facts" },
    pairs
      .filter(Boolean)
      .map(([k, v, id]) => el("div", { "data-fact": id }, el("dt", { text: k }), el("dd", {}, v))),
  );
}

function message(root, cls, title, ...lines) {
  root.replaceChildren(
    el(
      "div",
      { class: `verdict ${cls}`, "data-verdict": cls.replace("verdict-", "").toUpperCase(), role: "status" },
      el("p", { class: "verdict-title", text: title }),
      lines.map((l) => (typeof l === "string" ? el("p", { text: l }) : l)),
    ),
  );
}

/** The address the QR code carries: this page, with the transaction it verified pinned in it. */
function canonicalAddress(where, result) {
  const url = new URL(location.href);
  url.hash = "";
  url.searchParams.set("network", where.network);
  const tx = result.facts?.tx;
  if (tx && !url.searchParams.has("tx")) url.searchParams.set("tx", tx.hash);
  return url.toString();
}

function render(root, network, where, result, rerun) {
  const v = receiptVerdict(result);
  const s = result.summary;
  const f = result.facts ?? {};
  const problems = s.fail + s.error;
  const head = el(
    "div",
    { class: `verdict verdict-${v.toLowerCase()}`, "data-verdict": v, role: "status" },
    el("p", {
      class: "verdict-title",
      text:
        v === "PASS"
          ? `Verified: all ${s.total} checks passed`
          : `Not verified: ${problems} of ${s.total} checks did not pass`,
    }),
    el(
      "p",
      {},
      result.block
        ? `Read by this browser from ${network.label} at final block ${result.block.height} (${time(result.block.timestampMs)}) with ${result.rpcCalls} read-only requests. `
        : "The RPC endpoints could not be reached. ",
      s.error > 0
        ? `${s.error} value(s) could not be read; an unreadable value is never counted as a pass.`
        : "",
    ),
    el(
      "div",
      { class: "actions no-print" },
      el("button", { type: "button", class: "btn", id: "print", text: "Print receipt" }),
      el("button", { type: "button", class: "btn", id: "rerun", text: "Verify again" }),
    ),
  );
  head.querySelector("#print").addEventListener("click", () => window.print());
  head.querySelector("#rerun").addEventListener("click", rerun);

  const ex = network.explorer ?? {};
  const account = (id) =>
    id ? external(ex.account ? ex.account.replace("{account}", id) : "#", id, "mono") : mono("not read");
  const ins = f.inspection;
  const card = el(
    "section",
    { class: "panel receipt-card", "aria-labelledby": "receipt-title" },
    el("h2", { id: "receipt-title" }, "Receipt for trade ", mono(f.tradeId ?? where.tradeId)),
    el(
      "div",
      { class: "receipt-body" },
      facts([
        ["Amount paid", mono(f.amountText ?? "no paid release"), "amount"],
        ["Asset", mono(f.assetText ?? "not read"), "asset"],
        ["Buyer", account(f.buyer), "buyer"],
        ["Supplier", account(f.supplier), "supplier"],
        ["Paid to", account(f.release?.destination ?? f.payoutDestination), "paid-to"],
        [
          "Inspection",
          mono(
            ins
              ? `${ins.decision} (${ins.reasonCodes.join(", ") || "no reason code"}), ${time(ins.recordedAt)}`
              : "none",
          ),
          "inspection",
        ],
        [
          "Release intent",
          mono(f.release ? `${f.release.intentId} ${f.release.state}` : "none PAID"),
          "release",
        ],
        ["Paid at", mono(time(f.release?.paidAt)), "paid-at"],
        [
          "Release transaction",
          f.tx ? (f.tx.link ? external(f.tx.link, f.tx.hash, "mono") : mono(f.tx.hash)) : mono("not named"),
          "tx",
        ],
        ["Escrow contract", account(f.contractId), "contract"],
        ["Contract code hash", mono(f.codeHash ?? "not read"), "code-hash"],
        ["Network", mono(f.network), "network"],
      ]),
      qrFigure(canonicalAddress(where, result)),
    ),
  );
  root.replaceChildren(
    head,
    card,
    el(
      "section",
      { class: "panel" },
      el("h2", { text: "Checks made by this browser" }),
      checksTable(result.rows),
    ),
  );
}

async function main() {
  const root = document.getElementById("receipt");
  const where = parseReceiptLocation(location.href);
  let manifest;
  try {
    const res = await fetch("./proof-manifest.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    manifest = await res.json();
  } catch (e) {
    message(root, "verdict-fail", "The proof manifest could not be loaded", String(e.message));
    return;
  }
  if (!where) {
    const network = manifest.networks.testnet;
    const paid = (network?.journeys ?? []).filter((j) => j.kind !== "refund");
    message(
      root,
      "verdict-none",
      "No receipt named",
      "Open a receipt by its address: /receipt/<trade id> on the Dockside app, or receipt.html?trade=<trade id> here.",
      paid.length > 0
        ? el(
            "ul",
            { class: "receipt-list" },
            paid.map((j) =>
              el(
                "li",
                {},
                el("a", { href: `?trade=${encodeURIComponent(j.tradeId)}&network=testnet`, text: j.tradeId }),
              ),
            ),
          )
        : "",
    );
    return;
  }
  const network = manifest.networks[where.network];
  if (!network?.deployment) {
    message(
      root,
      "verdict-none",
      "Not deployed yet",
      `There is no Dockside deployment on ${network?.label ?? where.network}, so there is nothing to verify. No request was sent.`,
    );
    return;
  }
  document.title = `Dockside payment receipt ${where.tradeId}`;
  let runId = 0;
  const run = async () => {
    const id = ++runId;
    message(
      root,
      "verdict-busy",
      "Reading NEAR…",
      `Asking ${new URL(network.rpc[0]).host} about trade ${where.tradeId}.`,
    );
    const { network: _n, ...subject } = where;
    const result = await verifyReceipt(network, subject);
    if (id === runId) render(root, network, where, result, run);
  };
  await run();
}

main();
