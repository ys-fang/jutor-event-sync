/**
 * Main.js — Entry point for daily usage monitoring.
 *
 * Script Properties required:
 *   FIREBASE_EVENT_SA_KEY  — Firebase service account JSON
 *   SLACK_WEBHOOK_URL      — Slack incoming webhook URL
 *   SHEET_ID               — Google Sheet ID for trend tracking
 */

/**
 * Main entry point. Called by time-driven trigger daily at 08:00.
 */
function dailyReport() {
  console.log('Starting daily usage report...');

  // 1. Fetch all app documents from Firestore
  const docs = fetchAllAppDocs();
  if (docs.length === 0) {
    console.warn('No documents found in Firestore');
    postToSlack({ date: _formatDate(new Date()), apps: {}, totalActive24h: 0, totalActive7d: 0, totalRegistered: 0, uniqueActiveUsers: 0, growthRate: null }, ['No data found in Firestore']);
    return;
  }

  // 2. Read yesterday's metrics for trend comparison
  const yesterday = getYesterdayMetrics();

  // 3. Aggregate metrics
  const metrics = aggregateMetrics(docs, yesterday);
  console.log('Metrics:', JSON.stringify(metrics));

  // 4. Check alert thresholds
  const alerts = checkAlerts(metrics, yesterday);

  // 5. Post to Slack
  postToSlack(metrics, alerts);

  // 6. Append to Sheet
  appendToSheet(metrics);

  console.log('Daily report complete.');
}

/**
 * Check alert conditions.
 * @param {Object} metrics - Today's metrics
 * @param {Object|null} yesterday - Yesterday's metrics from Sheet
 * @returns {string[]} Alert messages
 */
function checkAlerts(metrics, yesterday) {
  const alerts = [];

  // Alert: any app has 0 active users in 24h
  for (const appId of KNOWN_APP_IDS) {
    const app = metrics.apps[appId];
    if (app && app.total > 0 && app.active24h === 0) {
      const name = APP_DISPLAY_NAMES[appId] || appId;
      alerts.push(`${name} has registered users but 0 active in 24h`);
    }
  }

  // Alert: significant drop (>30%) from yesterday
  if (yesterday) {
    for (const appId of KNOWN_APP_IDS) {
      const app = metrics.apps[appId];
      const prev = yesterday[appId];
      if (app && prev && prev.active24h > 5) {
        const drop = (prev.active24h - app.active24h) / prev.active24h;
        if (drop > 0.3) {
          const name = APP_DISPLAY_NAMES[appId] || appId;
          const pct = Math.round(drop * 100);
          alerts.push(`${name} active users dropped ${pct}% (${prev.active24h} → ${app.active24h})`);
        }
      }
    }
  }

  return alerts;
}

/**
 * Manual test: run the full report immediately.
 * Use this in the GAS editor to verify everything works.
 */
function testDailyReport() {
  dailyReport();
}

/**
 * Set up the daily trigger (run once during initial setup).
 * Creates a time-driven trigger for dailyReport at 08:00 Asia/Taipei.
 */
function setupTrigger() {
  // Remove existing triggers for this function
  const triggers = ScriptApp.getProjectTriggers();
  for (const trigger of triggers) {
    if (trigger.getHandlerFunction() === 'dailyReport') {
      ScriptApp.deleteTrigger(trigger);
    }
  }

  // Create new daily trigger at 8 AM
  ScriptApp.newTrigger('dailyReport')
    .timeBased()
    .atHour(8)
    .everyDays(1)
    .inTimezone('Asia/Taipei')
    .create();

  console.log('Daily trigger set for 08:00 Asia/Taipei');
}
