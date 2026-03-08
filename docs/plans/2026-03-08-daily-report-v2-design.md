# Daily Report v2 — Design

## Goals

1. **Ops guard** — monitor Firestore usage (reads/writes/storage) to stay within limits
2. **Product signal** — track which MVPs are popular enough to promote to production
3. **Auto-discovery** — no hardcoded app list; discover all apps dynamically
4. **Sheet as canonical history** — all metrics append-only in Google Sheets

## Approach: All-in-GAS

Extend the existing GAS codebase. Add Cloud Monitoring API access via a second JWT scope (`monitoring.read`) to fetch Firestore operation metrics directly from GAS.

## Auto-Discovery

Remove `KNOWN_APP_IDS`. The collection group query already returns all `apps` subcollections. Group results by `appId` to discover apps dynamically.

```
Before: KNOWN_APP_IDS = ['namiya', ...]  → filter docs
After:  Query all docs → group by appId → discover apps automatically
```

## Metrics

### Per-App Metrics (from Firestore docs)

| Metric | How |
|--------|-----|
| Doc count | Count docs per appId |
| Total keys | Sum all data keys across users per app |
| Est. storage (KB) | JSON.stringify each doc's data, sum byte length |
| Active 24h / 7d | Compare lastSync timestamps |
| Total users | Count unique UIDs per app |
| New users (day-over-day) | Compare with Sheet history |

### Firestore Ops (from Cloud Monitoring API)

| Metric | Cloud Monitoring metric type |
|--------|-----|
| Reads (24h) | `firestore.googleapis.com/document/read_count` |
| Writes (24h) | `firestore.googleapis.com/document/write_count` |
| Deletes (24h) | `firestore.googleapis.com/document/delete_count` |
| Stored bytes | `firestore.googleapis.com/document/stored_bytes` |

Auth: Reuse `Auth.js` service account JWT pattern, add `monitoring.read` scope.

## Sheet Structure

Two sheets in the same spreadsheet:

**Sheet: "App Metrics"** (one row per app per day)

```
Date | App | DocCount | TotalKeys | EstStorageKB | Active24h | Active7d | TotalUsers | NewUsers
```

**Sheet: "Firestore Ops"** (one row per day, project-level)

```
Date | Reads | Writes | Deletes | StoredBytes | StoredMB
```

Both are append-only. Yesterday's data is read from the sheet for delta calculations.

## Slack Message Format

```
:bar_chart: *Event Sync — Daily Report (2026-03-08)*

:fire: *Firestore Health*
  Reads (24h): 12,340 / 50,000 (24.7%)
  Writes (24h): 3,210 / 20,000 (16.1%)
  Storage: 45.2 MB / 1,024 MB (4.4%)

:iphone: *App Usage (24h)* — 7 apps discovered
  namiya: *142* users (+5) · 1,823 docs · 48.2 KB
  speak-sentence: *87* users (-3) · 952 docs · 22.1 KB
  vocabwall: *64* users (+12) · 445 docs · 15.8 KB
  vocabprint: *31* users (new!) · 112 docs · 3.2 KB
  ...

:busts_in_silhouette: Total: *324* active · *1,247* registered · +18 new today
:chart_with_upwards_trend: 7-Day Active: *456*

:white_check_mark: No alerts
:linked_paperclips: <https://docs.google.com/spreadsheets/d/SHEET_ID|View full history>
```

## Alerts

| Condition | Threshold |
|-----------|-----------|
| Firestore reads/writes | > 70% of free tier |
| Storage | > 70% of 1 GiB |
| 24h active drop | > 30% vs yesterday |
| Growth spike | > 3x previous day |

## Configuration

- **Schedule:** 09:00 Asia/Taipei daily (changed from 08:00)
- **Free tier limits:** Constants in code (50K reads, 20K writes, 1 GiB storage)
- **No hardcoded app list**

## Files to Modify

| File | Changes |
|------|---------|
| `gas/Firestore.js` | Remove `KNOWN_APP_IDS`, add auto-discovery, add doc count & storage estimation |
| `gas/Auth.js` | Add monitoring scope support |
| `gas/Metrics.js` | Add Cloud Monitoring API calls, new metric aggregation |
| `gas/Slack.js` | New message format with Firestore health, Sheet link |
| `gas/Sheet.js` | Two-sheet structure, new columns, read yesterday for both sheets |
| `gas/Main.js` | Update `dailyReport()` orchestration, new alert rules, 09:00 trigger |
