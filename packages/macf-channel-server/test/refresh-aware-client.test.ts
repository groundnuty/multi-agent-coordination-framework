/**
 * Tests for `src/refresh-aware-client.ts` (macf#317).
 *
 * Coverage targets:
 *  - Each method calls tokenRefresher.getRefreshedToken() before invoking inner client
 *  - On 401, force-refreshes + retries once
 *  - Second 401 propagates (no infinite retry)
 *  - Non-401 errors propagate without retry
 *  - Mock the underlying fetch via global override (createGitHubClient uses fetch)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Logger } from '@groundnuty/macf-core';

import { createRefreshAwareClient } from '../src/refresh-aware-client.js';
import type { TokenRefresher } from '../src/token-refresh.js';

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeRefresher(opts: {
  initial: string;
  fresh?: string;
}): TokenRefresher & { calls: Array<boolean> } {
  const calls: Array<boolean> = [];
  return {
    calls,
    getRefreshedToken: vi.fn().mockImplementation(async (o?: { forceRefresh?: boolean }) => {
      const forced = o?.forceRefresh === true;
      calls.push(forced);
      return forced && opts.fresh !== undefined ? opts.fresh : opts.initial;
    }),
  } as unknown as TokenRefresher & { calls: Array<boolean> };
}

interface FetchResponse {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
}

function mockFetch(responses: FetchResponse[]): ReturnType<typeof vi.fn> {
  let idx = 0;
  return vi.fn().mockImplementation(async () => {
    const r = responses[idx];
    idx = Math.min(idx + 1, responses.length - 1);
    if (r === undefined) throw new Error('no more mocked responses');
    return {
      ok: r.ok,
      status: r.status,
      json: r.json ?? (async () => ({})),
      text: r.text ?? (async () => ''),
    };
  });
}

describe('createRefreshAwareClient', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('readVariable: calls getRefreshedToken before fetch + returns value', async () => {
    globalThis.fetch = mockFetch([
      {
        ok: true,
        status: 200,
        json: async () => ({
          name: 'X',
          value: 'hello',
          created_at: '2026-01-01',
          updated_at: '2026-01-01',
        }),
      },
    ]) as unknown as typeof globalThis.fetch;

    const refresher = makeRefresher({ initial: 'ghs_aaa' });
    const client = createRefreshAwareClient({
      pathPrefix: '/repos/o/r',
      tokenRefresher: refresher,
      logger: makeLogger(),
    });

    const v = await client.readVariable('X');
    expect(v).toBe('hello');
    expect(refresher.getRefreshedToken).toHaveBeenCalledTimes(1);
    expect(refresher.calls).toEqual([false]);
  });

  it('listVariables: returns empty list on first call when total_count=0', async () => {
    globalThis.fetch = mockFetch([
      {
        ok: true,
        status: 200,
        json: async () => ({ total_count: 0, variables: [] }),
      },
    ]) as unknown as typeof globalThis.fetch;

    const refresher = makeRefresher({ initial: 'ghs_aaa' });
    const client = createRefreshAwareClient({
      pathPrefix: '/repos/o/r',
      tokenRefresher: refresher,
      logger: makeLogger(),
    });

    const list = await client.listVariables();
    expect(list).toEqual([]);
  });

  it('on 401, force-refreshes + retries once (success path)', async () => {
    globalThis.fetch = mockFetch([
      // First attempt: 401
      { ok: false, status: 401, text: async () => 'Bad credentials' },
      // Retry: 200
      {
        ok: true,
        status: 200,
        json: async () => ({
          name: 'X',
          value: 'after-refresh',
          created_at: '2026-01-01',
          updated_at: '2026-01-01',
        }),
      },
    ]) as unknown as typeof globalThis.fetch;

    const refresher = makeRefresher({ initial: 'ghs_stale', fresh: 'ghs_fresh' });
    const logger = makeLogger();
    const client = createRefreshAwareClient({
      pathPrefix: '/repos/o/r',
      tokenRefresher: refresher,
      logger,
    });

    const v = await client.readVariable('X');
    expect(v).toBe('after-refresh');

    // First call: forceRefresh=false (cache), second: forceRefresh=true (401-retry)
    expect(refresher.calls).toEqual([false, true]);
    expect(logger.warn).toHaveBeenCalledWith(
      'github_api_401_refreshing_and_retrying',
      expect.objectContaining({ method: 'readVariable' }),
    );
  });

  it('on second 401 after refresh, throws (no infinite retry)', async () => {
    globalThis.fetch = mockFetch([
      // First attempt: 401
      { ok: false, status: 401, text: async () => 'Bad credentials' },
      // Retry: still 401 (e.g., revoked installation)
      { ok: false, status: 401, text: async () => 'Bad credentials' },
    ]) as unknown as typeof globalThis.fetch;

    const refresher = makeRefresher({ initial: 'ghs_stale', fresh: 'ghs_still_bad' });
    const client = createRefreshAwareClient({
      pathPrefix: '/repos/o/r',
      tokenRefresher: refresher,
      logger: makeLogger(),
    });

    await expect(client.readVariable('X')).rejects.toThrow(/401/);
    expect(refresher.calls).toEqual([false, true]);
  });

  it('non-401 errors propagate without retry', async () => {
    globalThis.fetch = mockFetch([
      { ok: false, status: 500, text: async () => 'server error' },
    ]) as unknown as typeof globalThis.fetch;

    const refresher = makeRefresher({ initial: 'ghs_aaa' });
    const client = createRefreshAwareClient({
      pathPrefix: '/repos/o/r',
      tokenRefresher: refresher,
      logger: makeLogger(),
    });

    await expect(client.listVariables()).rejects.toThrow(/500/);
    // Only initial call — no retry on 500
    expect(refresher.calls).toEqual([false]);
  });

  it('writeVariable: PATCH 401 → refresh → PATCH 200', async () => {
    globalThis.fetch = mockFetch([
      { ok: false, status: 401, text: async () => 'Bad credentials' },
      // After refresh, PATCH succeeds (the wrapper rebuilds the inner client
      // with the fresh token; the inner client tries PATCH first again)
      { ok: true, status: 200 },
    ]) as unknown as typeof globalThis.fetch;

    const refresher = makeRefresher({ initial: 'ghs_stale', fresh: 'ghs_fresh' });
    const client = createRefreshAwareClient({
      pathPrefix: '/repos/o/r',
      tokenRefresher: refresher,
      logger: makeLogger(),
    });

    await expect(client.writeVariable('X', 'value')).resolves.toBeUndefined();
    expect(refresher.calls).toEqual([false, true]);
  });

  it('deleteVariable: 401 → refresh → 204 succeeds', async () => {
    globalThis.fetch = mockFetch([
      { ok: false, status: 401, text: async () => 'Bad credentials' },
      { ok: true, status: 204 },
    ]) as unknown as typeof globalThis.fetch;

    const refresher = makeRefresher({ initial: 'ghs_stale', fresh: 'ghs_fresh' });
    const client = createRefreshAwareClient({
      pathPrefix: '/repos/o/r',
      tokenRefresher: refresher,
      logger: makeLogger(),
    });

    await expect(client.deleteVariable('X')).resolves.toBeUndefined();
    expect(refresher.calls).toEqual([false, true]);
  });
});
