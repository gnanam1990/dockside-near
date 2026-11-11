import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fail, toHex } from "@dockside/core";

/**
 * Content-addressed object storage for evidence originals and derived artifacts. Objects are
 * named by their SHA-256, written to a temporary file and renamed into place (atomic on the
 * same volume), never overwritten, and re-hashed on every read so a tampered file is refused.
 * Production deployments may put an S3-compatible store behind the same interface.
 */
export interface ObjectStore {
  put(bytes: Uint8Array): string;
  get(digest: string): Uint8Array;
  has(digest: string): boolean;
}

const HEX64 = /^[0-9a-f]{64}$/;

export function sha256Hex(bytes: Uint8Array): string {
  return toHex(createHash("sha256").update(bytes).digest());
}

export class LocalObjectStore implements ObjectStore {
  private seq = 0;

  /** `instanceId` names this writer's temporary files so concurrent writers never collide. */
  constructor(
    readonly root: string,
    private readonly instanceId: string,
  ) {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(instanceId))
      fail("CONFIG_INVALID", "object store instance id malformed");
    mkdirSync(join(root, "tmp"), { recursive: true });
  }

  private pathOf(digest: string): string {
    if (!HEX64.test(digest)) fail("VALIDATION_FAILED", "object digest malformed");
    return join(this.root, digest.slice(0, 2), digest);
  }

  put(bytes: Uint8Array): string {
    const digest = sha256Hex(bytes);
    const target = this.pathOf(digest);
    if (existsSync(target)) return digest;
    mkdirSync(join(this.root, digest.slice(0, 2)), { recursive: true });
    const tmp = join(this.root, "tmp", `${this.instanceId}-${process.pid}-${++this.seq}`);
    writeFileSync(tmp, bytes, { flag: "wx" });
    renameSync(tmp, target);
    return digest;
  }

  get(digest: string): Uint8Array {
    const p = this.pathOf(digest);
    if (!existsSync(p)) fail("NOT_FOUND", "object not found");
    const bytes = new Uint8Array(readFileSync(p));
    if (sha256Hex(bytes) !== digest) fail("DIGEST_MISMATCH", "stored object does not match its digest");
    return bytes;
  }

  has(digest: string): boolean {
    return existsSync(this.pathOf(digest));
  }
}
