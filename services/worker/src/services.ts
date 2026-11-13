import type { IsolatedSigner } from "@dockside/authority";
import { toTypedJson } from "@dockside/core";
import type { EvidenceService, HoldService } from "@dockside/evidence";
import type { EscrowContract, FunctionCall } from "@dockside/near";
import type { Database } from "@dockside/store";
import type { RelayResult } from "./submit.js";

/**
 * ManifestAttestor and deterministic-policy services on a real chain (M43). Each service key lives
 * in its own isolated signer child process (`IsolatedSigner`, seed file read only by that child) and
 * may sign only its PoP challenge and its one purpose. A service acts only for trades whose agreed
 * terms bind exactly its public key (the administrator enrolled it in the web app with a proof of
 * possession). The same loops drive the local stack (scripts/local-stack/stack.ts) over the
 * simulated chain; here they submit with the relayer's function-call key.
 */

export interface ServiceLoopDeps {
  readonly db: Database;
  readonly evidence: EvidenceService;
  readonly holds: HoldService;
  readonly escrow: EscrowContract;
  readonly attestor: IsolatedSigner | null;
  readonly policy: IsolatedSigner | null;
  readonly submit: (call: FunctionCall) => Promise<RelayResult>;
  readonly log: (line: Record<string, string | number | null>) => void;
}

export class ServiceLoops {
  private readonly evaluated = new Map<string, string>();
  private readonly lastError = new Map<string, string>();
  private running = false;

  constructor(private readonly d: ServiceLoopDeps) {}

  private trades(): string[] {
    return this.d.db.all("SELECT trade_id FROM evidence_trades").map((r) => String(r["trade_id"]));
  }

  /** The attestor attests each complete manifest it is bound to and keeps the chain current. */
  private async attest(t: string): Promise<void> {
    const signer = this.d.attestor;
    if (!signer) return;
    const terms = this.d.evidence.terms(t);
    if (terms.manifestAttestor.publicKey !== signer.publicKey) return;
    if (this.d.evidence.evaluate(t).status !== "COMPLETE") return;
    if ((await this.d.escrow.getTrade(t)) === null) return;
    let att = this.d.evidence.currentAttestation(t);
    if (!att) att = await this.d.evidence.attest(t, signer);
    const onChain = await this.d.escrow.getEvidence(t);
    if (onChain.current?.digest === att.manifestDigest) return;
    const res = await this.d.submit(this.d.escrow.submitManifestAttestationCall(t, att.typed, att.signature));
    this.d.log({ event: "attestor.submitted", tradeId: t, outcome: res.outcome, txHash: res.txHash });
  }

  /** The deterministic-policy service evaluates its rules when a trade's evidence state changes. */
  private async policy(t: string): Promise<void> {
    const signer = this.d.policy;
    if (!signer) return;
    const terms = this.d.evidence.terms(t);
    if (terms.policySetter.publicKey !== signer.publicKey) return;
    const key = `${this.d.evidence.currentInspection(t)?.digest ?? "-"}|${this.d.evidence.currentAcceptedManifestDigest(t) ?? "-"}`;
    if (this.evaluated.get(t) === key) return;
    if ((await this.d.escrow.getTrade(t)) === null) return;
    for (const h of await this.d.holds.applyDeterministicPolicy(t, signer)) {
      const res = await this.d.submit(
        this.d.escrow.setHoldCall(t, toTypedJson(h.setPayload), h.setSignature),
      );
      this.d.log({
        event: "policy.hold_set",
        tradeId: t,
        ruleId: h.ruleId,
        outcome: res.outcome,
        txHash: res.txHash,
      });
    }
    this.evaluated.set(t, key);
  }

  /** One pass over every trade. Never overlaps itself; errors are logged as codes only. */
  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const t of this.trades()) {
        for (const [name, step] of [
          ["attestor", (x: string) => this.attest(x)],
          ["policy", (x: string) => this.policy(x)],
        ] as const) {
          try {
            await step(t);
          } catch (e) {
            // Logged once per trade and failure (the loop retries every tick).
            const code = (e as { code?: string }).code ?? "INTERNAL";
            const detail = JSON.stringify((e as { details?: unknown }).details ?? null);
            const k = `${name}|${t}`;
            if (this.lastError.get(k) === `${code}|${detail}`) continue;
            this.lastError.set(k, `${code}|${detail}`);
            this.d.log({
              event: `${name}.error`,
              tradeId: t,
              code,
              message: (e as Error).message ?? null,
              detail,
            });
          }
        }
      }
    } finally {
      this.running = false;
    }
  }
}
