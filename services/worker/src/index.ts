import type { OutboxWorker, Reconciler } from "@dockside/journal";

/**
 * Worker loop over the M05 journal: deliver due outbox rows, then reconcile due operations, on a
 * fixed interval. All authority stays in the journal (fenced leases, database-enforced state
 * machine, contract re-checks); the loop only schedules. Errors are logged as codes, never with
 * payloads, and the next tick retries.
 */
export interface WorkerLoopDeps {
  readonly worker: OutboxWorker;
  readonly reconciler: Reconciler;
  readonly intervalMs: number;
  readonly log?: (line: Record<string, string | number | null>) => void;
}

export interface TickResult {
  readonly delivered: string[];
  readonly reconciled: string[];
}

export class WorkerLoop {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<TickResult> | null = null;
  private stopped = false;

  constructor(private readonly deps: WorkerLoopDeps) {
    if (!Number.isSafeInteger(deps.intervalMs) || deps.intervalMs < 10)
      throw new Error("worker interval must be at least 10 ms");
  }

  /** One delivery pass and one reconciliation pass. Never overlaps itself. */
  async tick(): Promise<TickResult> {
    if (this.running) return this.running;
    this.running = (async () => {
      try {
        const delivered = await this.deps.worker.runOnce();
        const reconciled = await this.deps.reconciler.runOnce();
        if (delivered.length || reconciled.length)
          this.deps.log?.({
            event: "worker.tick",
            delivered: delivered.length,
            reconciled: reconciled.length,
          });
        return { delivered, reconciled };
      } catch (e) {
        this.deps.log?.({ event: "worker.error", code: (e as { code?: string }).code ?? "INTERNAL" });
        return { delivered: [], reconciled: [] };
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    const loop = () => {
      void this.tick().finally(() => {
        if (!this.stopped) this.timer = setTimeout(loop, this.deps.intervalMs);
      });
    };
    this.timer = setTimeout(loop, 0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.running) await this.running;
  }
}
