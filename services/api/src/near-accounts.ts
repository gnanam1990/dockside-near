import type { AuthContext } from "@dockside/authority";
import {
  type CanonicalValue,
  DocksideError,
  digestHexFor,
  encodeSignature,
  fail,
  fromHex,
  newNonce,
  parseNearAccountId,
  parsePublicKey,
  verifyNep413,
} from "@dockside/core";
import type { AccessKeyView } from "@dockside/near";
import { AuditLog } from "@dockside/store";
import { z } from "zod";
import type { AppDeps } from "./app.js";
import { type Route, route } from "./routing.js";

/**
 * NEAR account ownership (ADR-0018, T-004). A signed-in principal links a NEAR account by asking its
 * wallet to sign a NEP-413 message the server issued. The server then:
 *   1. verifies the NEP-413 signature (Borsh tag 2^31+413, message, 32-byte nonce, recipient = this
 *      origin) with the public key the wallet reported;
 *   2. asks the chain adapter `view_access_key(accountId, publicKey)` and accepts only a FullAccess key
 *      (NEP-413: the key must belong to the account; a FunctionCall key is not ownership);
 *   3. consumes the one-time challenge and records the link plus the chain observation, audited.
 * The link is an identity fact about the principal; it grants no capability and no trade authority.
 */
const SOURCE = "dockside-api";
const CHALLENGE_TTL_MS = 5 * 60_000;

type LinkStatus = "VERIFIED" | "KEY_NOT_FOUND" | "NOT_FULL_ACCESS";

function must(ctx: AuthContext | null): AuthContext {
  if (!ctx) fail("UNAUTHENTICATED", "authentication required");
  return ctx;
}

function chain(d: AppDeps) {
  if (!d.chain) fail("NOT_FOUND", "no such endpoint", { reason: "CHAIN_NOT_CONFIGURED" });
  return d.chain;
}

/** Wallets return the raw 64-byte signature as base64; Dockside's own form is ed25519:<base58>. */
export function normaliseWalletSignature(raw: string): string {
  if (raw.startsWith("ed25519:")) return raw;
  if (!/^[A-Za-z0-9+/]{86}==$/.test(raw))
    fail("SIGNATURE_INVALID", "signature must be base64 or ed25519:<base58>");
  return encodeSignature(new Uint8Array(Buffer.from(raw, "base64")));
}

export function nearLinkMessage(p: {
  accountId: string;
  principalId: string;
  organizationId: string;
  network: string;
  expiresAt: number;
  digestHex: string;
}): string {
  return [
    "Dockside NEAR account link",
    `account: ${p.accountId}`,
    `principal: ${p.principalId}`,
    `organization: ${p.organizationId}`,
    `network: ${p.network}`,
    `expires: ${new Date(p.expiresAt).toISOString()}`,
    `digest: ${p.digestHex}`,
  ].join("\n");
}

/** Observe the key on chain. NOT_FOUND from the RPC means the key is not an access key of the account. */
async function observe(
  d: AppDeps,
  accountId: string,
  publicKey: string,
): Promise<{ status: LinkStatus; view: AccessKeyView | null }> {
  try {
    const view = await chain(d).rpc.viewAccessKey(accountId, publicKey);
    return { status: view.permission === "FullAccess" ? "VERIFIED" : "NOT_FULL_ACCESS", view };
  } catch (e) {
    if (e instanceof DocksideError && e.code === "NOT_FOUND" && e.message !== "no such endpoint")
      return { status: "KEY_NOT_FOUND", view: null };
    throw e;
  }
}

function linkView(r: Record<string, unknown>) {
  return {
    linkId: String(r["id"]),
    principalId: String(r["principal_id"]),
    organizationId: String(r["organization_id"]),
    accountId: String(r["account_id"]),
    publicKey: String(r["public_key"]),
    network: String(r["network"]),
    status: String(r["status"]) as LinkStatus,
    permission: r["permission"] === null ? null : String(r["permission"]),
    blockHeight: r["block_height"] === null ? null : Number(r["block_height"]),
    linkedAt: Number(r["linked_at"]),
    lastCheckedAt: Number(r["last_checked_at"]),
    linkedWithKeyVersionId: String(r["key_version_id"]),
  };
}

export function nearAccountRoutes(d: AppDeps): Route[] {
  const r = route;
  const audit = () => new AuditLog(d.db, d.clock, d.ids);
  const log = (
    ctx: AuthContext,
    eventType: string,
    subjectId: string,
    payload: Record<string, string | number | boolean | null>,
  ) =>
    audit().append({
      eventType,
      organizationId: ctx.organizationId,
      actorPrincipalId: ctx.principal.id,
      actorKeyVersionId: ctx.keyVersion.id,
      sessionId: ctx.session.id,
      subjectType: "near_account",
      subjectId,
      correlationId: ctx.correlationId,
      source: SOURCE,
      payload,
    });
  const deny = (ctx: AuthContext, subjectId: string, code: string, accountId: string) =>
    log(ctx, "NEAR_ACCOUNT_LINK_DENIED", subjectId, { code, accountId });
  const visibleLink = (ctx: AuthContext, linkId: string) => {
    const row = d.db.get("SELECT * FROM near_account_links WHERE id = ?", linkId);
    const own = row && row["principal_id"] === ctx.principal.id;
    const admin =
      row && row["organization_id"] === ctx.organizationId && ctx.capabilities.includes("ORG_SECURITY_ADMIN");
    // Same answer for "no such link" and "not yours" (no enumeration).
    if (!row || (!own && !admin)) fail("NOT_FOUND", "NEAR account link not found");
    return row;
  };

  return [
    r(
      "POST",
      "/v1/me/near-accounts/challenges",
      true,
      z.object({ accountId: z.string().max(64) }).strict(),
      ({ ctx, body }) => {
        const c = must(ctx);
        chain(d);
        const accountId = parseNearAccountId((body as { accountId: string }).accountId, { mode: "input" });
        const now = d.clock.now();
        const id = d.ids.next("chl");
        const payload: Record<string, CanonicalValue> = {
          challengeId: id,
          purpose: "NEAR_ACCOUNT_LINK",
          origin: d.config.DOCKSIDE_ORIGIN,
          network: d.config.DOCKSIDE_NETWORK,
          organizationId: c.organizationId,
          principalId: c.principal.id,
          keyVersionId: c.keyVersion.id,
          accountId,
          nonce: newNonce(),
          issuedAt: now,
          expiresAt: now + CHALLENGE_TTL_MS,
        };
        const digestHex = digestHexFor("NEAR_ACCOUNT_LINK", payload);
        const message = nearLinkMessage({
          accountId,
          principalId: c.principal.id,
          organizationId: c.organizationId,
          network: d.config.DOCKSIDE_NETWORK,
          expiresAt: Number(payload["expiresAt"]),
          digestHex,
        });
        d.db.transaction(() => {
          d.db.run(
            `INSERT INTO near_account_challenges (id, principal_id, key_version_id, organization_id, account_id, origin, message, nonce, digest_hex, issued_at, expires_at, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
            id,
            c.principal.id,
            c.keyVersion.id,
            c.organizationId,
            accountId,
            d.config.DOCKSIDE_ORIGIN,
            message,
            String(payload["nonce"]),
            digestHex,
            now,
            Number(payload["expiresAt"]),
          );
          log(c, "NEAR_ACCOUNT_CHALLENGE_ISSUED", id, { accountId });
        });
        return {
          challengeId: id,
          accountId,
          digestHex,
          expiresAt: payload["expiresAt"],
          // Exactly what a NEP-413 wallet's signMessage takes.
          nep413: { message, nonceHex: payload["nonce"], recipient: d.config.DOCKSIDE_ORIGIN },
        };
      },
    ),
    r(
      "POST",
      "/v1/me/near-accounts",
      true,
      z
        .object({
          challengeId: z.string().max(64),
          accountId: z.string().max(64),
          publicKey: z.string().max(64),
          signature: z.string().max(128),
        })
        .strict(),
      async ({ ctx, body }) => {
        const c = must(ctx);
        chain(d);
        const b = body as { challengeId: string; accountId: string; publicKey: string; signature: string };
        const ch = d.db.get("SELECT * FROM near_account_challenges WHERE id = ?", b.challengeId);
        if (!ch || ch["principal_id"] !== c.principal.id) fail("NOT_FOUND", "challenge not found");
        if (ch["status"] !== "PENDING") fail("NONCE_REPLAYED", "challenge already consumed");
        if (ch["origin"] !== d.config.DOCKSIDE_ORIGIN)
          fail("WRONG_ORIGIN", "challenge was issued for another origin");
        if (ch["key_version_id"] !== c.keyVersion.id)
          fail("KEY_NOT_BOUND", "the challenge was issued to another session key of this principal");
        if (d.clock.now() >= Number(ch["expires_at"])) fail("EXPIRED", "challenge has expired");
        const accountId = String(ch["account_id"]);
        if (parseNearAccountId(b.accountId, { mode: "input" }) !== accountId) {
          deny(c, b.challengeId, "SCOPE_MISMATCH", accountId);
          fail("SCOPE_MISMATCH", "the wallet answered for a different NEAR account than the challenge names");
        }
        const publicKey = parsePublicKey(b.publicKey);
        const signature = normaliseWalletSignature(b.signature);
        const ok = verifyNep413(
          publicKey,
          {
            message: String(ch["message"]),
            nonce: fromHex(String(ch["nonce"])),
            recipient: d.config.DOCKSIDE_ORIGIN,
          },
          signature,
        );
        if (!ok) {
          deny(c, b.challengeId, "SIGNATURE_INVALID", accountId);
          fail("SIGNATURE_INVALID", "NEP-413 signature does not verify for this message, nonce and origin");
        }
        const seen = await observe(d, accountId, publicKey);
        if (seen.status !== "VERIFIED") {
          const code =
            seen.status === "KEY_NOT_FOUND" ? "ACCESS_KEY_NOT_FOUND" : "ACCESS_KEY_NOT_FULL_ACCESS";
          deny(c, b.challengeId, code, accountId);
          fail(
            code,
            seen.status === "KEY_NOT_FOUND"
              ? "the signing key is not an access key of this NEAR account"
              : "the signing key is a function-call key; ownership needs a full-access key",
          );
        }
        const now = d.clock.now();
        return d.db.transaction(() => {
          const r1 = d.db.run(
            "UPDATE near_account_challenges SET status = 'CONSUMED', consumed_at = ? WHERE id = ? AND status = 'PENDING'",
            now,
            b.challengeId,
          );
          if (Number(r1.changes) !== 1) fail("NONCE_REPLAYED", "challenge already consumed");
          const prior = d.db.get(
            "SELECT id FROM near_account_links WHERE principal_id = ? AND account_id = ? AND public_key = ?",
            c.principal.id,
            accountId,
            publicKey,
          );
          const linkId = prior ? String(prior["id"]) : d.ids.next("nal");
          if (prior)
            d.db.run(
              "UPDATE near_account_links SET status = 'VERIFIED', permission = ?, block_height = ?, last_checked_at = ?, key_version_id = ? WHERE id = ?",
              seen.view?.permission ?? null,
              seen.view?.blockHeight ?? null,
              now,
              c.keyVersion.id,
              linkId,
            );
          else
            d.db.run(
              `INSERT INTO near_account_links (id, principal_id, organization_id, key_version_id, account_id, public_key, network, challenge_id, signature, status, permission, block_height, linked_at, last_checked_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'VERIFIED', ?, ?, ?, ?)`,
              linkId,
              c.principal.id,
              c.organizationId,
              c.keyVersion.id,
              accountId,
              publicKey,
              d.config.DOCKSIDE_NETWORK,
              b.challengeId,
              signature,
              seen.view?.permission ?? null,
              seen.view?.blockHeight ?? null,
              now,
              now,
            );
          d.db.run(
            "INSERT INTO near_account_checks (id, link_id, result, permission, block_height, checked_by, checked_at) VALUES (?, ?, 'VERIFIED', ?, ?, ?, ?)",
            d.ids.next("nac"),
            linkId,
            seen.view?.permission ?? null,
            seen.view?.blockHeight ?? null,
            c.principal.id,
            now,
          );
          log(c, "NEAR_ACCOUNT_LINKED", linkId, {
            accountId,
            publicKey,
            permission: seen.view?.permission ?? null,
            blockHeight: seen.view?.blockHeight ?? null,
          });
          return linkView(d.db.get("SELECT * FROM near_account_links WHERE id = ?", linkId) ?? {});
        });
      },
    ),
    r("GET", "/v1/me/near-accounts", true, undefined, ({ ctx }) => {
      const c = must(ctx);
      return {
        network: d.config.DOCKSIDE_NETWORK,
        chainConfigured: d.chain !== undefined,
        links: d.db
          .all("SELECT * FROM near_account_links WHERE principal_id = ? ORDER BY linked_at", c.principal.id)
          .map(linkView),
      };
    }),
    r("GET", "/v1/organization/near-accounts", true, undefined, ({ ctx }) => {
      const c = must(ctx);
      if (!c.capabilities.includes("ORG_SECURITY_ADMIN") && !c.capabilities.includes("AUDITOR"))
        fail(
          "FORBIDDEN",
          "organization NEAR account links are readable by security administrators and auditors",
        );
      return {
        links: d.db
          .all(
            "SELECT * FROM near_account_links WHERE organization_id = ? ORDER BY linked_at",
            c.organizationId,
          )
          .map(linkView),
      };
    }),
    r("POST", "/v1/near-accounts/:id/recheck", true, z.object({}).strict(), async ({ ctx, params }) => {
      const c = must(ctx);
      chain(d);
      const row = visibleLink(c, params["id"] as string);
      const seen = await observe(d, String(row["account_id"]), String(row["public_key"]));
      const now = d.clock.now();
      return d.db.transaction(() => {
        d.db.run(
          "UPDATE near_account_links SET status = ?, permission = ?, block_height = ?, last_checked_at = ? WHERE id = ?",
          seen.status,
          seen.view?.permission ?? null,
          seen.view?.blockHeight ?? null,
          now,
          String(row["id"]),
        );
        d.db.run(
          "INSERT INTO near_account_checks (id, link_id, result, permission, block_height, checked_by, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          d.ids.next("nac"),
          String(row["id"]),
          seen.status,
          seen.view?.permission ?? null,
          seen.view?.blockHeight ?? null,
          c.principal.id,
          now,
        );
        log(c, "NEAR_ACCOUNT_RECHECKED", String(row["id"]), {
          accountId: String(row["account_id"]),
          result: seen.status,
          blockHeight: seen.view?.blockHeight ?? null,
        });
        return linkView(d.db.get("SELECT * FROM near_account_links WHERE id = ?", String(row["id"])) ?? {});
      });
    }),
  ];
}
