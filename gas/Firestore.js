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
