import type { AuthContext } from "@dockside/authority";
import type { z } from "zod";

export interface HandlerInput {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  ctx: AuthContext | null;
  presentedSessionToken: string | undefined;
}

export type Handler = (req: HandlerInput) => unknown;

export interface Route {
  method: "GET" | "POST";
  pattern: RegExp;
  auth: boolean;
  schema?: z.ZodType;
  /** Route-specific request body limit (defaults to MAX_BODY_BYTES). */
  maxBody?: number;
  /**
   * Top-level result fields that are one-time secrets: returned to the caller once and never
   * persisted, so an Idempotency-Key replay omits them.
   */
  oneTimeFields?: readonly string[];
  handler: Handler;
}

/** Build a route. `:name` segments accept only Dockside identifiers (`[a-z]{2,8}_[0-9a-f]{32}`). */
export function route(
  method: Route["method"],
  path: string,
  auth: boolean,
  schema: z.ZodType | undefined,
  handler: Handler,
  opts: { maxBody?: number; oneTimeFields?: readonly string[] } = {},
): Route {
  const pattern = new RegExp(`^${path.replace(/:([a-zA-Z]+)/g, "(?<$1>[a-z]{2,8}_[0-9a-f]{32})")}$`);
  let base: Route =
    schema === undefined ? { method, pattern, auth, handler } : { method, pattern, auth, schema, handler };
  if (opts.maxBody !== undefined) base = { ...base, maxBody: opts.maxBody };
  if (opts.oneTimeFields !== undefined) base = { ...base, oneTimeFields: opts.oneTimeFields };
  return base;
}
