/**
 * Metrics.js — Aggregate usage metrics from Firestore data.
 */

const MS_PER_DAY = 86400000;

/**
 * Aggregate metrics from app documents.
 *
 * @param {Array<{ uid: string, appId: string, lastSync: number, keyCount: number }>} docs
 * @param {Object|null} yesterday - Previous day's metrics from Sheet (for trends)
 * @returns {Object} Aggregated metrics
 */
function aggregateMetrics(docs, yesterday) {
  const now = Date.now();
  const cutoff24h = now - MS_PER_DAY;
  const cutoff7d = now - 7 * MS_PER_DAY;

  // Per-app metrics
  const perApp = {};
  for (const appId of KNOWN_APP_IDS) {
    perApp[appId] = {
      active24h: new Set(),
      active7d: new Set(),
      totalUsers: new Set(),
      totalKeys: 0,
    };
  }

  // Track all unique users
  const allUsers = new Set();
  const activeUsers24h = new Set();

  for (const doc of docs) {
    const app = perApp[doc.appId];
    if (!app) continue; // Unknown appId, skip

    app.totalUsers.add(doc.uid);
    app.totalKeys += doc.keyCount;
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
  let totalRegistered = 0;

  for (const appId of KNOWN_APP_IDS) {
    const app = perApp[appId];
    const active24h = app.active24h.size;
    const active7d = app.active7d.size;
    const total = app.totalUsers.size;
    const avgKeys = total > 0 ? Math.round(app.totalKeys / total) : 0;

    // Day-over-day change (compare to yesterday's Sheet data)
    let delta24h = null;
    if (yesterday && yesterday[appId]) {
      delta24h = active24h - yesterday[appId].active24h;
    }

    apps[appId] = { active24h, active7d, total, avgKeys, delta24h };
    totalActive24h += active24h;
    totalActive7d += active7d;
    totalRegistered += total;
  }

  // Growth rate (7-day)
  let growthRate = null;
  if (yesterday && yesterday._totalRegistered) {
    const diff = allUsers.size - yesterday._totalRegistered;
    growthRate = yesterday._totalRegistered > 0
      ? ((diff / yesterday._totalRegistered) * 100).toFixed(1)
      : null;
  }

  return {
    date: _formatDate(new Date()),
    apps,
    totalActive24h,
    totalActive7d,
    totalRegistered: allUsers.size,
    uniqueActiveUsers: activeUsers24h.size,
    growthRate,
  };
}

/**
 * Format date as YYYY-MM-DD in Taipei timezone.
 * @param {Date} d
 * @returns {string}
 */
function _formatDate(d) {
  return Utilities.formatDate(d, 'Asia/Taipei', 'yyyy-MM-dd');
}
