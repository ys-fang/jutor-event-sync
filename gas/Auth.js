/**
 * Auth.js — Service account OAuth2 for Firestore REST API.
 *
 * Reads FIREBASE_EVENT_SA_KEY from Script Properties.
 * Creates a JWT signed with RS256, exchanges for an access token.
 */

/** @type {string|null} */
let _cachedToken = null;
/** @type {number} */
let _tokenExpiry = 0;

/**
 * Get a valid access token for Firestore API calls.
 * Caches the token until 5 minutes before expiry.
 * @returns {string} Bearer access token
 */
function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (_cachedToken && now < _tokenExpiry - 300) {
    return _cachedToken;
  }

  const sa = _getServiceAccount();
  const jwt = _createJwt(sa, now);
  const token = _exchangeJwtForToken(jwt);

  _cachedToken = token.access_token;
  _tokenExpiry = now + token.expires_in;
  return _cachedToken;
}

/**
 * Get a valid access token for Cloud Monitoring API calls.
 * Separate cache from Firestore token since scopes differ.
 * @returns {string} Bearer access token
 */
let _cachedMonitoringToken = null;
let _monitoringTokenExpiry = 0;

function getMonitoringAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (_cachedMonitoringToken && now < _monitoringTokenExpiry - 300) {
    return _cachedMonitoringToken;
  }

  const sa = _getServiceAccount();
  const jwt = _createJwtWithScope(sa, now, 'https://www.googleapis.com/auth/monitoring.read');
  const token = _exchangeJwtForToken(jwt);

  _cachedMonitoringToken = token.access_token;
  _monitoringTokenExpiry = now + token.expires_in;
  return _cachedMonitoringToken;
}

/**
 * Get the Firebase project ID from the service account key.
 * @returns {string}
 */
function getProjectId() {
  return _getServiceAccount().project_id;
}

/** @returns {Object} Parsed service account JSON */
function _getServiceAccount() {
  const raw = PropertiesService.getScriptProperties().getProperty('FIREBASE_EVENT_SA_KEY');
  if (!raw) throw new Error('Missing FIREBASE_EVENT_SA_KEY in Script Properties');
  return JSON.parse(raw);
}

/**
 * Create a signed JWT for the Firestore scope (default).
 * @param {Object} sa - Service account object
 * @param {number} now - Current epoch seconds
 * @returns {string} Signed JWT
 */
function _createJwt(sa, now) {
  return _createJwtWithScope(sa, now, 'https://www.googleapis.com/auth/datastore');
}

/**
 * Create a signed JWT for the given scope.
 * @param {Object} sa - Service account object
 * @param {number} now - Current epoch seconds
 * @param {string} scope - OAuth2 scope URL
 * @returns {string} Signed JWT
 */
function _createJwtWithScope(sa, now, scope) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: sa.client_email,
    scope: scope,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  const headerB64 = _base64url(JSON.stringify(header));
  const payloadB64 = _base64url(JSON.stringify(payload));
  const signingInput = headerB64 + '.' + payloadB64;

  const signature = Utilities.computeRsaSha256Signature(signingInput, sa.private_key);
  const signatureB64 = _base64url(signature);

  return signingInput + '.' + signatureB64;
}

/**
 * Exchange JWT for an access token.
 * @param {string} jwt
 * @returns {{ access_token: string, expires_in: number }}
 */
function _exchangeJwtForToken(jwt) {
  const resp = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    },
    muteHttpExceptions: true,
  });

  if (resp.getResponseCode() !== 200) {
    throw new Error('Token exchange failed: ' + resp.getContentText());
  }
  return JSON.parse(resp.getContentText());
}

/**
 * Base64url encode a string or byte array.
 * @param {string|number[]} input
 * @returns {string}
 */
function _base64url(input) {
  const bytes = typeof input === 'string'
    ? Utilities.newBlob(input).getBytes()
    : input;
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}
