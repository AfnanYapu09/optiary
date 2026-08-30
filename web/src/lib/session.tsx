import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api, ApiError, setStoredToken } from "./api.ts";
import { auth, onAuthStateChanged, signOutFirebase } from "./firebase.ts";
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
      if (me.status === "fulfilled") {
        setUser(me.value.user);
        if (me.value.token) {
          setStoredToken(me.value.token);
        }
      } else {
        setUser(null);
      }
      setConfig(cfg.status === "fulfilled" ? cfg.value : null);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) console.error(error);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Synchronize with Firebase Auth state
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (fbUser) => {
      if (fbUser) {
        try {
          const idToken = await fbUser.getIdToken();
          const res = await api.firebaseLogin(idToken);
          if (res?.user) {
            setUser(res.user);
          }
        } catch (err) {
          console.warn("Auto-sync Firebase auth state notice:", err);
        }
      }
    });
    return () => unsubscribe();
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } catch (err) {
      console.warn("Logout error:", err);
    }
    try {
      await signOutFirebase();
    } catch (err) {
      console.warn("Firebase logout error:", err);
    }
    setStoredToken(null);
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
