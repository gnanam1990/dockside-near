export interface AttackDef {
  id: string;
  title: string;
  method: string;
  expect: string;
  what: string;
}
export declare const ATTACKS: AttackDef[];
export interface JudgedAttempt {
  signer: string | null;
  receiver: string | null;
  method: string | null;
  signerOk: boolean;
  receiverOk: boolean;
  methodOk: boolean;
  ranOnEscrow: boolean;
  final: boolean;
  refused: boolean;
  code: string | null;
  message: string | null;
  blockers: string[];
  rawError: string | null;
  blockHash: string | null;
}
export declare function judgeAttempt(
  tx: unknown,
  o: { escrow: string; signer?: string; method?: string },
): JudgedAttempt;
export interface FundsRow {
  id: string;
  label: string;
  expected: bigint;
  actual: bigint;
  ok: boolean;
}
export declare function fundsState(
  config: Record<string, unknown>,
  read: { ledger: unknown; release: unknown; holds: unknown },
): {
  rows: FundsRow[];
  payoutDestination: string | null;
  intentState: string | null;
  holdStatus: string[];
  blockers: string[];
  checks: Record<string, boolean>;
  unchanged: boolean;
};
export declare function attemptCount(accessKey: unknown, config: Record<string, unknown>): bigint | null;
export declare function keyScope(
  accessKey: unknown,
  config: Record<string, unknown>,
): {
  functionCallOnly: boolean;
  receiver: string | null;
  restrictedToEscrow: boolean;
  allowanceYocto: string | null;
};
export declare function explorerTx(config: Record<string, unknown>, txHash: string): string;
export declare function formatNear(yocto: bigint | string): string;
export declare function recordedFor(
  config: Record<string, unknown>,
  attackId: string,
): { attack: string; txHash: string; signer?: string; code: string | null } | null;
