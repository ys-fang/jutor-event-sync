/**
 * Slack.js — Format and post daily report to Slack.
 */

const APP_DISPLAY_NAMES = {
  'namiya': 'Namiya',
  'speak-sentence': 'Speak Sentence',
  'speak-passage': 'Speak Passage',
};

/**
 * Post the daily report to Slack.
 * @param {Object} metrics - From aggregateMetrics()
 * @param {string[]} alerts - Alert messages (empty if none)
 */
function postToSlack(metrics, alerts) {
  const webhookUrl = PropertiesService.getScriptProperties().getProperty('SLACK_WEBHOOK_URL');
  if (!webhookUrl) {
    console.warn('No SLACK_WEBHOOK_URL configured, skipping Slack post');
    return;
  }

  const message = _formatSlackMessage(metrics, alerts);

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
 * @param {string[]} alerts
 * @returns {string}
 */
function _formatSlackMessage(metrics, alerts) {
  const lines = [];
  lines.push(`:bar_chart: *Event Sync — Daily Report (${metrics.date})*`);
  lines.push('');

  // Per-app active users
  lines.push(':iphone: *Active Users (24h)*');
  for (const appId of KNOWN_APP_IDS) {
    const app = metrics.apps[appId];
    if (!app) continue;
    const name = APP_DISPLAY_NAMES[appId] || appId;
    const delta = app.delta24h !== null && app.delta24h !== undefined
      ? ` (${app.delta24h >= 0 ? '+' : ''}${app.delta24h})`
      : '';
    lines.push(`  ${name}: *${app.active24h}*${delta}`);
  }
  lines.push(`  Total: *${metrics.totalActive24h}*`);
  lines.push('');

  // Totals
  lines.push(`:busts_in_silhouette: All-Time Users: *${metrics.totalRegistered}*`);
  lines.push(`:chart_with_upwards_trend: 7-Day Active: *${metrics.totalActive7d}*`);
  if (metrics.growthRate !== null) {
    const arrow = parseFloat(metrics.growthRate) >= 0 ? ':arrow_up:' : ':arrow_down:';
    lines.push(`${arrow} Growth: *${metrics.growthRate}%*`);
  }
  lines.push('');

  // Per-app details
  lines.push(':memo: *Per-App Details*');
  for (const appId of KNOWN_APP_IDS) {
    const app = metrics.apps[appId];
    if (!app) continue;
    const name = APP_DISPLAY_NAMES[appId] || appId;
    lines.push(`  ${name}: ${app.total} total, ${app.active7d} active(7d), ~${app.avgKeys} keys/user`);
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

  return lines.join('\n');
}
