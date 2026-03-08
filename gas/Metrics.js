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
