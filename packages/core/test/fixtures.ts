/**
 * Test fixture builders. These construct *inputs* (trade terms with freshly generated
 * keys); they never stand in for a system under test.
 */
import { generateEd25519KeyPair, randomIds } from "../src/index.js";

export function makeTermsJson(): Record<string, unknown> {
  const k = () => generateEd25519KeyPair().publicKey;
  const buyerOrg = randomIds.next("org");
  const tradeId = randomIds.next("trd");
  return {
    schemaVersion: 1,
    profileVersion: "dockside-direct-testnet-v1",
    tradeId,
    revision: 1,
    predecessorDigest: null,
    network: "near-testnet",
    escrowContractId: "dockside-escrow.testnet",
    buyer: {
      organizationId: buyerOrg,
      principalId: randomIds.next("prn"),
      keyVersionId: randomIds.next("key"),
      publicKey: k(),
      accountId: "acme-buyer.testnet",
    },
    supplier: {
      organizationId: randomIds.next("org"),
      principalId: randomIds.next("prn"),
      keyVersionId: randomIds.next("key"),
      publicKey: k(),
      accountId: "harbor-supplier.testnet",
    },
    asset: { kind: "NEAR_NATIVE", network: "near-testnet" },
    amountYocto: "2500000000000000000000000",
    milestone: { id: "shipment-1", description: "Container MSCU1234565 loaded and inspected — café grade A" },
    evidencePolicy: { id: "commercial-docs", revision: 1, digest: "ab".repeat(32) },
    inspector: {
      principalId: randomIds.next("prn"),
      keyVersionId: randomIds.next("key"),
      publicKey: k(),
      attestationSchema: "dockside/inspection-attestation@1",
    },
    manifestAttestor: {
      enrollmentId: randomIds.next("svc"),
      serviceId: "manifest-attestor",
      keyVersion: 1,
      publicKey: k(),
      capability: "MANIFEST_ATTEST",
      scope: {
        organizationId: buyerOrg,
        tradeId: null,
        evidencePolicyId: "commercial-docs",
        evidencePolicyRevision: 1,
      },
      attestationSchema: "dockside/manifest-attestation@1",
    },
    policySetter: {
      enrollmentId: randomIds.next("svc"),
      serviceId: "deterministic-policy",
      keyVersion: 1,
      publicKey: k(),
      capability: "DETERMINISTIC_POLICY_SET",
      scope: {
        organizationId: buyerOrg,
        tradeId,
        evidencePolicyId: "commercial-docs",
        evidencePolicyRevision: 1,
      },
      attestationSchema: "dockside/hold-set@1",
    },
    riskResolver: { principalId: randomIds.next("prn"), keyVersionId: randomIds.next("key"), publicKey: k() },
    payout: {
      network: "near-testnet",
      recipientType: "NEAR_ACCOUNT",
      destination: "harbor-supplier.testnet",
    },
    refundPolicy: { id: "dockside-refund-v1", revision: 1 },
    delayPolicy: { destinationChangeDelayMs: 86_400_000 },
    expiresAt: 1_900_000_000_000,
  };
}

/** Deep clone with every object's keys in a caller-chosen order. */
export function reorderKeys(v: unknown, order: (keys: string[]) => string[]): unknown {
  if (Array.isArray(v)) return v.map((x) => reorderKeys(x, order));
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of order(Object.keys(o))) out[key] = reorderKeys(o[key], order);
    return out;
  }
  return v;
}

export function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
