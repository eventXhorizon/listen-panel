import { createContext, useContext } from 'react';
import type { AppFeatures, User } from '../types';

export interface AuthContextValue {
  user: User | null;
  needsSetup: boolean;
  loading: boolean;
  /// Off-by-default app feature switches. Used to hide nav/routes for modules
  /// an admin hasn't enabled.
  features: AppFeatures;
  refresh: () => Promise<void>;
  /// Re-pull feature flags after an admin toggles one in Settings.
  refreshFeatures: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  setup: (username: string, displayName: string, password: string) => Promise<void>;
  register: (username: string, displayName: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
