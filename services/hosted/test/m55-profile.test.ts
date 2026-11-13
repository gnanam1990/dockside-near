/**
 * M55 hosted runtime profile: how the launcher turns the host's environment (Render, Fly.io or a
 * plain `docker run`) into the M43 testnet profile of the API and the worker. Pure, no I/O.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveHostedProfile } from "../src/profile.js";

const APP = join("/", "app");
const base = {
  DOCKSIDE_ESCROW_CONTRACT_ID: "escrow.dockside-demo.testnet",
  DOCKSIDE_NEAR_RPC_URL: "https://test.rpc.fastnear.com",
  DOCKSIDE_RELAYER_ACCOUNT_ID: "relayer.dockside-demo.testnet",
  DOCKSIDE_ESCROW_MANIFEST: "/app/manifests/escrow.json",
  DOCKSIDE_ORIGIN: "https://dockside.example",
};
const resolve = (env: Record<string, string | undefined>) => resolveHostedProfile(env, { appRoot: APP });
const refusal = (env: Record<string, string | undefined>) => {
  try {
    resolve(env);
  } catch (e) {
    const err = e as { code?: string; details?: { name?: string; names?: string } };
    return { code: err.code, name: err.details?.name ?? err.details?.names };
  }
  throw new Error("expected a refusal");
};

describe("M55 hosted profile", () => {
  it("serves on every interface at the host's PORT and keeps the API and relay on loopback", () => {
    const p = resolve({ ...base, PORT: "10000" });
    expect(p.listen).toEqual({ host: "0.0.0.0", port: 10000 });
    expect(p.origin).toBe("https://dockside.example");
    expect(p.apiEnv["DOCKSIDE_HOST"]).toBe("127.0.0.1");
    expect(p.apiEnv["DOCKSIDE_PORT"]).toBe(String(p.apiPort));
    expect(p.workerEnv["DOCKSIDE_RELAY_PORT"]).toBe(String(p.relayPort));
    expect(p.apiPort).not.toBe(p.relayPort);
    expect(p.webRoot).toBe(join(APP, "apps", "web", "dist"));
    expect(resolve(base).listen.port).toBe(8080);
  });

  it("puts the database, the objects and the service keys on the persistent volume", () => {
    const d = join("/", "data");
    const p = resolve({ ...base, HOSTED_DATA_DIR: d });
    for (const env of [p.apiEnv, p.workerEnv]) {
      expect(env["DOCKSIDE_DB_PATH"]).toBe(join(d, "dockside.sqlite"));
      expect(env["DOCKSIDE_OBJECT_STORE_DIR"]).toBe(join(d, "objects"));
    }
    expect(p.apiEnv["DOCKSIDE_AUDIT_EXPORT_KEY_FILE"]).toBe(join(d, "keys", "audit-export.seed"));
    expect(p.workerEnv["DOCKSIDE_MANIFEST_ATTESTOR_KEY_FILE"]).toBe(
      join(d, "keys", "manifest-attestor.seed"),
    );
    expect(p.workerEnv["DOCKSIDE_POLICY_SERVICE_KEY_FILE"]).toBe(
      join(d, "keys", "deterministic-policy.seed"),
    );
    expect(p.keyFiles).toEqual({
      auditExport: join(d, "keys", "audit-export.seed"),
      manifestAttestor: join(d, "keys", "manifest-attestor.seed"),
      deterministicPolicy: join(d, "keys", "deterministic-policy.seed"),
    });
  });

  it("gives both processes the testnet chain profile and only the worker the relayer identity", () => {
    const p = resolve({ ...base, HOSTED_RELAYER_KEY_FILE: "/run/dockside/relayer-key.json" });
    for (const env of [p.apiEnv, p.workerEnv]) {
      expect(env["DOCKSIDE_NETWORK"]).toBe("near-testnet");
      expect(env["DOCKSIDE_NEAR_CHAIN_ID"]).toBe("testnet");
      expect(env["DOCKSIDE_ESCROW_CONTRACT_ID"]).toBe(base.DOCKSIDE_ESCROW_CONTRACT_ID);
      expect(env["DOCKSIDE_NEAR_RPC_URL"]).toBe(base.DOCKSIDE_NEAR_RPC_URL);
      expect(env["DOCKSIDE_ESCROW_MANIFEST"]).toBe(base.DOCKSIDE_ESCROW_MANIFEST);
      expect(env["DOCKSIDE_ORIGIN"]).toBe(base.DOCKSIDE_ORIGIN);
    }
    expect(p.workerEnv["DOCKSIDE_RELAYER_ACCOUNT_ID"]).toBe(base.DOCKSIDE_RELAYER_ACCOUNT_ID);
    expect(p.workerEnv["DOCKSIDE_RELAYER_KEY_FILE"]).toBe("/run/dockside/relayer-key.json");
    expect(p.apiEnv["DOCKSIDE_RELAYER_KEY_FILE"]).toBeUndefined();
    expect(p.apiEnv["DOCKSIDE_RELAYER_ACCOUNT_ID"]).toBeUndefined();
    expect(p.apiEnv["DOCKSIDE_MANIFEST_ATTESTOR_KEY_FILE"]).toBeUndefined();
    expect(p.workerEnv["DOCKSIDE_AUDIT_EXPORT_KEY_FILE"]).toBeUndefined();
  });

  it("leaves the relayer key file out when the host supplied none, so the worker refuses to start", () => {
    const p = resolve(base);
    expect(p.relayerKeyFile).toBeNull();
    expect(p.workerEnv["DOCKSIDE_RELAYER_KEY_FILE"]).toBeUndefined();
  });

  it("takes the public origin from the host when DOCKSIDE_ORIGIN is not set", () => {
    const { DOCKSIDE_ORIGIN: _o, ...noOrigin } = base;
    expect(resolve({ ...noOrigin, RENDER_EXTERNAL_URL: "https://dockside-demo.onrender.com" }).origin).toBe(
      "https://dockside-demo.onrender.com",
    );
    expect(resolve({ ...noOrigin, FLY_APP_NAME: "dockside-demo" }).origin).toBe(
      "https://dockside-demo.fly.dev",
    );
    expect(
      resolve({ ...base, RENDER_EXTERNAL_URL: "https://other.onrender.com", FLY_APP_NAME: "other" }).origin,
    ).toBe(base.DOCKSIDE_ORIGIN);
    expect(refusal(noOrigin)).toEqual({ code: "CONFIG_INVALID", name: "DOCKSIDE_ORIGIN" });
  });

  it("refuses a public origin that is not HTTPS", () => {
    expect(refusal({ ...base, DOCKSIDE_ORIGIN: "http://dockside.example" })).toEqual({
      code: "CONFIG_INVALID",
      name: "DOCKSIDE_ORIGIN",
    });
    expect(resolve({ ...base, DOCKSIDE_ORIGIN: "http://127.0.0.1:9032" }).origin).toBe(
      "http://127.0.0.1:9032",
    );
  });

  it("passes only named settings to the children: host secrets and stray variables never reach them", () => {
    const p = resolve({
      ...base,
      RELAYER_KEY_JSON_B64: "c2VjcmV0",
      AWS_SECRET_ACCESS_KEY: "x",
      HOSTED_RELAYER_KEY_FILE: "/run/dockside/relayer-key.json",
      PATH: "/usr/local/bin:/usr/bin",
      DOCKSIDE_RATE_LIMIT_UNAUTH_PER_MIN: "600",
    });
    for (const env of [p.apiEnv, p.workerEnv]) {
      for (const k of Object.keys(env))
        expect(
          k === "PATH" || k === "NODE_ENV" || k === "NODE_NO_WARNINGS" || k.startsWith("DOCKSIDE_"),
        ).toBe(true);
      expect(JSON.stringify(env)).not.toContain("c2VjcmV0");
      expect(env["PATH"]).toBe("/usr/local/bin:/usr/bin");
      expect(env["DOCKSIDE_RATE_LIMIT_UNAUTH_PER_MIN"]).toBe("600");
    }
  });

  it("refuses settings the launcher owns, unknown settings, mainnet and an incomplete chain profile", () => {
    for (const name of [
      "DOCKSIDE_DB_PATH",
      "DOCKSIDE_OBJECT_STORE_DIR",
      "DOCKSIDE_HOST",
      "DOCKSIDE_PORT",
      "DOCKSIDE_RELAY_PORT",
      "DOCKSIDE_RELAYER_KEY_FILE",
      "DOCKSIDE_AUDIT_EXPORT_KEY_FILE",
      "DOCKSIDE_MANIFEST_ATTESTOR_KEY_FILE",
      "DOCKSIDE_POLICY_SERVICE_KEY_FILE",
    ])
      expect(refusal({ ...base, [name]: "1" })).toEqual({ code: "CONFIG_INVALID", name });
    expect(refusal({ ...base, DOCKSIDE_RELAYER_KEY: "ed25519:x" })).toEqual({
      code: "CONFIG_INVALID",
      name: "DOCKSIDE_RELAYER_KEY",
    });
    expect(refusal({ ...base, DOCKSIDE_NETWORK: "near-mainnet" }).code).toBe("CONFIG_INVALID");
    for (const name of [
      "DOCKSIDE_ESCROW_CONTRACT_ID",
      "DOCKSIDE_NEAR_RPC_URL",
      "DOCKSIDE_RELAYER_ACCOUNT_ID",
      "DOCKSIDE_ESCROW_MANIFEST",
    ] as const) {
      const { [name]: _gone, ...rest } = base;
      expect(refusal(rest)).toEqual({ code: "CONFIG_INVALID", name });
    }
    expect(refusal({ ...base, PORT: "0" })).toEqual({ code: "CONFIG_INVALID", name: "PORT" });
    expect(refusal({ ...base, PORT: "http" })).toEqual({ code: "CONFIG_INVALID", name: "PORT" });
    expect(refusal({ ...base, HOSTED_API_PORT: "9033", HOSTED_RELAY_PORT: "9033" })).toEqual({
      code: "CONFIG_INVALID",
      name: "HOSTED_RELAY_PORT",
    });
  });

  it("never puts a value into a refusal", () => {
    let seen = "";
    try {
      resolve({ ...base, DOCKSIDE_ORIGIN: "http://leaky.example/secret-path" });
    } catch (e) {
      seen = JSON.stringify({ m: (e as Error).message, d: (e as { details?: unknown }).details });
    }
    expect(seen).not.toBe("");
    expect(seen).not.toContain("leaky");
  });
});
