import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import { getAuth, signInWithCustomToken, type Auth } from 'firebase/auth';
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  type Firestore,
} from 'firebase/firestore';

let app: FirebaseApp | null = null;
let auth: Auth | null = null;
let db: Firestore | null = null;

export function initFirebase(config: Record<string, string>) {
  if (getApps().length === 0) {
    app = initializeApp(config);
  } else {
    app = getApps()[0];
  }
  auth = getAuth(app);
  db = getFirestore(app);
  return { app, auth, db };
}

export async function signInWithToken(token: string): Promise<void> {
  if (!auth) throw new Error('Firebase not initialized');
  await signInWithCustomToken(auth, token);
}

export function getDocRef(uid: string, appId: string) {
  if (!db) throw new Error('Firebase not initialized');
  return doc(db, 'event-records', uid, 'apps', appId);
}

export async function readRecord(
  uid: string,
  appId: string
): Promise<{ data: Record<string, string>; lastSync: number } | null> {
  const ref = getDocRef(uid, appId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;
  return snap.data() as { data: Record<string, string>; lastSync: number };
}

export async function writeRecord(
  uid: string,
  appId: string,
  data: Record<string, string>
): Promise<void> {
  const ref = getDocRef(uid, appId);
  await setDoc(ref, { data, lastSync: Date.now() }, { merge: true });
}
