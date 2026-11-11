import { type ReactNode, useEffect, useRef, useState } from "react";
import { useApp, useMutationGate } from "../app/app-context";
import type { ApiFailure, ApiOutcome } from "../lib/api/client";
import {
  type FunctionCall,
  type Prepared,
  type RelayerStatus,
  type RelayResult,
  relayCall,
  relayerStatus,
} from "../lib/api/trade";
import type { TypedJson } from "../lib/canonical";
import { formatUtc } from "../lib/format";
import { flattenTyped, type PreparedSignature, prepareSignature, signPrepared } from "../lib/signing";
import { AddressDisplay } from "./Data";
import { BlockedAction, Callout, FailureState } from "./States";

let relayerPromise: Promise<RelayerStatus | null> | null = null;

/** Relayer availability, probed once per page load. */
export function useRelayer(): RelayerStatus | null | undefined {
  const [s, setS] = useState<RelayerStatus | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    relayerPromise ??= relayerStatus();
    void relayerPromise.then((r) => {
      if (live) setS(r);
    });
    return () => {
      live = false;
    };
  }, []);
  return s;
}

/** Shows an exact contract call and submits it through the relayer, or says why it cannot. */
export function RelayPanel({
  call,
  onRelayed,
  label,
}: {
  call: FunctionCall;
  onRelayed: (r: RelayResult) => void;
  label: string;
}) {
  const relayer = useRelayer();
  const [state, setState] = useState<"idle" | "sending" | "done" | "failed">("idle");
  const [result, setResult] = useState<RelayResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sent = useRef(false);
  const send = async () => {
    if (sent.current) return;
    sent.current = true;
    setState("sending");
    try {
      const r = await relayCall(call);
      setResult(r);
      setState(r.outcome === "FINAL_SUCCESS" ? "done" : "failed");
      if (r.outcome !== "FINAL_SUCCESS") sent.current = false;
      onRelayed(r);
    } catch (e) {
      sent.current = false;
      setError((e as Error).message);
      setState("failed");
    }
  };
  return (
    <div className="relay" data-testid="relay-panel">
      <h4>Contract call: {label}</h4>
      <dl className="identity">
        <div>
          <dt>Contract</dt>
          <dd className="mono">{call.receiverId}</dd>
        </div>
        <div>
          <dt>Method</dt>
          <dd className="mono">{call.methodName}</dd>
        </div>
        <div>
          <dt>Attached deposit</dt>
          <dd className="mono tabular">{call.depositYocto} yoctoNEAR</dd>
        </div>
      </dl>
      {relayer === undefined ? <p className="muted">Checking for a relayer…</p> : null}
      {relayer === null ? (
        <Callout
          tone="warning"
          icon="blocked"
          title="No relayer is configured"
          headingLevel={3}
          testId="relay-blocked"
        >
          <p>
            This build has no relayer or wallet connector for {call.receiverId}. The signed call above is
            complete; submit it with your own NEAR wallet. Status: BLOCKED until a relayer is provisioned.
          </p>
        </Callout>
      ) : null}
      {relayer ? (
        <>
          <p className="small">
            Relayer <code>{relayer.relayer}</code> on{" "}
            {relayer.chain === "SIMULATED" ? "a simulated chain" : relayer.network}: {relayer.note}
          </p>
          {state !== "done" ? (
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void send()}
              disabled={state === "sending"}
            >
              Submit to the escrow contract
            </button>
          ) : null}
        </>
      ) : null}
      <p role="status" data-testid="relay-status">
        {state === "sending" ? "Submitting the call…" : null}
        {state === "done" && result
          ? `Contract accepted ${result.method} (transaction ${result.txHash}).`
          : null}
        {state === "failed"
          ? `Contract did not accept the call: ${result?.error ?? error ?? result?.outcome ?? "unknown reason"}.`
          : null}
      </p>
    </div>
  );
}

export interface SignedActionProps {
  /** Unique slug for test ids and headings. */
  readonly id: string;
  readonly title: string;
  readonly intro?: ReactNode;
  /** Shown in the review before signing: what the signature does. */
  readonly consequence: string;
  readonly startLabel: string;
  readonly signLabel?: string;
  readonly disabledReason?: string | null;
  readonly prepare: () => Promise<ApiOutcome<Prepared>>;
  /** Record the signature; may return a relay call for the contract. */
  readonly record: (
    payload: TypedJson,
    signature: string,
  ) => Promise<ApiOutcome<{ relay?: FunctionCall } & Record<string, unknown>>>;
  readonly onDone: () => void;
  /** Extra facts shown above the payload in the review. */
  readonly facts?: ReactNode;
  readonly children?: ReactNode;
  /** Called with true when a flow starts and false when it ends, so parents keep it mounted. */
  readonly onBusyChange?: (busy: boolean) => void;
}

type Phase =
  | { k: "idle" }
  | { k: "preparing" }
  | { k: "review"; prepared: Prepared; sig: PreparedSignature }
  | { k: "recording" }
  | { k: "relay"; call: FunctionCall; summary: Record<string, unknown> }
  | { k: "done"; summary: Record<string, unknown> }
  | { k: "failed"; failure: ApiFailure };

/**
 * Prepare (server builds the exact payload), review (browser recomputes the digest and shows the
 * exact fields, actor, expiry and consequence), sign (explicit action), record (server verifies),
 * relay (the contract re-verifies). Nothing is signed automatically.
 */
export function SignedAction(p: SignedActionProps) {
  const app = useApp();
  const gate = useMutationGate();
  const [phase, setPhaseRaw] = useState<Phase>({ k: "idle" });
  const busyCb = useRef(p.onBusyChange);
  busyCb.current = p.onBusyChange;
  const setPhase = (next: Phase) => {
    setPhaseRaw(next);
    // A finished flow stays pinned so its outcome stays visible after the state it changed refreshes.
    busyCb.current?.(next.k !== "idle" && next.k !== "failed");
  };
  const reviewRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (phase.k === "review") reviewRef.current?.focus();
  }, [phase.k]);
  const session = app.client.getSession();
  const disabled = !gate.allowed || Boolean(p.disabledReason) || !session;

  const start = async () => {
    setPhase({ k: "preparing" });
    const out = await p.prepare();
    if (!out.ok) return setPhase({ k: "failed", failure: out.error });
    const sig = await prepareSignature(out.data.purpose, out.data.payload, out.data.digest ?? null);
    if (!sig.ok) return setPhase({ k: "failed", failure: { kind: "refused-to-sign", reason: sig.reason } });
    setPhase({ k: "review", prepared: out.data, sig: sig.value });
  };
  const sign = async (prepared: Prepared, sig: PreparedSignature) => {
    const s = app.client.getSession();
    if (!s) return setPhase({ k: "failed", failure: { kind: "no-session" } });
    setPhase({ k: "recording" });
    const signature = await signPrepared(sig, s.privateKey);
    const out = await p.record(prepared.payload, signature);
    if (!out.ok) return setPhase({ k: "failed", failure: out.error });
    const { relay, ...summary } = out.data;
    if (relay) setPhase({ k: "relay", call: relay, summary });
    else {
      setPhase({ k: "done", summary });
      p.onDone();
    }
  };

  const fields = phase.k === "review" ? flattenTyped(phase.prepared.payload) : [];
  const expires = fields.find(([k]) => k === "expiresAt")?.[1];

  return (
    <section className="action" aria-labelledby={`${p.id}-title`} data-testid={`action-${p.id}`}>
      <h3 id={`${p.id}-title`}>{p.title}</h3>
      {p.intro}
      {p.children}
      {phase.k === "idle" || phase.k === "failed" || phase.k === "done" ? (
        <p>
          <button type="button" className="btn" onClick={() => void start()} disabled={disabled}>
            {phase.k === "done" ? `${p.startLabel} again` : p.startLabel}
          </button>
        </p>
      ) : null}
      {p.disabledReason ? <BlockedAction reason={p.disabledReason} /> : null}
      {!p.disabledReason && gate.reason ? <BlockedAction reason={gate.reason} /> : null}
      {phase.k === "preparing" ? <p role="status">Asking the server for the exact payload…</p> : null}
      {phase.k === "review" ? (
        <div className="review" data-testid={`review-${p.id}`}>
          <h4 tabIndex={-1} ref={reviewRef}>
            Review before signing: {phase.sig.purpose}
          </h4>
          {p.facts}
          <dl className="identity">
            <div>
              <dt>Signing domain</dt>
              <dd className="mono">{phase.sig.purpose}</dd>
            </div>
            <div>
              <dt>Signer</dt>
              <dd className="mono">
                {session?.grant.principalId} (key version {session?.grant.keyVersion},{" "}
                {session?.grant.keyVersionId})
              </dd>
            </div>
            <div>
              <dt>Expiry</dt>
              <dd className="mono">{expires ? formatUtc(Number(expires)) : "No expiry field"}</dd>
            </div>
            <div>
              <dt>Consequence</dt>
              <dd>{p.consequence}</dd>
            </div>
          </dl>
          <h5>Digest recomputed by this browser</h5>
          <AddressDisplay value={phase.sig.digestHex} label="digest" />
          <p className="small">
            {phase.sig.serverDigestHex
              ? "Matches the digest the server reported."
              : "The server did not report a digest; this one was computed from the exact payload below."}
          </p>
          <details>
            <summary>Exact payload fields ({fields.length})</summary>
            <dl className="payload">
              {fields.map(([k, v]) => (
                <div key={k}>
                  <dt className="mono">{k}</dt>
                  <dd className="mono">{v}</dd>
                </div>
              ))}
            </dl>
          </details>
          <div className="btn-row">
            <button type="button" className="btn" onClick={() => setPhase({ k: "idle" })}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void sign(phase.prepared, phase.sig)}
              disabled={!gate.allowed}
            >
              {p.signLabel ?? "Sign with this device key"}
            </button>
          </div>
        </div>
      ) : null}
      {phase.k === "recording" ? <p role="status">Signing and recording with the server…</p> : null}
      {phase.k === "relay" ? (
        <RelayPanel
          call={phase.call}
          label={p.title}
          onRelayed={(r) => {
            if (r.outcome === "FINAL_SUCCESS") {
              setPhase({ k: "done", summary: phase.summary });
              p.onDone();
            }
          }}
        />
      ) : null}
      {phase.k === "done" ? (
        <p role="status" className="ok" data-testid={`done-${p.id}`}>
          Recorded by the server (and accepted by the contract where a call was needed). The view refreshes
          from the API.
        </p>
      ) : null}
      {phase.k === "failed" ? <FailureState failure={phase.failure} what={p.title} headingLevel={3} /> : null}
    </section>
  );
}
