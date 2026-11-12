/**
 * Security finding dockside m29 (external security audit, follow-up to vuln-0002): the containers
 * that build the deployable escrow wasm must not reuse a cargo/rustup home that earlier runs, and
 * the code those runs tested, could write. A digest match of $CARGO_HOME/bin/rustup says nothing
 * about the env script, the cargo/rustc proxies, the installed toolchain or the registry cache
 * beside it. The runners therefore mount no cargo/rustup volume, and the bootstrap installs only
 * into empty homes and never sources a script from them. ADR-0021.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const dir = mkdtempSync(join(tmpdir(), "dockside-sec-m29-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const RUNNERS = ["scripts/container-reproduce.mjs", "scripts/sandbox/run.mjs"];
// Hand-run instructions for the same containers.
const HAND_RUN_DOCS = [
  "README.md",
  "scripts/container-reproduce.sh",
  "scripts/sandbox/container-sandbox.sh",
  "scripts/testnet-deploy/README.md",
];
const posix = (p: string) => p.replace(/\\/g, "/");

/**
 * Runs a copy of the bootstrap whose rustup-init pins are replaced by the digest of `rustupBytes`,
 * so a planted $CARGO_HOME/bin/rustup with those bytes passes the old "cached rustup matches the
 * pin" check. curl is a shim that records the call and fails, so nothing is downloaded.
 */
function runBootstrap(name: string, rustupBytes: string, plant: boolean) {
  const base = join(dir, name);
  const cargo = join(base, "cargo");
  const rustup = join(base, "rustup");
  const shims = join(base, "shims");
  const log = join(base, "log");
  mkdirSync(shims, { recursive: true });
  writeFileSync(join(shims, "curl"), `#!/bin/sh\necho CURL "$@" >> "${posix(log)}"\nexit 1\n`);
  chmodSync(join(shims, "curl"), 0o755);
  const digest = createHash("sha256").update(rustupBytes).digest("hex");
  const boot = read("scripts/lib/rust-bootstrap.sh").replace(
    /^(RUSTUP_INIT_SHA256_(?:X86_64|AARCH64))=\S+$/gm,
    `$1=${digest}`,
  );
  const bootFile = join(base, "rust-bootstrap.sh");
  writeFileSync(bootFile, boot);
  if (plant) {
    // What a reproduced ref running as root could leave behind in a shared cargo volume.
    mkdirSync(join(cargo, "bin"), { recursive: true });
    mkdirSync(join(rustup, "toolchains", "1.97.1-x86_64-unknown-linux-gnu", "bin"), { recursive: true });
    writeFileSync(join(cargo, "bin", "rustup"), rustupBytes);
    chmodSync(join(cargo, "bin", "rustup"), 0o755);
    writeFileSync(join(cargo, "bin", "cargo"), `#!/bin/sh\necho POISONED_CARGO_RAN >> "${posix(log)}"\n`);
    chmodSync(join(cargo, "bin", "cargo"), 0o755);
    writeFileSync(join(cargo, "env"), `echo POISONED_ENV_SOURCED >> "${posix(log)}"\n`);
  }
  const r = spawnSync("sh", ["-c", `. "${posix(bootFile)}" && cargo build --release`], {
    encoding: "utf8",
    env: {
      ...process.env,
      CARGO_HOME: posix(cargo),
      RUSTUP_HOME: posix(rustup),
      PATH: `${shims}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
    },
  });
  return { ...r, log: existsSync(log) ? readFileSync(log, "utf8") : "" };
}

describe("m29: no reused cargo/rustup home for the deployable build", () => {
  it("neither container runner mounts a cargo or rustup home from the host or a volume", () => {
    for (const f of RUNNERS) {
      const text = read(f);
      expect(text, f).not.toMatch(/:\/root\/\.(cargo|rustup)\b/);
      expect(text, f).not.toMatch(/dockside-(cargo|rustup)/);
    }
  });

  it("the hand-run instructions mount no cargo or rustup volume either", () => {
    for (const f of HAND_RUN_DOCS) expect(read(f), f).not.toMatch(/-v\s+\S+:\/root\/\.(cargo|rustup)\b/);
  });

  it("a planted toolchain in CARGO_HOME is refused, even when bin/rustup matches the pin", () => {
    const r = runBootstrap("planted", '#!/bin/sh\necho STUB_RUSTUP "$@"\n', true);
    expect(r.log).not.toMatch(/POISONED_ENV_SOURCED/);
    expect(r.log).not.toMatch(/POISONED_CARGO_RAN/);
    expect(r.log).not.toMatch(/CURL/);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/rust-bootstrap: .* is not empty/);
  });

  it("the bootstrap never sources a script from CARGO_HOME", () => {
    const boot = read("scripts/lib/rust-bootstrap.sh");
    expect(boot).not.toMatch(/^\s*\.\s+\S*CARGO_HOME/m);
    expect(boot).not.toMatch(/^\s*source\s/m);
  });

  it("with empty homes it goes straight to the pinned, digest-checked installer", () => {
    const r = runBootstrap("fresh", "not rustup-init", false);
    // The curl shim fails, so the installer check refuses: nothing from the homes was executed.
    expect(r.log).toMatch(/CURL .*static\.rust-lang\.org\/rustup\/archive\//);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/does not match its pinned SHA-256/);
  });
});
