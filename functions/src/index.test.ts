import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted runs before vi.mock hoisting, so these are available in the factory
const { createCustomToken, mockAdmin } = vi.hoisted(() => {
  const createCustomToken = vi.fn().mockResolvedValue('mock-custom-token');
  const mockAdmin = {
    initializeApp: vi.fn(),
    auth: vi.fn(() => ({ createCustomToken })),
  };
  return { createCustomToken, mockAdmin };
});

// Mock firebase-admin
// index.ts uses `import * as admin` (namespace), so named exports are needed.
// The test file uses `import admin from` (default), so `default` is also needed.
vi.mock('firebase-admin', () => ({
  ...mockAdmin,
  default: mockAdmin,
}));

// Mock firebase-functions
vi.mock('firebase-functions/v2/https', () => ({
  onRequest: vi.fn((_opts: unknown, handler: unknown) => handler),
}));

import admin from 'firebase-admin';

describe('mintToken', () => {
  let handler: (req: any, res: any) => Promise<void>;

  beforeEach(async () => {
    vi.clearAllMocks();
    createCustomToken.mockResolvedValue('mock-custom-token');
    const mod = await import('./index.js');
    handler = mod.mintToken as unknown as typeof handler;
  });

  it('returns 405 for non-POST requests', async () => {
    const req = { method: 'GET', body: {} } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(405);
  });

  it('returns 400 if uid is missing', async () => {
    const req = { method: 'POST', body: {} } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 if uid is not a string', async () => {
    const req = { method: 'POST', body: { uid: 123 } } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns custom token for valid uid', async () => {
    const req = { method: 'POST', body: { uid: 'test-uid-123' } } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    await handler(req, res);
    expect(admin.auth().createCustomToken).toHaveBeenCalledWith('test-uid-123');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ token: 'mock-custom-token' });
  });

  it('returns 500 if createCustomToken fails', async () => {
    createCustomToken.mockRejectedValueOnce(new Error('auth error'));
    const req = { method: 'POST', body: { uid: 'test-uid-123' } } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Failed to create token' });
  });
});
