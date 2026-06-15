import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  authStatus,
  getFeatures,
  login as loginApi,
  logout as logoutApi,
  registerAccount,
  setupAccount,
} from '../api';
import type { AppFeatures, User } from '../types';
import { AuthContext, type AuthContextValue } from './auth-context';

const DEFAULT_FEATURES: AppFeatures = { interview: false };

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [loading, setLoading] = useState(true);
  const [features, setFeatures] = useState<AppFeatures>(DEFAULT_FEATURES);

  const refreshFeatures = useCallback(async () => {
    try {
      setFeatures(await getFeatures());
    } catch {
      // Unauthenticated (pre-login) or transient error: leave everything off.
      setFeatures(DEFAULT_FEATURES);
    }
  }, []);

  const refresh = useCallback(async () => {
    const status = await authStatus();
    setUser(status.user);
    setNeedsSetup(status.needs_setup);
    if (status.user) {
      await refreshFeatures();
    } else {
      setFeatures(DEFAULT_FEATURES);
    }
  }, [refreshFeatures]);

  useEffect(() => {
    (async () => {
      try {
        await refresh();
      } finally {
        setLoading(false);
      }
    })();
  }, [refresh]);

  const login = useCallback(
    async (username: string, password: string) => {
      const u = await loginApi({ username, password });
      setUser(u);
      setNeedsSetup(false);
      await refreshFeatures();
    },
    [refreshFeatures],
  );

  const setup = useCallback(
    async (username: string, displayName: string, password: string) => {
      const u = await setupAccount({
        username,
        display_name: displayName.trim() || undefined,
        password,
      });
      setUser(u);
      setNeedsSetup(false);
      await refreshFeatures();
    },
    [refreshFeatures],
  );

  const register = useCallback(
    async (username: string, displayName: string, password: string) => {
      const u = await registerAccount({
        username,
        display_name: displayName.trim() || undefined,
        password,
      });
      setUser(u);
      setNeedsSetup(false);
      await refreshFeatures();
    },
    [refreshFeatures],
  );

  const logout = useCallback(async () => {
    await logoutApi();
    setUser(null);
    await refresh();
  }, [refresh]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      needsSetup,
      loading,
      features,
      refresh,
      refreshFeatures,
      login,
      setup,
      register,
      logout,
    }),
    [
      user,
      needsSetup,
      loading,
      features,
      refresh,
      refreshFeatures,
      login,
      setup,
      register,
      logout,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
