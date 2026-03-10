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
      date: formatDate(new Date()), apps: {}, appIds: [],
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
  appendAppMetrics(metrics, yesterday);
  appendFirestoreOps(firestoreOps, metrics.date, metrics.totalRegistered);

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
      alerts.push(`Firestore reads at ${fmtPct(firestoreOps.reads, FIRESTORE_LIMITS.READS_PER_DAY)} of free tier`);
    }
    if (firestoreOps.writes > FIRESTORE_LIMITS.WRITES_PER_DAY * 0.7) {
      alerts.push(`Firestore writes at ${fmtPct(firestoreOps.writes, FIRESTORE_LIMITS.WRITES_PER_DAY)} of free tier`);
    }
    if (firestoreOps.storedBytes > FIRESTORE_LIMITS.STORAGE_BYTES * 0.7) {
      alerts.push(`Firestore storage at ${fmtPct(firestoreOps.storedBytes, FIRESTORE_LIMITS.STORAGE_BYTES)} of free tier`);
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
