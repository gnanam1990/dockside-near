export interface UsdcRow {
  check: string;
  expected: string;
  actual: string;
  status: "PASS" | "FAIL" | "ERROR";
  link?: string;
}
export const USDC_EVIDENCE: string;
export const USDC_RPC: string[];
export function loadUsdcEvidence(root: string): any;
export function panicCode(status: unknown): string | null;
export function summariseUsdcTx(
  result: any,
  escrow: string,
  token: string,
): {
  signer: string;
  receiver: string;
  actions: string[];
  txStatus: "SuccessValue" | "Failure";
  finality: string;
  failedCodes: string[];
  logCodes: string[];
  ftTransfers: { receiver: string; amount: string; outcome: string }[];
};
export function verifyUsdc(
  evidence: any,
  options?: { rpc?: string[]; fetch?: typeof fetch; concurrency?: number; timeoutMs?: number },
): Promise<{ rows: UsdcRow[]; rpcCalls: number }>;
