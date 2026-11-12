import { TableScroller } from "../../components/Data";
import { Callout } from "../../components/States";
import { StatusBadge } from "../../components/Status";
import type { OrganizationAttestor } from "../../lib/api/trade";
import { useTrade } from "./common";

const ROLE_LABEL: Record<string, string> = {
  buyer: "Buyer approver",
  supplier: "Supplier signer",
  inspector: "Named inspector",
  riskResolver: "Risk/policy resolver",
  manifestAttestor: "ManifestAttestor",
  policySetter: "Deterministic policy",
};

/**
 * Rotation, revocation and recovery never change a trade silently. When any authority this
 * revision binds is no longer its current usable key (M01 bindingStatus, served on the trade
 * projection), every tab says so and names the role and the reason.
 */
export function AuthorityRevisionCallout() {
  const t = useTrade();
  const a = t.p.authority;
  if (!a?.requiresNewRevision) return null;
  return (
    <Callout
      tone="negative"
      icon="superseded"
      title="A new trade revision is required"
      role="alert"
      testId="authority-revision"
    >
      <p>
        Revision r{t.p.trade.revision} binds authority that was rotated, revoked or recovered. Evidence
        attestation, inspection, holds and release under this revision are refused until both parties accept a
        new trade revision that binds current keys; nothing was changed on this trade silently.
      </p>
      <ul className="checklist">
        {a.issues.map((i) => (
          <li key={`${i.role}-${i.code}`} data-role={i.role} data-issue={i.code}>
            <strong>{ROLE_LABEL[i.role] ?? i.role}</strong>:{" "}
            <StatusBadge
              dimension="bindingIssue"
              value={i.code}
              source="authority bindingStatus on GET /v1/trades/:id"
              observedAt={t.receivedAt}
            />
          </li>
        ))}
      </ul>
      <p className="small">
        Creating that revision (renewed keys, then fresh evidence, inspection and release authority) is not
        served by this API build; see the Agreement tab for the revision this trade binds.
      </p>
    </Callout>
  );
}

/**
 * The viewer organization's ManifestAttestor enrollments as the trade sees them: which one this
 * revision binds, at which key version, and whether its enrolled scope covers this trade. Another
 * organization's enrollments are never served.
 */
export function OrganizationAttestorsTable({
  attestors,
  boundKeyVersion,
}: {
  attestors: OrganizationAttestor[];
  boundKeyVersion: number;
}) {
  const t = useTrade();
  if (attestors.length === 0)
    return (
      <p data-testid="org-attestors-none">
        Your organization has no ManifestAttestor enrollment; only the buyer organization's attestor can be
        bound.
      </p>
    );
  return (
    <TableScroller label="Your organization's ManifestAttestor enrollments">
      <table data-testid="org-attestors">
        <caption>Your organization's ManifestAttestor enrollments and this revision</caption>
        <thead>
          <tr>
            <th scope="col">Service</th>
            <th scope="col">Bound by this revision</th>
            <th scope="col">Key version</th>
            <th scope="col">Scope</th>
          </tr>
        </thead>
        <tbody>
          {attestors.map((x) => {
            const versionNote = x.boundByRevision
              ? x.activeKeyVersion === boundKeyVersion
                ? `bound v${boundKeyVersion} is the active version`
                : `wrong key version: revision binds v${boundKeyVersion}, active is ${x.activeKeyVersion === null ? "none" : `v${x.activeKeyVersion}`}`
              : x.activeKeyVersion === null
                ? "no active version"
                : `active v${x.activeKeyVersion}`;
            return (
              <tr
                key={x.enrollmentId}
                data-enrollment={x.enrollmentId}
                data-bound={x.boundByRevision ? "yes" : "no"}
                data-coverage={x.coverage}
              >
                <td>
                  <code className="wrap">{x.serviceId}</code>
                  <br />
                  <span className="mono small wrap">{x.enrollmentId}</span>
                  <br />
                  <StatusBadge
                    dimension="enrollmentStatus"
                    value={x.status}
                    source="authority enrollment"
                    observedAt={t.receivedAt}
                    compact
                  />
                </td>
                <td>
                  {x.boundByRevision
                    ? "Yes: the only attestor whose signatures this revision accepts"
                    : "No: wrong attestor for this revision; its attestations are refused here"}
                </td>
                <td className="small">{versionNote}</td>
                <td>
                  <StatusBadge
                    dimension="attestorCoverage"
                    value={x.coverage}
                    source="enrolled scope vs this trade"
                    observedAt={t.receivedAt}
                  />
                  <span className="small">
                    {" "}
                    ({x.scope.tradeId ? `trade ${x.scope.tradeId}` : "every trade"},{" "}
                    {x.scope.evidencePolicyId} r{x.scope.evidencePolicyRevision})
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableScroller>
  );
}
