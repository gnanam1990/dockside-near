/**
 * Test harness for M01. Every actor owns a real Ed25519 key and authenticates through
 * the real challenge / session / per-request proof path. Nothing here bypasses the
 * service: helpers only sign what a wallet or isolated signer would sign.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Capability,
  type Ed25519KeyPair,
  fromHex,
  generateEd25519KeyPair,
  ManualClock,
  randomIds,
  sha256,
  signFor,
  signNep413,
  toHex,
} from "@dockside/core";
import { Database } from "@dockside/store";
import {
  type AuthContext,
  AuthorityService,
  type ChallengeView,
  type ServiceChallengeView,
  type SessionGrant,
} from "../src/index.js";

export const ORIGIN = "https://dockside.test";
export const T0 = 1_800_000_000_000;

export interface Harness {
  readonly dir: string;
  readonly dbPath: string;
  db: Database;
  svc: AuthorityService;
  readonly clock: ManualClock;
  reopen(): void;
  close(): void;
  withOrigin(origin: string): AuthorityService;
}

const harnesses: Harness[] = [];

export function makeHarness(
  overrides: Partial<{ recoveryDelayMs: number; recoveryChallengeTtlMs: number }> = {},
): Harness {
  const dir = mkdtempSync(join(tmpdir(), "dockside-auth-"));
  const dbPath = join(dir, "authority.sqlite");
  const clock = new ManualClock(T0);
  const cfg = {
    origin: ORIGIN,
    network: "near-testnet" as const,
    challengeTtlMs: 5 * 60_000,
    sessionTtlMs: 8 * 3600_000,
    invitationTtlMs: 3 * 24 * 3600_000,
    recoveryDelayMs: overrides.recoveryDelayMs ?? 48 * 3600_000,
    requestProofSkewMs: 60_000,
    ...(overrides.recoveryChallengeTtlMs ? { recoveryChallengeTtlMs: overrides.recoveryChallengeTtlMs } : {}),
  };
  const open = () => {
    const db = Database.open(dbPath);
    db.migrate();
    return db;
  };
  const db = open();
  const h: Harness = {
    dir,
    dbPath,
    db,
    clock,
    svc: new AuthorityService({ db, clock, ids: randomIds, config: cfg }),
    reopen() {
      h.db.close();
      h.db = open();
      h.svc = new AuthorityService({ db: h.db, clock, ids: randomIds, config: cfg });
    },
    close() {
      try {
        h.db.close();
      } catch {
        /* already closed */
      }
      rmSync(dir, { recursive: true, force: true });
    },
    withOrigin(origin: string) {
      return new AuthorityService({ db: h.db, clock, ids: randomIds, config: { ...cfg, origin } });
    },
  };
  harnesses.push(h);
  return h;
}

export function closeHarnesses(): void {
  for (const h of harnesses.splice(0)) h.close();
}

/** Sign a human PoP challenge the way the Dockside client does (canonical Ed25519). */
export function signChallenge(key: Ed25519KeyPair, c: ChallengeView) {
  return {
    scheme: "dockside-ed25519" as const,
    signature: signFor(key.privateKey, "POP_CHALLENGE", c.canonicalPayload),
  };
}

/** Sign a human PoP challenge the way a NEAR wallet does (NEP-413 signMessage). */
export function signChallengeNep413(key: Ed25519KeyPair, c: ChallengeView, recipient = c.nep413.recipient) {
  return {
    scheme: "nep413" as const,
    signature: signNep413(key.privateKey, {
      message: c.nep413.message,
      nonce: fromHex(c.nep413.nonceHex),
      recipient,
    }),
  };
}

export function signServiceChallenge(key: Ed25519KeyPair, c: ServiceChallengeView) {
  return signFor(key.privateKey, "SERVICE_POP_CHALLENGE", c.canonicalPayload);
}

/** A human actor: one key, one session, signs a fresh proof per request. */
export class Actor {
  grant: SessionGrant | undefined;
  constructor(
    readonly h: Harness,
    readonly key: Ed25519KeyPair = generateEd25519KeyPair(),
  ) {}

  get principalId(): string {
    if (!this.grant) throw new Error("actor has no session");
    return this.grant.principalId;
  }

  get keyVersionId(): string {
    if (!this.grant) throw new Error("actor has no session");
    return this.grant.keyVersionId;
  }

  get organizationId(): string {
    if (!this.grant) throw new Error("actor has no session");
    return this.grant.organizationId;
  }

  /** Authenticate one request through the real session + proof verifier. */
  ctx(method = "POST", path = "/v1/test", body = "{}", svc: AuthorityService = this.h.svc): AuthContext {
    if (!this.grant) throw new Error("actor has no session");
    const proof = this.proof(method, path, body);
    return svc.authenticate({ sessionToken: this.grant.sessionToken, proof, method, path, body });
  }

  proof(method: string, path: string, body: string, key: Ed25519KeyPair = this.key) {
    if (!this.grant) throw new Error("actor has no session");
    const issuedAt = this.h.clock.now();
    const nonce = toHex(sha256(new TextEncoder().encode(`${randomIds.next("cor")}${Math.random()}`)));
    const payload = {
      sessionId: this.grant.sessionId,
      origin: ORIGIN,
      method,
      path,
      bodyDigest: toHex(sha256(new TextEncoder().encode(body))),
      issuedAt,
      nonce,
    };
    return {
      sessionId: this.grant.sessionId,
      issuedAt,
      nonce,
      signature: signFor(key.privateKey, "REQUEST_PROOF", payload),
    };
  }
}

export function bootstrap(h: Harness, name = "Acme Imports"): Actor {
  const admin = new Actor(h);
  const c = h.svc.createBootstrapChallenge({ organizationName: name, publicKey: admin.key.publicKey });
  admin.grant = h.svc.completeBootstrap({ challengeId: c.challengeId, proof: signChallenge(admin.key, c) });
  return admin;
}

/** Invite -> recipient proves its own key in its own session -> admin grants later. */
export function enrollHuman(
  h: Harness,
  admin: Actor,
  capability: Capability,
  displayName: string = capability,
): Actor {
  const inv = h.svc.createInvitation(admin.ctx(), { capability });
  const person = new Actor(h);
  const c = h.svc.createInvitationChallenge({
    invitationSecret: inv.secret,
    publicKey: person.key.publicKey,
    displayName,
  });
  person.grant = h.svc.acceptInvitation({ challengeId: c.challengeId, proof: signChallenge(person.key, c) });
  h.svc.grantRole(admin.ctx(), { invitationId: inv.invitationId });
  return person;
}

export function code(fn: () => unknown): string {
  try {
    fn();
    return "NO_ERROR";
  } catch (e) {
    return (e as { code?: string }).code ?? `FOREIGN:${(e as Error).message}`;
  }
}
