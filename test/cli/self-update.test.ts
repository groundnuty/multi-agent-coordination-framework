/**
 * Tests for `macf self-update` (#144).
 *
 * The command pulls main + rebuilds, so its failure-mode surface is:
 *   - source repo has no .git/ (npm tarball install)
 *   - working tree is dirty
 *   - local has diverged from origin/main (ff-only would fail)
 *   - already up-to-date (early exit, don't rebuild)
 *   - happy path (pull + rebuild)
 *
 * The happy path's `npm run build` step is skipped in tests — we set
 * `MACF_SELF_UPDATE_SKIP_BUILD=1` so tests focus on the git orchestration
 * without actually shelling out to npm. The build step itself is
 * exercised by CI (which runs `npm run build` on every merge anyway).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selfUpdate } from '../../src/cli/commands/self-update.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function initCommitInRepo(dir: string, msg: string = 'seed'): string {
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'commit', '--allow-empty', '-q', '-m', msg);
  return git(dir, 'rev-parse', 'HEAD');
}

describe('selfUpdate', () => {
  let tmpRoot: string;
  let upstream: string;
  let local: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    // Real bare upstream repo + local clone so `git pull` has a valid target.
    tmpRoot = mkdtempSync(join(tmpdir(), 'macf-selfupdate-test-'));
    upstream = join(tmpRoot, 'upstream.git');

    // Build an upstream by first making a working repo, then cloning bare.
    const seed = join(tmpRoot, 'seed');
    mkdirSync(seed, { recursive: true });
    initCommitInRepo(seed);
    execFileSync('git', ['clone', '-q', '--bare', seed, upstream], { stdio: 'ignore' });

    // Clone the local repo from the bare upstream — this gives us proper
    // origin tracking without the shenanigans.
    local = join(tmpRoot, 'local');
    execFileSync('git', ['clone', '-q', '-b', 'main', upstream, local], { stdio: 'ignore' });
    git(local, 'config', 'user.email', 'test@example.invalid');
    git(local, 'config', 'user.name', 'Test');

    // Skip the npm build step during tests.
    originalEnv = process.env['MACF_SELF_UPDATE_SKIP_BUILD'];
    process.env['MACF_SELF_UPDATE_SKIP_BUILD'] = '1';
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env['MACF_SELF_UPDATE_SKIP_BUILD'];
    else process.env['MACF_SELF_UPDATE_SKIP_BUILD'] = originalEnv;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('throws when source repo has no .git/ directory', () => {
    const notARepo = join(tmpRoot, 'not-a-repo');
    mkdirSync(notARepo, { recursive: true });
    writeFileSync(join(notARepo, 'package.json'), '{"name": "macf"}');
    expect(() => selfUpdate(notARepo)).toThrow(/not a git-cloned install/i);
  });

  it('throws when working tree is dirty', () => {
    writeFileSync(join(local, 'uncommitted.txt'), 'dirty');
    git(local, 'add', 'uncommitted.txt');
    expect(() => selfUpdate(local)).toThrow(/working tree.*dirty/i);
  });

  it('throws when local has diverged (ff-only would fail)', () => {
    // Advance upstream by one commit AND local by a different commit.
    // To advance upstream: push from the seed-clone mechanism. Simpler:
    // make a new commit on local, then advance upstream via a fresh clone+push.
    const pusher = join(tmpRoot, 'pusher');
    execFileSync('git', ['clone', '-q', '-b', 'main', upstream, pusher], { stdio: 'ignore' });
    git(pusher, 'config', 'user.email', 'test@example.invalid');
    git(pusher, 'config', 'user.name', 'Test');
    git(pusher, 'commit', '--allow-empty', '-q', '-m', 'upstream advance');
    execFileSync('git', ['-C', pusher, 'push', '-q', 'origin', 'main'], { stdio: 'ignore' });

    // Diverge local on a different path.
    git(local, 'commit', '--allow-empty', '-q', '-m', 'local divergence');

    expect(() => selfUpdate(local)).toThrow(/diverged|ff-only|non-fast-forward/i);
  });

  it('early-exits when already up-to-date (no rebuild)', () => {
    // local and upstream are at the same commit.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = selfUpdate(local);
    expect(result.updated).toBe(false);
    expect(logSpy.mock.calls.flat().join(' ')).toMatch(/already up.to.date|no update/i);
    logSpy.mockRestore();
  });

  it('pulls new commits when upstream is ahead (happy path)', () => {
    // Advance upstream by one commit via a separate clone.
    const pusher = join(tmpRoot, 'pusher-happy');
    execFileSync('git', ['clone', '-q', '-b', 'main', upstream, pusher], { stdio: 'ignore' });
    git(pusher, 'config', 'user.email', 'test@example.invalid');
    git(pusher, 'config', 'user.name', 'Test');
    git(pusher, 'commit', '--allow-empty', '-q', '-m', 'new feature');
    const newHead = git(pusher, 'rev-parse', 'HEAD');
    execFileSync('git', ['-C', pusher, 'push', '-q', 'origin', 'main'], { stdio: 'ignore' });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = selfUpdate(local);

    expect(result.updated).toBe(true);
    expect(result.newCommit).toBe(newHead);
    expect(git(local, 'rev-parse', 'HEAD')).toBe(newHead);
    logSpy.mockRestore();
  });
});
