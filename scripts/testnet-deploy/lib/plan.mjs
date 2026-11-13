// What a run-all run will move, decided before anything is sent (M50).
//
// Pure functions: the asset a run uses, the `new` arguments of a deployment, the exposure limits
// run-all enforces on itself, and the value plan (every amount, who sends it, who can receive it)
// that the preflight prints. Nothing here reads the chain or a key.
import { ToolError } from "./near-tools.mjs";

export const NEAR = 10n ** 24n;
/** Mainnet caps the contract applies when `new` names none: 5 NEAR and 25 USDC (6 decimals). */
export const MAINNET_DEFAULT_CAP_NEAR_YOCTO = 5n * NEAR;
export const MAINNET_DEFAULT_CAP_NEP141 = 25_000_000n;
/** Journey defaults. */
export const DEFAULT_AMOUNT_YOCTO = 5n * 10n ** 22n; // 0.05 NEAR
export const DEFAULT_EXCESS_YOCTO = 10n ** 22n; // 0.01 NEAR
export const DEFAULT_AMOUNT_UNITS = 5_000_000n; // 5 USDC
export const DEFAULT_EXCESS_UNITS = 1_000_000n; // 1 USDC
/** NEP-141 `ft_transfer` and `ft_transfer_call` take exactly one yoctoNEAR. */
export const ONE_YOCTO = 1n;

const UINT = /^[1-9][0-9]{0,38}$/;
// A named NEAR account, or an implicit (64 hex) one: Circle's USDC contracts are implicit ids.
const TOKEN_ID = /^(?:[0-9a-f]{64}|(?=.{2,64}$)([a-z\d]+[-_])*[a-z\d]+(\.([a-z\d]+[-_])*[a-z\d]+)+)$/;

function uint(value, name, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !UINT.test(value))
    throw new ToolError("USAGE", `${name} must be a positive integer`);
  return BigInt(value);
}

/**
 * The asset of a run from its flags: `--asset near` (default) or `--asset usdc --token <account>`
 * (`--token-decimals`, default 6). `usdc` is the NEP-141 rail: any NEP-141 contract the caller
 * names, on mainnet Circle's USDC. A token given with `--asset near` is only pinned at deployment.
 */
export function assetFromFlags(f) {
  const kind = f.asset ?? "near";
  if (kind !== "near" && kind !== "usdc") throw new ToolError("USAGE", "--asset must be near or usdc");
  let token = null;
  if (f.token !== undefined) {
    if (typeof f.token !== "string" || !TOKEN_ID.test(f.token))
      throw new ToolError("USAGE", "--token must be a NEAR account id (the NEP-141 contract)");
    const d = f["token-decimals"] ?? "6";
    if (typeof d !== "string" || !/^(0|[1-9][0-9]?)$/.test(d) || Number(d) > 24)
      throw new ToolError("USAGE", "--token-decimals must be 0 to 24");
    token = { accountId: f.token, decimals: Number(d) };
  } else if (f["token-decimals"] !== undefined) {
    throw new ToolError("USAGE", "--token-decimals needs --token");
  }
  if (kind === "usdc" && !token) throw new ToolError("USAGE", "--asset usdc needs --token <account id>");
  return { kind: kind === "usdc" ? "nep141" : "near", token };
}

/** Trade amount and refund excess of a run, in base units of its asset. */
export function amountsFromFlags(f, asset, journey) {
  const token = asset.kind === "nep141";
  const wrong = token ? ["amount-yocto", "excess-yocto"] : ["amount-units", "excess-units"];
  for (const k of wrong) {
    if (f[k] !== undefined)
      throw new ToolError(
        "USAGE",
        `--${k} does not apply to --asset ${token ? "usdc (use --amount-units / --excess-units)" : "near (use --amount-yocto / --excess-yocto)"}`,
      );
  }
  const amount = token
    ? uint(f["amount-units"], "--amount-units", DEFAULT_AMOUNT_UNITS)
    : uint(f["amount-yocto"], "--amount-yocto", DEFAULT_AMOUNT_YOCTO);
  const excessFlag = token ? f["excess-units"] : f["excess-yocto"];
  const excess = token
    ? uint(excessFlag, "--excess-units", DEFAULT_EXCESS_UNITS)
    : uint(excessFlag, "--excess-yocto", DEFAULT_EXCESS_YOCTO);
  return { amount, excess: journey === "refund" ? excess : 0n };
}

/**
 * Caps a new deployment is initialised with. `near-mainnet`: the given caps or the contract's own
 * defaults, never zero. `near-testnet`: the given caps, or none.
 */
export function capsFromFlags(f, contractNetwork) {
  const near = uint(f["cap-near-yocto"], "--cap-near-yocto", undefined);
  const nep141 = uint(f["cap-token-units"], "--cap-token-units", undefined);
  if (contractNetwork === "near-mainnet") {
    return {
      nearYocto: near ?? MAINNET_DEFAULT_CAP_NEAR_YOCTO,
      nep141: nep141 ?? MAINNET_DEFAULT_CAP_NEP141,
    };
  }
  if (near === undefined && nep141 === undefined) return null;
  return { nearYocto: near ?? 0n, nep141: nep141 ?? 0n };
}

/** The `new` arguments run-all deploys with. Caps and the pinned token cannot change afterwards. */
export function initArgs({ contractNetwork, caps, token }) {
  return {
    network: contractNetwork,
    min_deposit_yocto: null,
    max_trade_amount: caps ? { near_yocto: caps.nearYocto.toString(), nep141: caps.nep141.toString() } : null,
    nep141_token: token ? { account_id: token.accountId, decimals: token.decimals } : null,
    min_deposit_nep141: null,
  };
}

/** Caps as `get_config` reports them (`maxTradeAmount`), as bigints; "0" is no cap. */
export function capsFromConfig(config) {
  const m = config?.maxTradeAmount;
  if (!m || typeof m.nearYocto !== "string" || typeof m.nep141 !== "string")
    throw new ToolError("CONFIG_MISMATCH", "the contract reports no maxTradeAmount (an older build?)");
  return { nearYocto: BigInt(m.nearYocto), nep141: BigInt(m.nep141) };
}

/**
 * The exposure check: the most this run puts into the escrow at once (trade amount plus the refund
 * excess) must fit the contract's cap for the asset, and on a real-funds run the cap itself must
 * exist and stay within run-all's own ceiling (the mainnet defaults unless --max-exposure-* widens
 * it on purpose).
 */
export function checkExposure({ asset, amounts, caps, realFunds, ceiling }) {
  const token = asset.kind === "nep141";
  const cap = caps ? (token ? caps.nep141 : caps.nearYocto) : 0n;
  const held = amounts.amount + amounts.excess;
  const unit = token ? "token base units" : "yoctoNEAR";
  if (realFunds) {
    if (!caps || caps.nearYocto === 0n || caps.nep141 === 0n)
      throw new ToolError(
        "CAP_REQUIRED",
        "a real-funds run needs a contract with a non-zero cap for every asset",
      );
    const limit = token ? ceiling.nep141 : ceiling.nearYocto;
    if (cap > limit)
      throw new ToolError(
        "EXPOSURE_EXCEEDED",
        `the contract cap ${cap} ${unit} is above run-all's ceiling ${limit}; lower the cap or raise --max-exposure-${token ? "token-units" : "near-yocto"} on purpose`,
      );
  }
  if (cap > 0n && held > cap)
    throw new ToolError(
      "EXPOSURE_EXCEEDED",
      `this run would hold ${held} ${unit} in escrow, above the contract cap ${cap}`,
    );
  return { heldAtMost: held, cap, unit };
}

export function ceilingFromFlags(f) {
  return {
    nearYocto: uint(
      f["max-exposure-near-yocto"],
      "--max-exposure-near-yocto",
      MAINNET_DEFAULT_CAP_NEAR_YOCTO,
    ),
    nep141: uint(f["max-exposure-token-units"], "--max-exposure-token-units", MAINNET_DEFAULT_CAP_NEP141),
  };
}

/** `12.5` style rendering of base units for people; the exact integer is always printed beside it. */
export function human(units, decimals) {
  const s = units.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = decimals ? s.slice(s.length - decimals).replace(/0+$/, "") : "";
  return frac ? `${whole}.${frac}` : whole;
}

/**
 * Every amount a run moves, in the order it happens. `registrations` are the accounts run-all
 * registers with the token first (NEP-145 `storage_deposit`, paid in NEAR by the escrow account).
 */
export function valuePlan({
  journey,
  asset,
  amounts,
  accounts,
  deploy,
  relayerKey,
  registrations = [],
  storageDepositYocto = 0n,
}) {
  const token = asset.kind === "nep141";
  const symbol = token ? `units of ${asset.token.accountId}` : "yoctoNEAR";
  const decimals = token ? asset.token.decimals : 24;
  const show = (n) => `${n} ${symbol} (${human(n, decimals)} ${token ? "tokens" : "NEAR"})`;
  const rows = [];
  if (deploy)
    rows.push({
      what: "deploy and initialise the escrow",
      from: accounts.escrow,
      to: accounts.escrow,
      amount: "0 NEAR attached; the account pays gas and keeps its own balance as storage stake",
    });
  for (const who of registrations)
    rows.push({
      what: `register ${who} with the token (storage_deposit)`,
      from: accounts.escrow,
      to: asset.token.accountId,
      amount: `${storageDepositYocto} yoctoNEAR (${human(storageDepositYocto, 24)} NEAR)`,
    });
  if (relayerKey)
    rows.push({
      what: "add the relayer's function-call key",
      from: accounts.relayer,
      to: accounts.relayer,
      amount: "0 NEAR attached; gas only",
    });
  const deposit = amounts.amount + amounts.excess;
  if (journey === "refusal")
    rows.push({
      what: "refused funding attempt with a wrong terms digest (must come back whole)",
      from: accounts.buyer,
      to: accounts.buyer,
      amount: `${show(amounts.amount / 2n)}, returned by the ${token ? "token contract" : "failed call"}`,
    });
  rows.push({
    what: token ? "fund the trade (ft_transfer_call on the token)" : "fund the trade",
    from: accounts.buyer,
    to: accounts.escrow,
    amount: token ? `${show(deposit)} plus 1 yoctoNEAR` : show(deposit),
  });
  if (journey === "refund") {
    rows.push({
      what: "refund MUTUAL_CANCEL (the trade amount)",
      from: accounts.escrow,
      to: accounts.buyer,
      amount: show(amounts.amount),
    });
    rows.push({
      what: "refund EXCESS_FUNDING_RETURN (the excess)",
      from: accounts.escrow,
      to: accounts.buyer,
      amount: show(amounts.excess),
    });
  } else {
    rows.push({
      what: journey === "paid" ? "release" : "release after the hold is resolved",
      from: accounts.escrow,
      to: accounts.supplier,
      amount: show(amounts.amount),
    });
  }
  if (token)
    rows.push({
      what: "each token transfer the escrow sends",
      from: accounts.escrow,
      to: asset.token.accountId,
      amount: "1 yoctoNEAR (required by NEP-141), from the escrow account's own balance",
    });
  rows.push({
    what: "every other step",
    from: accounts.relayer,
    to: accounts.escrow,
    amount: "0 attached; gas from the relayer key's allowance",
  });
  return rows;
}

export function printPlan(rows, write) {
  write("value plan (nothing has been sent yet):");
  for (const r of rows) write(`  ${r.what}: ${r.amount}; ${r.from} -> ${r.to}`);
}
