import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EventSyncConfig } from './types.js';

// ---- Mock modules ----

const mockFetchJutorUser = vi.fn();
vi.mock('./auth.js', () => ({
  fetchJutorUser: (...args: unknown[]) => mockFetchJutorUser(...args),
}));

const mockReadRecord = vi.fn();
const mockWriteRecord = vi.fn();
vi.mock('./sync-api.js', () => ({
  readRecord: (...args: unknown[]) => mockReadRecord(...args),
  writeRecord: (...args: unknown[]) => mockWriteRecord(...args),
}));

// ---- Fake localStorage ----

function createFakeLocalStorage() {
  const store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    get length() {
      return Object.keys(store).length;
    },
    key: (index: number) => Object.keys(store)[index] ?? null,
    clear: () => {
      for (const key of Object.keys(store)) delete store[key];
    },
    _store: store,
  };
}

// ---- Helpers ----

/** Create a server merge response in { v, t } format. */
function mergedResponse(
  entries: Record<string, { v: string; t: number }>,
  lastSync?: number
) {
  const timestamps = Object.values(entries).map((e) => e.t);
  const ts = lastSync ?? (timestamps.length ? Math.max(...timestamps) : 0);
  return { data: entries, lastSync: ts };
}

// ---- Test config ----

const baseConfig: EventSyncConfig = {
  appId: 'test-app',
  localStoragePrefix: 'app_',
  syncApiUrl: 'https://api.example.com/api/event/sync',
  syncIntervalMs: 60_000,
};

const testUser = {
  uid: 'user-123',
  userName: 'Alice',
};

describe('initEventSync', () => {
  let fakeStorage: ReturnType<typeof createFakeLocalStorage>;
  let originalWindow: typeof globalThis.window;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    fakeStorage = createFakeLocalStorage();

    originalWindow = globalThis.window;
    // @ts-expect-error -- partial window mock for testing
    globalThis.window = {
      localStorage: fakeStorage,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      location: { href: '' },
    };
    // @ts-expect-error -- partial document mock for visibilitychange
    globalThis.document = { visibilityState: 'visible' };
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.window = originalWindow;
  });

  it('returns isLoggedIn: false when Jutor session is not active', async () => {
    mockFetchJutorUser.mockResolvedValue(null);

    const { initEventSync } = await import('./sync.js');
    const instance = await initEventSync(baseConfig);

    expect(instance.isLoggedIn).toBe(false);
    expect(instance.user).toBeNull();
    expect(mockWriteRecord).not.toHaveBeenCalled();
  });

  it('redirectToLogin navigates to Jutor login page', async () => {
    mockFetchJutorUser.mockResolvedValue(null);

    const { initEventSync } = await import('./sync.js');
    const instance = await initEventSync({
      ...baseConfig,
      jutorApiBase: 'https://jutor.example.com',
    });

    instance.redirectToLogin();
    expect(window.location.href).toBe('https://jutor.example.com/login');
  });

  it('restores merged data from server on startup (server has newer keys)', async () => {
    mockFetchJutorUser.mockResolvedValue(testUser);

    // Local data
    fakeStorage.setItem('app_user-123_score', '10');

    // Server merge returns newer values + extra key from another device
    mockWriteRecord.mockResolvedValue(
      mergedResponse({
        'app_user-123_score': { v: '99', t: 2000 },
        'app_user-123_level': { v: '5', t: 2000 },
      })
    );

    const { initEventSync } = await import('./sync.js');
    const instance = await initEventSync(baseConfig);

    expect(instance.isLoggedIn).toBe(true);
    expect(instance.user).toEqual(testUser);

    // Bidirectional sync was called
    expect(mockWriteRecord).toHaveBeenCalledWith(
      baseConfig.syncApiUrl,
      'user-123',
      'test-app',
      expect.objectContaining({
        'app_user-123_score': expect.objectContaining({ v: '10' }),
      })
    );

    // Merged data restored to localStorage
    expect(fakeStorage.getItem('app_user-123_score')).toBe('99');
    expect(fakeStorage.getItem('app_user-123_level')).toBe('5');
  });

  it('preserves local data when server merge returns local values', async () => {
    mockFetchJutorUser.mockResolvedValue(testUser);

    // Local data (newer)
    fakeStorage.setItem('app_user-123_score', '50');
    fakeStorage.setItem('app_user-123__lastSync', '5000');

    // Server merge returns local values (local was newer per key)
    mockWriteRecord.mockResolvedValue(
      mergedResponse({
        'app_user-123_score': { v: '50', t: 5000 },
      })
    );

    const { initEventSync } = await import('./sync.js');
    await initEventSync(baseConfig);

    // Local data preserved
    expect(fakeStorage.getItem('app_user-123_score')).toBe('50');
    expect(mockWriteRecord).toHaveBeenCalled();
  });

  it('pushes local data when server has no prior record', async () => {
    mockFetchJutorUser.mockResolvedValue(testUser);

    fakeStorage.setItem('app_user-123_score', '50');
    fakeStorage.setItem('app_user-123__lastSync', '5000');

    // Server returns local data as-is (first sync, nothing to merge with)
    mockWriteRecord.mockResolvedValue(
      mergedResponse({
        'app_user-123_score': { v: '50', t: 5000 },
      })
    );

    const { initEventSync } = await import('./sync.js');
    await initEventSync(baseConfig);

    expect(fakeStorage.getItem('app_user-123_score')).toBe('50');
    expect(mockWriteRecord).toHaveBeenCalled();
  });

  it('pushes local data on syncNow()', async () => {
    mockFetchJutorUser.mockResolvedValue(testUser);

    fakeStorage.setItem('app_user-123_progress', 'chapter3');

    // Startup sync response
    mockWriteRecord.mockResolvedValue(
      mergedResponse({
        'app_user-123_progress': { v: 'chapter3', t: 1000 },
      })
    );

    const { initEventSync } = await import('./sync.js');
    const instance = await initEventSync(baseConfig);

    mockWriteRecord.mockClear();
    mockWriteRecord.mockResolvedValue(
      mergedResponse({
        'app_user-123_progress': { v: 'chapter3', t: 2000 },
      })
    );

    await instance.syncNow();

    expect(mockWriteRecord).toHaveBeenCalledWith(
      baseConfig.syncApiUrl,
      'user-123',
      'test-app',
      expect.objectContaining({
        'app_user-123_progress': expect.objectContaining({ v: 'chapter3' }),
      })
    );
  });

  it('periodic sync triggers at configured interval', async () => {
    mockFetchJutorUser.mockResolvedValue(testUser);

    fakeStorage.setItem('app_user-123_data', 'test');

    mockWriteRecord.mockResolvedValue(
      mergedResponse({
        'app_user-123_data': { v: 'test', t: 1000 },
      })
    );

    const { initEventSync } = await import('./sync.js');
    await initEventSync({ ...baseConfig, syncIntervalMs: 60_000 });

    // Clear calls from startup
    mockWriteRecord.mockClear();

    // Advance timer by one interval
    await vi.advanceTimersByTimeAsync(60_000);

    expect(mockWriteRecord).toHaveBeenCalledTimes(1);

    // Advance again
    mockWriteRecord.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(mockWriteRecord).toHaveBeenCalledTimes(1);
  });

  it('destroy() stops periodic sync and removes beforeunload handler', async () => {
    mockFetchJutorUser.mockResolvedValue(testUser);

    mockWriteRecord.mockResolvedValue(mergedResponse({}));

    const { initEventSync } = await import('./sync.js');
    const instance = await initEventSync(baseConfig);

    mockWriteRecord.mockClear();

    instance.destroy();

    // Advance timer -- no sync should happen
    await vi.advanceTimersByTimeAsync(300_000);

    expect(mockWriteRecord).not.toHaveBeenCalled();
    expect(window.removeEventListener).toHaveBeenCalledWith(
      'beforeunload',
      expect.any(Function)
    );
  });
});

describe('collectLocalData', () => {
  let fakeStorage: ReturnType<typeof createFakeLocalStorage>;
  let originalWindow: typeof globalThis.window;

  beforeEach(() => {
    fakeStorage = createFakeLocalStorage();
    originalWindow = globalThis.window;
    // @ts-expect-error -- partial window mock
    globalThis.window = {
      localStorage: fakeStorage,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      location: { href: '' },
    };
  });

  afterEach(() => {
    globalThis.window = originalWindow;
  });

  it('collects only keys matching prefix + uid', async () => {
    fakeStorage.setItem('app_user-123_score', '10');
    fakeStorage.setItem('app_user-123_level', '3');
    fakeStorage.setItem('other_key', 'ignored');
    fakeStorage.setItem('app_user-456_score', 'other user');

    const { collectLocalData } = await import('./sync.js');
    const data = collectLocalData('app_', 'user-123');

    expect(data).toEqual({
      'app_user-123_score': '10',
      'app_user-123_level': '3',
    });
  });

  it('excludes __keyTimestamps entries', async () => {
    fakeStorage.setItem('app_user-123_score', '10');
    fakeStorage.setItem('app_user-123__keyTimestamps', '{"a":1000}');

    const { collectLocalData } = await import('./sync.js');
    const data = collectLocalData('app_', 'user-123');

    expect(data).toEqual({
      'app_user-123_score': '10',
    });
  });
});
