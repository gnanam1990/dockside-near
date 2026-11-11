import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type ApiOutcome, DocksideClient } from "../lib/api/client";
import type { MeResponse, ReadyResponse, SessionGrant } from "../lib/api/types";
import { type DeviceKeyRecord, IndexedDbKeyStore, type KeyStore } from "../lib/keys";

export type ConnectionStatus = "CONNECTING" | "CONNECTED" | "STALE" | "DISCONNECTED";

export interface ConnectionState {
  readonly status: ConnectionStatus;
  /** Time of the last authoritative API answer, if any. */
  readonly lastOkAt: number | null;
  readonly lastFailureAt: number | null;
}

export interface AppValue {
  readonly client: DocksideClient;
  readonly keys: KeyStore;
  readonly ready: ReadyResponse | null;
  readonly me: MeResponse | null;
  readonly meLoaded: boolean;
  readonly sessionGrant: SessionGrant | null;
  readonly connection: ConnectionState;
  readonly now: number;
  adoptSession(grant: SessionGrant, key: DeviceKeyRecord): Promise<void>;
  refreshMe(): Promise<ApiOutcome<MeResponse> | null>;
  signOut(): void;
  reconnect(): Promise<void>;
}

const AppContext = createContext<AppValue | null>(null);

const SESSION_KEY = "dockside.session.v1";
/** Poll interval for /readyz and threshold after which data is labelled stale. */
export const POLL_MS = 15_000;
export const STALE_AFTER_MS = 45_000;

interface StoredSession {
  readonly grant: SessionGrant;
  readonly publicKey: string;
}

function readStoredSession(): StoredSession | null {
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  } catch {
    return null;
  }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [connection, setConnection] = useState<ConnectionState>({
    status: "CONNECTING",
    lastOkAt: null,
    lastFailureAt: null,
  });
  const connRef = useRef(connection);
  connRef.current = connection;

  const client = useMemo(
    () =>
      new DocksideClient({
        baseUrl: "",
        origin: window.location.origin,
        onTransport: ({ ok, at, networkError }) => {
          setConnection((c) =>
            ok
              ? { status: "CONNECTED", lastOkAt: at, lastFailureAt: c.lastFailureAt }
              : networkError
                ? { status: "DISCONNECTED", lastOkAt: c.lastOkAt, lastFailureAt: at }
                : c,
          );
        },
      }),
    [],
  );
  const keys = useMemo<KeyStore>(() => new IndexedDbKeyStore(), []);
  const [ready, setReady] = useState<ReadyResponse | null>(null);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [meLoaded, setMeLoaded] = useState(false);
  const [sessionGrant, setSessionGrant] = useState<SessionGrant | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const refreshMe = useCallback(async () => {
    if (!client.getSession()) {
      setMe(null);
      setMeLoaded(true);
      return null;
    }
    const out = await client.me();
    if (out.ok) setMe(out.data);
    else if (out.error.kind === "http" && (out.error.status === 401 || out.error.code === "KEY_REVOKED")) {
      // The server no longer accepts this session: drop it rather than pretend.
      client.setSession(null);
      setSessionGrant(null);
      setMe(null);
      try {
        window.sessionStorage.removeItem(SESSION_KEY);
      } catch {
        /* storage unavailable */
      }
    }
    setMeLoaded(true);
    return out;
  }, [client]);

  const adoptSession = useCallback(
    async (grant: SessionGrant, key: DeviceKeyRecord) => {
      client.setSession({ grant, publicKey: key.publicKey, privateKey: key.privateKey });
      setSessionGrant(grant);
      await keys.put({ ...key, principalId: grant.principalId, organizationId: grant.organizationId });
      try {
        window.sessionStorage.setItem(SESSION_KEY, JSON.stringify({ grant, publicKey: key.publicKey }));
      } catch {
        /* storage unavailable: session lives for this page only */
      }
      await refreshMe();
    },
    [client, keys, refreshMe],
  );

  const signOut = useCallback(() => {
    client.setSession(null);
    setSessionGrant(null);
    setMe(null);
    try {
      window.sessionStorage.removeItem(SESSION_KEY);
    } catch {
      /* ignore */
    }
  }, [client]);

  const reconnect = useCallback(async () => {
    const r = await client.ready();
    if (r.ok) setReady(r.data);
    if (client.getSession()) await refreshMe();
  }, [client, refreshMe]);

  // Restore a session from this tab (the token is useless without the device key).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = readStoredSession();
      if (stored && stored.grant.expiresAt > Date.now()) {
        try {
          const key = await keys.get(stored.publicKey);
          if (key && !cancelled) {
            client.setSession({ grant: stored.grant, publicKey: key.publicKey, privateKey: key.privateKey });
            setSessionGrant(stored.grant);
          }
        } catch {
          /* key store unavailable */
        }
      }
      if (!cancelled) await refreshMe();
    })();
    return () => {
      cancelled = true;
    };
  }, [client, keys, refreshMe]);

  // Readiness polling drives connection freshness and the network label.
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      const r = await client.ready();
      if (!stop && r.ok) setReady(r.data);
    };
    void tick();
    const id = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [client]);

  // Clock for relative ages and staleness.
  useEffect(() => {
    const id = window.setInterval(() => {
      const t = Date.now();
      setNow(t);
      const c = connRef.current;
      if (c.status === "CONNECTED" && c.lastOkAt !== null && t - c.lastOkAt > STALE_AFTER_MS)
        setConnection({ ...c, status: "STALE" });
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  const value = useMemo<AppValue>(
    () => ({
      client,
      keys,
      ready,
      me,
      meLoaded,
      sessionGrant,
      connection,
      now,
      adoptSession,
      refreshMe,
      signOut,
      reconnect,
    }),
    [
      client,
      keys,
      ready,
      me,
      meLoaded,
      sessionGrant,
      connection,
      now,
      adoptSession,
      refreshMe,
      signOut,
      reconnect,
    ],
  );
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppValue {
  const v = useContext(AppContext);
  if (!v) throw new Error("AppProvider missing");
  return v;
}

/** Whether state-changing actions may be offered right now, and why not. */
export function useMutationGate(): { allowed: boolean; reason: string | null } {
  const { connection } = useApp();
  if (connection.status === "DISCONNECTED")
    return { allowed: false, reason: "Disconnected from the API. Reconnect before changing anything." };
  if (connection.status === "CONNECTING")
    return { allowed: false, reason: "Waiting for the first API answer." };
  return { allowed: true, reason: null };
}

/** Load data from the API with explicit loading / refreshing / error states. */
export function useApiData<T>(
  load: (() => Promise<ApiOutcome<T>>) | null,
  deps: readonly unknown[],
): {
  state: "idle" | "loading" | "refreshing" | "done";
  outcome: ApiOutcome<T> | null;
  reload: () => void;
} {
  const [outcome, setOutcome] = useState<ApiOutcome<T> | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "refreshing" | "done">(load ? "loading" : "idle");
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are supplied by the caller
  useEffect(() => {
    const fn = loadRef.current;
    if (!fn) {
      setState("idle");
      return;
    }
    let cancelled = false;
    setState((s) => (s === "done" ? "refreshing" : "loading"));
    void fn().then((o) => {
      if (cancelled) return;
      setOutcome(o);
      setState("done");
    });
    return () => {
      cancelled = true;
    };
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { state, outcome, reload };
}
