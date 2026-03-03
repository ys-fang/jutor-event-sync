# Jutor Event Sync — Integration Guide

> Single source of truth for adding Jutor SSO login + cross-device sync to any `/event/[app]`.
> For both humans and Claude Code. Code templates available via the `/add-jutor-login` skill.

## Table of Contents

1. [Architecture](#architecture)
2. [Repository Structure](#repository-structure)
3. [Client Library API](#client-library-api)
4. [UI Reference](#ui-reference)
5. [App Init Flow](#app-init-flow)
6. [Integration: React + Vite](#integration-react--vite)
7. [Integration: Vanilla JS + Vite](#integration-vanilla-js--vite)
8. [Sync API Endpoints](#sync-api-endpoints)
9. [Firestore Document Structure](#firestore-document-structure)
10. [Monitoring (GAS)](#monitoring-gas)
11. [Testing Checklist](#testing-checklist)
12. [Known Gotchas and Lessons Learned](#known-gotchas-and-lessons-learned)
13. [CI/CD Notes](#cicd-notes)
14. [Existing Integrations](#existing-integrations)

---

## Architecture

```
┌──────────────┐     REST API      ┌─────────────────────┐      Firestore SDK
│  Event App   │ ←──────────────→  │ speech-token-server  │ ←──────────────→  Firestore
│ (React/Vite  │   GET/POST sync   │   (Cloud Run)        │                   event-records/
│  or Vanilla) │                   │                      │                    {uid}/apps/{appId}
│              │                   │  Per-key merge       │
│ localStorage │                   │  (timestamp-based)   │
│ ↕ vendor lib │                   └─────────────────────┘
└──────────────┘
```

**Key design decisions:**
- Apps never talk to Firestore directly — all sync goes through the REST API
- Per-key timestamps ensure no data loss during concurrent edits across devices
- Jutor SSO uses session cookies (requires `*.jutor.ai` domain)
- Guest users get full app functionality but no cross-device sync
- No Firebase client SDK on the browser side

---

## Repository Structure

```
jutor-event-sync/
├── client/              # TypeScript sync library
│   ├── src/             # Source (auth.ts, sync.ts, sync-api.ts, types.ts)
│   └── dist/            # Built output → vendor into apps
├── functions/           # Cloud Functions (sync API on speech-token-server)
├── gas/                 # Google Apps Script (daily usage monitoring)
│   └── Firestore.js     # KNOWN_APP_IDS array (line 8) — add new apps here
├── docs/                # This guide
└── firebase.json        # Firebase project config
```

---

## Client Library API

### Exports from `@jutor-event/sync`

```typescript
// Initialize sync — auto-detects Jutor session, sets up periodic sync
initEventSync(config: EventSyncConfig): Promise<EventSyncInstance>

// Utility functions
collectLocalData(prefix: string, uid: string): Record<string, string>
wrapWithTimestamps(data, timestamps): Record<string, {v: string, t: number}>
unwrapFromTimestamps(data): {values, timestamps}
updateKeyTimestamps(prev, curr, existing, now): Record<string, number>

// Direct API access (rarely needed — initEventSync handles this)
readRecord(url, uid, appId): Promise<{data, lastSync}>
writeRecord(url, uid, appId, data): Promise<{data, lastSync}>

// Auth
fetchJutorUser(apiBase: string): Promise<JutorUser | null>
```

### EventSyncConfig

```typescript
interface EventSyncConfig {
  appId: string;                 // Unique app ID in Firestore
  localStoragePrefix: string;    // e.g., 'reading_' (must end with _)
  syncApiUrl: string;            // Always: speech-token-server URL
  syncIntervalMs?: number;       // Default: 300000 (5 min)
  collectData?: () => Record<string, string>;   // Custom collector
  restoreData?: (data) => void;                 // Custom restorer
}
```

### EventSyncInstance

```typescript
interface EventSyncInstance {
  user: JutorUser | null;        // null if not logged in
  isLoggedIn: boolean;
  redirectToLogin: () => void;   // Redirect to Jutor login
  syncNow: () => Promise<void>;  // Force immediate sync
  destroy: () => void;           // Cleanup timers/listeners
}
```

### JutorUser

```typescript
interface JutorUser {
  uid: string;
  userName: string;
  email?: string;
  grade?: string;
  class?: string;
  schoolName?: string;
}
```

---

## UI Reference

### Login Screen (Welcome Modal)

Two-button layout: Jutor SSO (primary) + Guest trial (secondary).

```
┌─────────────────────────────────────┐
│         [App Logo]                  │
│                                     │
│    {APP_TITLE}                      │
│                                     │
│  登入後可跨裝置同步學習紀錄           │
│                                     │
│  ┌───────────────────────────────┐  │
│  │  🔑  登入 / 註冊 Jutor 帳號   │  │  ← primary CTA
│  └───────────────────────────────┘  │
│                                     │
│       ── 或 ──                      │
│                                     │
│  ┌───────────────────────────────┐  │
│  │  👀  先體驗看看（不需帳號）    │  │  ← secondary
│  └───────────────────────────────┘  │
│                                     │
│  ⚠️ 體驗模式的紀錄僅保存在此裝置     │
└─────────────────────────────────────┘
```

### User Menu Modal

Different content for Jutor vs guest users:

**Jutor user (isGuest: false):**
```
┌──────────────────────────────────┐
│  目前帳號                         │
│  👤 {name}                       │
│  ☁️ 跨裝置同步已啟用              │
│                                   │
│  [取消]              [登出]       │
└──────────────────────────────────┘
```

**Guest user (isGuest: true):**
```
┌──────────────────────────────────┐
│  目前為體驗模式                    │
│  ⚠️ 紀錄僅保存在此裝置            │
│  登入 Jutor 帳號可跨裝置           │
│  保存你的學習紀錄                  │
│                                   │
│  [取消]          [登入 Jutor]     │
└──────────────────────────────────┘
```

### User Identity Model

```javascript
user = {
  uid: string,       // Jutor uid OR random UUID (guest)
  name: string,      // Jutor userName OR form input / "體驗用戶"
  isGuest: boolean,  // true = trial mode, false = Jutor account
}
```

| Identity | uid source | Cross-device sync | Data persistence |
|----------|-----------|-------------------|-----------------|
| Jutor user | `JutorUser.uid` | Yes | Cloud + local |
| Guest | Form input or `crypto.randomUUID()` | No | Local only |

---

## App Init Flow

```
init()
  │
  ├─ await initSync()
  │     └─ fetchJutorUser() → JutorUser | null
  │
  ├─ checkAutoLogin()
  │     │
  │     ├─ syncInstance.isLoggedIn?
  │     │   ├─ YES → create user from JutorUser → enter app
  │     │   └─ NO  → check localStorage for saved user
  │     │             ├─ valid user found → restore → enter app
  │     │             └─ none → show login screen
  │     │
  │     └─ Edge case: saved user is Jutor but session expired
  │        → clear user → show login screen
  │
  └─ initApp() (if user resolved)
```

**Key behaviors:**
1. **Jutor redirect return**: User returns from `jutor.ai/login` → `fetchJutorUser()` succeeds → auto-login
2. **Returning Jutor user**: Cookie still valid → auto-login
3. **Returning guest**: `currentUser` in localStorage → restore session
4. **Expired session**: Had Jutor user but cookie expired → clear, show login
5. **First visit**: No user, not logged in → show login screen

**Critical**: `initSync()` must be called **before** user identity decisions. The sync instance determines whether a Jutor session exists.

---

## Integration: React + Vite

Full code templates available via the `/add-jutor-login` skill.

### 1. Vendor the library

```bash
mkdir -p vendor/jutor-event-sync
cp /path/to/jutor-event-sync/client/dist/* vendor/jutor-event-sync/
```

### 2. Vite alias

```typescript
resolve: {
  alias: {
    '@jutor-event/sync': path.resolve(__dirname, 'vendor/jutor-event-sync/index.js'),
  },
},
```

### 3. Create files

| File | Purpose |
|------|---------|
| `src/lib/eventSync.ts` | Sync wrapper: `initSync()`, `redirectToJutorLogin/Logout()` |
| `src/context/UserContext.tsx` | `UserProvider` + `useUser()` hook |
| `src/components/LoginGate.tsx` | Login screen (Jutor SSO + guest form) |
| `src/components/TopBar.tsx` | User menu with logout |

### 4. Wrap the app

```tsx
<UserProvider>
  <LoginGate>
    <YourApp />
  </LoginGate>
</UserProvider>
```

---

## Integration: Vanilla JS + Vite

For non-React apps (like Speak Sentence/Passage). Same vendor library, different UI approach.

### 1-2. Vendor + Vite alias

Same as React (see above).

### 3. Create files

| File | Purpose |
|------|---------|
| `src/config.js` | App constants (`APP_ID`, `LS_PREFIX`, `SYNC_API_URL`) |
| `src/state.js` | State management (`currentUser`, `syncInstance`) |
| `src/user.js` | Identity logic (`loginJutorUser`, `loginAsGuest`, `logoutUser`, `loadCurrentUser`) |
| `src/eventSync.js` | Sync wrapper with `collectData`/`restoreData` |
| `index.html` | Login modal + switch modal HTML |
| `src/styles.css` | Modal styles (`.login-modal`, `.switch-modal`) |
| `src/main.js` | Init orchestration: `initSync()` → user check → UI setup |

### 4. Key differences from React

- No `UserProvider`/`useUser()` — use module-level state (`state.js`)
- No `LoginGate` component — show/hide modals via DOM manipulation
- Login buttons use `addEventListener` instead of `onClick`
- Guest UID often uses `crypto.randomUUID()` instead of form input
- Modal HTML lives in `index.html`, not JSX

---

## Sync API Endpoints

**Base URL:** `https://speech-token-server-819106170113.asia-east1.run.app/api/event/sync`

### GET `?uid={uid}&appId={appId}`
Returns current Firestore data for this user+app.

### POST `{uid, appId, data}`
Performs per-key merge. Request body `data` uses `{v: string, t: number}` format per key. Server merges by comparing timestamps, always keeping the newer value. Returns the merged result.

**Per-key merge details:**
- Each key independently keeps the newest version (by timestamp)
- Server wins ties (same timestamp)
- Old Firestore data (plain strings) auto-converts to `{v, t}` format on first POST
- Bidirectional every time — client always pushes local data and receives merged result
- `__keyTimestamps` stored locally for conflict resolution, never synced

---

## Firestore Document Structure

```
event-records/
  {uid}/                    # User document (phantom — no fields)
    apps/
      {appId}/              # App document
        data: {             # Synced key-value pairs
          "key1": { v: "value", t: 1709500000000 },
          "key2": { v: "value", t: 1709500000001 },
        }
        lastSync: 1709500000001
```

---

## Monitoring (GAS)

The GAS project at `jutor-event-sync/gas/` runs daily at 08:00 Asia/Taipei:
- Queries all app documents via Firestore collection group query
- Computes metrics (active users, key counts, sync freshness)
- Writes to Google Sheet
- Sends Slack notification

**Adding a new app:** Edit `KNOWN_APP_IDS` in `gas/Firestore.js:8` → `clasp push --force`.

---

## Testing Checklist

### Manual Testing Flow

1. **Fresh visit** (no cookies, no localStorage): Login screen appears
2. **Click "先體驗看看"**: Guest mode, app loads, toast "歡迎體驗！紀錄將保存在此裝置"
3. **Use the app**: Create some data (progress, settings)
4. **Click user icon → "登入 Jutor"**: Redirects to `jutor.ai/login`
5. **Login on Jutor**: Redirects back, auto-login with Jutor identity
6. **Refresh page**: Auto-login without seeing login screen
7. **Click user icon → "登出"**: Returns to login screen
8. **Refresh after logout**: Still shows login screen (not auto-login)
9. **Click "登入 Jutor"**: Redirects, returns, auto-login works

### Cross-Device Test

1. Login on Device A, create app data
2. Wait for sync (~5 min) or trigger: `getSyncInstance().syncNow()`
3. Login on Device B with same Jutor account
4. Verify data appears on Device B
5. Make changes on Device B, wait for sync
6. Refresh Device A — changes should propagate

### Guest Mode

- No sync API calls made (check Network tab for `/api/event/sync`)
- Guest data is local only, does not appear on other devices

### Edge Cases

- **Expired Jutor session**: `fetchJutorUser()` returns null → user logged out, login screen shown
- **Network errors during sync**: `initSync()` catches errors, returns null → app works without sync
- **Concurrent tabs**: Both tabs sync periodically, per-key merge handles conflicts
- **localStorage full**: `restoreData()` may throw — sync library handles gracefully

---

## Known Gotchas and Lessons Learned

### 1. SSO only works on `*.jutor.ai` domain

`fetchJutorUser()` relies on Jutor session cookies. These cookies are only sent when the app is served from `*.jutor.ai`. Local development (`localhost`) will never detect a Jutor session. Always test SSO on the deployed production URL.

### 2. SA key deployment format (Cloud Run)

The service account key JSON contains commas, which breaks `--set-env-vars`. Use `--env-vars-file`:

```bash
# WRONG — commas in JSON break parsing:
gcloud run deploy --set-env-vars FIREBASE_EVENT_SA_KEY='{"type":"service_account",...}'

# CORRECT:
python3 -c "import json; ..." > /tmp/env.yaml
gcloud run deploy --env-vars-file /tmp/env.yaml
```

### 3. Vendor path must point to dist, not source

```javascript
// CORRECT — pre-built dist:
'@jutor-event/sync': resolve(__dirname, 'vendor/jutor-event-sync/index.js')

// WRONG — TypeScript source (won't resolve):
'@jutor-event/sync': resolve(__dirname, '../../jutor-event-sync/client/src/index.ts')
```

### 4. Logout flag exclusion (speak apps)

In speak apps using a `_logged_out` localStorage flag: this flag **must** be in `EXCLUDE_SUFFIXES` for both collect AND restore. Without exclusion, the flag syncs to Firestore, then restores on login — permanently blocking the user on the login screen. This was a real production bug.

React/Namiya apps avoid this by redirecting to `jutor.ai/logout` (clears the cookie server-side).

### 5. `localStoragePrefix` must end with `_`

The collector uses `key.startsWith(prefix)`. Without the trailing underscore, a prefix like `speak` would match `speakFoo`, `speakBar`, etc. Always use `speak_sentence_`, not `speak_sentence`.

### 6. Custom collectData/restoreData are almost always needed

The library's default collector assumes keys follow `${prefix}${uid}_*`. Most apps store keys differently (e.g., `${prefix}key` without uid), so custom functions are required. Always provide them.

### 7. appId must be unique per app

The `appId` determines the Firestore document path `event-records/{uid}/apps/{appId}`. If two apps share the same `appId`, their data overwrites each other. Convention: `'speak-sentence'`, `'namiya'`, etc.

### 8. EXCLUDE_SUFFIXES reference

These suffixes must always be excluded from sync (both collect AND restore):

| Suffix | Reason |
|--------|--------|
| `__lastSync` | Internal sync timestamp — syncing causes conflicts |
| `__keyTimestamps` | Per-key merge timestamps — device-local tracking |
| `_current_user` | Saved user identity — device-specific |
| `_logged_out` | Logout flag (speak apps) — syncing blocks re-login |
| `rate_limit_tracker` | Device-specific rate limits |

### 9. initSync() must run before user identity check

The init flow must `await initSync()` before checking for saved users. Sync may restore data (including `current_user`) and the Jutor user detection depends on the sync instance.

### 10. Sync API URL is absolute

```
https://speech-token-server-819106170113.asia-east1.run.app/api/event/sync
```

The frontend is served from GCS (different domain than Cloud Run), so the URL must be absolute, not relative.

### 11. Don't forget GAS registration

New apps won't appear in daily monitoring reports without adding to `KNOWN_APP_IDS` in `gas/Firestore.js:8`. This is the most commonly forgotten step.

---

## CI/CD Notes

### Frontend Deployment

- GitHub Actions workflow deploys to GCS via `gsutil rsync`
- Base path must match `vite.config` base: `/event/{app-path}/`
- Path-filtered triggers: only changes in the app's directory trigger its workflow

### Adding a New App Workflow

Copy from an existing workflow (e.g., `deploy-sentence.yml`) and update:
1. Trigger paths (`sentence/**` → `myapp/**`)
2. Build directory
3. GCS destination path
4. Base path in `vite.config`

### Backend Deployment

- Cloud Run via GitHub Actions
- Uses `--env-vars-file` for JSON-containing env vars (see gotcha #2)
- `FIREBASE_EVENT_SA_KEY` stored as GitHub secret

---

## Existing Integrations

| App | Type | appId | localStorage prefix | Repo |
|-----|------|-------|-------------------|------|
| Namiya (portal, vocab800, vocab1200, grammar) | React monorepo | `namiya` | `namiya_` | `prj_Andy/Namiya/` |
| Speak Sentence | Vanilla JS | `speak-sentence` | `sentence_` | `speak/sentence/` |
| Speak Passage | Vanilla JS | `speak-passage` | `passage_` | `speak/passage/` |

---

## Constants Quick Reference

| Constant | Value |
|----------|-------|
| Sync API URL | `https://speech-token-server-819106170113.asia-east1.run.app/api/event/sync` |
| Jutor Login URL | `https://www.jutor.ai/login?continue={encoded_url}` |
| Jutor Logout URL | `https://www.jutor.ai/logout?continue={encoded_url}` |
| Firebase Project | `jutor-event` |
| Firestore Path | `event-records/{uid}/apps/{appId}` |
| GCS Bucket | `jutor-event-di1dzdgl64` |
| GAS Script ID | `1GKDRgCQTfP3jmo7qfkq_AsfZBe5DURREExJeNd2Oi7Rw_04CIatGmc0U` |
