import type { KeyObject } from "node:crypto";
import type { FunctionCall, NearAction, TxOutcome } from "@dockside/near";

export declare const NEAR: bigint;
export interface Key {
  readonly privateKey: KeyObject;
  readonly publicKey: string;
  secret(): string;
}
export interface Signer {
  readonly accountId: string;
  readonly publicKey: string;
  readonly privateKey: KeyObject;
}
export interface Sandbox {
  readonly name: string;
  readonly rpcUrl: string;
  readonly chainId: string;
  readonly root: Signer & Key;
  logs(): string;
  stop(): unknown;
}
export interface ProductChain {
  readonly accounts: { escrow: string; relayer: string; buyer: string; supplier: string };
  readonly txs: Record<string, string>;
  readonly relayerKeyFile: string;
  readonly relayerFullKeyFile: string;
  readonly buyerKeyFile: string;
  readonly relayerFcPublicKey: string;
}
export declare function newKey(): Key;
export declare function writeKeyFile(path: string, accountId: string, key: Key): string;
export declare function keyFromFile(path: string): Signer;
export declare function startSandbox(o: {
  name: string;
  port: number;
  root?: string;
  balance?: bigint;
}): Promise<Sandbox>;
export declare function sendTx(
  rpcUrl: string,
  signer: Signer,
  receiverId: string,
  actions: NearAction[],
): Promise<{ txHash: string; outcome: TxOutcome }>;
export declare function walletCall(
  rpcUrl: string,
  signer: Signer,
  call: FunctionCall,
): Promise<{ txHash: string; outcome: TxOutcome }>;
export declare function prepareProductChain(
  sb: Sandbox,
  o: { wasm: string; dir: string },
): Promise<ProductChain>;
