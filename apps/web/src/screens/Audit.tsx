import { type ReactNode, useMemo, useState } from "react";
import { useApiData, useApp } from "../app/app-context";
import { PageHeader } from "../components/AppShell";
import { TableScroller } from "../components/Data";
import { Field } from "../components/Forms";
import { Callout, EmptyState, FailureState, LoadingState } from "../components/States";
import { StatusBadge } from "../components/Status";
import { formatUtc } from "../lib/format";

const LIMIT = 500;

export function AuditScreen() {
  const app = useApp();
  const signedIn = app.sessionGrant !== null;
  const { state, outcome, reload } = useApiData(signedIn ? () => app.client.audit(LIMIT) : null, [
    signedIn,
    app.sessionGrant?.sessionId,
  ]);
  const [type, setType] = useState("");
  const [actor, setActor] = useState("");

  const events = outcome?.ok ? outcome.data.events : [];
  const types = useMemo(() => [...new Set(events.map((e) => e.eventType))].sort(), [events]);
  const visible = events.filter(
    (e) => (!type || e.eventType === type) && (!actor || (e.actorPrincipalId ?? "").includes(actor.trim())),
  );
  const hidden = events.length - visible.length;

  let body: ReactNode;
  if (!signedIn) body = <FailureState failure={{ kind: "no-session" }} what="Audit history" />;
  else if (state === "loading" || !outcome) body = <LoadingState what="audit events" />;
  else if (!outcome.ok) body = <FailureState failure={outcome.error} what="Audit history" onRetry={reload} />;
  else if (events.length === 0)
    body = (
      <EmptyState title="No audit events">
        <p>The API returned no events for your organization.</p>
      </EmptyState>
    );
  else
    body = (
      <>
        <search className="filters" aria-label="Filter audit events">
          <Field id="audit-type" label="Action">
            {(aria) => (
              <select {...aria} value={type} onChange={(e) => setType(e.target.value)}>
                <option value="">All actions</option>
                {types.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field id="audit-actor" label="Actor principal contains">
            {(aria) => (
              <input
                {...aria}
                type="search"
                className="mono"
                value={actor}
                onChange={(e) => setActor(e.target.value)}
              />
            )}
          </Field>
          <button type="button" className="btn" onClick={reload}>
            Refresh
          </button>
        </search>
        <p role="status" data-testid="audit-count">
          Showing {visible.length} of {events.length} loaded events
          {hidden > 0 ? `; ${hidden} hidden by filters` : ""}. Loaded {formatUtc(outcome.receivedAt)} from GET
          /v1/audit (limit {LIMIT}).
        </p>
        <TableScroller label="Audit events">
          <table data-testid="audit-table">
            <caption>Append-only audit events, oldest first</caption>
            <thead>
              <tr>
                <th scope="col">Seq</th>
                <th scope="col">Action</th>
                <th scope="col">Actor</th>
                <th scope="col">Object</th>
                <th scope="col">Observed</th>
                <th scope="col">Recorded</th>
                <th scope="col">Source</th>
                <th scope="col">Event digest</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((e) => (
                <tr key={e.id}>
                  <td className="tabular">{e.seq}</td>
                  <td>{e.eventType}</td>
                  <td className="mono">{e.actorPrincipalId ?? "unauthenticated"}</td>
                  <td className="mono">
                    {e.subjectType} {e.subjectId}
                  </td>
                  <td className="mono">{formatUtc(e.observedAt)}</td>
                  <td className="mono">{formatUtc(e.recordedAt)}</td>
                  <td>{e.source}</td>
                  <td className="mono">{e.eventHash}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroller>
      </>
    );

  return (
    <>
      <PageHeader
        title="Audit"
        description="Immutable, hash-chained event history of your organization, as recorded by the API."
      />
      {body}
      <section className="panel" aria-labelledby="export-title">
        <h2 id="export-title">Export</h2>
        <StatusBadge
          dimension="productGate"
          value="NOT_RUN"
          source="this backend build"
          observedAt={null}
          reason="Audit export with a manifest digest is served by the integrated API (M07); export generation and any product verdict are separate states."
        />
      </section>
      <Callout tone="neutral" icon="locked" title="About this history" headingLevel={2}>
        <p>
          Events are appended in the same transaction as the change they record. Filters only narrow what is
          shown; the count above always states how many loaded events are hidden.
        </p>
      </Callout>
    </>
  );
}
