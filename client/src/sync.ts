import type { EventSyncConfig, EventSyncInstance, JutorUser } from './types.js';
import { fetchJutorUser } from './auth.js';
import { writeRecord } from './sync-api.js';

const DEFAULT_SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const LAST_SYNC_SUFFIX = '__lastSync';
const KEY_TIMESTAMPS_SUFFIX = '__keyTimestamps';

// ---------------------------------------------------------------------------
// Per-key timestamp utilities
// ---------------------------------------------------------------------------

/** Wrap flat key-value data with per-key timestamps for sending to server. */
export function wrapWithTimestamps(
  data: Record<string, string>,
  timestamps: Record<string, number>
): Record<string, { v: string; t: number }> {
  const wrapped: Record<string, { v: string; t: number }> = {};
  const now = Date.now();
  for (const [key, value] of Object.entries(data)) {
    wrapped[key] = { v: value, t: timestamps[key] || now };
  }
  return wrapped;
}

/** Unwrap { v, t } format from server response to flat values + timestamps. */
export function unwrapFromTimestamps(
  data: Record<string, unknown>
): { values: Record<string, string>; timestamps: Record<string, number> } {
  const values: Record<string, string> = {};
  const timestamps: Record<string, number> = {};
  for (const [key, entry] of Object.entries(data)) {
    if (entry && typeof entry === 'object' && 'v' in entry && 't' in entry) {
      const e = entry as { v: string; t: number };
      values[key] = e.v;
      timestamps[key] = e.t;
    } else {
      values[key] = String(entry);
      timestamps[key] = 0;
    }
  }
  return { values, timestamps };
}

/** Compare previous and current collected data, update timestamps for changed keys. */
export function updateKeyTimestamps(
  prev: Record<string, string> | null,
  curr: Record<string, string>,
  existingTimestamps: Record<string, number>,
  now: number
): Record<string, number> {
  const updated = { ...existingTimestamps };
  for (const [key, value] of Object.entries(curr)) {
    if (!prev || prev[key] !== value) {
      updated[key] = now;
    }
  }
  return updated;
}

// ---------------------------------------------------------------------------
// localStorage helpers
// ---------------------------------------------------------------------------

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
    if (
      key &&
      key.startsWith(keyPrefix) &&
      !key.endsWith(LAST_SYNC_SUFFIX) &&
      !key.endsWith(KEY_TIMESTAMPS_SUFFIX)
    ) {
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
 * Get per-key timestamps from localStorage.
 */
function getKeyTimestamps(
  prefix: string,
  uid: string
): Record<string, number> {
  const key = `${prefix}${uid}${KEY_TIMESTAMPS_SUFFIX}`;
  const val = window.localStorage.getItem(key);
  if (!val) return {};
  try {
    return JSON.parse(val) as Record<string, number>;
  } catch {
    return {};
  }
}

/**
 * Store per-key timestamps in localStorage.
 */
function setKeyTimestamps(
  prefix: string,
  uid: string,
  timestamps: Record<string, number>
): void {
  const key = `${prefix}${uid}${KEY_TIMESTAMPS_SUFFIX}`;
  window.localStorage.setItem(key, JSON.stringify(timestamps));
}

// ---------------------------------------------------------------------------
// Bidirectional sync flow
// ---------------------------------------------------------------------------

/**
 * Bidirectional sync: collect local data, push with per-key timestamps,
 * receive merged result from server, and restore locally.
 *
 * Flow:
 * 1. Collect local data via collectData()
 * 2. Load per-key timestamps from localStorage
 * 3. Wrap with timestamps: { key: value } -> { key: { v: value, t: timestamp } }
 * 4. POST to server (always — no more pull-OR-push decision)
 * 5. Server merges per-key, returns merged result
 * 6. Unwrap: { key: { v, t } } -> { key: value }
 * 7. Call restoreData(unwrapped) to apply merged result
 * 8. Store per-key timestamps locally
 */
async function bidirectionalSync(
  syncApiUrl: string,
  uid: string,
  appId: string,
  prefix: string,
  customCollect?: () => Record<string, string>,
  customRestore?: (data: Record<string, string>) => void
): Promise<void> {
  // 1. Collect local data
  const data = customCollect
    ? customCollect()
    : collectLocalData(prefix, uid);

  // 2. Load per-key timestamps
  const keyTimestamps = getKeyTimestamps(prefix, uid);

  // 3. Wrap with timestamps
  const wrapped = wrapWithTimestamps(data, keyTimestamps);

  // 4. POST to server — always push, server merges per-key
  const response = await writeRecord(syncApiUrl, uid, appId, wrapped);

  // 5-6. Unwrap merged result from server
  const { values: mergedValues, timestamps: mergedTimestamps } =
    unwrapFromTimestamps(response.data);

  // 7. Restore merged data locally
  if (customRestore) {
    customRestore(mergedValues);
  } else {
    for (const [key, value] of Object.entries(mergedValues)) {
      window.localStorage.setItem(key, value);
    }
  }

  // 8. Store per-key timestamps + lastSync
  setKeyTimestamps(prefix, uid, mergedTimestamps);
  setLocalLastSync(prefix, uid, response.lastSync);
}

/**
 * Sync localStorage with server on startup.
 * Always uses bidirectional sync (push + merge).
 */
async function syncOnStartup(
  syncApiUrl: string,
  uid: string,
  appId: string,
  prefix: string,
  customCollect?: () => Record<string, string>,
  customRestore?: (data: Record<string, string>) => void
): Promise<void> {
  await bidirectionalSync(
    syncApiUrl,
    uid,
    appId,
    prefix,
    customCollect,
    customRestore
  );
}

/**
 * Push local data to server using bidirectional sync.
 */
async function pushToServer(
  syncApiUrl: string,
  uid: string,
  appId: string,
  prefix: string,
  customCollect?: () => Record<string, string>,
  customRestore?: (data: Record<string, string>) => void
): Promise<void> {
  await bidirectionalSync(
    syncApiUrl,
    uid,
    appId,
    prefix,
    customCollect,
    customRestore
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the event sync system.
 *
 * 1. Checks if the user is logged in to Jutor.
 * 2. Bidirectional sync on startup (always push+merge).
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

  // 2. Bidirectional sync on startup
  await syncOnStartup(
    syncApiUrl,
    user.uid,
    appId,
    prefix,
    customCollect,
    customRestore
  );

  // 3. Periodic sync (with error handling to prevent silent failures)
  const intervalId = setInterval(async () => {
    try {
      await pushToServer(
        syncApiUrl,
        user.uid,
        appId,
        prefix,
        customCollect,
        customRestore
      );
    } catch (err) {
      console.error('[event-sync] periodic sync failed:', err);
    }
  }, syncIntervalMs);

  // 4. beforeunload + visibilitychange handlers for best-effort save
  const saveHandler = () => {
    pushToServer(
      syncApiUrl,
      user.uid,
      appId,
      prefix,
      customCollect,
      customRestore
    ).catch(() => {});
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
    syncNow: () =>
      pushToServer(
        syncApiUrl,
        user.uid,
        appId,
        prefix,
        customCollect,
        customRestore
      ),
    destroy: () => {
      clearInterval(intervalId);
      window.removeEventListener('beforeunload', saveHandler);
    },
  };
}
