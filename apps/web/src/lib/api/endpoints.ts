/**
 * Endpoint catalog. `implemented` entries match services/api/src/app.ts route for route
 * (checked by apps/web/test/endpoints.test.ts against the live router). `planned` entries
 * are routes the router does not serve yet; the client still calls them, and the UI renders the
 * backend's real "no such endpoint" answer as an explicit unavailable state rather than
 * inventing data. Since M07 every TDD §15 trade route is served; a backend without escrow/RPC
 * configuration answers those routes with "no such endpoint" (TRADE_MODULES_NOT_CONFIGURED).
 */
export type Availability = "implemented" | "planned";

export interface EndpointSpec {
  readonly id: string;
  readonly method: "GET" | "POST";
  /** Path template; `:name` segments must match `[a-z]{2,8}_[0-9a-f]{32}`. */
  readonly path: string;
  readonly auth: boolean;
  readonly availability: Availability;
  /** Module that owns the backend side. */
  readonly owner: string;
}

const e = (
  id: string,
  method: EndpointSpec["method"],
  path: string,
  auth: boolean,
  availability: Availability,
  owner: string,
): EndpointSpec => ({ id, method, path, auth, availability, owner });

export const ENDPOINTS = {
  health: e("health", "GET", "/healthz", false, "implemented", "M01"),
  ready: e("ready", "GET", "/readyz", false, "implemented", "M01"),
  bootstrapChallenge: e(
    "bootstrapChallenge",
    "POST",
    "/v1/bootstrap/challenges",
    false,
    "implemented",
    "M01",
  ),
  bootstrapComplete: e("bootstrapComplete", "POST", "/v1/bootstrap/complete", false, "implemented", "M01"),
  loginChallenge: e("loginChallenge", "POST", "/v1/sessions/challenges", false, "implemented", "M01"),
  loginComplete: e("loginComplete", "POST", "/v1/sessions/complete", false, "implemented", "M01"),
  me: e("me", "GET", "/v1/me", true, "implemented", "M01"),
  createInvitation: e("createInvitation", "POST", "/v1/invitations", true, "implemented", "M01"),
  invitationChallenge: e(
    "invitationChallenge",
    "POST",
    "/v1/invitations/challenges",
    false,
    "implemented",
    "M01",
  ),
  acceptInvitation: e("acceptInvitation", "POST", "/v1/invitations/accept", false, "implemented", "M01"),
  grantInvitation: e("grantInvitation", "POST", "/v1/invitations/:id/grant", true, "implemented", "M01"),
  grantCapability: e(
    "grantCapability",
    "POST",
    "/v1/principals/:id/capabilities",
    true,
    "implemented",
    "M01",
  ),
  revokeKey: e("revokeKey", "POST", "/v1/keys/:id/revoke", true, "implemented", "M01"),
  rotationChallenge: e(
    "rotationChallenge",
    "POST",
    "/v1/keys/rotation/challenges",
    true,
    "implemented",
    "M01",
  ),
  rotationComplete: e("rotationComplete", "POST", "/v1/keys/rotation/complete", true, "implemented", "M01"),
  startRecovery: e("startRecovery", "POST", "/v1/recoveries", true, "implemented", "M01"),
  proveRecovery: e("proveRecovery", "POST", "/v1/recoveries/prove", false, "implemented", "M01"),
  completeRecovery: e("completeRecovery", "POST", "/v1/recoveries/:id/complete", true, "implemented", "M01"),
  recoveryCancelChallenge: e(
    "recoveryCancelChallenge",
    "POST",
    "/v1/recoveries/:id/cancel-challenges",
    false,
    "implemented",
    "M01",
  ),
  cancelRecovery: e("cancelRecovery", "POST", "/v1/recoveries/cancel", false, "implemented", "M01"),
  createServiceEnrollment: e(
    "createServiceEnrollment",
    "POST",
    "/v1/service-enrollments",
    true,
    "implemented",
    "M01",
  ),
  proveServiceKey: e("proveServiceKey", "POST", "/v1/service-enrollments/prove", false, "implemented", "M01"),
  activateServiceKey: e(
    "activateServiceKey",
    "POST",
    "/v1/service-enrollments/:id/activate",
    true,
    "implemented",
    "M01",
  ),
  rotateServiceKey: e(
    "rotateServiceKey",
    "POST",
    "/v1/service-enrollments/:id/rotate",
    true,
    "implemented",
    "M01",
  ),
  recoverServiceKey: e(
    "recoverServiceKey",
    "POST",
    "/v1/service-enrollments/:id/recover",
    true,
    "implemented",
    "M01",
  ),
  revokeServiceKey: e(
    "revokeServiceKey",
    "POST",
    "/v1/service-enrollments/:id/revoke",
    true,
    "implemented",
    "M01",
  ),
  getServiceEnrollment: e(
    "getServiceEnrollment",
    "GET",
    "/v1/service-enrollments/:id",
    true,
    "implemented",
    "M01",
  ),
  audit: e("audit", "GET", "/v1/audit", true, "implemented", "M01"),

  /* M07 integrated trade, evidence, hold, release, journal and audit surface. */
  listTrades: e("listTrades", "GET", "/v1/trades", true, "implemented", "M07"),
  createTrade: e("createTrade", "POST", "/v1/trades", true, "implemented", "M07"),
  registerEvidencePolicy: e(
    "registerEvidencePolicy",
    "POST",
    "/v1/evidence-policies",
    true,
    "implemented",
    "M07",
  ),
  getTrade: e("getTrade", "GET", "/v1/trades/:id", true, "implemented", "M07"),
  syncTrade: e("syncTrade", "POST", "/v1/trades/:id/sync", true, "implemented", "M07"),
  tradeAttestor: e("tradeAttestor", "GET", "/v1/trades/:id/attestor", true, "implemented", "M07"),
  tradeEvidence: e("tradeEvidence", "GET", "/v1/trades/:id/evidence", true, "implemented", "M07"),
  uploadEvidence: e("uploadEvidence", "POST", "/v1/trades/:id/evidence", true, "implemented", "M07"),
  recordInspection: e("recordInspection", "POST", "/v1/trades/:id/inspections", true, "implemented", "M07"),
  listInspections: e("listInspections", "GET", "/v1/inspections", true, "implemented", "M07"),
  tradeHolds: e("tradeHolds", "GET", "/v1/trades/:id/holds", true, "implemented", "M07"),
  holdSetChallenge: e(
    "holdSetChallenge",
    "POST",
    "/v1/trades/:id/hold-challenges",
    true,
    "implemented",
    "M07",
  ),
  setHold: e("setHold", "POST", "/v1/trades/:id/holds", true, "implemented", "M07"),
  requestHoldResolution: e(
    "requestHoldResolution",
    "POST",
    "/v1/holds/:id/resolution-requests",
    true,
    "implemented",
    "M07",
  ),
  holdResolutionChallenge: e(
    "holdResolutionChallenge",
    "POST",
    "/v1/holds/:id/resolution-challenges",
    true,
    "implemented",
    "M07",
  ),
  resolveHold: e("resolveHold", "POST", "/v1/holds/:id/resolution", true, "implemented", "M07"),
  tradeRelease: e("tradeRelease", "GET", "/v1/trades/:id/release", true, "implemented", "M07"),
  prepareReleaseIntent: e(
    "prepareReleaseIntent",
    "POST",
    "/v1/trades/:id/release-intents",
    true,
    "implemented",
    "M07",
  ),
  signReleaseIntent: e(
    "signReleaseIntent",
    "POST",
    "/v1/release-intents/:id/signature",
    true,
    "implemented",
    "M07",
  ),
  approvalChallenge: e(
    "approvalChallenge",
    "POST",
    "/v1/release-intents/:id/approval-challenges",
    true,
    "implemented",
    "M07",
  ),
  approveRelease: e("approveRelease", "POST", "/v1/release-intents/:id/approval", true, "implemented", "M07"),
  executeRelease: e("executeRelease", "POST", "/v1/release-intents/:id/execute", true, "implemented", "M07"),
  cancelChallenge: e(
    "cancelChallenge",
    "POST",
    "/v1/release-intents/:id/cancel-challenges",
    true,
    "implemented",
    "M07",
  ),
  cancelConsentChallenge: e(
    "cancelConsentChallenge",
    "POST",
    "/v1/release-intents/:id/cancel-consent-challenges",
    true,
    "implemented",
    "M07",
  ),
  cancelConsent: e(
    "cancelConsent",
    "POST",
    "/v1/release-intents/:id/cancel-consents",
    true,
    "implemented",
    "M07",
  ),
  cancelConsentRevocationChallenge: e(
    "cancelConsentRevocationChallenge",
    "POST",
    "/v1/release-intents/:id/cancel-consent-revocation-challenges",
    true,
    "implemented",
    "M07",
  ),
  cancelConsentRevocation: e(
    "cancelConsentRevocation",
    "POST",
    "/v1/release-intents/:id/cancel-consent-revocations",
    true,
    "implemented",
    "M07",
  ),
  abandonChallenge: e(
    "abandonChallenge",
    "POST",
    "/v1/release-intents/:id/abandon-challenges",
    true,
    "implemented",
    "M07",
  ),
  abandonRelease: e("abandonRelease", "POST", "/v1/release-intents/:id/abandon", true, "implemented", "M07"),
  destinationChange: e(
    "destinationChange",
    "GET",
    "/v1/trades/:id/destination-change",
    true,
    "implemented",
    "M09",
  ),
  destinationChangeChallenge: e(
    "destinationChangeChallenge",
    "POST",
    "/v1/trades/:id/destination-change-challenges",
    true,
    "implemented",
    "M09",
  ),
  destinationConsent: e(
    "destinationConsent",
    "POST",
    "/v1/trades/:id/destination-consents",
    true,
    "implemented",
    "M09",
  ),
  destinationRevocationChallenge: e(
    "destinationRevocationChallenge",
    "POST",
    "/v1/trades/:id/destination-revocation-challenges",
    true,
    "implemented",
    "M09",
  ),
  destinationRevocation: e(
    "destinationRevocation",
    "POST",
    "/v1/trades/:id/destination-revocations",
    true,
    "implemented",
    "M09",
  ),
  destinationActivation: e(
    "destinationActivation",
    "POST",
    "/v1/trades/:id/destination-activation",
    true,
    "implemented",
    "M09",
  ),
  destinationBinding: e(
    "destinationBinding",
    "POST",
    "/v1/trades/:id/destination-binding",
    true,
    "implemented",
    "M09",
  ),
  tradePayout: e("tradePayout", "GET", "/v1/trades/:id/payout", true, "implemented", "M07"),
  tradeRefund: e("tradeRefund", "GET", "/v1/trades/:id/refund", true, "implemented", "M07"),
  tradeTimeline: e("tradeTimeline", "GET", "/v1/trades/:id/timeline", true, "implemented", "M07"),
  listPayouts: e("listPayouts", "GET", "/v1/payouts", true, "implemented", "M07"),
  auditExport: e("auditExport", "GET", "/v1/trades/:id/audit-export", true, "implemented", "M07"),
  getOperation: e("getOperation", "GET", "/v1/operations/:id", true, "implemented", "M07"),
  requestReconciliation: e(
    "requestReconciliation",
    "POST",
    "/v1/operations/:id/reconciliation-requests",
    true,
    "implemented",
    "M07",
  ),
  requestAdjudication: e(
    "requestAdjudication",
    "POST",
    "/v1/operations/:id/adjudication-requests",
    true,
    "implemented",
    "M07",
  ),
  operationSourceHint: e(
    "operationSourceHint",
    "POST",
    "/v1/operations/:id/source-hints",
    true,
    "implemented",
    "M07",
  ),
  freezeTrade: e("freezeTrade", "POST", "/v1/trades/:id/freeze", true, "implemented", "M07"),
  proposeTrade: e("proposeTrade", "POST", "/v1/trade-proposals", true, "implemented", "M08"),
  reviewTradeProposal: e(
    "reviewTradeProposal",
    "POST",
    "/v1/trade-proposals/review",
    true,
    "implemented",
    "M08",
  ),
  tradeEvidencePolicy: e(
    "tradeEvidencePolicy",
    "GET",
    "/v1/trades/:id/evidence-policy",
    true,
    "implemented",
    "M08",
  ),
  inspectionChallenge: e(
    "inspectionChallenge",
    "POST",
    "/v1/trades/:id/inspection-challenges",
    true,
    "implemented",
    "M08",
  ),
} as const satisfies Record<string, EndpointSpec>;

export type EndpointId = keyof typeof ENDPOINTS;

const ID_SEGMENT = /^[a-z]{2,8}_[0-9a-f]{32}$/;

/** Fill `:name` segments; refuses identifiers that the API router would not accept. */
export function buildPath(spec: EndpointSpec, params: Record<string, string> = {}): string {
  return spec.path.replace(/:([a-zA-Z]+)/g, (_m, name: string) => {
    const v = params[name];
    if (v === undefined || !ID_SEGMENT.test(v)) throw new Error(`invalid identifier for :${name}`);
    return v;
  });
}

export function isApiIdentifier(v: string): boolean {
  return ID_SEGMENT.test(v);
}
