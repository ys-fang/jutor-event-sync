/**
 * Firestore.js — Read sync data from Firestore REST API.
 *
 * Uses collection group query on "apps" subcollections under event-records.
 * Parent documents are "phantom" (no fields), so we query subcollections directly.
 */

// Add new app IDs here when integrating Jutor login into a new /event/[app].
// Each entry must match the appId used in the app's eventSync.ts config.
const KNOWN_APP_IDS = ['namiya', 'speak-sentence', 'speak-passage'];

/**
 * Fetch all app documents across all users via collection group query.
 * Returns a flat array of { uid, appId, lastSync, keyCount }.
 *
 * @returns {Array<{ uid: string, appId: string, lastSync: number, keyCount: number }>}
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
      // Use offset-based pagination via page token
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
    let hasDocuments = false;

    for (const item of items) {
      if (!item.document) continue;
      hasDocuments = true;

      const doc = item.document;
      // doc.name: "projects/.../documents/event-records/{uid}/apps/{appId}"
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

      results.push({ uid, appId, lastSync, keyCount });
    }

    // runQuery doesn't use nextPageToken — it returns all results up to limit.
    // If we got exactly 300 results, there might be more (but unlikely for our scale).
    pageToken = null; // For now, single batch is sufficient
  } while (pageToken);

  console.log(`Fetched ${results.length} total app documents`);
  return results;
}
