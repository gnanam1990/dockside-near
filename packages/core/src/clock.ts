import { randomBytes } from "node:crypto";
import { fail } from "./errors.js";

/** Time abstraction: all authority decisions read time through a Clock, never Date.now() directly. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = Object.freeze({ now: () => Date.now() });

/**
 * Deterministic clock for tests and replay tooling. It isolates time only; it never
 * fabricates authority state. Clearly test/support code.
 */
export class ManualClock implements Clock {
  constructor(private t: number) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    if (ms < 0) fail("VALIDATION_FAILED", "clock cannot move backwards");
    this.t += ms;
  }
  set(ms: number): void {
    this.t = ms;
  }
}

/** ID abstraction: `<prefix>_<32 lowercase hex>` from 128 bits of CSPRNG output. */
export interface IdGenerator {
  next(prefix: IdPrefix): string;
}

export const ID_PREFIXES = {
  organization: "org",
  principal: "prn",
  keyVersion: "key",
  challenge: "chl",
  session: "ses",
  invitation: "inv",
  roleGrant: "grt",
  serviceEnrollment: "svc",
  recovery: "rec",
  auditEvent: "aud",
  trade: "trd",
  refundIntent: "rfd",
  hold: "hld",
  evidenceItem: "evi",
  manifestAttestation: "mat",
  inspection: "ins",
  finding: "fnd",
  holdResolutionRequest: "hrq",
  correlation: "cor",
  releaseIntent: "rli",
  releaseEvent: "rle",
  releaseSignature: "rsg",
  economicOperation: "eop",
  outbox: "obx",
  observation: "obs",
  operationTransition: "otr",
  disposition: "dsp",
  incident: "inc",
  operatorRequest: "opr",
} as const;
export type IdPrefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES];

export const randomIds: IdGenerator = Object.freeze({
  next: (prefix: IdPrefix) => `${prefix}_${randomBytes(16).toString("hex")}`,
});
