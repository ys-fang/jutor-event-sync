import type { EventSyncConfig, EventSyncInstance, JutorUser } from './types.js';
import { fetchJutorUser, requestMintToken } from './auth.js';
import {
  initFirebase,
  signInWithToken,
  readRecord,
  writeRecord,
} from './firebase-client.js';

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
 * Pull remote data from Firestore if it is newer than local.
 * Overwrites matching localStorage keys with remote values.
 */
async function pullFromFirestore(
  uid: string,
  appId: string,
  prefix: string
): Promise<void> {
  const remote = await readRecord(uid, appId);
  const localLastSync = getLocalLastSync(prefix, uid);

  if (remote && remote.lastSync > localLastSync) {
    // Remote is newer — overwrite localStorage
    for (const [key, value] of Object.entries(remote.data)) {
      window.localStorage.setItem(key, value);
    }
    setLocalLastSync(prefix, uid, remote.lastSync);
  } else {
    // Local is newer or no remote record — push to Firestore
    await pushToFirestore(uid, appId, prefix);
  }
}

/**
 * Collect localStorage data and write it to Firestore.
 */
async function pushToFirestore(
  uid: string,
  appId: string,
  prefix: string
): Promise<void> {
  const data = collectLocalData(prefix, uid);
  await writeRecord(uid, appId, data);
  setLocalLastSync(prefix, uid, Date.now());
}

/**
 * Initialize the event sync system.
 *
 * 1. Checks if the user is logged in to Jutor.
 * 2. Initializes Firebase and authenticates with a custom token.
 * 3. Pulls from Firestore on startup (if remote is newer).
 * 4. Sets up periodic sync and beforeunload handler.
 * 5. Returns an EventSyncInstance.
 */
export async function initEventSync(
  config: EventSyncConfig
): Promise<EventSyncInstance> {
  const {
    appId,
    localStoragePrefix: prefix,
    jutorApiBase,
    mintTokenUrl,
    firebaseConfig,
    syncIntervalMs = DEFAULT_SYNC_INTERVAL_MS,
  } = config;

  // 1. Check Jutor session
  const apiBase = jutorApiBase ?? 'https://jutor.com';
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

  // 2. Firebase init + auth
  initFirebase(firebaseConfig);
  const token = await requestMintToken(mintTokenUrl, user.uid);
  await signInWithToken(token);

  // 3. Pull on startup
  await pullFromFirestore(user.uid, appId, prefix);

  // 4. Periodic sync
  const intervalId = setInterval(async () => {
    await pushToFirestore(user.uid, appId, prefix);
  }, syncIntervalMs);

  // 5. beforeunload handler
  const beforeUnloadHandler = () => {
    // Best-effort push — synchronous context, so we fire and forget
    pushToFirestore(user.uid, appId, prefix);
  };
  window.addEventListener('beforeunload', beforeUnloadHandler);

  // Return instance
  return {
    user,
    isLoggedIn: true,
    redirectToLogin: () => {
      window.location.href = `${apiBase}/login`;
    },
    syncNow: () => pushToFirestore(user.uid, appId, prefix),
    destroy: () => {
      clearInterval(intervalId);
      window.removeEventListener('beforeunload', beforeUnloadHandler);
    },
  };
}
