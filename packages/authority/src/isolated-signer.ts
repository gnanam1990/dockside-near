import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { type CanonicalValue, fail, type SigningPurpose, toTypedJson } from "@dockside/core";

export const ISOLATED_SIGNER_SCRIPT = fileURLToPath(
  new URL("../signer/isolated-signer.mjs", import.meta.url),
);

/**
 * Client for an isolated signer child process. The parent (API / worker) holds only the
 * public key; the private key lives in the child. Production custody may replace the
 * child with an HSM/KMS behind the same request/response contract.
 */
export class IsolatedSigner {
  private seq = 0;
  private readonly pending = new Map<number, { resolve: (s: string) => void; reject: (e: Error) => void }>();

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    readonly publicKey: string,
    readonly allowedPurposes: readonly SigningPurpose[],
  ) {}

  static spawn(opts: {
    allowedPurposes: readonly SigningPurpose[];
    seedFile?: string;
  }): Promise<IsolatedSigner> {
    const args = [ISOLATED_SIGNER_SCRIPT, `--allow=${opts.allowedPurposes.join(",")}`];
    if (opts.seedFile !== undefined) args.push(`--seed-file=${opts.seedFile}`);
    const child = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    return new Promise((resolve, reject) => {
      const rl = createInterface({ input: child.stdout });
      let signer: IsolatedSigner | undefined;
      let stderr = "";
      child.stderr.on("data", (d) => {
        stderr += String(d);
      });
      child.on("exit", (code) => {
        if (!signer) reject(new Error(`isolated signer exited (${code}): ${stderr.slice(0, 500)}`));
        else for (const p of signer.pending.values()) p.reject(new Error("isolated signer exited"));
      });
      rl.on("line", (line) => {
        const msg = JSON.parse(line) as {
          ready?: boolean;
          publicKey?: string;
          id?: number;
          signature?: string;
          error?: string;
        };
        if (msg.ready && msg.publicKey) {
          signer = new IsolatedSigner(child, msg.publicKey, opts.allowedPurposes);
          resolve(signer);
          return;
        }
        const p = msg.id === undefined ? undefined : signer?.pending.get(msg.id);
        if (!p || msg.id === undefined) return;
        signer?.pending.delete(msg.id);
        if (msg.signature) p.resolve(msg.signature);
        else p.reject(new Error(msg.error ?? "signer error"));
      });
    });
  }

  sign(purpose: SigningPurpose, payload: CanonicalValue): Promise<string> {
    if (this.child.exitCode !== null) fail("INTERNAL", "isolated signer is not running");
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ id, purpose, payload: toTypedJson(payload) })}\n`);
    });
  }

  close(): void {
    this.child.stdin.end();
    this.child.kill();
  }
}
