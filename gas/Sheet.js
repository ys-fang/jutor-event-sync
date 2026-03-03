/**
 * Sheet.js — Append daily metrics to a Google Sheet for trend tracking.
 *
 * Sheet ID is stored in Script Properties as SHEET_ID.
 * Sheet name: "Daily Metrics"
 *
 * Columns: Date | App | Active24h | Active7d | Total | AvgKeys
 */

const SHEET_NAME = 'Daily Metrics';

/**
 * Append today's metrics as rows to the tracking sheet.
 * One row per app.
 * @param {Object} metrics - From aggregateMetrics()
 */
function appendToSheet(metrics) {
  const sheetId = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!sheetId) {
    console.warn('No SHEET_ID configured, skipping Sheet append');
    return;
  }

  const ss = SpreadsheetApp.openById(sheetId);
  let sheet = ss.getSheetByName(SHEET_NAME);

  // Create sheet with headers if it doesn't exist
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(['Date', 'App', 'Active24h', 'Active7d', 'Total', 'AvgKeys']);
    sheet.getRange('1:1').setFontWeight('bold');
  }

  // Append one row per app
  for (const appId of KNOWN_APP_IDS) {
    const app = metrics.apps[appId];
    sheet.appendRow([
      metrics.date,
      appId,
      app.active24h,
      app.active7d,
      app.total,
      app.avgKeys,
    ]);
  }

  console.log(`Appended ${KNOWN_APP_IDS.length} rows to Sheet for ${metrics.date}`);
}

/**
 * Read yesterday's metrics from the Sheet (for trend calculation).
 * @returns {Object|null} { [appId]: { active24h }, _totalRegistered } or null
 */
function getYesterdayMetrics() {
  const sheetId = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!sheetId) return null;

  try {
    const ss = SpreadsheetApp.openById(sheetId);
    const sheet = ss.getSheetByName(SHEET_NAME);
    if (!sheet) return null;

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return null; // No data rows

    // Read the last N rows (enough to find yesterday's data for all apps)
    const numRows = Math.min(lastRow - 1, KNOWN_APP_IDS.length * 2);
    const range = sheet.getRange(lastRow - numRows + 1, 1, numRows, 6);
    const values = range.getValues();

    const yesterday = Utilities.formatDate(
      new Date(Date.now() - MS_PER_DAY), 'Asia/Taipei', 'yyyy-MM-dd'
    );

    const result = { _totalRegistered: 0 };
    for (const row of values) {
      if (row[0] === yesterday) {
        const appId = row[1];
        result[appId] = { active24h: row[2] };
        result._totalRegistered += row[4]; // Total column
      }
    }

    return Object.keys(result).length > 1 ? result : null;
  } catch (e) {
    console.error('Failed to read yesterday metrics:', e);
    return null;
  }
}
