import { type FormEvent, useEffect, useState } from "react";
import { useApiData, useApp, useMutationGate } from "../../app/app-context";
import { PageHeader } from "../../components/AppShell";
import { IdentityList, TableScroller } from "../../components/Data";
import { Field } from "../../components/Forms";
import { BlockedAction, Callout, FailureState, LoadingState } from "../../components/States";
import { StatusBadge } from "../../components/Status";
import type { ApiFailure } from "../../lib/api/client";
import { ENDPOINTS } from "../../lib/api/endpoints";
import { fromHex } from "../../lib/canonical";
import { formatUtc, networkLabel } from "../../lib/format";
import {
  checkWalletAnswer,
  discoverWallets,
  type Nep413Request,
  type WalletConnector,
} from "../../lib/wallet";
import { OrgNav } from "./common";
import { failureText, Loaded } from "./Settings";

/**
 * NEAR account ownership (M17, ADR-0018). The signed-in principal links a NEAR account: the server
 * issues a NEP-413 message, the user's NEAR wallet signs it through the wallet-connector boundary,
 * this browser checks the answer, and the server verifies the signature and asks the chain
 * (`view_access_key`) whether the key is a full-access key of the account. A link is an identity
 * fact only; it grants no capability.
 */

interface LinkView {
  readonly linkId: string;
  readonly principalId: string;
  readonly accountId: string;
  readonly publicKey: string;
  readonly network: string;
  readonly status: string;
  readonly permission: string | null;
  readonly blockHeight: number | null;
  readonly linkedAt: number;
  readonly lastCheckedAt: number;
}

interface Challenge {
  readonly challengeId: string;
  readonly accountId: string;
  readonly digestHex: string;
  readonly expiresAt: number;
  readonly nep413: { readonly message: string; readonly nonceHex: string; readonly recipient: string };
}

const ACCOUNT = /^(?=.{2,64}$)[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\.[a-z0-9]+(?:[-_][a-z0-9]+)*)*$/;

function LinksTable({
  links,
  caption,
  testId,
  onRecheck,
  busy,
}: {
  links: LinkView[];
  caption: string;
  testId: string;
  onRecheck?: (l: LinkView) => void;
  busy?: string | null;
}) {
  return (
    <TableScroller label={caption}>
      <table data-testid={testId}>
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Account</th>
            <th scope="col">Wallet key</th>
            <th scope="col">Ownership</th>
            <th scope="col">Observed at block</th>
            <th scope="col">Last checked</th>
            {onRecheck ? <th scope="col">Action</th> : null}
          </tr>
        </thead>
        <tbody>
          {links.map((l) => (
            <tr key={l.linkId} data-testid={`link-${l.accountId}`}>
              <td className="mono wrap">{l.accountId}</td>
              <td className="mono wrap">{l.publicKey}</td>
              <td>
                <StatusBadge
                  dimension="nearAccountLink"
                  value={l.status}
                  source={`view_access_key on ${networkLabel(l.network)}`}
                  observedAt={l.lastCheckedAt}
                  compact
                />
              </td>
              <td className="tabular">{l.blockHeight ?? "—"}</td>
              <td className="mono">{formatUtc(l.lastCheckedAt)}</td>
              {onRecheck ? (
                <td>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy === l.linkId}
                    onClick={() => onRecheck(l)}
                  >
                    Re-check {l.accountId}
                  </button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroller>
  );
}

function LinkPanel({ onLinked }: { onLinked: () => void }) {
  const app = useApp();
  const gate = useMutationGate();
  const [wallets, setWallets] = useState<WalletConnector[] | null>(null);
  const [walletId, setWalletId] = useState<string>("");
  const [account, setAccount] = useState("");
  const [touched, setTouched] = useState(false);
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [linked, setLinked] = useState<LinkView | null>(null);
  const [busy, setBusy] = useState(false);
  const look = () => {
    setWallets(null);
    void discoverWallets().then((w) => {
      setWallets(w);
      setWalletId((cur) => (w.some((x) => x.id === cur) ? cur : (w[0]?.id ?? "")));
    });
  };
  useEffect(look, []);
  const normalized = account.trim().toLowerCase();
  const invalid = !ACCOUNT.test(normalized);
  const wallet = wallets?.find((w) => w.id === walletId) ?? null;

  const request = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (invalid) return;
    setBusy(true);
    setFailure(null);
    setLinked(null);
    const out = await app.client.call<Challenge>(ENDPOINTS.nearAccountChallenge, {
      body: { accountId: normalized },
    });
    setBusy(false);
    if (!out.ok) return setFailure(failureText(out.error));
    if (out.data.accountId !== normalized || out.data.nep413.recipient !== app.client.origin)
      return setFailure("The server's challenge names another account or origin; nothing was signed.");
    setChallenge(out.data);
  };

  const sign = async () => {
    if (!challenge || !wallet) return;
    setBusy(true);
    setFailure(null);
    try {
      const req: Nep413Request = {
        message: challenge.nep413.message,
        nonce: fromHex(challenge.nep413.nonceHex),
        recipient: challenge.nep413.recipient,
      };
      let answer: Awaited<ReturnType<WalletConnector["signMessage"]>>;
      try {
        answer = await wallet.signMessage(req);
      } catch (err) {
        setFailure(`The wallet did not sign: ${(err as Error).message}`);
        return;
      }
      const check = await checkWalletAnswer(req, challenge.accountId, answer);
      if (!check.ok) {
        setFailure(`Not sent to the server: ${check.reason}.`);
        return;
      }
      const out = await app.client.call<LinkView>(ENDPOINTS.linkNearAccount, {
        body: {
          challengeId: challenge.challengeId,
          accountId: answer.accountId,
          publicKey: answer.publicKey,
          signature: answer.signature,
        },
      });
      if (!out.ok) {
        setFailure(failureText(out.error as ApiFailure));
        return;
      }
      setLinked(out.data);
      setChallenge(null);
      onLinked();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel" aria-labelledby="link-title" data-testid="near-link-panel">
      <h2 id="link-title">Link a NEAR account</h2>
      <p className="muted">
        Your NEAR wallet signs a one-time NEP-413 message for this site. Dockside then checks on chain that
        the signing key is a full-access key of the account. The link proves account ownership only; it grants
        no role or trade authority.
      </p>
      {wallets === null ? (
        <p role="status">Looking for NEAR wallets in this browser…</p>
      ) : wallets.length === 0 ? (
        <Callout
          tone="neutral"
          icon="not-run"
          title="No NEAR wallet detected in this browser"
          headingLevel={3}
          testId="no-wallet"
        >
          <p>
            A wallet connects by announcing itself to this page (<code>near-wallet:announce</code>). No wallet
            is bundled with Dockside, and none answered.
          </p>
          <button type="button" className="btn" onClick={look}>
            Look for wallets again
          </button>
        </Callout>
      ) : null}
      <form onSubmit={(e) => void request(e)}>
        {wallets && wallets.length > 0 ? (
          <Field id="near-wallet" label="Wallet" help="Wallets that announced themselves to this page.">
            {(aria) => (
              <select {...aria} value={walletId} onChange={(e) => setWalletId(e.target.value)}>
                {wallets.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        ) : null}
        <Field
          id="near-account"
          label="NEAR account ID"
          help="For example acme-treasury.testnet. Lowercase letters, digits, - _ and dots."
          error={touched && invalid ? "Enter a valid NEAR account ID (2 to 64 characters)." : undefined}
        >
          {(aria) => (
            <input
              {...aria}
              autoComplete="off"
              spellCheck={false}
              value={account}
              onBlur={() => setTouched(true)}
              onChange={(e) => setAccount(e.target.value)}
            />
          )}
        </Field>
        <button type="submit" className="btn btn--primary" disabled={busy || !gate.allowed || !wallet}>
          Request signing message
        </button>
        {!wallet && wallets !== null ? <BlockedAction reason="Connect a NEAR wallet first." /> : null}
        {gate.reason ? <BlockedAction reason={gate.reason} /> : null}
      </form>
      {challenge ? (
        <div className="panel" data-testid="near-challenge-review">
          <h3>Review before your wallet signs</h3>
          <IdentityList
            items={[
              ["Account", <code key="a">{challenge.accountId}</code>],
              ["Recipient (this site)", <code key="r">{challenge.nep413.recipient}</code>],
              [
                "Nonce",
                <code key="n" className="wrap">
                  {challenge.nep413.nonceHex}
                </code>,
              ],
              ["Expires", formatUtc(challenge.expiresAt)],
              [
                "Message",
                <pre key="m" className="wrap">
                  {challenge.nep413.message}
                </pre>,
              ],
            ]}
          />
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy || !wallet}
            onClick={() => void sign()}
          >
            Sign with {wallet?.name ?? "wallet"}
          </button>{" "}
          <button type="button" className="btn" onClick={() => setChallenge(null)}>
            Cancel
          </button>
        </div>
      ) : null}
      <p role="status">{busy ? "Waiting for the wallet and the chain check…" : ""}</p>
      {failure ? (
        <Callout
          tone="negative"
          icon="blocked"
          title="Account not linked"
          headingLevel={3}
          role="alert"
          testId="near-link-failure"
        >
          <p>{failure}</p>
        </Callout>
      ) : null}
      {linked ? (
        <Callout
          tone="neutral"
          icon="complete"
          title={`${linked.accountId} linked`}
          headingLevel={3}
          role="status"
          testId="near-linked"
        >
          <p>
            Key {linked.publicKey} is a full-access key of {linked.accountId}, observed at block{" "}
            {linked.blockHeight}.
          </p>
        </Callout>
      ) : null}
    </section>
  );
}

export function NearAccountsScreen() {
  const app = useApp();
  const me = app.me;
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [recheck, setRecheck] = useState<string | null>(null);
  const reader =
    !!me && (me.capabilities.includes("ORG_SECURITY_ADMIN") || me.capabilities.includes("AUDITOR"));
  const mine = useApiData(
    me
      ? () =>
          app.client.call<{ network: string; chainConfigured: boolean; links: LinkView[] }>(
            ENDPOINTS.myNearAccounts,
          )
      : null,
    [me?.principal.id, tick],
  );
  const org = useApiData(
    reader ? () => app.client.call<{ links: LinkView[] }>(ENDPOINTS.organizationNearAccounts) : null,
    [reader, tick],
  );
  const header = (
    <>
      <PageHeader
        title="NEAR accounts"
        description="Link a NEAR account with a NEP-413 wallet signature; the server checks on chain that the key is a full-access key of that account."
      />
      <OrgNav />
    </>
  );
  if (!app.meLoaded) return <LoadingState what="your session" />;
  if (!me)
    return (
      <>
        {header}
        <FailureState failure={{ kind: "no-session" }} what="NEAR accounts" />
      </>
    );
  const doRecheck = async (l: LinkView) => {
    setBusy(l.linkId);
    const out = await app.client.call<LinkView>(ENDPOINTS.recheckNearAccount, {
      params: { id: l.linkId },
      body: {},
    });
    setBusy(null);
    setRecheck(
      out.ok
        ? `${out.data.accountId}: ${out.data.status === "VERIFIED" ? "still a full-access key" : out.data.status === "KEY_NOT_FOUND" ? "the key is no longer an access key of the account" : "the key is no longer a full-access key"} (block ${out.data.blockHeight ?? "—"}).`
        : failureText(out.error),
    );
    setTick((t) => t + 1);
  };
  return (
    <>
      {header}
      <Loaded what="Your NEAR accounts" data={mine}>
        {(v) =>
          v.chainConfigured ? (
            <>
              <LinkPanel onLinked={() => setTick((t) => t + 1)} />
              <section className="panel" aria-labelledby="mine-title">
                <h2 id="mine-title">Your linked accounts</h2>
                <p role="status" data-testid="recheck-result">
                  {recheck ?? ""}
                </p>
                {v.links.length === 0 ? (
                  <p className="muted">You have not linked a NEAR account.</p>
                ) : (
                  <LinksTable
                    links={v.links}
                    caption="Your NEAR account links"
                    testId="my-near-links"
                    onRecheck={(l) => void doRecheck(l)}
                    busy={busy}
                  />
                )}
              </section>
            </>
          ) : (
            <Callout
              tone="neutral"
              icon="not-run"
              title="No NEAR chain adapter in this backend"
              testId="near-unavailable"
            >
              <p>
                This API process has no NEAR RPC endpoint configured, so account ownership cannot be checked.
              </p>
            </Callout>
          )
        }
      </Loaded>
      {reader ? (
        <section className="panel" aria-labelledby="org-links-title">
          <h2 id="org-links-title">Accounts linked in your organization</h2>
          <Loaded what="Organization NEAR accounts" data={org}>
            {(v) =>
              v.links.length === 0 ? (
                <p className="muted">No principal of your organization has linked a NEAR account.</p>
              ) : (
                <LinksTable
                  links={v.links}
                  caption="NEAR account links in your organization"
                  testId="org-near-links"
                />
              )
            }
          </Loaded>
        </section>
      ) : null}
    </>
  );
}
