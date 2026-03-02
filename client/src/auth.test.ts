import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchJutorUser, requestMintToken } from './auth.js';
import type { JutorUser } from './types.js';

describe('fetchJutorUser', () => {
  const apiBase = 'https://jutor.example.com';
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns JutorUser when session is active', async () => {
    const mockUser: JutorUser = {
      uid: 'user-123',
      userName: 'Alice',
      email: 'alice@example.com',
      grade: '3',
      class: 'A',
      schoolName: 'Test School',
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockUser),
    });

    const user = await fetchJutorUser(apiBase);

    expect(user).toEqual(mockUser);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      `${apiBase}/api/v1/auth/user-profile`,
      { credentials: 'include' }
    );
  });

  it('returns null on 401 (not authenticated)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
    });

    const user = await fetchJutorUser(apiBase);

    expect(user).toBeNull();
  });

  it('returns null on network error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    const user = await fetchJutorUser(apiBase);

    expect(user).toBeNull();
  });
});

describe('requestMintToken', () => {
  const mintTokenUrl = 'https://mint.example.com/mintToken';
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns token string on success', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ token: 'custom-token-abc' }),
    });

    const token = await requestMintToken(mintTokenUrl, 'user-123');

    expect(token).toBe('custom-token-abc');
    expect(globalThis.fetch).toHaveBeenCalledWith(mintTokenUrl, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid: 'user-123' }),
    });
  });

  it('throws on error response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });

    await expect(requestMintToken(mintTokenUrl, 'user-123')).rejects.toThrow(
      'mintToken failed: 500 Internal Server Error'
    );
  });

  it('throws on network error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Connection refused'));

    await expect(requestMintToken(mintTokenUrl, 'user-123')).rejects.toThrow(
      'Connection refused'
    );
  });
});
