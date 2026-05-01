/**
 * Tests for `src/token-refresh.ts` (macf#317).
 *
 * Coverage targets:
 *  - Cache returns same token for calls within REFRESH_AGE_MS
 *  - Cache mints fresh past REFRESH_AGE_MS
 *  - `forceRefresh: true` bypasses cache
 *  - In-flight de-dup: concurrent calls share a single mint
 *  - Mint failure throws (does NOT silently fall back to env token)
 *  - Bad-prefix token is rejected
 *  - Empty stdout from helper script is rejected
 *  - Diagnostic message references silent-fallback-hazards.md Instance 1
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from '@groundnuty/macf-core';

import { createTokenRefresher, REFRESH_AGE_MS } from '../src/token-refresh.js';

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

interface MockClock {
  readonly now: () => number;
  advance: (ms: number) => void;
}

function makeClock(initial = 1_000_000): MockClock {
  let t = initial;
  return {
    now: () => t,
    advance: (ms: number) => { t += ms; },
  };
}

describe('createTokenRefresher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns cached token within REFRESH_AGE_MS', async () => {
    const clock = makeClock();
    const exec = vi.fn().mockResolvedValue({ stdout: 'ghs_aaa\n', stderr: '' });
    const refresher = createTokenRefresher({
      tokenScriptPath: '/fake/macf-gh-token.sh',
      clock,
      exec,
      logger: makeLogger(),
    });

    // Inject required env vars for the helper code path
    process.env['APP_ID'] = '1';
    process.env['INSTALL_ID'] = '2';
    process.env['KEY_PATH'] = '/fake/key.pem';

    const t1 = await refresher.getRefreshedToken();
    expect(t1).toBe('ghs_aaa');
    expect(exec).toHaveBeenCalledTimes(1);

    // 30 minutes later — still within 50-min cache window
    clock.advance(30 * 60 * 1000);
    const t2 = await refresher.getRefreshedToken();
    expect(t2).toBe('ghs_aaa');
    expect(exec).toHaveBeenCalledTimes(1); // no new mint
  });

  it('mints fresh past REFRESH_AGE_MS', async () => {
    const clock = makeClock();
    const exec = vi.fn()
      .mockResolvedValueOnce({ stdout: 'ghs_aaa\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'ghs_bbb\n', stderr: '' });
    const refresher = createTokenRefresher({
      tokenScriptPath: '/fake/macf-gh-token.sh',
      clock,
      exec,
      logger: makeLogger(),
    });

    process.env['APP_ID'] = '1';
    process.env['INSTALL_ID'] = '2';
    process.env['KEY_PATH'] = '/fake/key.pem';

    const t1 = await refresher.getRefreshedToken();
    expect(t1).toBe('ghs_aaa');

    // Advance past the 50-min mark
    clock.advance(REFRESH_AGE_MS + 1);
    const t2 = await refresher.getRefreshedToken();
    expect(t2).toBe('ghs_bbb');
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('forceRefresh: true bypasses cache', async () => {
    const clock = makeClock();
    const exec = vi.fn()
      .mockResolvedValueOnce({ stdout: 'ghs_aaa\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'ghs_ccc\n', stderr: '' });
    const refresher = createTokenRefresher({
      tokenScriptPath: '/fake/macf-gh-token.sh',
      clock,
      exec,
      logger: makeLogger(),
    });

    process.env['APP_ID'] = '1';
    process.env['INSTALL_ID'] = '2';
    process.env['KEY_PATH'] = '/fake/key.pem';

    const t1 = await refresher.getRefreshedToken();
    expect(t1).toBe('ghs_aaa');

    // No clock advance — would normally hit cache
    const t2 = await refresher.getRefreshedToken({ forceRefresh: true });
    expect(t2).toBe('ghs_ccc');
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('de-duplicates concurrent mint requests', async () => {
    const clock = makeClock();
    let resolveExec: ((v: { stdout: string; stderr: string }) => void) | null = null;
    const exec = vi.fn().mockImplementation(() => new Promise((res) => {
      resolveExec = res;
    }));

    const refresher = createTokenRefresher({
      tokenScriptPath: '/fake/macf-gh-token.sh',
      clock,
      exec,
      logger: makeLogger(),
    });

    process.env['APP_ID'] = '1';
    process.env['INSTALL_ID'] = '2';
    process.env['KEY_PATH'] = '/fake/key.pem';

    // Fire 3 concurrent calls — only 1 mint should run
    const p1 = refresher.getRefreshedToken();
    const p2 = refresher.getRefreshedToken();
    const p3 = refresher.getRefreshedToken();

    // Allow microtask queue to settle
    await new Promise((r) => setImmediate(r));
    expect(exec).toHaveBeenCalledTimes(1);

    // Resolve the in-flight mint
    expect(resolveExec).not.toBeNull();
    resolveExec!({ stdout: 'ghs_concurrent\n', stderr: '' });

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1).toBe('ghs_concurrent');
    expect(r2).toBe('ghs_concurrent');
    expect(r3).toBe('ghs_concurrent');
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('throws on mint failure (does NOT fall back to env token)', async () => {
    const clock = makeClock();
    const exec = vi.fn().mockRejectedValue(new Error('clock drift'));
    const refresher = createTokenRefresher({
      tokenScriptPath: '/fake/macf-gh-token.sh',
      clock,
      exec,
      logger: makeLogger(),
    });

    process.env['APP_ID'] = '1';
    process.env['INSTALL_ID'] = '2';
    process.env['KEY_PATH'] = '/fake/key.pem';
    // Even with GH_TOKEN set in env, refresher must NOT fall back to it
    process.env['GH_TOKEN'] = 'ghs_stale_env_token';

    await expect(refresher.getRefreshedToken()).rejects.toThrow(
      /Token refresh failed/,
    );
    // Diagnostic should reference the canonical hazard rule
    await expect(refresher.getRefreshedToken()).rejects.toThrow(
      /silent-fallback/,
    );
  });

  it('rejects token with non-ghs_ prefix', async () => {
    const clock = makeClock();
    const exec = vi.fn().mockResolvedValue({ stdout: 'ghp_user_pat\n', stderr: '' });
    const refresher = createTokenRefresher({
      tokenScriptPath: '/fake/macf-gh-token.sh',
      clock,
      exec,
      logger: makeLogger(),
    });

    process.env['APP_ID'] = '1';
    process.env['INSTALL_ID'] = '2';
    process.env['KEY_PATH'] = '/fake/key.pem';

    await expect(refresher.getRefreshedToken()).rejects.toThrow(
      /bad prefix.*ghp_/,
    );
  });

  it('rejects empty token from helper', async () => {
    const clock = makeClock();
    const exec = vi.fn().mockResolvedValue({ stdout: '\n', stderr: '' });
    const refresher = createTokenRefresher({
      tokenScriptPath: '/fake/macf-gh-token.sh',
      clock,
      exec,
      logger: makeLogger(),
    });

    process.env['APP_ID'] = '1';
    process.env['INSTALL_ID'] = '2';
    process.env['KEY_PATH'] = '/fake/key.pem';

    await expect(refresher.getRefreshedToken()).rejects.toThrow(
      /empty token/,
    );
  });

  it('throws when APP_ID/INSTALL_ID/KEY_PATH unset', async () => {
    const clock = makeClock();
    const exec = vi.fn();
    const refresher = createTokenRefresher({
      tokenScriptPath: '/fake/macf-gh-token.sh',
      clock,
      exec,
      logger: makeLogger(),
    });

    delete process.env['APP_ID'];
    delete process.env['INSTALL_ID'];
    delete process.env['KEY_PATH'];

    await expect(refresher.getRefreshedToken()).rejects.toThrow(
      /APP_ID\/INSTALL_ID\/KEY_PATH/,
    );
    expect(exec).not.toHaveBeenCalled();
  });

  it('logs token_refreshed event on successful mint', async () => {
    const clock = makeClock();
    const exec = vi.fn().mockResolvedValue({ stdout: 'ghs_logged\n', stderr: '' });
    const logger = makeLogger();
    const refresher = createTokenRefresher({
      tokenScriptPath: '/fake/macf-gh-token.sh',
      clock,
      exec,
      logger,
    });

    process.env['APP_ID'] = '1';
    process.env['INSTALL_ID'] = '2';
    process.env['KEY_PATH'] = '/fake/key.pem';

    await refresher.getRefreshedToken();
    expect(logger.info).toHaveBeenCalledWith(
      'token_refreshed',
      expect.objectContaining({ source: '/fake/macf-gh-token.sh' }),
    );
  });
});

describe('REFRESH_AGE_MS', () => {
  it('is 50 minutes (10-min safety margin under 1hr TTL)', () => {
    expect(REFRESH_AGE_MS).toBe(50 * 60 * 1000);
    // Sanity: less than the GitHub installation-token TTL (60 min)
    expect(REFRESH_AGE_MS).toBeLessThan(60 * 60 * 1000);
  });
});
