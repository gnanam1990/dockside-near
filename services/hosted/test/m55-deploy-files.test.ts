/**
 * M55 deployment files: the host configurations, the Dockerfile and the entrypoint are checked
 * against the code they configure, so a renamed setting or a moved manifest fails here and not on
 * the host. Running the image is `pnpm run hosted:verify`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { LAUNCHER_OWNED, resolveHostedProfile } from "../src/profile.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const ESCROW = "gnanam1990-dock-escrow2.testnet";
const RELAYER = "gnanam1990-dock-relayer.testnet";
const RPC = "https://test.rpc.fastnear.com";
const dockerfile = read("Dockerfile");
/** Variables the image itself sets (Dockerfile ENV). */
const imageEnv = Object.fromEntries(
  [...dockerfile.matchAll(/^(?:ENV)?\s+([A-Z_]+)=(\S+?)(?: \\)?$/gm)].map((m) => [
    m[1] as string,
    m[2] as string,
  ]),
);

describe("M55 deployment files", () => {
  it("bakes the artifact record of the deployed escrow into the image", () => {
    const baked = JSON.parse(read("deploy/escrow-manifest.json")) as { nearCodeHash: string };
    expect(baked).toEqual(JSON.parse(read("docs/evidence/M34/run-testnet-20261113T022714Z/artifact.json")));
    expect(baked.nearCodeHash).toBe("7GEti5E6NWcjq8kHj5Gweed5HwggY1cxPD7cfbB65h8N");
    expect(imageEnv["DOCKSIDE_ESCROW_MANIFEST"]).toBe("/app/deploy/escrow-manifest.json");
    expect(dockerfile).toContain("cp deploy/entrypoint.sh deploy/escrow-manifest.json /out/deploy/");
  });

  it("builds on the pinned Node.js image and starts through the entrypoint", () => {
    const pin = /bookworm: "(node:22-bookworm-slim@sha256:[0-9a-f]{64})"/.exec(
      read("scripts/lib/docker.mjs"),
    )?.[1];
    expect(pin).toBeDefined();
    expect(dockerfile).toContain(`ARG NODE_IMAGE=${pin}`);
    const base = "$" + "{NODE_IMAGE}";
    expect(dockerfile.match(/^FROM .*$/gm)).toEqual([`FROM ${base} AS build`, `FROM ${base}`]);
    expect(dockerfile).toContain('ENTRYPOINT ["/app/deploy/entrypoint.sh"]');
    expect(dockerfile).toContain("pnpm install --frozen-lockfile");
    expect(imageEnv["HOSTED_DATA_DIR"]).toBe("/data");
    // No key, key path or secret is set at build time.
    expect(Object.keys(imageEnv).sort()).toEqual(
      ["DOCKSIDE_ESCROW_MANIFEST", "HOSTED_DATA_DIR", "NODE_ENV", "PORT"].sort(),
    );
    expect(dockerfile).not.toMatch(/RELAYER_KEY|\.seed|private_key/);
  });

  it("keeps local state, keys and build output out of the build context", () => {
    const ignored = read(".dockerignore").split("\n");
    for (const p of [".git", ".data", ".dockside-secrets", ".env", ".env.*", "**/node_modules", "**/dist"])
      expect(ignored).toContain(p);
  });

  it("has an entrypoint that removes the secret variable and never traces or prints it", () => {
    const sh = read("deploy/entrypoint.sh");
    expect(sh.startsWith("#!/bin/sh\n")).toBe(true);
    expect(sh).not.toContain("\r");
    expect(sh).toContain("set -eu");
    expect(sh).not.toMatch(/set -[a-z]*x/);
    expect(sh.match(/unset RELAYER_KEY_JSON_B64/g)).toHaveLength(2);
    // The only use of the variable's value is the decode into the private file.
    const uses = sh
      .split("\n")
      .filter((l) => l.includes("$RELAYER_KEY_JSON_B64") || l.includes("${RELAYER_KEY_JSON_B64"));
    expect(uses).toHaveLength(2);
    expect(uses.some((l) => l.includes('| base64 -d > "$KEY"'))).toBe(true);
    expect(sh.indexOf("unset RELAYER_KEY_JSON_B64")).toBeLessThan(
      sh.indexOf("as_user node /app/services/hosted/dist/main.js"),
    );
    expect(sh).toContain("setpriv --reuid=");
  });

  it("render.yaml is a complete hosted profile with one disk and the key as an unsynced secret", () => {
    const doc = parse(read("render.yaml")) as {
      services: {
        type: string;
        runtime: string;
        dockerfilePath: string;
        healthCheckPath: string;
        disk: { mountPath: string };
        envVars: { key: string; value?: string; sync?: boolean }[];
      }[];
    };
    expect(doc.services).toHaveLength(1);
    const svc = doc.services[0];
    expect(svc).toMatchObject({
      type: "web",
      runtime: "docker",
      dockerfilePath: "./Dockerfile",
      healthCheckPath: "/readyz",
      disk: { mountPath: imageEnv["HOSTED_DATA_DIR"] },
    });
    const vars = svc?.envVars ?? [];
    expect(vars.find((v) => v.key === "RELAYER_KEY_JSON_B64")).toEqual({
      key: "RELAYER_KEY_JSON_B64",
      sync: false,
    });
    for (const v of vars) expect(LAUNCHER_OWNED).not.toContain(v.key);
    const env: Record<string, string> = {
      ...imageEnv,
      RENDER_EXTERNAL_URL: "https://dockside-demo.onrender.com",
      PORT: "10000",
    };
    for (const v of vars) if (v.value !== undefined) env[v.key] = v.value;
    const p = resolveHostedProfile(env, { appRoot: "/app" });
    expect(p.origin).toBe("https://dockside-demo.onrender.com");
    expect(p.listen.port).toBe(10000);
    expect(p.workerEnv).toMatchObject({
      DOCKSIDE_NETWORK: "near-testnet",
      DOCKSIDE_NEAR_CHAIN_ID: "testnet",
      DOCKSIDE_ESCROW_CONTRACT_ID: ESCROW,
      DOCKSIDE_RELAYER_ACCOUNT_ID: RELAYER,
      DOCKSIDE_NEAR_RPC_URL: RPC,
      DOCKSIDE_ESCROW_MANIFEST: "/app/deploy/escrow-manifest.json",
    });
  });

  it("fly.toml is a complete hosted profile with one volume, one always-on machine and no secret", () => {
    const toml = read("fly.toml");
    const section = (name: string) =>
      new RegExp(`^\\[${name.replace(/[[\].]/g, "\\$&")}\\]\\n((?:(?!^\\[).*\\n?)*)`, "m").exec(toml)?.[1] ??
      "";
    const pairs = (body: string) =>
      Object.fromEntries(
        [...body.matchAll(/^\s*([A-Za-z_]+)\s*=\s*"?([^"\n]*?)"?\s*$/gm)].map((m) => [
          m[1] as string,
          m[2] as string,
        ]),
      );
    const app = /^app = "([a-z0-9-]+)"$/m.exec(toml)?.[1] as string;
    expect(app).toBeDefined();
    const flyEnv = pairs(section("env"));
    const http = pairs(section("http_service"));
    expect(pairs(section("mounts"))["destination"]).toBe(imageEnv["HOSTED_DATA_DIR"]);
    expect(http).toMatchObject({
      internal_port: flyEnv["PORT"],
      force_https: "true",
      auto_stop_machines: "off",
      min_machines_running: "1",
    });
    expect(toml).toContain('path = "/readyz"');
    expect(toml).not.toMatch(/RELAYER_KEY_JSON_B64\s*=/);
    for (const k of Object.keys(flyEnv)) expect(LAUNCHER_OWNED).not.toContain(k);
    const p = resolveHostedProfile({ ...imageEnv, ...flyEnv, FLY_APP_NAME: app }, { appRoot: "/app" });
    expect(p.origin).toBe(`https://${app}.fly.dev`);
    expect(p.listen.port).toBe(Number(http["internal_port"]));
    expect(p.workerEnv).toMatchObject({
      DOCKSIDE_ESCROW_CONTRACT_ID: ESCROW,
      DOCKSIDE_RELAYER_ACCOUNT_ID: RELAYER,
      DOCKSIDE_NEAR_RPC_URL: RPC,
    });
  });
});
