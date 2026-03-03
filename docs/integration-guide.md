# Jutor Event Sync — Integration Guide

> For both humans and Claude Code: everything needed to add Jutor SSO login + cross-device sync to a new `/event/[app]`.

## Architecture

```
┌──────────────┐     REST API      ┌─────────────────────┐      Firestore SDK
│  Event App   │ ←──────────────→  │ speech-token-server  │ ←──────────────→  Firestore
│ (React/Vite) │   GET/POST sync   │   (Cloud Run)        │                   event-records/
│              │                   │                      │                    {uid}/apps/{appId}
│ localStorage │                   │  Per-key merge       │
│ ↕ vendor lib │                   │  (timestamp-based)   │
└──────────────┘                   └─────────────────────┘
```

**Key design decisions:**
- Apps never talk to Firestore directly — all sync goes through the REST API
- Per-key timestamps ensure no data loss during concurrent edits across devices
- Jutor SSO uses session cookies (requires `*.jutor.ai` domain)
- Guest users get full app functionality but no cross-device sync

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
  localStoragePrefix: string;    // e.g., 'reading_'
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

## Step-by-Step Integration (React + Vite)

### 1. Vendor the library

```bash
mkdir -p vendor/jutor-event-sync
cp jutor-event-sync/client/dist/* vendor/jutor-event-sync/
```

### 2. Vite alias

```typescript
// vite.config.ts
resolve: {
  alias: {
    '@jutor-event/sync': path.resolve(__dirname, 'vendor/jutor-event-sync/index.js'),
  },
},
```

### 3. Create sync wrapper

Create `src/lib/eventSync.ts` — wraps the vendor library with app-specific config:
- Set `appId` and `localStoragePrefix`
- Implement `collectData()` to gather app localStorage keys
- Implement `restoreData()` to write synced data back
- Export `initSync()`, `getSyncInstance()`, `redirectToJutorLogin()`, `redirectToJutorLogout()`

### 4. Create auth context

Create `src/context/UserContext.tsx`:
- `UserProvider` — wraps the app, calls `initSync()` on mount
- `useUser()` hook — provides `user`, `isLoggedIn`, `syncReady`, `login`, `logout`
- Auto-detects Jutor session and creates user from `JutorUser`
- Guest login via form (name + studentId)
- Logout: Jutor users redirect to `/logout`, guests stay local

### 5. Create login gate

Create `src/components/LoginGate.tsx`:
- Shows loading spinner while `syncReady === false`
- Shows login screen with Jutor SSO button + guest form
- Renders children when `isLoggedIn === true`

### 6. Wrap the app

```tsx
<UserProvider>
  <LoginGate>
    <YourApp />
  </LoginGate>
</UserProvider>
```

### 7. Register in monitoring

Add the new `appId` to `KNOWN_APP_IDS` in `jutor-event-sync/gas/Firestore.js` (line 8), then `clasp push --force`.

## Sync API Endpoints

**Base URL:** `https://speech-token-server-819106170113.asia-east1.run.app/api/event/sync`

### GET `?uid={uid}&appId={appId}`
Returns current Firestore data for this user+app.

### POST `{uid, appId, data}`
Performs per-key merge. Request body `data` uses `{v: string, t: number}` format per key. Server merges by comparing timestamps, always keeping the newer value. Returns the merged result.

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

## Monitoring

The GAS project at `jutor-event-sync/gas/` runs daily at 08:00 Asia/Taipei:
- Queries all app documents via collection group query
- Computes metrics (active users, key counts, sync freshness)
- Writes to Google Sheet
- Sends Slack notification

**Adding a new app to monitoring:** Edit `KNOWN_APP_IDS` in `Firestore.js:8` and `clasp push --force`.

## Existing Integrations

| App | Type | appId | localStorage prefix |
|-----|------|-------|-------------------|
| Namiya (4 apps) | React monorepo | `namiya` | `namiya_` |
| Speak Sentence | Vanilla JS | `speak-sentence` | `speak_sentence_` |
| Speak Passage | Vanilla JS | `speak-passage` | `speak_passage_` |

## Common Pitfalls

1. **SSO only works on `*.jutor.ai`** — Local dev won't detect Jutor sessions. Test SSO on deployed URL only.
2. **`localStoragePrefix` must end with `_`** — The collector uses `startsWith()` matching.
3. **Exclude device-specific keys** — `__lastSync`, `__keyTimestamps`, `_current_user` must never sync.
4. **Don't forget GAS registration** — New apps won't appear in daily reports without adding to `KNOWN_APP_IDS`.
5. **Jutor URL whitelist is required** — Without it, the login redirect will fail or loop. Contact the Jutor backend team.
