import type { ReactNode } from "react";
import { useApp } from "../app/app-context";
import { Link } from "../app/router";
import type { ApiFailure } from "../lib/api/client";
import { ENDPOINTS, type EndpointSpec } from "../lib/api/endpoints";
import { formatAge, formatUtc } from "../lib/format";
import type { IconName } from "../lib/status";
import { StatusIcon } from "./Icon";

type CalloutTone = "neutral" | "warning" | "negative" | "unknown";

export function Callout({
  tone,
  icon,
  title,
  children,
  headingLevel = 2,
  role,
  testId,
}: {
  tone: CalloutTone;
  icon: IconName;
  title: string;
  children?: ReactNode;
  headingLevel?: 2 | 3;
  role?: "status" | "alert";
  testId?: string;
}) {
  const H = headingLevel === 2 ? "h2" : "h3";
  return (
    <div className={`callout callout--${tone}`} role={role} data-testid={testId}>
      <StatusIcon name={icon} />
      <div>
        <H>{title}</H>
        {children}
      </div>
    </div>
  );
}

/** Skeleton that reserves shape but contains no values. */
export function LoadingState({ what, refreshing = false }: { what: string; refreshing?: boolean }) {
  return (
    <div className="panel" aria-busy="true" data-testid="state-loading">
      <p className="muted" role="status">
        {refreshing ? `Refreshing ${what} from the API…` : `Loading ${what} from the API…`}
      </p>
      <div className="skeleton" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Callout tone="neutral" icon="not-run" title={title} testId="state-empty">
      {children}
    </Callout>
  );
}

function ownerOf(path: string, method: string): EndpointSpec | undefined {
  return (Object.values(ENDPOINTS) as EndpointSpec[]).find(
    (e) => e.method === method && new RegExp(`^${e.path.replace(/:[a-zA-Z]+/g, "[^/]+")}$`).test(path),
  );
}

/** Renders exactly what went wrong, from the API's own answer. */
export function FailureState({
  failure,
  what,
  onRetry,
  headingLevel = 2,
}: {
  failure: ApiFailure;
  what: string;
  onRetry?: () => void;
  headingLevel?: 2 | 3;
}) {
  const retry = onRetry ? (
    <p>
      <button type="button" className="btn" onClick={onRetry}>
        Try loading again
      </button>
    </p>
  ) : null;
  switch (failure.kind) {
    case "endpoint-unavailable": {
      const spec = ownerOf(failure.path, failure.method);
      return (
        <Callout
          tone="neutral"
          icon="not-run"
          title={`${what}: not available in this backend build`}
          headingLevel={headingLevel}
          testId="state-unavailable"
        >
          <p>
            The API answered <code>no such endpoint</code> for{" "}
            <code>
              {failure.method} {failure.path}
            </code>
            {spec ? ` (owned by ${spec.owner}).` : "."} No {what.toLowerCase()} data is shown because none was
            returned.
          </p>
        </Callout>
      );
    }
    case "no-session":
      return (
        <Callout
          tone="warning"
          icon="blocked"
          title="Sign in required"
          headingLevel={headingLevel}
          testId="state-signin"
        >
          <p>
            {what} is only served to an authenticated proof-of-possession session.{" "}
            <Link href="/sign-in">Sign in or create an organization</Link>.
          </p>
        </Callout>
      );
    case "network":
      return (
        <Callout
          tone="negative"
          icon="disconnected"
          title={`${what}: API unreachable`}
          headingLevel={headingLevel}
          testId="state-network"
        >
          <p>The request did not reach the Dockside API ({failure.message}). Nothing was changed.</p>
          {retry}
        </Callout>
      );
    case "invalid-response":
      return (
        <Callout
          tone="unknown"
          icon="unknown"
          title={`${what}: unsupported response`}
          headingLevel={headingLevel}
          testId="state-unsupported"
        >
          <p>{failure.message}. The client shows nothing rather than guess.</p>
          {retry}
        </Callout>
      );
    case "refused-to-sign":
      return (
        <Callout
          tone="negative"
          icon="blocked"
          title="Signature withheld"
          headingLevel={headingLevel}
          role="alert"
          testId="state-refused"
        >
          <p>{failure.reason}</p>
        </Callout>
      );
    case "http": {
      if (failure.status === 401)
        return (
          <Callout
            tone="warning"
            icon="blocked"
            title="Session not accepted"
            headingLevel={headingLevel}
            testId="state-unauthenticated"
          >
            <p>
              The server refused the session ({failure.code}: {failure.message}).{" "}
              <Link href="/sign-in">Sign in again</Link>.
            </p>
          </Callout>
        );
      if (failure.status === 403)
        return (
          <Callout
            tone="warning"
            icon="blocked"
            title="Permission denied"
            headingLevel={headingLevel}
            testId="state-forbidden"
          >
            <p>
              The server refused this for your session ({failure.code}: {failure.message}). Your role does not
              include this action; nothing is shown or changed.
            </p>
          </Callout>
        );
      if (failure.code === "LIMIT_EXCEEDED")
        return (
          <Callout tone="negative" icon="limit" title="Resource limit exceeded" headingLevel={headingLevel}>
            <p>{failure.message}</p>
          </Callout>
        );
      return (
        <Callout
          tone="negative"
          icon="failed"
          title={`${what}: request failed`}
          headingLevel={headingLevel}
          testId="state-error"
        >
          <p>
            HTTP {failure.status} {failure.code}: {failure.message}
          </p>
          {retry}
        </Callout>
      );
    }
  }
}

/** Sticky banner for stale/disconnected data, with exact staleness and a reconnect action. */
export function ConnectionBanner() {
  const { connection, now, reconnect } = useApp();
  if (connection.status !== "DISCONNECTED" && connection.status !== "STALE") return null;
  const since =
    connection.lastOkAt === null
      ? "No authoritative answer has been received in this session."
      : `Last authoritative answer ${formatUtc(connection.lastOkAt)} (${formatAge(connection.lastOkAt, now)}).`;
  return (
    <div className="banner" data-testid={`banner-${connection.status.toLowerCase()}`}>
      <Callout
        tone={connection.status === "DISCONNECTED" ? "negative" : "warning"}
        icon={connection.status === "DISCONNECTED" ? "disconnected" : "stale"}
        title={
          connection.status === "DISCONNECTED" ? "Disconnected from the Dockside API" : "Data may be stale"
        }
        role="status"
      >
        <p>
          {since} Data on screen is frozen as last received
          {connection.status === "DISCONNECTED" ? " and actions that change state are disabled." : "."}
        </p>
        <button type="button" className="btn" onClick={() => void reconnect()}>
          Reconnect
        </button>
      </Callout>
    </div>
  );
}

export function BlockedAction({ reason }: { reason: string }) {
  return (
    <p className="field__help" data-testid="blocked-reason">
      <StatusIcon name="blocked" /> {reason}
    </p>
  );
}
