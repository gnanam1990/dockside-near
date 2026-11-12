/**
 * Real child processes for the process-kill tests (M05, M15). A worker process reports each
 * persistence/effect boundary on stdout; with DS_PAUSE_AT it blocks at that boundary so the test
 * can kill it there with SIGKILL (TerminateProcess on Windows): no handler, no cleanup, no flush.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { expect } from "vitest";

export interface Proc {
  readonly proc: ChildProcess;
  readonly lines: string[];
  until(re: RegExp): Promise<string>;
  exit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const live: ChildProcess[] = [];

/** Kill every process a test left running (afterEach). */
export function killAll(): void {
  for (const p of live) if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
  live.length = 0;
}

export function startProcess(script: string, env: Record<string, string>): Proc {
  const proc = spawn(process.execPath, ["--no-warnings", script], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  live.push(proc);
  const lines: string[] = [];
  const waiters: { re: RegExp; resolve: (l: string) => void }[] = [];
  let buf = "";
  let err = "";
  proc.stdout?.on("data", (d: Buffer) => {
    buf += d.toString("utf8");
    let i = buf.indexOf("\n");
    while (i >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      lines.push(line);
      for (const x of [...waiters])
        if (x.re.test(line)) {
          waiters.splice(waiters.indexOf(x), 1);
          x.resolve(line);
        }
      i = buf.indexOf("\n");
    }
  });
  proc.stderr?.on("data", (d: Buffer) => {
    err += d.toString("utf8");
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) =>
    proc.on("exit", (code, signal) => r({ code, signal })),
  );
  return {
    proc,
    lines,
    until(re) {
      const hit = lines.find((l) => re.test(l));
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        waiters.push({ re, resolve });
        void exited.then((e) =>
          reject(
            new Error(`process exited (${e.code}/${e.signal}) before ${re}: ${lines.join(" | ")} ${err}`),
          ),
        );
      });
    },
    exit: () => exited,
  };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Run a process until it blocks at `boundary`, then kill it there. Returns its stdout lines. */
export async function killAt(
  script: string,
  boundary: string,
  env: Record<string, string>,
): Promise<string[]> {
  const p = startProcess(script, { ...env, DS_PAUSE_AT: boundary });
  await p.until(new RegExp(`^PAUSED ${escape(boundary)} `));
  p.proc.kill("SIGKILL");
  const e = await p.exit();
  // Killed, not exited: no exit code (signal on POSIX) or a non-zero TerminateProcess code.
  expect(e.code === null || e.code !== 0).toBe(true);
  return p.lines;
}

/** Run a fresh process to its stop condition; it must exit 0. */
export async function runToEnd(script: string, env: Record<string, string>): Promise<string[]> {
  const p = startProcess(script, env);
  const e = await p.exit();
  expect(e.code, p.lines.join(" | ")).toBe(0);
  return p.lines;
}
