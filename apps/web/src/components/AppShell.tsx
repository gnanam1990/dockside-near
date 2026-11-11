import { type ReactNode, useState } from "react";
import { useApp } from "../app/app-context";
import { Link, useRouter } from "../app/router";
import { capabilityLabel, formatAge, formatUtc } from "../lib/format";
import { describeStatus } from "../lib/status";
import { StatusIcon, type UI_ICONS, UiIcon } from "./Icon";
import { ConnectionBanner } from "./States";
import { NetworkLabel } from "./Status";

const NAV: ReadonlyArray<{ href: string; label: string; icon: keyof typeof UI_ICONS }> = [
  { href: "/trades", label: "Trades", icon: "trades" },
  { href: "/inspections", label: "Inspections", icon: "inspections" },
  { href: "/payouts", label: "Payouts", icon: "payouts" },
  { href: "/audit", label: "Audit", icon: "audit" },
  { href: "/organization", label: "Organization", icon: "organization" },
];

function isCurrent(path: string, href: string): boolean {
  return path === href || path.startsWith(`${href}/`);
}

/** Organization, network, role, connection freshness and last authoritative sync. */
function ContextBar() {
  const { me, ready, connection, now } = useApp();
  const conn = describeStatus("connection", connection.status);
  const roles = me?.capabilities.length
    ? me.capabilities.map(capabilityLabel).join(", ")
    : me
      ? "No capability granted"
      : "Not signed in";
  return (
    <dl className="context-bar" aria-label="Session context">
      <div>
        <dt>Organization</dt>
        <dd className="mono">{me?.organizationId ?? "—"}</dd>
      </div>
      <div>
        <dt>Network</dt>
        <dd>
          <NetworkLabel network={ready?.network} />
        </dd>
      </div>
      <div>
        <dt>Role</dt>
        <dd>{roles}</dd>
      </div>
      <div data-testid="connection-status" data-status={connection.status}>
        <dt>API</dt>
        <dd className={`status tone-${conn.tone}`}>
          <StatusIcon name={conn.icon} className="status__icon" />
          <span className="status__label">{conn.label}</span>
        </dd>
      </div>
      <div>
        <dt>Last sync</dt>
        <dd className="mono">
          {connection.lastOkAt === null
            ? "none yet"
            : `${formatUtc(connection.lastOkAt)} (${formatAge(connection.lastOkAt, now)})`}
        </dd>
      </div>
    </dl>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { path } = useRouter();
  const { me, signOut } = useApp();
  const [navOpen, setNavOpen] = useState(false);
  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <header className="topbar">
        <Link href="/trades" className="brand">
          <UiIcon name="brand" size={22} />
          Dockside
        </Link>
        <button
          type="button"
          className="btn nav-toggle"
          aria-expanded={navOpen}
          aria-controls="primary-nav"
          onClick={() => setNavOpen((o) => !o)}
        >
          <UiIcon name="menu" />
          Menu
        </button>
        <ContextBar />
        {me ? (
          <button type="button" className="btn" onClick={signOut}>
            <UiIcon name="signOut" />
            Sign out
          </button>
        ) : (
          <Link href="/sign-in" className="btn" current={path === "/sign-in"}>
            <UiIcon name="signIn" />
            Sign in
          </Link>
        )}
      </header>
      <div className="layout">
        <nav className="sidenav" id="primary-nav" aria-label="Primary" data-open={navOpen}>
          <ul>
            {NAV.map((n) => (
              <li key={n.href}>
                <Link href={n.href} current={isCurrent(path, n.href)} onClick={() => setNavOpen(false)}>
                  <UiIcon name={n.icon} />
                  {n.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <main id="main" tabIndex={-1}>
          <div className="content">
            <ConnectionBanner />
            {children}
          </div>
        </main>
      </div>
      <nav className="bottomnav" aria-label="Primary (compact)">
        <ul>
          {NAV.map((n) => (
            <li key={n.href}>
              <Link href={n.href} current={isCurrent(path, n.href)}>
                <UiIcon name={n.icon} />
                {n.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  network,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  /** Money screens pass the network so testnet is labelled on every one of them. */
  network?: string | null | undefined;
}) {
  return (
    <div className="page-header">
      <div className="page-header__text">
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      <div className="page-header__actions">
        {network !== undefined ? <NetworkLabel network={network} /> : null}
        {actions}
      </div>
    </div>
  );
}
