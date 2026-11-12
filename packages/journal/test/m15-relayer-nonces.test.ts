/**
 * M15 relayer access-key sequencing (0008_relayer_nonces.sql, src/relayer.ts): one submitter per
 * relayer key at a time, nonces above the chain's and above every nonce already handed out, and a
 * nonce table that only moves forward. Two database connections stand in for two worker processes
 * (the process-level race is services/worker/test/m15-worker-process-kill.test.ts).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManualClock, randomIds } from "@dockside/core";
import { Database } from "@dockside/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Journal, withRelayerKey } from "../src/index.js";

const KEY = { signerId: "relayer.testnet", publicKey: "ed25519:11111111111111111111111111111111" };
let path = "";
let a: Database;
let b: Database;
let clock: ManualClock;

beforeEach(() => {
  path = join(mkdtempSync(join(tmpdir(), "dockside-m15-nonce-")), "j.sqlite");
  a = Database.open(path);
  a.migrate();
  b = Database.open(path);
  clock = new ManualClock(1_800_000_000_000);
});
afterEach(() => {
  a.close();
  b.close();
});

describe("M15 relayer key sequencing", () => {
  it("hands out nonces above the chain nonce and above every nonce already handed out", async () => {
    const ja = new Journal(a, clock, randomIds);
    const got: bigint[] = [];
    for (const chain of [5n, 5n, 3n, 9n]) {
      const r = await withRelayerKey(
        ja,
        KEY,
        "worker-a",
        1_000,
        async () => chain,
        async (n) => n,
      );
      expect(r.ran).toBe(true);
      if (r.ran) got.push(r.value);
    }
    // 5+1; the chain did not move (persisted, never broadcast): 7, not 6 again; lower chain read: 8; chain ahead: 10.
    expect(got).toEqual([6n, 7n, 8n, 10n]);
    expect(a.get("SELECT last_nonce FROM relayer_nonces")?.["last_nonce"]).toBe("10");
  });

  it("refuses a second submitter while the key is held, and fences a holder whose lease was taken over", async () => {
    const ja = new Journal(a, clock, randomIds);
    const jb = new Journal(b, clock, randomIds);
    let inner: Awaited<ReturnType<typeof withRelayerKey<bigint>>> | null = null;
    const outer = await withRelayerKey(
      ja,
      KEY,
      "worker-a",
      1_000,
      async () => 0n,
      async (n) => {
        inner = await withRelayerKey(
          jb,
          KEY,
          "worker-b",
          1_000,
          async () => 0n,
          async (m) => m,
        );
        return n;
      },
    );
    expect(outer).toEqual({ ran: true, value: 1n });
    expect(inner).toEqual({ ran: false });
    // Released on return: the other process gets the next nonce.
    expect(
      await withRelayerKey(
        jb,
        KEY,
        "worker-b",
        1_000,
        async () => 0n,
        async (m) => m,
      ),
    ).toEqual({
      ran: true,
      value: 2n,
    });
    // A holder that outlived its lease cannot allocate after a takeover.
    const stale = withRelayerKey(
      ja,
      KEY,
      "worker-a",
      1_000,
      async () => {
        clock.advance(2_000);
        jb.acquireLease(`relayer-key:${KEY.signerId}:${KEY.publicKey}`, "worker-b", 1_000);
        return 0n;
      },
      async (n) => n,
    );
    await expect(stale).rejects.toMatchObject({ code: "LEASE_LOST" });
  });

  it("the nonce table only moves forward and is never deleted", async () => {
    const ja = new Journal(a, clock, randomIds);
    await withRelayerKey(
      ja,
      KEY,
      "worker-a",
      1_000,
      async () => 41n,
      async (n) => n,
    );
    expect(() => a.run("UPDATE relayer_nonces SET last_nonce = '41'")).toThrow(/must increase/);
    expect(() => a.run("UPDATE relayer_nonces SET last_nonce = '9'")).toThrow(/must increase/);
    expect(() => a.run("DELETE FROM relayer_nonces")).toThrow(/append-only/);
    a.run("UPDATE relayer_nonces SET last_nonce = '100'");
    expect(a.get("SELECT last_nonce FROM relayer_nonces")?.["last_nonce"]).toBe("100");
  });
});
