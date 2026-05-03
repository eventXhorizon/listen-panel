import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  authStatus,
  login as loginApi,
  logout as logoutApi,
  registerAccount,
  setupAccount,
} from '../api';
import type { User } from '../types';
import { AuthContext, type AuthContextValue } from './auth-context';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const status = await authStatus();
    setUser(status.user);
    setNeedsSetup(status.needs_setup);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        await refresh();
      } finally {
        setLoading(false);
      }
    })();
  }, [refresh]);

  const login = useCallback(async (username: string, password: string) => {
    const u = await loginApi({ username, password });
    setUser(u);
    setNeedsSetup(false);
  }, []);

  const setup = useCallback(
    async (username: string, displayName: string, password: string) => {
      const u = await setupAccount({
        username,
        display_name: displayName.trim() || undefined,
        password,
      });
      setUser(u);
      setNeedsSetup(false);
    },
    [],
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
    },
    [],
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
      refresh,
      login,
      setup,
      register,
      logout,
    }),
    [user, needsSetup, loading, refresh, login, setup, register, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
