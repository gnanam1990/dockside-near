// Exact-build manifest (T-045). Records the commit, toolchain, lockfile digests, migration
// checksums, every built dist file's digest and the contract wasm's SHA-256 and NEAR code hash
// (base58 of the SHA-256, the value `view_account` reports after deployment), so evidence and a
// later testnet deployment can be tied to one tested build.
//
// Usage:
//   node scripts/build-manifest.mjs [--out <file>]       write (or print) the manifest
//   node scripts/build-manifest.mjs --verify <file>      recompute and compare with a manifest;
//                                                        commits after the manifest's commit may
//                                                        change only docs/ and top-level *.md files
// Run after `pnpm run build && pnpm run contract:build` (or `pnpm test`, which builds both).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WASM = "contract/target/wasm32-unknown-unknown/release/dockside_escrow.wasm";
const DIST_ROOTS = ["packages", "services"];
const shell = process.platform === "win32";

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const rel = (p) => relative(ROOT, p).split("\\").join("/");

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes) {
  let n = BigInt(`0x${Buffer.from(bytes).toString("hex") || "0"}`);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, {
      cwd: ROOT,
      encoding: "utf8",
      shell,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

function files(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p));
    else out.push(p);
  }
  return out;
}

function distFiles() {
  const out = [];
  for (const r of DIST_ROOTS) {
    for (const pkg of readdirSync(join(ROOT, r), { withFileTypes: true })) {
      const d = join(ROOT, r, pkg.name, "dist");
      if (pkg.isDirectory() && existsSync(d))
        out.push(...files(d).filter((f) => !f.endsWith(".tsbuildinfo")));
    }
  }
  return out.map(rel).sort();
}

export function computeManifest() {
  const dist = distFiles().map((p) => [p, sha256(readFileSync(join(ROOT, p)))]);
  const migrationsDir = join(ROOT, "packages/store/migrations");
  const migrations = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({ file: f, sha256: sha256(readFileSync(join(migrationsDir, f))) }));
  const wasmPath = join(ROOT, WASM);
  const wasm = existsSync(wasmPath) ? readFileSync(wasmPath) : null;
  const status = run("git", ["status", "--porcelain", "--untracked-files=no"]);
  return {
    schema: "dockside/build-manifest@1",
    commit: run("git", ["rev-parse", "HEAD"]),
    trackedTreeClean: status === "",
    toolchain: {
      node: process.version,
      pnpm: run("pnpm", ["--version"]),
      rustc: run("rustc", ["--version"]),
      cargo: run("cargo", ["--version"]),
      platform: `${process.platform}-${process.arch}`,
    },
    lockfiles: {
      "pnpm-lock.yaml": sha256(readFileSync(join(ROOT, "pnpm-lock.yaml"))),
      "contract/Cargo.lock": sha256(readFileSync(join(ROOT, "contract/Cargo.lock"))),
    },
    migrations,
    dist: {
      files: dist.length,
      // Digest over "path sha256\n" lines in path order: any changed, added or removed file changes it.
      digest: sha256(dist.map(([p, h]) => `${p} ${h}\n`).join("")),
    },
    contract: wasm
      ? {
          path: WASM,
          bytes: wasm.length,
          sha256: sha256(wasm),
          nearCodeHash: base58(createHash("sha256").update(wasm).digest()),
          builtAt: statSync(wasmPath).mtime.toISOString(),
        }
      : null,
    deployment: { network: "near-testnet", accountId: null, codeHashOnChain: null, status: "BLOCKED" },
  };
}

function verify(file) {
  const want = JSON.parse(readFileSync(file, "utf8"));
  const have = computeManifest();
  const problems = [];
  const same = (a, b, what) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) problems.push(`${what} differs`);
  };
  same(have.lockfiles, want.lockfiles, "lockfiles");
  same(have.migrations, want.migrations, "migrations");
  same(have.dist, want.dist, "dist files");
  same(have.contract?.sha256, want.contract?.sha256, "contract wasm sha256");
  same(have.contract?.nearCodeHash, want.contract?.nearCodeHash, "contract code hash");
  if (want.commit && have.commit && want.commit !== have.commit) {
    const changed = run("git", ["diff", "--name-only", want.commit, have.commit]);
    if (changed === null) problems.push(`commit ${want.commit} is not in this repository`);
    else {
      // Evidence and status documents may follow the build; nothing that is built or run may.
      const docsOnly = (p) => p.startsWith("docs/") || /^[A-Z0-9-]+\.md$/.test(p);
      const outside = changed.split("\n").filter((p) => p && !docsOnly(p));
      if (outside.length)
        problems.push(
          `files other than documentation changed since the manifest commit: ${outside.join(", ")}`,
        );
    }
  }
  const out = { ok: problems.length === 0, manifestCommit: want.commit, headCommit: have.commit, problems };
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 1);
}

const args = process.argv.slice(2);
if (args[0] === "--verify") verify(args[1]);
else {
  const m = computeManifest();
  const json = `${JSON.stringify(m, null, 2)}\n`;
  const i = args.indexOf("--out");
  if (i >= 0) {
    writeFileSync(args[i + 1], json);
    console.log(
      `build manifest written: commit ${m.commit} wasm ${m.contract?.sha256 ?? "absent"} dist ${m.dist.digest}`,
    );
  } else process.stdout.write(json);
}
