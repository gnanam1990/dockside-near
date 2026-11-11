import { createServer } from "node:http";
import { AuthorityService } from "@dockside/authority";
import { loadConfig, randomIds, redactConfig, systemClock } from "@dockside/core";
import { Database } from "@dockside/store";
import { createApp } from "./app.js";

/** Local entry point. Configuration comes only from DOCKSIDE_* environment variables. */
function main(): void {
  const config = loadConfig(process.env);
  const db = Database.open(config.DOCKSIDE_DB_PATH);
  const migrated = db.migrate();
  const authority = new AuthorityService({
    db,
    clock: systemClock,
    ids: randomIds,
    config: {
      origin: config.DOCKSIDE_ORIGIN,
      network: config.DOCKSIDE_NETWORK,
      challengeTtlMs: config.DOCKSIDE_CHALLENGE_TTL_MS,
      sessionTtlMs: config.DOCKSIDE_SESSION_TTL_MS,
      invitationTtlMs: config.DOCKSIDE_INVITATION_TTL_MS,
      recoveryDelayMs: config.DOCKSIDE_RECOVERY_DELAY_MS,
      requestProofSkewMs: config.DOCKSIDE_REQUEST_PROOF_SKEW_MS,
    },
  });
  const log = (line: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(line)}\n`);
  const server = createServer(createApp({ config, db, authority, clock: systemClock, ids: randomIds, log }));
  server.listen(config.DOCKSIDE_PORT, config.DOCKSIDE_HOST, () => {
    const addr = server.address();
    log({
      event: "listening",
      address: addr,
      migrationsApplied: migrated.applied,
      config: redactConfig(config),
    });
  });
  const stop = () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main();
