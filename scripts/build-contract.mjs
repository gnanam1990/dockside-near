// Builds the NEAR escrow wasm from inside contract/ so contract/.cargo/config.toml applies
// (`--cfg near`, stripped symbols), then verifies the artifact and prints its SHA-256.
// Usage: pnpm contract:build
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const contractDir = fileURLToPath(new URL("../contract/", import.meta.url));
const r = spawnSync(
  "cargo",
  ["build", "-p", "dockside-escrow", "--target", "wasm32-unknown-unknown", "--release", "--locked"],
  { cwd: contractDir, stdio: "inherit", shell: process.platform === "win32" },
);
if (r.status !== 0) process.exit(r.status ?? 1);

const wasmPath = new URL("../contract/target/wasm32-unknown-unknown/release/dockside_escrow.wasm", import.meta.url);
const wasm = readFileSync(wasmPath);
const imports = WebAssembly.Module.imports(new WebAssembly.Module(wasm)).map((i) => i.name);
// Without `--cfg near`, near-sdk compiles host fallbacks and contract panics lose their message.
if (!imports.includes("panic_utf8")) {
  console.error("contract wasm was built without --cfg near (panic_utf8 import missing)");
  process.exit(1);
}
const sha = createHash("sha256").update(wasm).digest("hex");
console.log(`dockside_escrow.wasm ${wasm.length} bytes sha256 ${sha}`);
