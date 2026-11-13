import type { RowStatus } from "./verify.mjs";
export interface ReceiptRow {
  id: string;
  title: string;
  expected: string;
  actual: string;
  status: RowStatus;
  link?: string;
  detail?: string;
  txHash?: string;
}
export interface ReceiptFacts {
  tradeId: string;
  network: string;
  contractId: string;
  codeHash?: string;
  buyer?: string;
  supplier?: string;
  payoutDestination?: string;
  termsDigest?: string;
  tradeAmount?: string;
  amount?: string;
  amountText?: string;
  asset?: Record<string, unknown>;
  assetText?: string;
  inspection?: { decision: string; reasonCodes: string[]; digest: string; recordedAt: number } | null;
  release?: {
    intentId: string;
    state: string;
    amount: string;
    destination: string;
    approvedAt: number | null;
    paidAt: number | null;
  };
  tx?: { hash: string; signer: string; source: "link" | "manifest"; link?: string };
}
export interface ReceiptResult {
  state: "NOT_DEPLOYED" | "CHECKED";
  rows: ReceiptRow[];
  summary: { total: number; pass: number; fail: number; error: number };
  block: { height: number; hash: string; timestampMs: number } | null;
  facts: ReceiptFacts | null;
  rpcCalls: number;
}
export interface ReceiptSubject {
  tradeId: string;
  txHash?: string;
  signer?: string;
}
export interface ReceiptLocation extends ReceiptSubject {
  network: "testnet" | "mainnet";
}
export function assetText(asset: unknown): string;
export function parseReceiptLocation(href: string): ReceiptLocation | null;
export function receiptLink(origin: string, where: ReceiptSubject & { network?: string }): string;
export function receiptVerdict(result: ReceiptResult): "PASS" | "FAIL" | "NOT_DEPLOYED";
export function verifyReceipt(
  network: unknown,
  subject: ReceiptSubject,
  options?: { fetch?: typeof fetch; timeoutMs?: number },
): Promise<ReceiptResult>;
