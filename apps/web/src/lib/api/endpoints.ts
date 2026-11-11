/**
 * Endpoint catalog. `implemented` entries match services/api/src/app.ts route for route
 * (checked by apps/web/test/endpoints.test.ts against the live router). `planned` entries
 * follow TDD §15 and UI-SPEC §3 and are wired by M03–M07/M08b; the client still calls them,
 * and the UI renders the backend's real "no such endpoint" answer as an explicit
 * unavailable state rather than inventing data.
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

  /* Planned (TDD §15): wired when the owning module lands. */
  listTrades: e("listTrades", "GET", "/v1/trades", true, "planned", "M04/M07"),
  createTrade: e("createTrade", "POST", "/v1/trades", true, "planned", "M04/M07"),
  getTrade: e("getTrade", "GET", "/v1/trades/:id", true, "planned", "M04/M07"),
  tradeEvidence: e("tradeEvidence", "GET", "/v1/trades/:id/evidence", true, "planned", "M03"),
  tradeHolds: e("tradeHolds", "GET", "/v1/trades/:id/holds", true, "planned", "M03"),
  tradeRelease: e("tradeRelease", "GET", "/v1/trades/:id/release", true, "planned", "M04"),
  tradePayout: e("tradePayout", "GET", "/v1/trades/:id/payout", true, "planned", "M05/M06"),
  tradeRefund: e("tradeRefund", "GET", "/v1/trades/:id/refund", true, "planned", "M02/M05"),
  tradeTimeline: e("tradeTimeline", "GET", "/v1/trades/:id/timeline", true, "planned", "M07"),
  listInspections: e("listInspections", "GET", "/v1/inspections", true, "planned", "M03"),
  listPayouts: e("listPayouts", "GET", "/v1/payouts", true, "planned", "M05"),
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
