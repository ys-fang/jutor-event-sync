import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---- Mock initEventSync ----

const mockInitEventSync = vi.fn();
vi.mock('./sync.js', () => ({
  initEventSync: (...args: unknown[]) => mockInitEventSync(...args),
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

// ---- Tests ----

describe('createAppSync', () => {
  let fakeStorage: ReturnType<typeof createFakeLocalStorage>;
  let originalWindow: typeof globalThis.window;

  beforeEach(() => {
    vi.clearAllMocks();
    fakeStorage = createFakeLocalStorage();
    originalWindow = globalThis.window;
    // @ts-expect-error -- partial window mock for testing
    globalThis.window = {
      localStorage: fakeStorage,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      location: { href: 'https://example.com/app' },
    };
  });

  afterEach(() => {
    globalThis.window = originalWindow;
  });

  it('returns an object with initSync, getSyncInstance, redirectToJutorLogin, redirectToJutorLogout', async () => {
    const { createAppSync } = await import('./app-sync.js');
    const sync = createAppSync({ appId: 'test', prefix: 'test_' });

    expect(sync).toHaveProperty('initSync');
    expect(sync).toHaveProperty('getSyncInstance');
    expect(sync).toHaveProperty('redirectToJutorLogin');
    expect(sync).toHaveProperty('redirectToJutorLogout');
    expect(typeof sync.initSync).toBe('function');
    expect(typeof sync.getSyncInstance).toBe('function');
    expect(typeof sync.redirectToJutorLogin).toBe('function');
    expect(typeof sync.redirectToJutorLogout).toBe('function');
  });

  it('initSync calls initEventSync with correct config', async () => {
    const fakeInstance = {
      user: { uid: 'u1', userName: 'Alice' },
      isLoggedIn: true,
      redirectToLogin: vi.fn(),
      syncNow: vi.fn(),
      destroy: vi.fn(),
    };
    mockInitEventSync.mockResolvedValue(fakeInstance);

    const { createAppSync } = await import('./app-sync.js');
    const sync = createAppSync({ appId: 'myapp', prefix: 'myapp_' });
    await sync.initSync();

    expect(mockInitEventSync).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'myapp',
        localStoragePrefix: 'myapp_',
        syncApiUrl: expect.stringContaining('speech-token-server'),
        collectData: expect.any(Function),
        restoreData: expect.any(Function),
      })
    );
  });

  it('collectData collects prefix-matching keys and skips excluded suffixes', async () => {
    // Populate localStorage
    fakeStorage.setItem('myapp_progress', 'data1');
    fakeStorage.setItem('myapp_settings', 'data2');
    fakeStorage.setItem('myapp___lastSync', 'skip');
    fakeStorage.setItem('myapp___keyTimestamps', 'skip');
    fakeStorage.setItem('myapp__current_user', 'skip');
    fakeStorage.setItem('other_key', 'skip');

    // Capture the collectData function passed to initEventSync
    mockInitEventSync.mockImplementation((config: { collectData: () => Record<string, string> }) => {
      const collected = config.collectData();
      return Promise.resolve({
        user: null,
        isLoggedIn: false,
        redirectToLogin: vi.fn(),
        syncNow: vi.fn(),
        destroy: vi.fn(),
        _collected: collected,
      });
    });

    const { createAppSync } = await import('./app-sync.js');
    const sync = createAppSync({ appId: 'myapp', prefix: 'myapp_' });
    const result = await sync.initSync() as any;

    expect(result._collected).toEqual({
      myapp_progress: 'data1',
      myapp_settings: 'data2',
    });
  });

  it('restoreData writes keys to localStorage, skipping excluded suffixes', async () => {
    mockInitEventSync.mockImplementation((config: { restoreData: (data: Record<string, string>) => void }) => {
      config.restoreData({
        myapp_progress: 'restored1',
        myapp_settings: 'restored2',
        myapp___lastSync: 'should_skip',
        myapp___keyTimestamps: 'should_skip',
      });
      return Promise.resolve({
        user: null,
        isLoggedIn: false,
        redirectToLogin: vi.fn(),
        syncNow: vi.fn(),
        destroy: vi.fn(),
      });
    });

    const { createAppSync } = await import('./app-sync.js');
    const sync = createAppSync({ appId: 'myapp', prefix: 'myapp_' });
    await sync.initSync();

    expect(fakeStorage.getItem('myapp_progress')).toBe('restored1');
    expect(fakeStorage.getItem('myapp_settings')).toBe('restored2');
    expect(fakeStorage.getItem('myapp___lastSync')).toBeNull();
    expect(fakeStorage.getItem('myapp___keyTimestamps')).toBeNull();
  });

  it('getSyncInstance returns null before init, instance after init', async () => {
    const fakeInstance = {
      user: null,
      isLoggedIn: false,
      redirectToLogin: vi.fn(),
      syncNow: vi.fn(),
      destroy: vi.fn(),
    };
    mockInitEventSync.mockResolvedValue(fakeInstance);

    const { createAppSync } = await import('./app-sync.js');
    const sync = createAppSync({ appId: 'test', prefix: 'test_' });

    expect(sync.getSyncInstance()).toBeNull();

    await sync.initSync();

    expect(sync.getSyncInstance()).toBe(fakeInstance);
  });

  it('supports extraExcludeSuffixes', async () => {
    fakeStorage.setItem('test_progress', 'keep');
    fakeStorage.setItem('test_rate_limit', 'skip');
    fakeStorage.setItem('test___lastSync', 'skip');

    mockInitEventSync.mockImplementation((config: { collectData: () => Record<string, string> }) => {
      const collected = config.collectData();
      return Promise.resolve({
        user: null,
        isLoggedIn: false,
        redirectToLogin: vi.fn(),
        syncNow: vi.fn(),
        destroy: vi.fn(),
        _collected: collected,
      });
    });

    const { createAppSync } = await import('./app-sync.js');
    const sync = createAppSync({
      appId: 'test',
      prefix: 'test_',
      extraExcludeSuffixes: ['rate_limit'],
    });
    const result = await sync.initSync() as any;

    expect(result._collected).toEqual({
      test_progress: 'keep',
    });
  });

  it('extraSyncKeys collects both prefix keys and named global keys', async () => {
    fakeStorage.setItem('sentence_progress', 'data1');
    fakeStorage.setItem('byot_sessions_v1', 'sessions');
    fakeStorage.setItem('other_random', 'skip');

    mockInitEventSync.mockImplementation((config: { collectData: () => Record<string, string> }) => {
      const collected = config.collectData();
      return Promise.resolve({
        user: null,
        isLoggedIn: false,
        redirectToLogin: vi.fn(),
        syncNow: vi.fn(),
        destroy: vi.fn(),
        _collected: collected,
      });
    });

    const { createAppSync } = await import('./app-sync.js');
    const sync = createAppSync({
      appId: 'sentence',
      prefix: 'sentence_',
      extraSyncKeys: ['byot_sessions_v1'],
    });
    const result = await sync.initSync() as any;

    expect(result._collected).toEqual({
      sentence_progress: 'data1',
      byot_sessions_v1: 'sessions',
    });
  });

  it('extraSyncKeys still respects exclude suffixes', async () => {
    fakeStorage.setItem('byot_sessions_v1', 'keep');
    fakeStorage.setItem('sentence___lastSync', 'skip');
    fakeStorage.setItem('sentence_progress', 'keep');

    mockInitEventSync.mockImplementation((config: { collectData: () => Record<string, string> }) => {
      const collected = config.collectData();
      return Promise.resolve({
        user: null,
        isLoggedIn: false,
        redirectToLogin: vi.fn(),
        syncNow: vi.fn(),
        destroy: vi.fn(),
        _collected: collected,
      });
    });

    const { createAppSync } = await import('./app-sync.js');
    const sync = createAppSync({
      appId: 'sentence',
      prefix: 'sentence_',
      extraSyncKeys: ['byot_sessions_v1'],
    });
    const result = await sync.initSync() as any;

    expect(result._collected).toEqual({
      byot_sessions_v1: 'keep',
      sentence_progress: 'keep',
    });
    expect(result._collected).not.toHaveProperty('sentence___lastSync');
  });

  it('initSync returns null on error', async () => {
    mockInitEventSync.mockRejectedValue(new Error('network fail'));

    const { createAppSync } = await import('./app-sync.js');
    const sync = createAppSync({ appId: 'test', prefix: 'test_' });
    const result = await sync.initSync();

    expect(result).toBeNull();
  });

  it('redirectToJutorLogin navigates to Jutor login with continue URL', async () => {
    const { createAppSync } = await import('./app-sync.js');
    const sync = createAppSync({ appId: 'test', prefix: 'test_' });

    sync.redirectToJutorLogin();

    expect(window.location.href).toBe(
      `https://www.jutor.ai/login?continue=${encodeURIComponent('https://example.com/app')}`
    );
  });

  it('redirectToJutorLogout navigates to Jutor logout with continue URL', async () => {
    const { createAppSync } = await import('./app-sync.js');
    const sync = createAppSync({ appId: 'test', prefix: 'test_' });

    sync.redirectToJutorLogout();

    expect(window.location.href).toBe(
      `https://www.jutor.ai/logout?continue=${encodeURIComponent('https://example.com/app')}`
    );
  });

  it('each createAppSync call produces an independent instance', async () => {
    const fakeInstance1 = { user: null, isLoggedIn: false, redirectToLogin: vi.fn(), syncNow: vi.fn(), destroy: vi.fn() };
    const fakeInstance2 = { user: { uid: 'u2', userName: 'Bob' }, isLoggedIn: true, redirectToLogin: vi.fn(), syncNow: vi.fn(), destroy: vi.fn() };

    mockInitEventSync
      .mockResolvedValueOnce(fakeInstance1)
      .mockResolvedValueOnce(fakeInstance2);

    const { createAppSync } = await import('./app-sync.js');
    const sync1 = createAppSync({ appId: 'app1', prefix: 'app1_' });
    const sync2 = createAppSync({ appId: 'app2', prefix: 'app2_' });

    await sync1.initSync();
    await sync2.initSync();

    expect(sync1.getSyncInstance()).toBe(fakeInstance1);
    expect(sync2.getSyncInstance()).toBe(fakeInstance2);
  });
});
