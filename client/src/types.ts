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
}

export interface EventSyncInstance {
  user: JutorUser | null;
  isLoggedIn: boolean;
  redirectToLogin: () => void;
  syncNow: () => Promise<void>;
  destroy: () => void;
}
