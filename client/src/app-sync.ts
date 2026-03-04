import type { EventSyncInstance } from './types.js';
import { initEventSync } from './sync.js';

const SYNC_API_URL =
  'https://speech-token-server-819106170113.asia-east1.run.app/api/event/sync';

const DEFAULT_EXCLUDE_SUFFIXES = ['__lastSync', '__keyTimestamps', '_current_user'];

export interface AppSyncConfig {
  appId: string;
  prefix: string;
  extraExcludeSuffixes?: string[];
  extraSyncKeys?: string[];
}

export interface AppSync {
  initSync(): Promise<EventSyncInstance | null>;
  getSyncInstance(): EventSyncInstance | null;
  redirectToJutorLogin(): void;
  redirectToJutorLogout(): void;
}

export function createAppSync(config: AppSyncConfig): AppSync {
  const excludeSuffixes = [
    ...DEFAULT_EXCLUDE_SUFFIXES,
    ...(config.extraExcludeSuffixes || []),
  ];
  let syncInstance: EventSyncInstance | null = null;

  function collectData(): Record<string, string> {
    const data: Record<string, string> = {};
    const storage = window.localStorage;
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key) continue;
      if (excludeSuffixes.some((s) => key.endsWith(s))) continue;
      if (
        key.startsWith(config.prefix) ||
        (config.extraSyncKeys && config.extraSyncKeys.includes(key))
      ) {
        data[key] = storage.getItem(key)!;
      }
    }
    return data;
  }

  function restoreData(data: Record<string, string>): void {
    for (const [key, value] of Object.entries(data)) {
      if (excludeSuffixes.some((s) => key.endsWith(s))) continue;
      window.localStorage.setItem(key, value);
    }
  }

  return {
    async initSync(): Promise<EventSyncInstance | null> {
      try {
        syncInstance = await initEventSync({
          appId: config.appId,
          localStoragePrefix: config.prefix,
          syncApiUrl: SYNC_API_URL,
          collectData,
          restoreData,
        });

        if (syncInstance.isLoggedIn) {
          console.log('[event-sync] Synced as', syncInstance.user?.userName);
        }

        return syncInstance;
      } catch (err) {
        console.error('[event-sync] Init failed:', err);
        return null;
      }
    },

    getSyncInstance(): EventSyncInstance | null {
      return syncInstance;
    },

    redirectToJutorLogin(): void {
      window.location.href = `https://www.jutor.ai/login?continue=${encodeURIComponent(window.location.href)}`;
    },

    redirectToJutorLogout(): void {
      window.location.href = `https://www.jutor.ai/logout?continue=${encodeURIComponent(window.location.href)}`;
    },
  };
}
