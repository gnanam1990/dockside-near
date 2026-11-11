import { type FormEvent, useRef, useState } from "react";
import { useApiData, useApp, useMutationGate } from "../../app/app-context";
import { AddressDisplay, IdentityList, TableScroller } from "../../components/Data";
import { Field } from "../../components/Forms";
import { SignedAction } from "../../components/SignedAction";
import { BlockedAction, Callout, FailureState } from "../../components/States";
import { StatusBadge } from "../../components/Status";
import type { ApiFailure } from "../../lib/api/client";
import type { HoldWithRequests, ManifestItem, SlotPolicy } from "../../lib/api/trade";
import { formatUtc } from "../../lib/format";
import { issuanceValue, signPrepared } from "../../lib/signing";
import { Section, useTrade } from "./common";

const RECOVERY: Record<string, string> = {
  MISSING: "Upload a current item from an allowed uploader, signed by an allowed issuer.",
  UNDERFILLED: "Upload more current items until the slot minimum is met.",
  STALE: "Upload a replacement; the attestor then signs the new manifest revision.",
  FILLED: "No action needed. Replacing an item creates a new manifest revision and needs a new attestation.",
};

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

type UploadPhase =
  | { k: "idle" }
  | { k: "working"; step: string }
  | { k: "done"; revision: number; itemId: string }
  | { k: "conflict"; message: string }
  | { k: "failed"; failure: ApiFailure };

/** Standard file control, per-file progress, cancel, compare-and-swap on the visible manifest revision. */
function UploadForm({
  slot,
  manifestRevision,
  current,
  onUploaded,
}: {
  slot: SlotPolicy;
  manifestRevision: number;
  current: ManifestItem | undefined;
  onUploaded: () => void;
}) {
  const app = useApp();
  const t = useTrade();
  const gate = useMutationGate();
  const caps = app.me?.capabilities ?? [];
  const issuerCaps = slot.issuerCapabilities.filter((c) => caps.includes(c as never));
  const [file, setFile] = useState<File | null>(null);
  const [issuer, setIssuer] = useState(issuerCaps[0] ?? "");
  const [phase, setPhase] = useState<UploadPhase>({ k: "idle" });
  const abort = useRef<AbortController | null>(null);
  const fid = `upload-${slot.slotId}`;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const s = app.client.getSession();
    if (!file || !s) return;
    const ctl = new AbortController();
    abort.current = ctl;
    try {
      setPhase({ k: "working", step: `Reading ${file.name} (${file.size} bytes)…` });
      const content = new Uint8Array(await file.arrayBuffer());
      setPhase({ k: "working", step: "Computing the original digest and signing the issuance statement…" });
      const issuedAt = Date.now() - 60_000;
      const iss = await issuanceValue({
        tradeId: t.tradeId,
        slotId: slot.slotId,
        content,
        issuedAt,
        issuerPrincipalId: s.grant.principalId,
        issuerKeyVersionId: s.grant.keyVersionId,
        issuerCapability: issuer,
      });
      const signature = await signPrepared(
        { purpose: "EVIDENCE_ISSUANCE", value: iss.value, digestHex: "", serverDigestHex: null },
        s.privateKey,
      );
      if (ctl.signal.aborted) return setPhase({ k: "idle" });
      setPhase({ k: "working", step: `Uploading against manifest revision ${manifestRevision}…` });
      const out = await t.api.call<{ manifestRevision: number; itemId: string }>("uploadEvidence", {
        params: { id: t.tradeId },
        body: {
          slotId: slot.slotId,
          contentBase64: toBase64(content),
          ...(file.type ? { declaredMime: file.type } : {}),
          issuer: { capability: issuer, issuedAt, signature },
          ...(current ? { replacesItemId: current.itemId } : {}),
          expectedManifestRevision: manifestRevision,
        },
        signal: ctl.signal,
      });
      if (!out.ok) {
        if (out.error.kind === "network" && ctl.signal.aborted) return setPhase({ k: "idle" });
        if (out.error.kind === "http" && out.error.code === "VERSION_CONFLICT") {
          setPhase({
            k: "conflict",
            message: `Another upload changed the manifest after revision ${manifestRevision} (${out.error.message}). Your file is still selected; review the refreshed slots and upload again.`,
          });
          onUploaded();
          return;
        }
        return setPhase({ k: "failed", failure: out.error });
      }
      setPhase({ k: "done", revision: out.data.manifestRevision, itemId: out.data.itemId });
      onUploaded();
    } finally {
      abort.current = null;
    }
  };

  if (issuerCaps.length === 0)
    return (
      <BlockedAction
        reason={`Only a principal holding ${slot.issuerCapabilities.join(" or ")} can issue this slot; your session holds ${caps.join(", ") || "no capability"}.`}
      />
    );
  return (
    <form className="upload" onSubmit={(e) => void submit(e)} aria-labelledby={`${fid}-title`}>
      <h5 id={`${fid}-title`}>{current ? "Replace the current item" : "Upload an item"}</h5>
      <p className="small">
        Allowed: {slot.allowedMime.join(", ")}; at most {slot.maxItemBytes.toLocaleString("en-US")} bytes per
        item. Stored content-addressed; visible to the trade's parties, inspector and risk resolver. Retention
        follows the organisation's policy.
      </p>
      <Field id={`${fid}-file`} label={`File for ${slot.slotId}`} help="Use the file chooser; nothing is read until you upload.">
        {(aria) => (
          <input
            {...aria}
            type="file"
            accept={slot.allowedMime.join(",")}
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              if (phase.k !== "working") setPhase({ k: "idle" });
            }}
          />
        )}
      </Field>
      <Field id={`${fid}-issuer`} label="Issue as" help="The capability you sign the issuance statement with.">
        {(aria) => (
          <select {...aria} value={issuer} onChange={(e) => setIssuer(e.target.value)}>
            {issuerCaps.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        )}
      </Field>
      <div className="btn-row">
        <button type="submit" className="btn btn--primary" disabled={!file || !gate.allowed || phase.k === "working"}>
          {current ? `Replace item in ${slot.slotId}` : `Upload to ${slot.slotId}`}
        </button>
        {phase.k === "working" ? (
          <button type="button" className="btn" onClick={() => abort.current?.abort()}>
            Cancel upload
          </button>
        ) : null}
      </div>
      <p role="status" data-testid={`${fid}-status`}>
        {phase.k === "working" ? phase.step : null}
        {phase.k === "done" ? `Recorded as ${phase.itemId}; manifest is now revision ${phase.revision}.` : null}
      </p>
      {phase.k === "conflict" ? (
        <Callout tone="warning" icon="stale" title="Manifest changed while you were uploading" headingLevel={3} role="alert">
          <p>{phase.message}</p>
        </Callout>
      ) : null}
      {phase.k === "failed" ? <FailureState failure={phase.failure} what="Upload" headingLevel={3} /> : null}
    </form>
  );
}

function ItemFacts({ item }: { item: ManifestItem }) {
  const issuer = item["issuer"] as { principalId?: string; capability?: string; issuedAt?: number } | undefined;
  const uploader = item["uploader"] as { principalId?: string; capability?: string } | undefined;
  const derived = (item["derived"] as { artifactClass: string; digest: string; sourceDigest: string }[] | undefined) ?? [];
  return (
    <IdentityList
      items={[
        ["Item", <code key="i">{item.itemId}</code>],
        ["Version", `v${item.version}${item.predecessorItemId ? `, replaces ${item.predecessorItemId}` : ""}`],
        ["Detected content", `${item.detectedMime} (${item.contentClass}), ${item.byteLength} bytes`],
        ["Original digest", <code key="d" className="wrap">{item.originalDigest}</code>],
        [
          "Derived artifacts",
          derived.length
            ? derived.map((x) => `${x.artifactClass} ${x.digest.slice(0, 16)}… from ${x.sourceDigest.slice(0, 16)}…`).join("; ")
            : "None",
        ],
        ["Uploader", `${uploader?.principalId ?? "?"} as ${uploader?.capability ?? "?"}`],
        [
          "Issuer",
          `${issuer?.principalId ?? "?"} as ${issuer?.capability ?? "?"}, issued ${issuer?.issuedAt ? formatUtc(issuer.issuedAt) : "?"}`,
        ],
        ["Fresh until", item.freshUntil ? formatUtc(item.freshUntil) : "No freshness bound"],
      ]}
    />
  );
}

function HoldsPanel({ holds, onChange }: { holds: HoldWithRequests[]; onChange: () => void }) {
  const t = useTrade();
  const isBuyer = t.has("BUYER");
  const isRisk = t.has("RISK_RESOLVER");
  const [note, setNote] = useState("");
  const [requestState, setRequestState] = useState<string | null>(null);
  const [code, setCode] = useState("RELEASE_HOLD");
  const [ttlMin, setTtlMin] = useState("120");
  const [holdReason, setHoldReason] = useState("RISK_REVIEW");
  return (
    <section aria-labelledby="holds-title" data-testid="holds-panel">
      <h3 id="holds-title">HoldRecords</h3>
      <p className="small">
        A hold blocks release while ACTIVE and also after expiry (EXPIRED_UNRESOLVED). Only the trade's
        separately authenticated risk/policy resolver can sign a resolution; deterministic policy can only SET.
      </p>
      {holds.length === 0 ? <p>No HoldRecord exists for this trade (source: hold journal and contract).</p> : null}
      {holds.map((h) => (
        <article key={h.holdId} className="hold" data-testid="hold" data-status={h.status} aria-labelledby={`h-${h.holdId}`}>
          <h4 id={`h-${h.holdId}`}>
            Hold <code>{h.holdId}</code>
          </h4>
          <StatusBadge dimension="holdState" value={h.status} source="hold journal (contract-verified)" observedAt={t.receivedAt} />
          <IdentityList
            items={[
              [
                "Set by",
                h.issuerRole === "POLICY_SETTER"
                  ? `Deterministic policy (rule ${h.ruleId ?? "?"}) — cannot resolve`
                  : "Risk/policy resolver",
              ],
              ["Reason", h.reasonCode],
              ["Manifest binding", h.manifestDigest ? <code key="m" className="wrap">{h.manifestDigest}</code> : "Not bound to a manifest"],
              ["Issued", formatUtc(h.issuedAt)],
              ["Expires", `${formatUtc(h.expiresAt)} (expiry does not clear the hold)`],
              ["SET digest", <code key="s" className="wrap">{h.setDigest}</code>],
              [
                "Resolution",
                h.resolution
                  ? `${h.resolution.code}, signed ${formatUtc(h.resolution.resolvedAt)} (digest ${h.resolution.digest.slice(0, 16)}…)`
                  : "Not resolved. Requires a signature from the trade's bound risk/policy resolver.",
              ],
              [
                "Resolution requests",
                h.resolutionRequests.length
                  ? h.resolutionRequests
                      .map((q) => `${q.requestedBy} at ${formatUtc(q.createdAt)} (non-authorizing)`)
                      .join("; ")
                  : "None",
              ],
            ]}
          />
          {h.status !== "RESOLVED" && isBuyer ? (
            <form
              className="request"
              onSubmit={(e) => {
                e.preventDefault();
                void (async () => {
                  setRequestState("Sending…");
                  const out = await t.api.call<{ holdStatus: string }>("requestHoldResolution", {
                    params: { id: h.holdId },
                    body: { note },
                  });
                  setRequestState(
                    out.ok
                      ? `Request recorded. It does not authorize anything; the hold is still ${out.data.holdStatus}.`
                      : `Request refused: ${out.error.kind === "http" ? out.error.message : out.error.kind}.`,
                  );
                  if (out.ok) {
                    setNote("");
                    onChange();
                  }
                })();
              }}
            >
              <h5>Request resolution (buyer, non-authorizing)</h5>
              <Field id={`note-${h.holdId}`} label="Message to the risk/policy resolver" help="Up to 500 characters. Stored as a digest only.">
                {(aria) => <textarea {...aria} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}
              </Field>
              <button type="submit" className="btn">
                Request resolution
              </button>
              <p role="status">{requestState}</p>
            </form>
          ) : null}
          {(h.status !== "RESOLVED" || t.pinned(`resolve-${h.holdId}`)) && isRisk ? (
            <SignedAction
              id={`resolve-${h.holdId}`}
              onBusyChange={t.busy(`resolve-${h.holdId}`)}
              title="Resolve hold (risk/policy signature)"
              consequence="Your signature resolves this HoldRecord on the contract. Any existing buyer approval becomes stale; a fresh intent and approval are needed."
              startLabel="Prepare resolution"
              signLabel="Sign resolution"
              prepare={() =>
                t.api.call("holdResolutionChallenge", {
                  params: { id: h.holdId },
                  body: {
                    resolutionCode: code,
                    evidenceDigest: t.p.attestation?.manifestDigest ?? t.p.evidence.manifestDigest,
                  },
                })
              }
              record={(payload, signature) =>
                t.api.call("resolveHold", { params: { id: h.holdId }, body: { payload, signature } })
              }
              onDone={onChange}
            >
              <Field id={`code-${h.holdId}`} label="Resolution" help="Bound into the signed resolution.">
                {(aria) => (
                  <select {...aria} value={code} onChange={(e) => setCode(e.target.value)}>
                    <option value="RELEASE_HOLD">RELEASE_HOLD — release may proceed</option>
                    <option value="RETRY_INSPECTION">RETRY_INSPECTION — inspector must decide again</option>
                    <option value="RESOLVE_TO_REFUND">RESOLVE_TO_REFUND — refund path</option>
                  </select>
                )}
              </Field>
            </SignedAction>
          ) : null}
        </article>
      ))}
      {isRisk ? (
        <SignedAction
          id="set-hold"
          title="Set a hold (risk/policy)"
          consequence="Your signature places a HoldRecord on the contract; release is blocked until a signed resolution."
          startLabel="Prepare hold"
          signLabel="Sign hold"
          prepare={() =>
            t.api.call("holdSetChallenge", {
              params: { id: t.tradeId },
              body: { reasonCode: holdReason, ttlMs: Math.max(1, Number(ttlMin) || 1) * 60_000 },
            })
          }
          record={(payload, signature) =>
            t.api.call("setHold", { params: { id: t.tradeId }, body: { payload, signature } })
          }
          onDone={onChange}
        >
          <Field id="hold-reason" label="Hold reason code" help="Uppercase code bound into the HoldRecord.">
            {(aria) => (
              <input
                {...aria}
                className="mono"
                value={holdReason}
                onChange={(e) => setHoldReason(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""))}
              />
            )}
          </Field>
          <Field id="hold-ttl" label="Hold lifetime (minutes)" help="After this time the hold reads EXPIRED_UNRESOLVED and still blocks release.">
            {(aria) => <input {...aria} inputMode="numeric" className="mono" value={ttlMin} onChange={(e) => setTtlMin(e.target.value.replace(/[^0-9]/g, ""))} />}
          </Field>
        </SignedAction>
      ) : null}
      {!isRisk ? (
        <p className="small" data-testid="no-resolver-ui">
          Resolution signing is not offered to your session: only the trade's bound risk/policy resolver may sign.
        </p>
      ) : null}
    </section>
  );
}

function InspectorWorkbench({ onChange }: { onChange: () => void }) {
  const t = useTrade();
  const [decision, setDecision] = useState<"PASS" | "FAIL" | "REVIEW">("PASS");
  const [reason, setReason] = useState("DOCS_MATCH");
  const att = t.p.attestation;
  const ready = t.p.evidence.status === "COMPLETE" && att?.status === "CURRENT";
  return (
    <section aria-labelledby="inspect-title" data-testid="inspector-workbench">
      <h3 id="inspect-title">Inspector workbench</h3>
      <IdentityList
        items={[
          ["Milestone", t.p.trade.milestone.description],
          ["Policy", `${t.p.evidence.policy.id} revision ${t.p.evidence.policy.revision}`],
          ["Manifest", `revision ${t.p.evidence.manifestRevision} (${t.p.evidence.status})`],
          ["Attested manifest", att ? <code key="a" className="wrap">{att.manifestDigest}</code> : "Not attested"],
          [
            "Prior decision",
            t.p.inspection ? `${t.p.inspection.decision} over ${t.p.inspection.manifestDigest.slice(0, 16)}…` : "None",
          ],
          ["Active holds", String(t.p.holds.blocking)],
        ]}
      />
      <SignedAction
        id="inspect"
        title="Sign inspection decision"
        consequence={`Your signature records ${decision} over the current attested manifest; it is relayed to the contract. A FAIL or REVIEW can trigger a deterministic-policy hold.`}
        startLabel="Prepare inspection"
        signLabel="Sign inspection"
        disabledReason={ready ? null : "Signing is disabled until the manifest is complete and its attestation is current."}
        prepare={() =>
          t.api.call("inspectionChallenge", {
            params: { id: t.tradeId },
            body: { decision, reasonCodes: [reason] },
          })
        }
        record={(payload, signature) =>
          t.api.call("recordInspection", { params: { id: t.tradeId }, body: { payload, signature } })
        }
        onDone={onChange}
      >
        <fieldset>
          <legend>Decision</legend>
          {(["PASS", "FAIL", "REVIEW"] as const).map((d) => (
            <label key={d} className="radio">
              <input type="radio" name="decision" value={d} checked={decision === d} onChange={() => setDecision(d)} />
              {d}
            </label>
          ))}
        </fieldset>
        <Field id="inspect-reason" label="Reason code" help="Uppercase letters, digits and underscores.">
          {(aria) => (
            <input
              {...aria}
              className="mono"
              value={reason}
              onChange={(e) => setReason(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""))}
            />
          )}
        </Field>
      </SignedAction>
    </section>
  );
}

export function EvidenceTab() {
  const t = useTrade();
  const ev = useApiData(() => t.api.evidence(t.tradeId), [t.tradeId, t.tick]);
  const pol = useApiData(() => t.api.policy(t.tradeId), [t.tradeId]);
  const holds = useApiData(() => t.api.holds(t.tradeId), [t.tradeId, t.tick]);
  const att = useApiData(() => t.api.attestor(t.tradeId), [t.tradeId, t.tick]);
  const changed = () => t.refresh();
  return (
    <>
      <Section what="evidence policy and manifest" state={ev.state} outcome={ev.outcome} reload={ev.reload}>
        {(e) => (
          <Section what="evidence policy" state={pol.state} outcome={pol.outcome} reload={pol.reload}>
            {(p) => (
              <section aria-labelledby="slots-title">
                <h3 id="slots-title">
                  EvidencePolicy {p.policy.policyId} revision {p.policy.revision}: slot checklist
                </h3>
                <p>
                  Manifest revision <span className="tabular">{e.manifest.revision}</span>, completeness{" "}
                  <StatusBadge
                    dimension="evidenceState"
                    value={e.evaluation.status}
                    source="evidence service evaluation"
                    observedAt={t.receivedAt}
                    compact
                  />
                  . Policy digest <code className="wrap">{p.digest}</code>.
                </p>
                <ol className="slots">
                  {p.policy.slots.map((s) => {
                    const ev2 = e.evaluation.slots.find((x) => x.slotId === s.slotId);
                    const items = e.manifest.items.filter((i) => i.slotId === s.slotId);
                    const status = ev2?.status ?? "UNSUPPORTED";
                    return (
                      <li key={s.slotId} className="slot" data-testid={`slot-${s.slotId}`} data-status={status}>
                        <h4>{s.slotId}</h4>
                        <StatusBadge dimension="slotStatus" value={status} source="evidence service evaluation" observedAt={t.receivedAt} />
                        <IdentityList
                          items={[
                            ["Purpose", s.purpose],
                            ["Cardinality", `${ev2?.itemCount ?? 0} current of ${s.minItems}–${s.maxItems}`],
                            ["Uploader capabilities", s.uploaderCapabilities.join(", ")],
                            ["Issuer capabilities", s.issuerCapabilities.join(", ")],
                            ["Content", `${s.contentClass}: ${s.allowedMime.join(", ")}`],
                            [
                              "Limits",
                              `${s.maxItemBytes} bytes per item, ${s.maxAggregateBytes} bytes in total; ${Object.entries(s.limits)
                                .map(([k, v]) => `${k} ${v}`)
                                .join(", ")}`,
                            ],
                            ["Required derived", s.requiredDerived.map((d) => `${d.artifactClass} (${d.transformProfile})`).join(", ")],
                            ["Freshness", `${Math.round(s.freshnessMs / 86_400_000)} days from issue; ${ev2?.freshUntil ? `current item fresh until ${formatUtc(ev2.freshUntil)}` : "no current item"}`],
                            ["Replacement", `${s.replacement} (compare-and-swap on the manifest revision)`],
                            ["Recovery", RECOVERY[status] ?? "Unsupported slot status; nothing is inferred."],
                          ]}
                        />
                        {items.map((i) => (
                          <details key={i.itemId}>
                            <summary>
                              Current item <code>{i.itemId}</code>
                            </summary>
                            <ItemFacts item={i} />
                          </details>
                        ))}
                        <UploadForm slot={s} manifestRevision={e.manifest.revision} current={items[0]} onUploaded={changed} />
                      </li>
                    );
                  })}
                </ol>
                <h4>Manifest history</h4>
                <TableScroller label="Manifest history">
                  <table>
                    <caption>Manifest revisions and replacements (append-only)</caption>
                    <thead>
                      <tr>
                        <th scope="col">Entry</th>
                        <th scope="col">Facts</th>
                      </tr>
                    </thead>
                    <tbody>
                      {e.history.map((h, i) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: append-only history has no other key
                        <tr key={i}>
                          <td className="tabular">{i + 1}</td>
                          <td className="mono wrap small">
                            {Object.entries(h)
                              .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
                              .join(" ")}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableScroller>
              </section>
            )}
          </Section>
        )}
      </Section>
      <section aria-labelledby="att-title" data-testid="attestation-panel">
        <h3 id="att-title">ManifestAttestation</h3>
        {t.p.attestation ? (
          <>
            <StatusBadge
              dimension="attestationStatus"
              value={t.p.attestation.status}
              source="evidence service (contract-equivalent verification)"
              observedAt={t.receivedAt}
            />
            <IdentityList
              items={[
                ["Manifest revision", String(t.p.attestation.manifestRevision)],
                ["Manifest digest", <code key="m" className="wrap">{t.p.attestation.manifestDigest}</code>],
                ["Attestation digest", <code key="d" className="wrap">{t.p.attestation.digest}</code>],
                ["Expires", formatUtc(t.p.attestation.expiresAt)],
              ]}
            />
          </>
        ) : (
          <p data-testid="attestation-none">
            No current attestation. The bound ManifestAttestor signs only a complete manifest; any replacement or
            stale slot requires a new attestation.
          </p>
        )}
        <Section what="attestor binding" state={att.state} outcome={att.outcome} reload={att.reload}>
          {(a) => (
            <IdentityList
              items={[
                ["Service", `${a.binding.serviceId} (${a.binding.enrollmentId})`],
                ["Key version", String(a.binding.keyVersion)],
                ["Public key", <code key="k" className="wrap">{a.binding.publicKey}</code>],
                ["Capability", "MANIFEST_ATTEST, isolated signer custody (secret never shown)"],
                [
                  "Binding issues",
                  a.issues.length
                    ? a.issues.map((i) => `${i.code}: a new trade revision is required`).join("; ")
                    : "None: the revision's bound key is active",
                ],
              ]}
            />
          )}
        </Section>
      </section>
      <section aria-labelledby="advisory-title" className="advisory">
        <h3 id="advisory-title">Advisory analysis</h3>
        <p>
          <strong>This analysis cannot create or clear a payment hold.</strong> No advisory findings are served by
          this API build; when present they appear here with source references and model version only.
        </p>
      </section>
      <Section what="holds" state={holds.state} outcome={holds.outcome} reload={holds.reload}>
        {(h) => <HoldsPanel holds={h.holds} onChange={changed} />}
      </Section>
      {t.has("INSPECTOR") ? <InspectorWorkbench onChange={changed} /> : null}
    </>
  );
}
