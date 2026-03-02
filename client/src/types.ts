export interface JutorUser {
  uid: string;
  userName: string;
  email?: string;
  grade?: string;
  class?: string;
  schoolName?: string;
}

export interface EventSyncConfig {
  appId: string;
  localStoragePrefix: string;
  jutorApiBase?: string;
  syncApiUrl: string;
  syncIntervalMs?: number;
  /**
   * Custom data collector. If provided, replaces the default
   * prefix+uid key matching with app-specific collection logic.
   */
  collectData?: () => Record<string, string>;
  /**
   * Custom data restorer. If provided, replaces the default
   * localStorage.setItem loop when pulling remote data.
   */
  restoreData?: (data: Record<string, string>) => void;
}

export interface EventSyncInstance {
  user: JutorUser | null;
  isLoggedIn: boolean;
  redirectToLogin: () => void;
  syncNow: () => Promise<void>;
  destroy: () => void;
}
