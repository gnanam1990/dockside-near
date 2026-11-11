import { useEffect, useRef } from "react";
import { AppProvider } from "./app/app-context";
import { matchRoute, type Route, RouterProvider, useRouter } from "./app/router";
import { AppShell } from "./components/AppShell";
import { AuditScreen } from "./screens/Audit";
import { InspectionsScreen, NotFoundScreen, PayoutsScreen } from "./screens/Operations";
import { OrganizationScreen } from "./screens/Organization";
import { SignInScreen } from "./screens/SignIn";
import { TradeCreateScreen } from "./screens/TradeCreate";
import { TradesScreen } from "./screens/Trades";
import { TradeWorkspaceScreen } from "./screens/TradeWorkspace";

function titleOf(r: Route): string {
  switch (r.name) {
    case "home":
    case "trades":
      return "Trades";
    case "sign-in":
      return "Sign in";
    case "trade-new":
      return "Create trade";
    case "trade":
      return `Trade ${r.tradeId} · ${r.tab}`;
    case "inspections":
      return "Inspections";
    case "payouts":
      return "Payouts";
    case "audit":
      return "Audit";
    case "organization":
      return "Organization";
    case "not-found":
      return "Page not found";
  }
}

function Screen({ route }: { route: Route }) {
  switch (route.name) {
    case "home":
    case "trades":
      return <TradesScreen />;
    case "sign-in":
      return <SignInScreen />;
    case "trade-new":
      return <TradeCreateScreen />;
    case "trade":
      return <TradeWorkspaceScreen tradeId={route.tradeId} tab={route.tab} />;
    case "inspections":
      return <InspectionsScreen />;
    case "payouts":
      return <PayoutsScreen />;
    case "audit":
      return <AuditScreen />;
    case "organization":
      return <OrganizationScreen />;
    case "not-found":
      return <NotFoundScreen path={route.path} />;
  }
}

function Routed() {
  const { path } = useRouter();
  const route = matchRoute(path);
  const first = useRef(true);
  useEffect(() => {
    document.title = `${titleOf(route)} — Dockside`;
    if (first.current) {
      first.current = false;
      return;
    }
    // Move focus to the new page so keyboard and screen-reader users land on its content.
    document.getElementById("main")?.focus();
  }, [route]);
  return (
    <AppShell>
      <Screen route={route} />
    </AppShell>
  );
}

export function App() {
  return (
    <RouterProvider>
      <AppProvider>
        <Routed />
      </AppProvider>
    </RouterProvider>
  );
}
