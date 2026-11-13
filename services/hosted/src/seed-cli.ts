#!/usr/bin/env node
/**
 * Demo seed of a hosted deployment (M55): run inside the running container, as the same user as the
 * product (`/app/deploy/entrypoint.sh seed-demo <command>`). It talks to the real API on loopback
 * and reads the deployment's facts from `<data dir>/hosted-runtime.json`, which the launcher writes.
 *
 *   seed-demo enroll [--reissue]
 *       Three demo organisations, the buyer organisation's commercial-documents EvidencePolicy, the
 *       ManifestAttestor and deterministic-policy service identities, and one invitation per trade
 *       role. Invitation secrets are printed once, here, and stored nowhere. Safe to run again.
 *       --reissue issues new invitations for roles nobody holds yet (after one expired or was lost).
 *   seed-demo grant
 *       Grants the invited role to every person who has accepted an invitation.
 *   seed-demo status
 *       The people and service identities of each demo organisation, as the API lists them.
 *
 * Exit codes: 0 success, 1 refused (the step and the API's error code are printed), 2 usage error.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type SeedContext, SeedError, seedEnroll, seedGrant, seedStatus } from "./seed.js";

const out = (v: unknown) => process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);

function context(dataDir: string, reissue: boolean): SeedContext {
  let rt: {
    origin?: unknown;
    apiPort?: unknown;
    manifestAttestorKeyFile?: unknown;
    deterministicPolicyKeyFile?: unknown;
  };
  try {
    rt = JSON.parse(readFileSync(join(dataDir, "hosted-runtime.json"), "utf8"));
  } catch {
    throw new SeedError(
      "DEPLOYMENT_NOT_RUNNING",
      "hosted-runtime.json was not found in the data directory: the product has not started here",
      "context",
    );
  }
  if (
    typeof rt.origin !== "string" ||
    typeof rt.apiPort !== "number" ||
    typeof rt.manifestAttestorKeyFile !== "string" ||
    typeof rt.deterministicPolicyKeyFile !== "string"
  )
    throw new SeedError("DEPLOYMENT_NOT_RUNNING", "hosted-runtime.json is incomplete", "context");
  return {
    apiBase: `http://127.0.0.1:${rt.apiPort}`,
    origin: rt.origin,
    stateDir: join(dataDir, "demo-seed"),
    manifestAttestorKeyFile: rt.manifestAttestorKeyFile,
    deterministicPolicyKeyFile: rt.deterministicPolicyKeyFile,
    reissue,
  };
}

async function main(): Promise<number> {
  const [cmd, ...flags] = process.argv.slice(2);
  const known = cmd === "enroll" ? ["--reissue"] : [];
  if (!["enroll", "grant", "status"].includes(cmd ?? "") || flags.some((f) => !known.includes(f))) {
    process.stderr.write("usage: seed-demo enroll [--reissue] | grant | status\n");
    return 2;
  }
  const ctx = context(process.env["HOSTED_DATA_DIR"] || "/data", flags.includes("--reissue"));
  if (cmd === "enroll") {
    const report = await seedEnroll(ctx);
    const fresh = report.invitations.filter((i) => i.secret !== undefined);
    out({
      ...report,
      next: [
        fresh.length > 0
          ? `Give each person their invitation secret privately. They open ${report.signInUrl}, choose to accept an invitation, paste the secret and sign with their own device key. The secrets above are shown only now.`
          : "No new invitation was issued. Use `enroll --reissue` for roles that still need one.",
        "After people accepted, run `seed-demo grant`.",
      ],
    });
    return 0;
  }
  if (cmd === "grant") {
    const results = await seedGrant(ctx);
    out({
      origin: ctx.origin,
      grants: results,
      next: results.every((r) => r.state === "GRANTED")
        ? ["Every trade role is held by a person. The buyer approver can create the first trade."]
        : ["PENDING: that person has not accepted yet. EXPIRED: run `seed-demo enroll --reissue`."],
    });
    return 0;
  }
  out(await seedStatus(ctx));
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    if (e instanceof SeedError) {
      process.stderr.write(`seed-demo: ${e.step}: ${e.code}: ${e.message}\n`);
      process.exit(1);
    }
    process.stderr.write(`seed-demo: INTERNAL: ${(e as Error).message}\n`);
    process.exit(1);
  },
);
