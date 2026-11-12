/**
 * Security finding dockside vuln-0002 (external automated scan, CWE-494): the containers that build
 * and test the deployable escrow wasm must not run unverified downloaded code. Every container
 * image is pinned by digest, the Rust toolchain installer by version and SHA-256 (no installer
 * script piped to a shell), and the nearcore sandbox used by the M17 suite by SHA-256 with its npm
 * package installed from a committed lockfile with install scripts disabled. ADR-0021.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const dir = mkdtempSync(join(tmpdir(), "dockside-sec-0002-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const CONTAINER_SCRIPTS = ["scripts/container-reproduce.sh", "scripts/sandbox/container-sandbox.sh"];
// Files that name a container image literally; the two runners take theirs from IMAGES.
const IMAGE_USERS = ["scripts/lib/docker.mjs", "services/api/test/m17-near-sandbox.test.ts"];
const RUNNERS = {
  "scripts/container-reproduce.mjs": "IMAGES.bookworm",
  "scripts/sandbox/run.mjs": "IMAGES.trixie",
};
const SHA = /^[0-9a-f]{64}$/;

describe("vuln-0002: pinned container toolchain bootstrap", () => {
  it("no container script pipes a downloaded script into a shell", () => {
    for (const f of [
      ...CONTAINER_SCRIPTS,
      "scripts/lib/rust-bootstrap.sh",
      ...IMAGE_USERS,
      ...Object.keys(RUNNERS),
    ]) {
      if (!existsSync(join(ROOT, f))) throw new Error(`${f} is missing`);
      const text = read(f);
      expect(text, f).not.toMatch(/sh\.rustup\.rs/);
      expect(text, f).not.toMatch(/(curl|wget)[^\n|]*\|\s*(ba|da)?sh\b/);
    }
  });

  it("both container scripts install Rust only through the pinned, digest-checked rustup-init", () => {
    for (const f of CONTAINER_SCRIPTS) {
      const text = read(f);
      expect(text, f).toMatch(/^\. \/repo\/scripts\/lib\/rust-bootstrap\.sh$/m);
      expect(text, f).not.toMatch(/rustup-init|rustup toolchain install/);
    }
    const boot = read("scripts/lib/rust-bootstrap.sh");
    expect(boot).toMatch(/^RUSTUP_VERSION=\d+\.\d+\.\d+$/m);
    expect(boot).toMatch(/^RUST_TOOLCHAIN=1\.97\.1$/m);
    for (const arch of ["X86_64", "AARCH64"]) {
      const m = boot.match(new RegExp(`^RUSTUP_INIT_SHA256_${arch}=(\\S+)$`, "m"));
      expect(m?.[1], arch).toMatch(SHA);
    }
    // The installer is fetched from the versioned archive, verified, and only then executed.
    const fetchAt = boot.indexOf("https://static.rust-lang.org/rustup/archive/$RUSTUP_VERSION/");
    const checkAt = boot.indexOf('echo "$RUSTUP_INIT_SHA256  $RUSTUP_INIT" | sha256sum -c -');
    const runAt = boot.indexOf('"$RUSTUP_INIT" -y');
    expect(fetchAt).toBeGreaterThan(0);
    expect(checkAt).toBeGreaterThan(fetchAt);
    expect(runAt).toBeGreaterThan(checkAt);
    expect(boot.slice(checkAt, runAt)).toMatch(/exit 1/);
    // No cached rustup is reused (m29: a cached home is refused), and rustup never self-updates.
    expect(boot).not.toContain("$RUSTUP_BIN");
    expect(boot).toMatch(/rustup set auto-self-update disable/);
  });

  it("every container image is referenced by digest", () => {
    const refs: string[] = [];
    for (const f of IMAGE_USERS) {
      const found = [...read(f).matchAll(/"(node:\d+-[^"\s]+)"/g)].map((m) => m[1] ?? "");
      expect(found.length, f).toBeGreaterThan(0);
      refs.push(...found);
    }
    for (const [f, use] of Object.entries(RUNNERS)) {
      expect(read(f), f).toContain(use);
      expect(read(f), f).not.toMatch(/"node:d+-/);
    }
    for (const ref of refs) expect(ref).toMatch(/^node:22-(bookworm|trixie)-slim@sha256:[0-9a-f]{64}$/);
    // One digest per tag across the repository.
    const byTag = new Map<string, Set<string>>();
    for (const ref of refs) {
      const [tag, digest] = ref.split("@");
      byTag.set(tag ?? "", (byTag.get(tag ?? "") ?? new Set()).add(digest ?? ""));
    }
    for (const [tag, digests] of byTag) expect(digests.size, tag).toBe(1);
  });

  it("the M17 sandbox container installs near-sandbox from a lockfile and a digest-pinned binary", () => {
    const test = read("services/api/test/m17-near-sandbox.test.ts");
    expect(test).toMatch(/npm ci --ignore-scripts/);
    expect(test).not.toMatch(/npm install/);
    expect(test).toMatch(/NEAR_SANDBOX_BIN_PATH=/);
    expect(test).toMatch(/fetch-sandbox\.mjs/);
    const lock = JSON.parse(read("scripts/near-sandbox/npm/package-lock.json")) as {
      lockfileVersion: number;
      packages: Record<string, { version?: string; integrity?: string; resolved?: string }>;
    };
    expect(lock.lockfileVersion).toBeGreaterThanOrEqual(3);
    expect(lock.packages["node_modules/near-sandbox"]?.version).toBe("0.3.4");
    for (const [name, p] of Object.entries(lock.packages)) {
      if (name === "") continue;
      expect(p.integrity, name).toMatch(/^sha512-/);
      expect(p.resolved, name).toMatch(/^https:\/\/registry\.npmjs\.org\//);
    }
  });

  it("fetch-sandbox.mjs refuses a nearcore archive whose SHA-256 differs from the pin", () => {
    const fake = join(dir, "near-sandbox.tar.gz");
    writeFileSync(fake, "not the pinned nearcore sandbox archive");
    const dest = join(dir, "bin");
    const r = spawnSync(
      process.execPath,
      [join(ROOT, "scripts/near-sandbox/fetch-sandbox.mjs"), dest, "--archive", fake],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/does not match its pinned SHA-256/);
    expect(existsSync(join(dest, "near-sandbox"))).toBe(false);
    const src = read("scripts/near-sandbox/fetch-sandbox.mjs");
    expect(src.match(/NEAR_SANDBOX_SHA256 = "([0-9a-f]+)"/)?.[1]).toMatch(SHA);
  });
});
