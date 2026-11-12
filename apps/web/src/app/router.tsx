import {
  type AnchorHTMLAttributes,
  createContext,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

/** Minimal History API router: one source of truth for the path, focus moved on navigation. */
interface RouterValue {
  readonly path: string;
  navigate(to: string): void;
}

const RouterContext = createContext<RouterValue | null>(null);

export function RouterProvider({ children }: { children: ReactNode }) {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = useCallback((to: string) => {
    if (to !== window.location.pathname) window.history.pushState(null, "", to);
    setPath(new URL(to, window.location.origin).pathname);
  }, []);
  const value = useMemo(() => ({ path, navigate }), [path, navigate]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouterValue {
  const r = useContext(RouterContext);
  if (!r) throw new Error("RouterProvider missing");
  return r;
}

export function Link({
  href,
  children,
  current,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; current?: boolean; children: ReactNode }) {
  const { navigate } = useRouter();
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    rest.onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(href);
  };
  return (
    <a {...rest} href={href} onClick={onClick} aria-current={current ? "page" : undefined}>
      {children}
    </a>
  );
}

export type Route =
  | { readonly name: "home" }
  | { readonly name: "sign-in" }
  | { readonly name: "trades" }
  | { readonly name: "trade-new" }
  | { readonly name: "trade-countersign" }
  | { readonly name: "trade"; readonly tradeId: string; readonly tab: string }
  | { readonly name: "inspections" }
  | { readonly name: "payouts" }
  | { readonly name: "audit" }
  | { readonly name: "organization" }
  | { readonly name: "organization-keys" }
  | { readonly name: "organization-services" }
  | { readonly name: "recovery" }
  | { readonly name: "not-found"; readonly path: string };

export const TRADE_TABS = [
  "overview",
  "agreement",
  "evidence",
  "release",
  "payout",
  "refund",
  "timeline",
] as const;
export type TradeTab = (typeof TRADE_TABS)[number];

export function matchRoute(path: string): Route {
  const p = path.replace(/\/+$/, "") || "/";
  if (p === "/") return { name: "home" };
  if (p === "/sign-in") return { name: "sign-in" };
  if (p === "/trades") return { name: "trades" };
  if (p === "/trades/new") return { name: "trade-new" };
  if (p === "/trades/countersign") return { name: "trade-countersign" };
  const t = /^\/trades\/([^/]+)(?:\/([a-z]+))?$/.exec(p);
  if (t) {
    const tab = t[2] ?? "overview";
    if ((TRADE_TABS as readonly string[]).includes(tab))
      return { name: "trade", tradeId: decodeURIComponent(t[1] ?? ""), tab };
  }
  if (p === "/inspections") return { name: "inspections" };
  if (p === "/payouts") return { name: "payouts" };
  if (p === "/audit") return { name: "audit" };
  if (p === "/organization") return { name: "organization" };
  if (p === "/organization/keys") return { name: "organization-keys" };
  if (p === "/organization/services") return { name: "organization-services" };
  if (p === "/recovery") return { name: "recovery" };
  return { name: "not-found", path: p };
}
