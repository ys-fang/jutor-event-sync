# Daily Report v2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enhance the GAS daily report with auto-discovery of apps, Firestore ops monitoring via Cloud Monitoring API, two-sheet history, and improved Slack message with health indicators.

**Architecture:** All-in-GAS. Extend the existing Auth.js JWT pattern with a second scope (`monitoring.read`) to call Cloud Monitoring API. Remove hardcoded KNOWN_APP_IDS — discover apps dynamically from Firestore query results. Two sheets: "App Metrics" (per-app per-day) and "Firestore Ops" (project-level per-day).

**Tech Stack:** Google Apps Script, Firestore REST API, Cloud Monitoring API, Slack Webhooks, Google Sheets

**Testing:** GAS has no automated test framework. Each task is verified via `clasp push` → run `testDailyReport()` in GAS editor → `clasp logs | tail -30`. A dry-run mode is added for safe iterative testing.

**Prerequisite:** The service account used by this script needs the `roles/monitoring.viewer` IAM role in GCP. Run:
```bash
# Get the SA email from Script Properties or .clasp.json
gcloud projects add-iam-policy-binding PROJECT_ID \
  --member="serviceAccount:SA_EMAIL" \
  --role="roles/monitoring.viewer"
```

---

## Task 1: Auth.js — Add monitoring scope support

**Files:**
- Modify: `gas/Auth.js`

**Goal:** Allow getting an access token with either `datastore` scope (for Firestore) or `monitoring.read` scope (for Cloud Monitoring). Keep the existing `getAccessToken()` working unchanged.

**Step 1: Add a scoped token function**

Add after the existing `getAccessToken()` function (line 31):

```javascript
/**
 * Get a valid access token for Cloud Monitoring API calls.
 * Separate cache from Firestore token since scopes differ.
 * @returns {string} Bearer access token
 */
let _cachedMonitoringToken = null;
let _monitoringTokenExpiry = 0;

function getMonitoringAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (_cachedMonitoringToken && now < _monitoringTokenExpiry - 300) {
    return _cachedMonitoringToken;
  }

  const sa = _getServiceAccount();
  const jwt = _createJwtWithScope(sa, now, 'https://www.googleapis.com/auth/monitoring.read');
  const token = _exchangeJwtForToken(jwt);

  _cachedMonitoringToken = token.access_token;
  _monitoringTokenExpiry = now + token.expires_in;
  return _cachedMonitoringToken;
}
```

**Step 2: Refactor _createJwt to accept scope**

Rename `_createJwt` → `_createJwtWithScope` with a scope parameter. Update `_createJwt` to call it with the default scope for backward compatibility:

```javascript
function _createJwt(sa, now) {
  return _createJwtWithScope(sa, now, 'https://www.googleapis.com/auth/datastore');
}

function _createJwtWithScope(sa, now, scope) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: sa.client_email,
    scope: scope,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  const headerB64 = _base64url(JSON.stringify(header));
  const payloadB64 = _base64url(JSON.stringify(payload));
  const signingInput = headerB64 + '.' + payloadB64;

  const signature = Utilities.computeRsaSha256Signature(signingInput, sa.private_key);
  const signatureB64 = _base64url(signature);

  return signingInput + '.' + signatureB64;
}
```

**Step 3: Deploy and verify**

```bash
cd gas && clasp push
```

Run `testDailyReport()` in GAS editor — existing report should still work unchanged.

```bash
clasp logs | tail -10
```

Expected: "Daily report complete." — no errors.

**Step 4: Commit**

```bash
git add gas/Auth.js
git commit -m "feat(gas): add monitoring scope support to Auth.js"
```

---

## Task 2: Firestore.js — Remove hardcoded app list, add storage estimation

**Files:**
- Modify: `gas/Firestore.js`

**Goal:** Remove `KNOWN_APP_IDS`. Return richer doc data (including raw data field for storage estimation). Let callers discover appIds from the results.

**Step 1: Remove KNOWN_APP_IDS and update fetchAllAppDocs**

Replace the entire `gas/Firestore.js` with:

```javascript
/**
 * Firestore.js — Read sync data from Firestore REST API.
 *
 * Uses collection group query on "apps" subcollections under event-records.
 * Auto-discovers all appIds — no hardcoded list.
 */

/**
 * Fetch all app documents across all users via collection group query.
 * Returns a flat array with enough data for metrics and storage estimation.
 *
 * @returns {Array<{ uid: string, appId: string, lastSync: number, keyCount: number, estimatedBytes: number }>}
 */
function fetchAllAppDocs() {
  const projectId = getProjectId();
  const token = getAccessToken();
  const baseUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;

  const results = [];
  let pageToken = null;

  do {
    const query = {
      structuredQuery: {
        from: [{ collectionId: 'apps', allDescendants: true }],
        limit: 300,
      },
    };
    if (pageToken) {
      query.structuredQuery.startAt = { before: false };
    }

    const resp = UrlFetchApp.fetch(`${baseUrl}:runQuery`, {
      method: 'post',
      headers: { 'Authorization': 'Bearer ' + token },
      contentType: 'application/json',
      payload: JSON.stringify(query),
      muteHttpExceptions: true,
    });

    if (resp.getResponseCode() !== 200) {
      console.error('Firestore query failed:', resp.getContentText());
      break;
    }

    const items = JSON.parse(resp.getContentText());

    for (const item of items) {
      if (!item.document) continue;

      const doc = item.document;
      const parts = doc.name.split('/');
      const appId = parts[parts.length - 1];
      const uid = parts[parts.length - 3];
      const fields = doc.fields || {};

      const lastSync = fields.lastSync
        ? Number(fields.lastSync.integerValue || fields.lastSync.doubleValue || 0)
        : 0;

      const dataFields = fields.data && fields.data.mapValue
        ? fields.data.mapValue.fields || {}
        : {};
      const keyCount = Object.keys(dataFields).length;

      // Estimate storage: stringify the data fields to approximate byte size
      let estimatedBytes = 0;
      try {
        estimatedBytes = JSON.stringify(dataFields).length;
      } catch (e) {
        estimatedBytes = 0;
      }

      results.push({ uid, appId, lastSync, keyCount, estimatedBytes });
    }

    pageToken = null; // Single batch for current scale
  } while (pageToken);

  console.log(`Fetched ${results.length} total app documents`);
  return results;
}

/**
 * Extract unique appIds from fetched documents.
 * @param {Array<{ appId: string }>} docs
 * @returns {string[]} Sorted array of unique appIds
 */
function discoverAppIds(docs) {
  const ids = new Set(docs.map(d => d.appId));
  const sorted = Array.from(ids).sort();
  console.log(`Discovered ${sorted.length} apps: ${sorted.join(', ')}`);
  return sorted;
}
```

**Step 2: Deploy and verify**

```bash
cd gas && clasp push
```

Run `testDailyReport()` — will fail because Metrics.js still references `KNOWN_APP_IDS`. That's expected. Check logs:

```bash
clasp logs | tail -10
```

Expected: Error about `KNOWN_APP_IDS` not defined. This confirms the old constant is removed.

**Step 3: Commit**

```bash
git add gas/Firestore.js
git commit -m "feat(gas): auto-discover apps, add storage estimation"
```

---

## Task 3: Metrics.js — Cloud Monitoring API + updated aggregation

**Files:**
- Modify: `gas/Metrics.js`

**Goal:** Replace `KNOWN_APP_IDS` references with dynamic appIds. Add `fetchFirestoreOps()` to call Cloud Monitoring API. Add storage aggregation.

**Step 1: Rewrite Metrics.js**

Replace the entire `gas/Metrics.js` with:

```javascript
/**
 * Metrics.js — Aggregate usage metrics and fetch Firestore operations.
 */

const MS_PER_DAY = 86400000;

/** Free tier limits */
const FIRESTORE_LIMITS = {
  READS_PER_DAY: 50000,
  WRITES_PER_DAY: 20000,
  STORAGE_BYTES: 1073741824, // 1 GiB
};

/**
 * Aggregate metrics from app documents (auto-discovered apps).
 *
 * @param {Array<{ uid: string, appId: string, lastSync: number, keyCount: number, estimatedBytes: number }>} docs
 * @param {string[]} appIds - Discovered app IDs
 * @param {Object|null} yesterday - Previous day's metrics from Sheet
 * @returns {Object} Aggregated metrics
 */
function aggregateMetrics(docs, appIds, yesterday) {
  const now = Date.now();
  const cutoff24h = now - MS_PER_DAY;
  const cutoff7d = now - 7 * MS_PER_DAY;

  // Per-app metrics
  const perApp = {};
  for (const appId of appIds) {
    perApp[appId] = {
      active24h: new Set(),
      active7d: new Set(),
      totalUsers: new Set(),
      totalKeys: 0,
      totalBytes: 0,
    };
  }

  const allUsers = new Set();
  const activeUsers24h = new Set();

  for (const doc of docs) {
    const app = perApp[doc.appId];
    if (!app) continue;

    app.totalUsers.add(doc.uid);
    app.totalKeys += doc.keyCount;
    app.totalBytes += doc.estimatedBytes;
    allUsers.add(doc.uid);

    if (doc.lastSync >= cutoff24h) {
      app.active24h.add(doc.uid);
      activeUsers24h.add(doc.uid);
    }
    if (doc.lastSync >= cutoff7d) {
      app.active7d.add(doc.uid);
    }
  }

  // Build result
  const apps = {};
  let totalActive24h = 0;
  let totalActive7d = 0;

  for (const appId of appIds) {
    const app = perApp[appId];
    const active24h = app.active24h.size;
    const active7d = app.active7d.size;
    const total = app.totalUsers.size;
    const docCount = docs.filter(d => d.appId === appId).length;
    const estStorageKB = Math.round(app.totalBytes / 1024 * 10) / 10;

    let delta24h = null;
    let isNew = false;
    if (yesterday && yesterday[appId]) {
      delta24h = active24h - yesterday[appId].active24h;
    } else if (yesterday) {
      // App exists now but not yesterday — it's new
      isNew = true;
    }

    apps[appId] = { active24h, active7d, total, docCount, totalKeys: app.totalKeys, estStorageKB, delta24h, isNew };
    totalActive24h += active24h;
    totalActive7d += active7d;
  }

  // Growth rate
  let growthRate = null;
  if (yesterday && yesterday._totalRegistered) {
    const diff = allUsers.size - yesterday._totalRegistered;
    growthRate = yesterday._totalRegistered > 0
      ? ((diff / yesterday._totalRegistered) * 100).toFixed(1)
      : null;
  }

  // New users today
  let newUsersToday = null;
  if (yesterday && yesterday._totalRegistered) {
    newUsersToday = allUsers.size - yesterday._totalRegistered;
  }

  return {
    date: _formatDate(new Date()),
    apps,
    appIds,
    totalActive24h,
    totalActive7d,
    totalRegistered: allUsers.size,
    uniqueActiveUsers: activeUsers24h.size,
    growthRate,
    newUsersToday,
  };
}

/**
 * Fetch Firestore operation metrics from Cloud Monitoring API.
 * Returns reads, writes, deletes (last 24h) and stored bytes.
 *
 * @returns {{ reads: number, writes: number, deletes: number, storedBytes: number, storedMB: number }}
 */
function fetchFirestoreOps() {
  const token = getMonitoringAccessToken();
  const projectId = getProjectId();

  const now = new Date();
  const yesterday = new Date(now.getTime() - MS_PER_DAY);
  const endTime = now.toISOString();
  const startTime = yesterday.toISOString();

  const metrics = {
    reads: _queryMetric(token, projectId, 'firestore.googleapis.com/document/read_count', startTime, endTime),
    writes: _queryMetric(token, projectId, 'firestore.googleapis.com/document/write_count', startTime, endTime),
    deletes: _queryMetric(token, projectId, 'firestore.googleapis.com/document/delete_count', startTime, endTime),
    storedBytes: _queryMetric(token, projectId, 'firestore.googleapis.com/document/stored_bytes', startTime, endTime, true),
  };

  metrics.storedMB = Math.round(metrics.storedBytes / 1048576 * 10) / 10;

  console.log(`Firestore ops — reads: ${metrics.reads}, writes: ${metrics.writes}, deletes: ${metrics.deletes}, storage: ${metrics.storedMB} MB`);
  return metrics;
}

/**
 * Query a single metric from Cloud Monitoring API.
 *
 * @param {string} token - Access token
 * @param {string} projectId - GCP project ID
 * @param {string} metricType - Full metric type string
 * @param {string} startTime - ISO timestamp
 * @param {string} endTime - ISO timestamp
 * @param {boolean} [isGauge=false] - If true, use ALIGN_MEAN (for gauge metrics like storage)
 * @returns {number} Aggregated metric value
 */
function _queryMetric(token, projectId, metricType, startTime, endTime, isGauge) {
  const aligner = isGauge ? 'ALIGN_MEAN' : 'ALIGN_SUM';
  const params = [
    `filter=metric.type="${metricType}"`,
    `interval.startTime=${startTime}`,
    `interval.endTime=${endTime}`,
    `aggregation.alignmentPeriod=86400s`,
    `aggregation.perSeriesAligner=${aligner}`,
    `aggregation.crossSeriesReducer=REDUCE_SUM`,
  ].join('&');

  const url = `https://monitoring.googleapis.com/v3/projects/${projectId}/timeSeries?${params}`;

  const resp = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { 'Authorization': 'Bearer ' + token },
    muteHttpExceptions: true,
  });

  if (resp.getResponseCode() !== 200) {
    console.error(`Cloud Monitoring query failed for ${metricType}:`, resp.getContentText());
    return -1; // Indicate error, not zero
  }

  const data = JSON.parse(resp.getContentText());

  // Extract value from time series response
  if (!data.timeSeries || data.timeSeries.length === 0) {
    return 0;
  }

  let total = 0;
  for (const series of data.timeSeries) {
    for (const point of series.points || []) {
      const val = point.value;
      total += Number(val.int64Value || val.doubleValue || 0);
    }
  }

  return Math.round(total);
}

/**
 * Format date as YYYY-MM-DD in Taipei timezone.
 * @param {Date} d
 * @returns {string}
 */
function _formatDate(d) {
  return Utilities.formatDate(d, 'Asia/Taipei', 'yyyy-MM-dd');
}
```

**Step 2: Deploy (will still fail — Sheet.js and Main.js not updated yet)**

```bash
cd gas && clasp push
```

**Step 3: Commit**

```bash
git add gas/Metrics.js
git commit -m "feat(gas): add Cloud Monitoring API, auto-discovered app aggregation"
```

---

## Task 4: Sheet.js — Two-sheet structure

**Files:**
- Modify: `gas/Sheet.js`

**Goal:** Write to two sheets: "App Metrics" (expanded columns) and "Firestore Ops" (project-level). Update `getYesterdayMetrics()` to read from new schema.

**Step 1: Rewrite Sheet.js**

Replace the entire `gas/Sheet.js` with:

```javascript
/**
 * Sheet.js — Append daily metrics to Google Sheets for trend tracking.
 *
 * Sheet ID is stored in Script Properties as SHEET_ID.
 *
 * Two sheets:
 *   "App Metrics"   — one row per app per day
 *   "Firestore Ops" — one row per day (project-level)
 */

const APP_SHEET_NAME = 'App Metrics';
const OPS_SHEET_NAME = 'Firestore Ops';

/**
 * Append today's app metrics (one row per app).
 * @param {Object} metrics - From aggregateMetrics()
 */
function appendAppMetrics(metrics) {
  const sheet = _getOrCreateSheet(APP_SHEET_NAME, [
    'Date', 'App', 'DocCount', 'TotalKeys', 'EstStorageKB', 'Active24h', 'Active7d', 'TotalUsers', 'NewUsers',
  ]);
  if (!sheet) return;

  const yesterday = getYesterdayMetrics();

  for (const appId of metrics.appIds) {
    const app = metrics.apps[appId];
    const prevTotal = yesterday && yesterday[appId] ? yesterday[appId].totalUsers : null;
    const newUsers = prevTotal !== null ? app.total - prevTotal : app.total;

    sheet.appendRow([
      metrics.date,
      appId,
      app.docCount,
      app.totalKeys,
      app.estStorageKB,
      app.active24h,
      app.active7d,
      app.total,
      newUsers,
    ]);
  }

  console.log(`Appended ${metrics.appIds.length} rows to "${APP_SHEET_NAME}" for ${metrics.date}`);
}

/**
 * Append today's Firestore ops (one row, project-level).
 * @param {Object} ops - From fetchFirestoreOps()
 * @param {string} date - YYYY-MM-DD
 */
function appendFirestoreOps(ops, date) {
  const sheet = _getOrCreateSheet(OPS_SHEET_NAME, [
    'Date', 'Reads', 'Writes', 'Deletes', 'StoredBytes', 'StoredMB',
  ]);
  if (!sheet) return;

  sheet.appendRow([
    date,
    ops.reads,
    ops.writes,
    ops.deletes,
    ops.storedBytes,
    ops.storedMB,
  ]);

  console.log(`Appended Firestore ops to "${OPS_SHEET_NAME}" for ${date}`);
}

/**
 * Read yesterday's app metrics from the Sheet (for trend/delta calculation).
 * @returns {Object|null} { [appId]: { active24h, totalUsers }, _totalRegistered } or null
 */
function getYesterdayMetrics() {
  const sheetId = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!sheetId) return null;

  try {
    const ss = SpreadsheetApp.openById(sheetId);
    const sheet = ss.getSheetByName(APP_SHEET_NAME);
    if (!sheet) {
      // Fall back to legacy sheet name
      const legacy = ss.getSheetByName('Daily Metrics');
      if (legacy) return _readYesterdayFromLegacy(legacy);
      return null;
    }

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return null;

    // Read last 20 rows (enough for ~10 apps × 2 days)
    const numRows = Math.min(lastRow - 1, 20);
    const range = sheet.getRange(lastRow - numRows + 1, 1, numRows, 9);
    const values = range.getValues();

    const yesterday = Utilities.formatDate(
      new Date(Date.now() - MS_PER_DAY), 'Asia/Taipei', 'yyyy-MM-dd'
    );

    const result = { _totalRegistered: 0 };
    for (const row of values) {
      const dateStr = row[0] instanceof Date
        ? Utilities.formatDate(row[0], 'Asia/Taipei', 'yyyy-MM-dd')
        : String(row[0]);
      if (dateStr === yesterday) {
        const appId = row[1];
        result[appId] = { active24h: row[5], totalUsers: row[7] };
        result._totalRegistered += row[7];
      }
    }

    return Object.keys(result).length > 1 ? result : null;
  } catch (e) {
    console.error('Failed to read yesterday metrics:', e);
    return null;
  }
}

/**
 * Read yesterday's metrics from the legacy "Daily Metrics" sheet.
 * Columns: Date | App | Active24h | Active7d | Total | AvgKeys
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @returns {Object|null}
 */
function _readYesterdayFromLegacy(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;

  const numRows = Math.min(lastRow - 1, 20);
  const range = sheet.getRange(lastRow - numRows + 1, 1, numRows, 6);
  const values = range.getValues();

  const yesterday = Utilities.formatDate(
    new Date(Date.now() - MS_PER_DAY), 'Asia/Taipei', 'yyyy-MM-dd'
  );

  const result = { _totalRegistered: 0 };
  for (const row of values) {
    const dateStr = row[0] instanceof Date
      ? Utilities.formatDate(row[0], 'Asia/Taipei', 'yyyy-MM-dd')
      : String(row[0]);
    if (dateStr === yesterday) {
      const appId = row[1];
      result[appId] = { active24h: row[2], totalUsers: row[4] };
      result._totalRegistered += row[4];
    }
  }

  return Object.keys(result).length > 1 ? result : null;
}

/**
 * Get or create a sheet with headers.
 * @param {string} name - Sheet name
 * @param {string[]} headers - Column headers
 * @returns {GoogleAppsScript.Spreadsheet.Sheet|null}
 */
function _getOrCreateSheet(name, headers) {
  const sheetId = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!sheetId) {
    console.warn('No SHEET_ID configured, skipping Sheet append');
    return null;
  }

  const ss = SpreadsheetApp.openById(sheetId);
  let sheet = ss.getSheetByName(name);

  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    sheet.getRange('1:1').setFontWeight('bold');
  }

  return sheet;
}
```

**Step 2: Deploy**

```bash
cd gas && clasp push
```

**Step 3: Commit**

```bash
git add gas/Sheet.js
git commit -m "feat(gas): two-sheet structure with legacy fallback"
```

---

## Task 5: Slack.js — New message format with Firestore health and Sheet link

**Files:**
- Modify: `gas/Slack.js`

**Goal:** New Slack message with Firestore health section, auto-discovered apps, and Sheet link. Remove hardcoded `APP_DISPLAY_NAMES` and `KNOWN_APP_IDS` references.

**Step 1: Rewrite Slack.js**

Replace the entire `gas/Slack.js` with:

```javascript
/**
 * Slack.js — Format and post daily report to Slack.
 */

/**
 * Post the daily report to Slack.
 * @param {Object} metrics - From aggregateMetrics()
 * @param {Object} firestoreOps - From fetchFirestoreOps()
 * @param {string[]} alerts - Alert messages
 */
function postToSlack(metrics, firestoreOps, alerts) {
  const webhookUrl = PropertiesService.getScriptProperties().getProperty('SLACK_WEBHOOK_URL');
  if (!webhookUrl) {
    console.warn('No SLACK_WEBHOOK_URL configured, skipping Slack post');
    return;
  }

  const message = _formatSlackMessage(metrics, firestoreOps, alerts);

  if (!webhookUrl.startsWith('https://hooks.slack.com/')) {
    console.warn('SLACK_WEBHOOK_URL does not look like a valid Slack webhook, skipping');
    console.log('Slack message preview:\n' + message);
    return;
  }

  const resp = UrlFetchApp.fetch(webhookUrl, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ text: message }),
    muteHttpExceptions: true,
  });

  if (resp.getResponseCode() !== 200) {
    console.error('Slack post failed:', resp.getContentText());
  }
}

/**
 * Format the Slack message.
 * @param {Object} metrics
 * @param {Object} firestoreOps
 * @param {string[]} alerts
 * @returns {string}
 */
function _formatSlackMessage(metrics, firestoreOps, alerts) {
  const lines = [];
  lines.push(`:bar_chart: *Event Sync — Daily Report (${metrics.date})*`);
  lines.push('');

  // Firestore Health
  lines.push(':fire: *Firestore Health*');
  if (firestoreOps.reads >= 0) {
    lines.push(`  Reads (24h): ${_num(firestoreOps.reads)} / ${_num(FIRESTORE_LIMITS.READS_PER_DAY)} (${_pct(firestoreOps.reads, FIRESTORE_LIMITS.READS_PER_DAY)})`);
    lines.push(`  Writes (24h): ${_num(firestoreOps.writes)} / ${_num(FIRESTORE_LIMITS.WRITES_PER_DAY)} (${_pct(firestoreOps.writes, FIRESTORE_LIMITS.WRITES_PER_DAY)})`);
    lines.push(`  Storage: ${firestoreOps.storedMB} MB / ${Math.round(FIRESTORE_LIMITS.STORAGE_BYTES / 1048576)} MB (${_pct(firestoreOps.storedBytes, FIRESTORE_LIMITS.STORAGE_BYTES)})`);
  } else {
    lines.push('  _Cloud Monitoring unavailable — check SA permissions_');
  }
  lines.push('');

  // Per-app active users
  const appCount = metrics.appIds.length;
  lines.push(`:iphone: *App Usage (24h)* — ${appCount} app${appCount !== 1 ? 's' : ''} discovered`);
  for (const appId of metrics.appIds) {
    const app = metrics.apps[appId];
    let delta = '';
    if (app.isNew) {
      delta = ' (new!)';
    } else if (app.delta24h !== null && app.delta24h !== undefined) {
      delta = ` (${app.delta24h >= 0 ? '+' : ''}${app.delta24h})`;
    }
    lines.push(`  ${appId}: *${app.active24h}* users${delta} · ${_num(app.docCount)} docs · ${app.estStorageKB} KB`);
  }
  lines.push('');

  // Totals
  const newStr = metrics.newUsersToday !== null ? ` · +${metrics.newUsersToday} new today` : '';
  lines.push(`:busts_in_silhouette: Total: *${metrics.uniqueActiveUsers}* active · *${metrics.totalRegistered}* registered${newStr}`);
  lines.push(`:chart_with_upwards_trend: 7-Day Active: *${metrics.totalActive7d}*`);
  if (metrics.growthRate !== null) {
    const arrow = parseFloat(metrics.growthRate) >= 0 ? ':arrow_up:' : ':arrow_down:';
    lines.push(`${arrow} Growth: *${metrics.growthRate}%*`);
  }
  lines.push('');

  // Alerts
  if (alerts.length > 0) {
    lines.push(':warning: *Alerts*');
    for (const alert of alerts) {
      lines.push(`  • ${alert}`);
    }
  } else {
    lines.push(':white_check_mark: No alerts');
  }

  // Sheet link
  const sheetId = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (sheetId) {
    lines.push(`:linked_paperclips: <https://docs.google.com/spreadsheets/d/${sheetId}|View full history>`);
  }

  return lines.join('\n');
}

/**
 * Format a number with commas.
 * @param {number} n
 * @returns {string}
 */
function _num(n) {
  return n.toLocaleString('en-US');
}

/**
 * Format a percentage string.
 * @param {number} value
 * @param {number} total
 * @returns {string}
 */
function _pct(value, total) {
  if (total <= 0 || value < 0) return 'N/A';
  return (value / total * 100).toFixed(1) + '%';
}
```

**Step 2: Deploy**

```bash
cd gas && clasp push
```

**Step 3: Commit**

```bash
git add gas/Slack.js
git commit -m "feat(gas): new Slack format with Firestore health and Sheet link"
```

---

## Task 6: Main.js — Updated orchestration, alerts, and trigger

**Files:**
- Modify: `gas/Main.js`

**Goal:** Wire everything together. Update `dailyReport()` to use auto-discovery, fetch Firestore ops, write to both sheets. Update alerts. Change trigger to 09:00.

**Step 1: Rewrite Main.js**

Replace the entire `gas/Main.js` with:

```javascript
/**
 * Main.js — Entry point for daily usage monitoring.
 *
 * Script Properties required:
 *   FIREBASE_EVENT_SA_KEY  — Firebase service account JSON
 *   SLACK_WEBHOOK_URL      — Slack incoming webhook URL
 *   SHEET_ID               — Google Sheet ID for trend tracking
 *
 * IAM required:
 *   Service account needs roles/monitoring.viewer for Cloud Monitoring API.
 */

/**
 * Main entry point. Called by time-driven trigger daily at 09:00.
 */
function dailyReport() {
  console.log('Starting daily usage report v2...');

  // 1. Fetch all app documents from Firestore
  const docs = fetchAllAppDocs();
  if (docs.length === 0) {
    console.warn('No documents found in Firestore');
    const emptyMetrics = {
      date: _formatDate(new Date()), apps: {}, appIds: [],
      totalActive24h: 0, totalActive7d: 0, totalRegistered: 0,
      uniqueActiveUsers: 0, growthRate: null, newUsersToday: null,
    };
    const emptyOps = { reads: -1, writes: -1, deletes: -1, storedBytes: 0, storedMB: 0 };
    postToSlack(emptyMetrics, emptyOps, ['No data found in Firestore']);
    return;
  }

  // 2. Auto-discover apps
  const appIds = discoverAppIds(docs);

  // 3. Read yesterday's metrics for trend comparison
  const yesterday = getYesterdayMetrics();

  // 4. Aggregate app metrics
  const metrics = aggregateMetrics(docs, appIds, yesterday);
  console.log('App metrics:', JSON.stringify(metrics));

  // 5. Fetch Firestore operation metrics from Cloud Monitoring
  let firestoreOps;
  try {
    firestoreOps = fetchFirestoreOps();
  } catch (e) {
    console.error('Failed to fetch Firestore ops:', e);
    firestoreOps = { reads: -1, writes: -1, deletes: -1, storedBytes: 0, storedMB: 0 };
  }

  // 6. Check alert thresholds
  const alerts = checkAlerts(metrics, firestoreOps, yesterday);

  // 7. Post to Slack
  postToSlack(metrics, firestoreOps, alerts);

  // 8. Append to Sheets
  appendAppMetrics(metrics);
  appendFirestoreOps(firestoreOps, metrics.date);

  console.log('Daily report v2 complete.');
}

/**
 * Check alert conditions.
 * @param {Object} metrics - Today's app metrics
 * @param {Object} firestoreOps - Firestore operation metrics
 * @param {Object|null} yesterday - Yesterday's metrics from Sheet
 * @returns {string[]} Alert messages
 */
function checkAlerts(metrics, firestoreOps, yesterday) {
  const alerts = [];

  // Firestore quota alerts (>70%)
  if (firestoreOps.reads >= 0) {
    if (firestoreOps.reads > FIRESTORE_LIMITS.READS_PER_DAY * 0.7) {
      alerts.push(`Firestore reads at ${_pct(firestoreOps.reads, FIRESTORE_LIMITS.READS_PER_DAY)} of free tier`);
    }
    if (firestoreOps.writes > FIRESTORE_LIMITS.WRITES_PER_DAY * 0.7) {
      alerts.push(`Firestore writes at ${_pct(firestoreOps.writes, FIRESTORE_LIMITS.WRITES_PER_DAY)} of free tier`);
    }
    if (firestoreOps.storedBytes > FIRESTORE_LIMITS.STORAGE_BYTES * 0.7) {
      alerts.push(`Firestore storage at ${_pct(firestoreOps.storedBytes, FIRESTORE_LIMITS.STORAGE_BYTES)} of free tier`);
    }
  }

  // Per-app alerts
  for (const appId of metrics.appIds) {
    const app = metrics.apps[appId];

    // Zero active with registered users
    if (app.total > 0 && app.active24h === 0) {
      alerts.push(`${appId} has ${app.total} registered users but 0 active in 24h`);
    }

    // Significant drop (>30%) from yesterday
    if (yesterday && yesterday[appId] && yesterday[appId].active24h > 5) {
      const prev = yesterday[appId].active24h;
      const drop = (prev - app.active24h) / prev;
      if (drop > 0.3) {
        alerts.push(`${appId} active users dropped ${Math.round(drop * 100)}% (${prev} → ${app.active24h})`);
      }
    }

    // Growth spike (>3x previous day)
    if (yesterday && yesterday[appId] && yesterday[appId].active24h > 0) {
      const prev = yesterday[appId].active24h;
      if (app.active24h > prev * 3) {
        alerts.push(`${appId} usage spiked ${Math.round(app.active24h / prev)}x (${prev} → ${app.active24h})`);
      }
    }
  }

  return alerts;
}

/**
 * Manual test: run the full report immediately.
 */
function testDailyReport() {
  dailyReport();
}

/**
 * Set up the daily trigger at 09:00 Asia/Taipei.
 * Run once in GAS editor after deploying.
 */
function setupTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  for (const trigger of triggers) {
    if (trigger.getHandlerFunction() === 'dailyReport') {
      ScriptApp.deleteTrigger(trigger);
    }
  }

  ScriptApp.newTrigger('dailyReport')
    .timeBased()
    .atHour(9)
    .everyDays(1)
    .inTimezone('Asia/Taipei')
    .create();

  console.log('Daily trigger set for 09:00 Asia/Taipei');
}
```

**Step 2: Deploy and test end-to-end**

```bash
cd gas && clasp push
```

Run `testDailyReport()` in GAS editor. Check:

```bash
clasp logs | tail -30
```

Expected output should include:
- "Fetched N total app documents"
- "Discovered N apps: ..."
- "Firestore ops — reads: ..., writes: ..., deletes: ..., storage: ... MB"
- "Appended N rows to App Metrics"
- "Appended Firestore ops"
- "Daily report v2 complete."

Verify in Slack: new format with Firestore health section and Sheet link.
Verify in Sheet: two new sheets created with correct data.

**Step 3: Commit**

```bash
git add gas/Main.js
git commit -m "feat(gas): wire up daily report v2 with auto-discovery and monitoring"
```

---

## Task 7: Update trigger and clean up

**Files:**
- Modify: `gas/Main.js` (no code change — run `setupTrigger()` in GAS editor)
- Modify: project `CLAUDE.md` (remove completed TODO)

**Step 1: Set up new trigger**

In GAS editor, run `setupTrigger()`. This replaces the 08:00 trigger with 09:00.

**Step 2: Grant IAM role to service account**

```bash
# Get project ID and SA email from the script
gcloud projects add-iam-policy-binding PROJECT_ID \
  --member="serviceAccount:SA_EMAIL" \
  --role="roles/monitoring.viewer"
```

**Step 3: Clean up CLAUDE.md**

Remove the "上次進度" block since the daily report topic is now implemented.

**Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "chore: clean up CLAUDE.md after daily report v2 implementation"
```

---

## Summary of Changes

| File | What changed |
|------|-------------|
| `gas/Auth.js` | Added `getMonitoringAccessToken()` and `_createJwtWithScope()` |
| `gas/Firestore.js` | Removed `KNOWN_APP_IDS`, added `discoverAppIds()`, added `estimatedBytes` |
| `gas/Metrics.js` | Accepts dynamic `appIds`, added `fetchFirestoreOps()` with Cloud Monitoring API, added `FIRESTORE_LIMITS` |
| `gas/Slack.js` | New format: Firestore health, auto-discovered apps, Sheet link. Removed `APP_DISPLAY_NAMES` |
| `gas/Sheet.js` | Two sheets: "App Metrics" (9 columns) + "Firestore Ops" (6 columns). Legacy fallback for "Daily Metrics" |
| `gas/Main.js` | Updated orchestration, new alert rules (quota, spike), trigger at 09:00 |

## Verification Checklist

After all tasks:
- [ ] `clasp push` succeeds
- [ ] `testDailyReport()` runs without errors
- [ ] Slack message shows Firestore health section
- [ ] Slack message shows all apps (not just hardcoded 5)
- [ ] Slack message includes Sheet link
- [ ] "App Metrics" sheet has correct columns and data
- [ ] "Firestore Ops" sheet has correct columns and data
- [ ] Trigger is set to 09:00 Asia/Taipei
- [ ] Service account has `monitoring.viewer` role
