import type { JutorUser } from './types.js';

/**
 * Fetch the current Jutor user profile using session cookies.
 * Returns null if the user is not authenticated.
 */
export async function fetchJutorUser(
  apiBase: string
): Promise<JutorUser | null> {
  try {
    const res = await fetch(`${apiBase}/api/v1/auth/user-profile`, {
      credentials: 'include',
    });
    if (!res.ok) return null;
    return (await res.json()) as JutorUser;
  } catch {
    return null;
  }
}

/**
 * Request a Firebase custom token from the mintToken endpoint.
 * Throws if the request fails.
 */
export async function requestMintToken(
  mintTokenUrl: string,
  uid: string
): Promise<string> {
  const res = await fetch(mintTokenUrl, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid }),
  });
  if (!res.ok) {
    throw new Error(`mintToken failed: ${res.status} ${res.statusText}`);
  }
  const { token } = (await res.json()) as { token: string };
  return token;
}
