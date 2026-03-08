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
