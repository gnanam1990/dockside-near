export type QrEcc = "L" | "M" | "Q" | "H";
export interface QrCode {
  version: number;
  ecc: QrEcc;
  size: number;
  mask: number;
  modules: boolean[][];
}
export function encodeQr(text: string, options?: { ecc?: QrEcc }): QrCode;
export function qrPathData(qr: QrCode): string;
