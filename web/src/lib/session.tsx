import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api, ApiError } from "./api.ts";
import type { AuthConfig, User, UserSettings } from "./types.ts";

type SessionValue = {
  user: User | null;
  config: AuthConfig | null;
  loading: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  applySettings: (settings: UserSettings) => void;
};

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [me, cfg] = await Promise.allSettled([api.me(), api.authConfig()]);
      setUser(me.status === "fulfilled" ? me.value.user : null);
      setConfig(cfg.status === "fulfilled" ? cfg.value : null);
    } catch (error) {
      // A 401 simply means "not signed in" — anything else is worth surfacing.
      if (!(error instanceof ApiError && error.status === 401)) console.error(error);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signOut = useCallback(async () => {
    await api.logout();
    setUser(null);
  }, []);

  const applySettings = useCallback((settings: UserSettings) => {
    setUser((current) => (current ? { ...current, settings } : current));
  }, []);

  const value = useMemo(
    () => ({ user, config, loading, refresh, signOut, applySettings }),
    [user, config, loading, refresh, signOut, applySettings],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside <SessionProvider>");
  return value;
}
