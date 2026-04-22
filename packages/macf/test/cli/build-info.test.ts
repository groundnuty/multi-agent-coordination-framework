/**
 * Tests for `src/cli/build-info.ts` — stale-dist detection (#144).
 *
 * Two public functions:
 *   - readBuildInfo(packageRoot): load dist/.build-info.json (or null)
 *   - detectStaleDist(packageRoot): compare build-info.commit against
 *     git rev-parse HEAD in the same repo, returning null (not stale,
 *     can't determine, or no git) or StaleDistInfo (stale detected).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBuildInfo, detectStaleDist, detectUnknownFreshness } from '../../src/cli/build-info.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function initRepo(dir: string): void {
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'commit', '--allow-empty', '-q', '-m', 'initial');
}

function writeBuildInfo(packageRoot: string, commit: string, builtAt = '2026-04-20T20:00:00Z'): void {
  const distDir = join(packageRoot, 'dist');
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, '.build-info.json'), JSON.stringify({ commit, built_at: builtAt }));
}

describe('readBuildInfo', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'macf-buildinfo-read-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns null when dist/.build-info.json is missing', () => {
    expect(readBuildInfo(tmp)).toBeNull();
  });

  it('returns parsed info when the file exists', () => {
    writeBuildInfo(tmp, 'abc1234def5678', '2026-04-20T12:00:00Z');
    const info = readBuildInfo(tmp);
    expect(info).toEqual({ commit: 'abc1234def5678', built_at: '2026-04-20T12:00:00Z' });
  });

  it('returns null on malformed JSON (does not throw)', () => {
    mkdirSync(join(tmp, 'dist'), { recursive: true });
    writeFileSync(join(tmp, 'dist', '.build-info.json'), '{ not valid');
    expect(readBuildInfo(tmp)).toBeNull();
  });
});

describe('detectStaleDist', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'macf-staledist-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns null when .git/ is missing (npm-tarball install)', () => {
    // No git init — just a directory with a build-info.
    writeBuildInfo(tmp, 'abc1234');
    expect(detectStaleDist(tmp)).toBeNull();
  });

  it('returns null when build-info is missing (never built)', () => {
    initRepo(tmp);
    expect(detectStaleDist(tmp)).toBeNull();
  });

  it('returns null when build-info.commit is "unknown" (fail-soft case)', () => {
    initRepo(tmp);
    writeBuildInfo(tmp, 'unknown');
    expect(detectStaleDist(tmp)).toBeNull();
  });

  it('returns null when commits match (fresh dist)', () => {
    initRepo(tmp);
    const head = git(tmp, 'rev-parse', 'HEAD');
    writeBuildInfo(tmp, head);
    expect(detectStaleDist(tmp)).toBeNull();
  });

  it('returns StaleDistInfo when commits differ', () => {
    initRepo(tmp);
    const oldHead = git(tmp, 'rev-parse', 'HEAD');
    writeBuildInfo(tmp, oldHead);
    // Make a new commit so HEAD moves.
    git(tmp, 'commit', '--allow-empty', '-q', '-m', 'newer');
    const newHead = git(tmp, 'rev-parse', 'HEAD');

    const stale = detectStaleDist(tmp);
    expect(stale).not.toBeNull();
    expect(stale?.buildCommit).toBe(oldHead);
    expect(stale?.currentCommit).toBe(newHead);
  });
});

describe('detectUnknownFreshness', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'macf-unknown-freshness-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns null when .git/ is missing (tarball install — nothing to warn about)', () => {
    writeBuildInfo(tmp, 'abc123');
    expect(detectUnknownFreshness(tmp)).toBeNull();
  });

  it('returns missing_build_info when .git/ exists but no build-info (operator ran `npx tsc` directly)', () => {
    initRepo(tmp);
    const r = detectUnknownFreshness(tmp);
    expect(r).toEqual({ reason: 'missing_build_info' });
  });

  it('returns unknown_build_commit when build-info.commit is "unknown" (build script ran without git)', () => {
    initRepo(tmp);
    writeBuildInfo(tmp, 'unknown');
    const r = detectUnknownFreshness(tmp);
    expect(r).toEqual({ reason: 'unknown_build_commit' });
  });

  it('returns null when build-info is genuine (stale-detect is the right check, not this)', () => {
    initRepo(tmp);
    const head = git(tmp, 'rev-parse', 'HEAD');
    writeBuildInfo(tmp, head);
    expect(detectUnknownFreshness(tmp)).toBeNull();
  });
});
