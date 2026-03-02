import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchJutorUser } from './auth.js';

describe('fetchJutorUser', () => {
  const apiBase = 'https://jutor.example.com';
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns JutorUser when session is active', async () => {
    const mockApiResponse = {
      success: true,
      data: {
        uid: 'user-123',
        userName: 'Alice',
        userData: {
          grade: '3',
          class: 'A',
          schoolName: 'Test School',
        },
      },
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockApiResponse),
    });

    const user = await fetchJutorUser(apiBase);

    expect(user).toEqual({
      uid: 'user-123',
      userName: 'Alice',
      grade: '3',
      class: 'A',
      schoolName: 'Test School',
    });
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
