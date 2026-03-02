import { describe, it, expect, vi, afterEach } from 'vitest';
import { readRecord, writeRecord } from './sync-api.js';

describe('readRecord', () => {
  const syncApiUrl = 'https://api.example.com/api/event/sync';
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns record when found', async () => {
    const mockData = {
      data: { 'app_user-123_score': '99' },
      lastSync: 2000,
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(mockData),
    });

    const result = await readRecord(syncApiUrl, 'user-123', 'test-app');

    expect(result).toEqual(mockData);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      `${syncApiUrl}?uid=user-123&appId=test-app`
    );
  });

  it('returns null on 404', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    });

    const result = await readRecord(syncApiUrl, 'user-123', 'test-app');

    expect(result).toBeNull();
  });

  it('throws on server error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });

    await expect(readRecord(syncApiUrl, 'user-123', 'test-app')).rejects.toThrow(
      'sync read failed: 500 Internal Server Error'
    );
  });
});

describe('writeRecord', () => {
  const syncApiUrl = 'https://api.example.com/api/event/sync';
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('sends POST with uid, appId, and data', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ lastSync: 3000 }),
    });

    const data = { 'app_user-123_score': '100' };
    await writeRecord(syncApiUrl, 'user-123', 'test-app', data);

    expect(globalThis.fetch).toHaveBeenCalledWith(syncApiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid: 'user-123', appId: 'test-app', data }),
    });
  });

  it('throws on server error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });

    await expect(
      writeRecord(syncApiUrl, 'user-123', 'test-app', {})
    ).rejects.toThrow('sync write failed: 500 Internal Server Error');
  });
});
