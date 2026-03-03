import { describe, it, expect, vi } from 'vitest';
import {
  wrapWithTimestamps,
  unwrapFromTimestamps,
  updateKeyTimestamps,
} from '../sync.js';

describe('wrapWithTimestamps', () => {
  it('wraps each key with its matching timestamp', () => {
    const data = { a: 'hello', b: 'world' };
    const timestamps = { a: 1000, b: 2000 };

    const result = wrapWithTimestamps(data, timestamps);

    expect(result).toEqual({
      a: { v: 'hello', t: 1000 },
      b: { v: 'world', t: 2000 },
    });
  });

  it('uses Date.now() for keys missing from timestamps', () => {
    const now = 1700000000000;
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const data = { a: 'hello', b: 'world' };
    const timestamps = { a: 1000 }; // b is missing

    const result = wrapWithTimestamps(data, timestamps);

    expect(result).toEqual({
      a: { v: 'hello', t: 1000 },
      b: { v: 'world', t: now },
    });

    vi.restoreAllMocks();
  });

  it('returns empty object for empty data', () => {
    const result = wrapWithTimestamps({}, {});
    expect(result).toEqual({});
  });
});

describe('unwrapFromTimestamps', () => {
  it('unwraps { v, t } entries to flat values and timestamps', () => {
    const data = {
      a: { v: 'hello', t: 1000 },
      b: { v: 'world', t: 2000 },
    };

    const result = unwrapFromTimestamps(data);

    expect(result).toEqual({
      values: { a: 'hello', b: 'world' },
      timestamps: { a: 1000, b: 2000 },
    });
  });

  it('handles plain values (non-{v,t} format) with timestamp 0', () => {
    const data = {
      a: 'plain-string' as unknown,
      b: 42 as unknown,
    };

    const result = unwrapFromTimestamps(data);

    expect(result).toEqual({
      values: { a: 'plain-string', b: '42' },
      timestamps: { a: 0, b: 0 },
    });
  });

  it('handles mixed entries (some wrapped, some plain)', () => {
    const data = {
      a: { v: 'wrapped', t: 1000 },
      b: 'plain' as unknown,
    };

    const result = unwrapFromTimestamps(data);

    expect(result).toEqual({
      values: { a: 'wrapped', b: 'plain' },
      timestamps: { a: 1000, b: 0 },
    });
  });

  it('returns empty objects for empty data', () => {
    const result = unwrapFromTimestamps({});
    expect(result).toEqual({ values: {}, timestamps: {} });
  });

  it('handles null/undefined entries gracefully', () => {
    const data = {
      a: null as unknown,
      b: undefined as unknown,
    };

    const result = unwrapFromTimestamps(data);

    // null/undefined should fall through to the else branch
    expect(result.values.a).toBe('null');
    expect(result.values.b).toBe('undefined');
    expect(result.timestamps.a).toBe(0);
    expect(result.timestamps.b).toBe(0);
  });

  it('handles objects with v but missing t', () => {
    const data = {
      a: { v: 'has-v-only' } as unknown,
    };

    const result = unwrapFromTimestamps(data);

    // Missing 't' means it doesn't match { v, t } pattern
    expect(result.values.a).toBe(String({ v: 'has-v-only' }));
    expect(result.timestamps.a).toBe(0);
  });
});

describe('updateKeyTimestamps', () => {
  const now = 1700000000000;

  it('sets timestamp for all keys when prev is null (first sync)', () => {
    const curr = { a: 'hello', b: 'world' };
    const existingTimestamps = {};

    const result = updateKeyTimestamps(null, curr, existingTimestamps, now);

    expect(result).toEqual({
      a: now,
      b: now,
    });
  });

  it('only updates timestamps for changed keys', () => {
    const prev = { a: 'hello', b: 'world' };
    const curr = { a: 'hello', b: 'changed' };
    const existingTimestamps = { a: 1000, b: 1000 };

    const result = updateKeyTimestamps(prev, curr, existingTimestamps, now);

    expect(result).toEqual({
      a: 1000, // unchanged — keeps old timestamp
      b: now,  // changed — gets new timestamp
    });
  });

  it('adds timestamps for new keys not in prev', () => {
    const prev = { a: 'hello' };
    const curr = { a: 'hello', b: 'new-key' };
    const existingTimestamps = { a: 1000 };

    const result = updateKeyTimestamps(prev, curr, existingTimestamps, now);

    expect(result).toEqual({
      a: 1000,
      b: now, // new key gets current timestamp
    });
  });

  it('preserves existing timestamps not present in curr', () => {
    const prev = { a: 'hello', b: 'world' };
    const curr = { a: 'hello' }; // b was removed
    const existingTimestamps = { a: 1000, b: 2000 };

    const result = updateKeyTimestamps(prev, curr, existingTimestamps, now);

    expect(result).toEqual({
      a: 1000,
      b: 2000, // preserved from existingTimestamps even though not in curr
    });
  });

  it('handles all keys changed', () => {
    const prev = { a: 'old-a', b: 'old-b' };
    const curr = { a: 'new-a', b: 'new-b' };
    const existingTimestamps = { a: 1000, b: 1000 };

    const result = updateKeyTimestamps(prev, curr, existingTimestamps, now);

    expect(result).toEqual({
      a: now,
      b: now,
    });
  });

  it('does not mutate the existingTimestamps object', () => {
    const prev = { a: 'hello' };
    const curr = { a: 'changed' };
    const existingTimestamps = { a: 1000 };

    updateKeyTimestamps(prev, curr, existingTimestamps, now);

    expect(existingTimestamps).toEqual({ a: 1000 }); // unchanged
  });
});
