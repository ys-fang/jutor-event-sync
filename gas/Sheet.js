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
 * @param {Object|null} yesterday - Yesterday's metrics (passed from caller to avoid redundant Sheet read)
 */
function appendAppMetrics(metrics, yesterday) {
  const sheet = _getOrCreateSheet(APP_SHEET_NAME, [
    'Date', 'App', 'DocCount', 'TotalKeys', 'EstStorageKB', 'Active24h', 'Active7d', 'TotalUsers', 'NewUsers',
  ]);
  if (!sheet) return;

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
