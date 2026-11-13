export function base58Encode(bytes: Uint8Array): string;
export function hexToBytes(hex: string): Uint8Array;
export function bytesToHex(bytes: Uint8Array): string;
export function base64ToBytes(b64: string): Uint8Array;
export function sha256Hex(bytes: Uint8Array): Promise<string>;
