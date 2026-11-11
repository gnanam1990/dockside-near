/**
 * T-045 (submission evidence matches the exact build), local part: scripts/build-manifest.mjs
 * ties the commit, lockfiles, migrations, built dist files and the contract wasm to one record,
 * computes the NEAR code hash a deployment must report, and its verifier refuses any manifest
 * whose artifacts or commit do not match the checkout. The on-chain code hash and account are
 * BLOCKED until a testnet deployment exists (scripts/testnet-deploy/verify-deploy.mjs).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { base58Encode } from "@dockside/core";
import { loadMigrations } from "@dockside/store";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../..");
const SCRIPT = join(ROOT, "scripts/build-manifest.mjs");
const WASM = join(ROOT, "contract/target/wasm32-unknown-unknown/release/dockside_escrow.wasm");
const dir = mkdtempSync(join(tmpdir(), "dockside-manifest-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const node = (args: string[]) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
  return { status: r.status, out: r.stdout, err: r.stderr };
};

describe("T-045: exact-build manifest", () => {
  const first = node([]);
  const m = JSON.parse(first.out);

  it("records the commit, toolchain, lockfiles, migrations, dist and wasm identities", () => {
    expect(first.status).toBe(0);
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout.trim();
    expect(m.commit).toBe(head);
    expect(m.toolchain.node).toBe(process.version);
    expect(m.lockfiles["pnpm-lock.yaml"]).toBe(
      createHash("sha256")
        .update(readFileSync(join(ROOT, "pnpm-lock.yaml")))
        .digest("hex"),
    );
    expect(m.migrations.map((x: { file: string }) => x.file)).toHaveLength(loadMigrations().length);
    expect(m.dist.files).toBeGreaterThan(20);
    const wasm = readFileSync(WASM);
    expect(m.contract.sha256).toBe(createHash("sha256").update(wasm).digest("hex"));
    // The value NEAR's view_account reports as code_hash for this exact artifact.
    expect(m.contract.nearCodeHash).toBe(
      base58Encode(new Uint8Array(createHash("sha256").update(wasm).digest())),
    );
    expect(m.deployment).toEqual({
      network: "near-testnet",
      accountId: null,
      codeHashOnChain: null,
      status: "BLOCKED",
    });
  });

  it("is deterministic for the same build", () => {
    const again = JSON.parse(node([]).out);
    expect({ ...again, contract: { ...again.contract, builtAt: null } }).toEqual({
      ...m,
      contract: { ...m.contract, builtAt: null },
    });
  });

  it("verifies against the checkout and refuses tampered artifacts or an unknown commit", () => {
    const good = join(dir, "good.json");
    writeFileSync(good, first.out);
    expect(node(["--verify", good]).status).toBe(0);
    const tamper = (f: (x: any) => void, name: string) => {
      const copy = JSON.parse(first.out);
      f(copy);
      const p = join(dir, `${name}.json`);
      writeFileSync(p, JSON.stringify(copy));
      const r = node(["--verify", p]);
      expect(r.status, name).toBe(1);
      return JSON.parse(r.out).problems.join(";");
    };
    expect(tamper((x) => (x.contract.sha256 = "00".repeat(32)), "wasm")).toContain("contract wasm sha256");
    expect(tamper((x) => (x.dist.digest = "11".repeat(32)), "dist")).toContain("dist files");
    expect(tamper((x) => (x.lockfiles["pnpm-lock.yaml"] = "22".repeat(32)), "lock")).toContain("lockfiles");
    expect(tamper((x) => (x.commit = "f".repeat(40)), "commit")).toContain("not in this repository");
  });
});
