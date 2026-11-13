// Shared building blocks of the proof site's three pages (proof, attack console, payment receipt):
// a DOM element builder, status badges with icon and text, and the site navigation. Everything is
// built with DOM calls; chain data is only ever written to the page as text.
import { icon } from "./icons.mjs";

export { icon };

/**
 * @param {string} tag
 * @param {Record<string, unknown>} [attrs]
 * @param {...unknown} children
 * @returns {HTMLElement}
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = String(v);
    else if (k === "text") node.textContent = String(v);
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    node.append(typeof c === "string" ? document.createTextNode(c) : /** @type {Node} */ (c));
  }
  return node;
}

export const mono = (text) => el("span", { class: "mono", text: String(text) });

/** A link that opens outside the site; the icon is decorative, so the link's name is its text. */
export const external = (href, text, cls) =>
  el(
    "a",
    { href, target: "_blank", rel: "noopener noreferrer", class: ["ext", cls].filter(Boolean).join(" ") },
    el("span", { text }),
    icon("external-link", { size: 14, class: "icon icon-ext" }),
  );

const STATUS = {
  PASS: { text: "Pass", icon: "circle-check" },
  FAIL: { text: "Fail", icon: "circle-x" },
  ERROR: { text: "Not readable", icon: "circle-help" },
};

/** A check result: icon and word, never colour alone. */
export const badge = (status) =>
  el(
    "span",
    { class: `badge badge-${status.toLowerCase()}`, "data-status": status },
    icon(STATUS[status].icon, { size: 16 }),
    STATUS[status].text,
  );

/** The icon that leads a verdict, by the verdict's class (verdict-pass, verdict-fail, ...). */
export const VERDICT_ICON = {
  pass: "shield-check",
  fail: "shield-x",
  busy: "scan-line",
  none: "circle-help",
};

/**
 * The site navigation. The three pages are static files beside each other; on the hosted app the
 * receipt is also served at /receipt/<trade id>, where the proof site lives under /proof/.
 * @param {"proof" | "attack" | "receipt"} current
 */
export function mountNav(current) {
  const nav = document.getElementById("site-nav");
  if (!nav) return;
  const hostedReceipt = /^\/receipt\//.test(location.pathname);
  const root = hostedReceipt ? "/proof/" : current === "attack" ? "../" : "./";
  const items = [
    ["proof", "Proof", root, "shield-check"],
    ["attack", "Attack console", `${root}attack/`, "lock"],
    ["receipt", "Receipts", hostedReceipt ? "/receipt/" : `${root}receipt.html`, "receipt"],
  ];
  nav.replaceChildren(
    el(
      "ul",
      {},
      items.map(([id, label, href, glyph]) =>
        el(
          "li",
          {},
          el(
            "a",
            { href, "aria-current": id === current ? "page" : null },
            icon(glyph, { size: 16 }),
            el("span", { text: label }),
          ),
        ),
      ),
    ),
  );
}

/** Mark the newest rendering so its arrival can be shown (CSS turns this off for reduced motion). */
export function arrive(node) {
  node.classList.add("arrive");
  return node;
}
