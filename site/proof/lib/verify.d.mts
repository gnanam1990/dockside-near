export type RowStatus = "PASS" | "FAIL" | "ERROR";
export interface ProofRow {
  id: string;
  group: string;
  title: string;
  expected: string;
  actual: string;
  status: RowStatus;
  link?: string;
  detail?: string;
  txHash?: string;
}
export interface ProofSummary {
  total: number;
  pass: number;
  fail: number;
  error: number;
}
export interface ProofResult {
  state: "NOT_DEPLOYED" | "CHECKED";
  rows: ProofRow[];
  summary: ProofSummary;
  block: { height: number; hash: string; timestampMs: number } | null;
  config: Record<string, unknown> | null;
  trades: { tradeId: string; kind: string; evidence: string; ledger: unknown; trade: unknown }[];
  rpcCalls: number;
}
export interface VerifyOptions {
  fetch?: typeof fetch;
  downloadCode?: boolean;
  concurrency?: number;
  timeoutMs?: number;
}
export const PASS: "PASS";
export const FAIL: "FAIL";
export const ERROR: "ERROR";
export function formatNear(yocto: string | bigint): string;
export function checkConservation(ledger: unknown): {
  ok: boolean;
  problems: string[];
  funded: string | null;
  equation: string;
};
export function summarise(rows: ProofRow[]): ProofSummary;
export function verdict(result: ProofResult): "PASS" | "FAIL" | "NOT_DEPLOYED";
// biome-ignore lint/suspicious/noExplicitAny: a manifest network is plain JSON
export function verifyNetwork(network: any, options?: VerifyOptions): Promise<ProofResult>;
