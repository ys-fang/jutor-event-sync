import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EventSyncConfig } from './types.js';

// ---- Mock modules ----

const mockFetchJutorUser = vi.fn();
const mockRequestMintToken = vi.fn();
vi.mock('./auth.js', () => ({
  fetchJutorUser: (...args: unknown[]) => mockFetchJutorUser(...args),
  requestMintToken: (...args: unknown[]) => mockRequestMintToken(...args),
}));

const mockInitFirebase = vi.fn();
const mockSignInWithToken = vi.fn();
const mockReadRecord = vi.fn();
const mockWriteRecord = vi.fn();
vi.mock('./firebase-client.js', () => ({
  initFirebase: (...args: unknown[]) => mockInitFirebase(...args),
  signInWithToken: (...args: unknown[]) => mockSignInWithToken(...args),
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

// ---- Test config ----

const baseConfig: EventSyncConfig = {
  appId: 'test-app',
  localStoragePrefix: 'app_',
  mintTokenUrl: 'https://mint.example.com/mintToken',
  firebaseConfig: { projectId: 'test-project' },
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

    // Provide a minimal window-like object with localStorage and addEventListener
    originalWindow = globalThis.window;
    // @ts-expect-error -- partial window mock for testing
    globalThis.window = {
      localStorage: fakeStorage,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      location: { href: '' },
    };
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
    expect(mockInitFirebase).not.toHaveBeenCalled();
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

  it('authenticates and pulls from Firestore on startup when remote is newer', async () => {
    mockFetchJutorUser.mockResolvedValue(testUser);
    mockRequestMintToken.mockResolvedValue('custom-token-xyz');
    mockSignInWithToken.mockResolvedValue(undefined);
    mockInitFirebase.mockReturnValue({
      app: {},
      auth: {},
      db: {},
    });

    // Local data: older
    fakeStorage.setItem('app_user-123_score', '10');
    fakeStorage.setItem('app_user-123__lastSync', '1000');

    // Remote data: newer
    mockReadRecord.mockResolvedValue({
      data: { 'app_user-123_score': '99', 'app_user-123_level': '5' },
      lastSync: 2000,
    });

    const { initEventSync } = await import('./sync.js');
    const instance = await initEventSync(baseConfig);

    expect(instance.isLoggedIn).toBe(true);
    expect(instance.user).toEqual(testUser);

    // Firebase was initialized and authenticated
    expect(mockInitFirebase).toHaveBeenCalledWith(baseConfig.firebaseConfig);
    expect(mockRequestMintToken).toHaveBeenCalledWith(
      baseConfig.mintTokenUrl,
      'user-123'
    );
    expect(mockSignInWithToken).toHaveBeenCalledWith('custom-token-xyz');

    // Remote data overwrites local
    expect(fakeStorage.getItem('app_user-123_score')).toBe('99');
    expect(fakeStorage.getItem('app_user-123_level')).toBe('5');
    // lastSync updated
    expect(fakeStorage.getItem('app_user-123__lastSync')).toBe('2000');
  });

  it('keeps local data when local is newer than Firestore', async () => {
    mockFetchJutorUser.mockResolvedValue(testUser);
    mockRequestMintToken.mockResolvedValue('token');
    mockSignInWithToken.mockResolvedValue(undefined);
    mockInitFirebase.mockReturnValue({ app: {}, auth: {}, db: {} });

    // Local data: newer
    fakeStorage.setItem('app_user-123_score', '50');
    fakeStorage.setItem('app_user-123__lastSync', '5000');

    // Remote data: older
    mockReadRecord.mockResolvedValue({
      data: { 'app_user-123_score': '10' },
      lastSync: 1000,
    });

    const { initEventSync } = await import('./sync.js');
    await initEventSync(baseConfig);

    // Local data preserved
    expect(fakeStorage.getItem('app_user-123_score')).toBe('50');
    // Push to Firestore since local is newer
    expect(mockWriteRecord).toHaveBeenCalled();
  });

  it('keeps local data when Firestore has no record', async () => {
    mockFetchJutorUser.mockResolvedValue(testUser);
    mockRequestMintToken.mockResolvedValue('token');
    mockSignInWithToken.mockResolvedValue(undefined);
    mockInitFirebase.mockReturnValue({ app: {}, auth: {}, db: {} });

    fakeStorage.setItem('app_user-123_score', '50');
    fakeStorage.setItem('app_user-123__lastSync', '5000');

    mockReadRecord.mockResolvedValue(null);

    const { initEventSync } = await import('./sync.js');
    await initEventSync(baseConfig);

    // Local data preserved
    expect(fakeStorage.getItem('app_user-123_score')).toBe('50');
    // Push to Firestore since no remote record
    expect(mockWriteRecord).toHaveBeenCalled();
  });

  it('pushes local data on syncNow()', async () => {
    mockFetchJutorUser.mockResolvedValue(testUser);
    mockRequestMintToken.mockResolvedValue('token');
    mockSignInWithToken.mockResolvedValue(undefined);
    mockInitFirebase.mockReturnValue({ app: {}, auth: {}, db: {} });
    mockReadRecord.mockResolvedValue(null);
    mockWriteRecord.mockResolvedValue(undefined);

    fakeStorage.setItem('app_user-123_progress', 'chapter3');

    const { initEventSync } = await import('./sync.js');
    const instance = await initEventSync(baseConfig);

    mockWriteRecord.mockClear();

    await instance.syncNow();

    expect(mockWriteRecord).toHaveBeenCalledWith(
      'user-123',
      'test-app',
      expect.objectContaining({ 'app_user-123_progress': 'chapter3' })
    );
  });

  it('periodic sync triggers at configured interval', async () => {
    mockFetchJutorUser.mockResolvedValue(testUser);
    mockRequestMintToken.mockResolvedValue('token');
    mockSignInWithToken.mockResolvedValue(undefined);
    mockInitFirebase.mockReturnValue({ app: {}, auth: {}, db: {} });
    mockReadRecord.mockResolvedValue(null);
    mockWriteRecord.mockResolvedValue(undefined);

    fakeStorage.setItem('app_user-123_data', 'test');

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
    mockRequestMintToken.mockResolvedValue('token');
    mockSignInWithToken.mockResolvedValue(undefined);
    mockInitFirebase.mockReturnValue({ app: {}, auth: {}, db: {} });
    mockReadRecord.mockResolvedValue(null);
    mockWriteRecord.mockResolvedValue(undefined);

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
});
