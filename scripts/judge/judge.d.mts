export interface JudgeRow {
  check: string;
  expected: string;
  actual: string;
  status: "PASS" | "FAIL" | "ERROR" | "SKIP";
  seconds?: number;
  link?: string;
}
export interface JudgeStep {
  name: string;
  run(ctx: { say(line: string): void }): Promise<JudgeRow[]>;
}
export interface JudgeSummary {
  verdict: "PASS" | "FAIL";
  pass: number;
  fail: number;
  error: number;
  skip: number;
  seconds: number;
}
export const STEP_NAMES: string[];
export function parseVitest(
  text: string,
): { files: number; filesFailed: number; passed: number; failed: number; skipped: number } | null;
export function parseCargo(
  text: string,
): { suites: number; passed: number; failed: number; ignored: number } | null;
export function runCommand(
  command: string,
  args: string[],
  options?: { cwd?: string; log?: string },
): Promise<{ status: number; output: string; ms: number }>;
export function renderTable(rows: JudgeRow[], options?: { width?: number }): string;
export function overall(rows: JudgeRow[]): "PASS" | "FAIL";
export function defaultSteps(options?: { manifestPath?: string; codeBytes?: boolean }): JudgeStep[];
export function runJudge(options: {
  steps: JudgeStep[];
  only?: string[];
  skip?: string[];
  out?: (line: string) => void;
  reportFile?: string | null;
}): Promise<{ rows: JudgeRow[]; summary: JudgeSummary }>;
