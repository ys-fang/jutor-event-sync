import type { EventSyncConfig, EventSyncInstance, JutorUser } from './types.js';
import { fetchJutorUser } from './auth.js';
import { readRecord, writeRecord } from './sync-api.js';

const DEFAULT_SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const LAST_SYNC_SUFFIX = '__lastSync';

/**
 * Collect all localStorage entries whose key starts with `${prefix}${uid}`.
 */
export function collectLocalData(
  prefix: string,
  uid: string
): Record<string, string> {
  const data: Record<string, string> = {};
  const keyPrefix = `${prefix}${uid}`;
  const storage = window.localStorage;

  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key && key.startsWith(keyPrefix) && !key.endsWith(LAST_SYNC_SUFFIX)) {
      data[key] = storage.getItem(key)!;
    }
  }
  return data;
}

/**
 * Get the local lastSync timestamp from localStorage.
 */
function getLocalLastSync(prefix: string, uid: string): number {
  const key = `${prefix}${uid}${LAST_SYNC_SUFFIX}`;
  const val = window.localStorage.getItem(key);
  return val ? Number(val) : 0;
}

/**
 * Set the local lastSync timestamp in localStorage.
 */
function setLocalLastSync(prefix: string, uid: string, ts: number): void {
  const key = `${prefix}${uid}${LAST_SYNC_SUFFIX}`;
  window.localStorage.setItem(key, String(ts));
}

/**
 * Sync localStorage with server on startup.
 * If remote is newer, overwrites local. Otherwise pushes local to remote.
 */
async function syncOnStartup(
  syncApiUrl: string,
  uid: string,
  appId: string,
  prefix: string,
  customCollect?: () => Record<string, string>,
  customRestore?: (data: Record<string, string>) => void
): Promise<void> {
  const remote = await readRecord(syncApiUrl, uid, appId);
  const localLastSync = getLocalLastSync(prefix, uid);

  if (remote && remote.lastSync > localLastSync) {
    // Remote is newer — overwrite localStorage
    if (customRestore) {
      customRestore(remote.data);
    } else {
      for (const [key, value] of Object.entries(remote.data)) {
        window.localStorage.setItem(key, value);
      }
    }
    setLocalLastSync(prefix, uid, remote.lastSync);
  } else {
    // Local is newer or no remote record — push to server
    await pushToServer(syncApiUrl, uid, appId, prefix, customCollect);
  }
}

/**
 * Collect localStorage data and write it via the sync API.
 */
async function pushToServer(
  syncApiUrl: string,
  uid: string,
  appId: string,
  prefix: string,
  customCollect?: () => Record<string, string>
): Promise<void> {
  const data = customCollect
    ? customCollect()
    : collectLocalData(prefix, uid);
  await writeRecord(syncApiUrl, uid, appId, data);
  setLocalLastSync(prefix, uid, Date.now());
}

/**
 * Initialize the event sync system.
 *
 * 1. Checks if the user is logged in to Jutor.
 * 2. Pulls from server on startup (if remote is newer).
 * 3. Sets up periodic sync and beforeunload handler.
 * 4. Returns an EventSyncInstance.
 */
export async function initEventSync(
  config: EventSyncConfig
): Promise<EventSyncInstance> {
  const {
    appId,
    localStoragePrefix: prefix,
    jutorApiBase,
    syncApiUrl,
    syncIntervalMs = DEFAULT_SYNC_INTERVAL_MS,
    collectData: customCollect,
    restoreData: customRestore,
  } = config;

  // 1. Check Jutor session
  const apiBase = jutorApiBase ?? '';
  const user: JutorUser | null = await fetchJutorUser(apiBase);

  if (!user) {
    return {
      user: null,
      isLoggedIn: false,
      redirectToLogin: () => {
        window.location.href = `${apiBase}/login`;
      },
      syncNow: async () => {},
      destroy: () => {},
    };
  }

  // 2. Sync on startup (pull if remote newer, push otherwise)
  await syncOnStartup(syncApiUrl, user.uid, appId, prefix, customCollect, customRestore);

  // 3. Periodic sync (with error handling to prevent silent failures)
  const intervalId = setInterval(async () => {
    try {
      await pushToServer(syncApiUrl, user.uid, appId, prefix, customCollect);
    } catch (err) {
      console.error('[event-sync] periodic sync failed:', err);
    }
  }, syncIntervalMs);

  // 4. beforeunload + visibilitychange handlers for best-effort save
  const saveHandler = () => {
    pushToServer(syncApiUrl, user.uid, appId, prefix, customCollect).catch(() => {});
  };
  window.addEventListener('beforeunload', saveHandler);
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      saveHandler();
    }
  });

  // Return instance
  return {
    user,
    isLoggedIn: true,
    redirectToLogin: () => {
      window.location.href = `${apiBase}/login`;
    },
    syncNow: () => pushToServer(syncApiUrl, user.uid, appId, prefix, customCollect),
    destroy: () => {
      clearInterval(intervalId);
      window.removeEventListener('beforeunload', saveHandler);
    },
  };
}
