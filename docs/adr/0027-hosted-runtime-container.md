# ADR-0027 — Hosted runtime: one container for API, worker and web

- Decision status: accepted
- Date: 2026-11-13, Dockside platform team
- Affected IDs: NFR-02, INV-13 (unchanged, see decision 8), T-007, T-019
- Relates to: ADR-0003 (service custody), ADR-0018 (isolated signer processes), ADR-0021 (pinned container
  images), ADR-0025 (relayer signer custody and the testnet runtime profile)
- Beyond the specification: the sealed specification pack (`docs/spec/`) does not describe a hosted deployment.
  Everything below is a deployment decision made outside it; no specified behaviour changes.

## Context

The testnet runtime profile of ADR-0025 runs as three processes in three terminals on the operator's machine,
with the web app on loopback. People on their own devices (INV-13, gate item 3) need the same product behind
HTTPS on a public host. Container hosts such as Render and Fly.io give one container one public HTTP port, a
persistent volume, a secret store, and terminate TLS themselves.

## Decisions

1. **One image, one process tree.** `Dockerfile` builds the workspace with the same commands as a developer
   machine and keeps only production dependencies, compiled packages, the SQL migrations, the isolated signer
   script and the web build. The base image is the Node.js 22 image already pinned by digest for the
   reproducible contract build. The image's process is the launcher `services/hosted/dist/main.js`, which starts
   the unchanged API (`services/api/dist/main.js`) and the unchanged worker (`services/worker/dist/main.js`) on
   loopback and supervises them.
2. **Fail closed as a whole.** The launcher refuses (exit 78) on an incomplete or contradictory profile, and
   ends the container with a child's exit status when the API or the worker exits at any time: a failed chain
   preflight, a missing, full-access or wrongly scoped relayer key, a wrong code hash. The public port opens
   only after the API is listening and the worker has logged `worker.started`. There is no degraded mode in
   which the web app is served without a worker.
3. **One public listener, which decides nothing.** `services/hosted/src/front.ts` replaces the Vite preview
   server of the runbook with the same contract: the web build with the same content security policy and
   security headers (a test keeps the two policies equal), `/v1`, `/healthz`, `/readyz` forwarded to the API and
   `/relay` to the worker's loopback relay. Request headers reach the API and the relay unchanged, so origin
   checks, authentication, body limits and rate limits stay where they were. Static files are served only from
   an index of the web build taken at start; a request can never name a path outside it. The API and the relay
   stay on loopback inside the container.
4. **HTTPS and origin by the host.** The container speaks plain HTTP on `PORT`; the host terminates TLS.
   `DOCKSIDE_ORIGIN` must be HTTPS (loopback excepted, as before) and defaults to the origin the host announces
   (`RENDER_EXTERNAL_URL`, or `https://<FLY_APP_NAME>.fly.dev`). HSTS is sent when the origin is HTTPS.
5. **The relayer key is a host secret, never in the image.** ADR-0025 decision 2 stands: the worker reads a
   near-cli-rs key file whose path is its only configuration, and checks its permissions and its on-chain
   restriction. New here is how that file comes to exist in a container: the entrypoint (`deploy/entrypoint.sh`,
   the only code that runs as root) copies it from a file the host mounts
   (`/etc/secrets/relayer-key.json`), or decodes it from the secret variable `RELAYER_KEY_JSON_B64` where the
   host offers only variables, into `/run/dockside/` (owner-only, outside the volume, gone with the container),
   removes the variable from the environment and drops to the unprivileged `dockside` user for good. The
   launcher passes the path to the worker alone and builds each child's environment from named settings, so
   neither the variable nor any other host variable reaches a Node.js process. A function-call key restricted
   to the escrow with a 1 NEAR allowance is the most this secret can ever be worth; a full-access key is
   refused at start.
6. **Service key seeds live on the volume.** The audit-export, ManifestAttestor and deterministic-policy seeds
   are created on first start by the existing custody tools (`export-key generate`, `service-key generate`:
   exclusive create, owner-only) under `/data/keys`, and read only by the isolated signer processes. They must
   survive restarts because organisations enrol their public keys. A copy of the volume therefore contains
   them; they can attest manifests and set holds, never move funds, and are revocable in the web app.
7. **One instance, SQLite on one volume.** The database, the evidence objects and the seeds are on `/data`.
   The deployment is exactly one container; the host configurations (`render.yaml`, `fly.toml`) say so. The
   journal's leases and nonce table already make a restart safe.
8. **Demo seed through the real API.** `seed-demo` (same image, run in the running container) enrols three demo
   organisations, the buyer organisation's commercial-documents EvidencePolicy, both service identities and one
   invitation per trade role, only by calling the API over HTTP with signed challenges and request proofs. It
   holds the three administrators' keys (`ORG_SECURITY_ADMIN` only, owner-only files on the volume) and never a
   trade role: approver, resolver, supplier signer and inspector are people who accept an invitation with their
   own device key. This is a convenience for a demonstration, operated by one person; it is not evidence for
   INV-13. Invitation secrets are printed once and stored nowhere.
9. **Launcher-owned settings.** Paths and loopback ports (`DOCKSIDE_DB_PATH`, `DOCKSIDE_HOST`, the key file
   paths, …) are derived by the launcher and refused when set by hand; the operator supplies the escrow, the
   RPC URL, the relayer account and optionally limits. The manifest in the image (`deploy/escrow-manifest.json`) is the artifact
   record of `gnanam1990-dock-escrow2.testnet`; a test keeps it equal to the M34 evidence. Mainnet stays refused at every layer, exactly as in ADR-0025.

## Consequences

- Every request reaches the API from the front's loopback address, so the per-address limit for
  unauthenticated routes (`DOCKSIDE_RATE_LIMIT_UNAUTH_PER_MIN`, default 300 a minute) is shared by all visitors
  of the deployment. Forwarded-for headers are deliberately not trusted. Per-session limits are unaffected.
- A wrong or missing secret shows as a container that exits 78 with a reason code in its log, not as a
  half-working site.
- Host secret stores are trusted to keep the relayer key; the host can read it. HSM/KMS custody remains a
  different `TxSigner` behind the same interface (ADR-0025).
- Scaling out needs a different store and is out of scope.
- Verified locally by `pnpm run hosted:verify`: the image built from the Dockerfile runs against a local
  nearcore sandbox prepared like the testnet deployment. Deploying to a host is the owner's step
  (docs/runbooks/hosted-deploy.md).
