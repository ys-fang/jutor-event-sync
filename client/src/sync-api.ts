/**
 * REST-based sync API client.
 * Talks to the speech-token-server's /api/event/sync endpoint
 * instead of using Firebase client SDK directly.
 */

export async function readRecord(
  syncApiUrl: string,
  uid: string,
  appId: string
): Promise<{ data: Record<string, string>; lastSync: number } | null> {
  const url = `${syncApiUrl}?uid=${encodeURIComponent(uid)}&appId=${encodeURIComponent(appId)}`;
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`sync read failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as { data: Record<string, string>; lastSync: number };
}

export async function writeRecord(
  syncApiUrl: string,
  uid: string,
  appId: string,
  data: Record<string, unknown>
): Promise<{ data: Record<string, unknown>; lastSync: number }> {
  const res = await fetch(syncApiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid, appId, data }),
  });
  if (!res.ok) {
    throw new Error(`sync write failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as { data: Record<string, unknown>; lastSync: number };
}
