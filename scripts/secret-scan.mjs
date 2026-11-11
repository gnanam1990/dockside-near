// Repository secret scan (NFR-02). Fails when tracked or staged files contain material
// that looks like a private key, seed phrase marker, or credential assignment.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  encoding: "utf8",
})
  .split("\n")
  .filter((f) => f && !f.startsWith("docs/spec/") && !/\.(png|wasm|lock)$/.test(f) && f !== "pnpm-lock.yaml");

const rules = [
  ["PEM private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  // NEAR secret keys and signatures share the same textual length, so key material is
  // detected by its label rather than by shape.
  ["NEAR secret key", /(secret_?key|private_?key)["']?\s*[:=]\s*["']?ed25519:[1-9A-HJ-NP-Za-km-z]{60,}/i],
  ["Credential assignment", /\b(api[_-]?key|secret|password|jwt|token)\s*[:=]\s*["'][^"'\s]{16,}["']/i],
  ["Seed phrase marker", /\b(mnemonic|seed[_ ]phrase)\s*[:=]/i],
];

const findings = [];
for (const f of files) {
  if (/(^|\/)\.env(\.|$)/.test(f)) findings.push([f, ".env file tracked"]);
  let text;
  try {
    text = readFileSync(f, "utf8");
  } catch {
    continue;
  }
  for (const [name, re] of rules) if (re?.test(text)) findings.push([f, name]);
}
if (findings.length) {
  for (const [f, n] of findings) console.error(`secret-scan: ${n} in ${f}`);
  process.exit(1);
}
console.log(`secret-scan: ${files.length} files clean`);
