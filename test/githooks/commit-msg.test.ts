/**
 * Tests for `.githooks/commit-msg` — the local commitlint pre-commit
 * hook added per #158.
 *
 * The hook is git's standard commit-msg mechanism: git invokes it with
 * the path to a file containing the staged commit message. Exit 0 =
 * commit proceeds; non-zero = commit aborted. Our hook runs
 * `node_modules/.bin/commitlint --edit <file> --config commitlint.config.mjs`
 * against the message and inherits its exit code.
 *
 * Smoke-tests the three failure classes that bit us 3 times in recent
 * PRs (length, type, case), plus the valid-happy-path baseline, plus
 * the defensive "missing commitlint in node_modules" fall-through.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const hookPath = join(repoRoot, '.githooks', 'commit-msg');

function runHook(msg: string): ReturnType<typeof spawnSync> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'macf-commit-msg-'));
  const msgFile = join(tmpDir, 'msg');
  writeFileSync(msgFile, msg);
  try {
    return spawnSync('bash', [hookPath, msgFile], {
      encoding: 'utf-8',
      cwd: repoRoot,
    });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe('.githooks/commit-msg (#158)', () => {
  describe('happy path', () => {
    it('allows a valid conventional commit subject', () => {
      const r = runHook('feat: valid subject\n');
      expect(r.status).toBe(0);
    });

    it('allows a subject with a valid scope', () => {
      const r = runHook('security(hooks): block bash -c bypass\n');
      expect(r.status).toBe(0);
    });

    it('allows each type in the commitlint enum', { timeout: 30_000 }, () => {
      // Walk the 13 configured types; each spawn is ~800ms so the
      // 5s default won't cover the loop. 30s leaves ample margin.
      const validTypes = [
        'feat', 'fix', 'security', 'reliability', 'refactor',
        'perf', 'docs', 'test', 'chore', 'ci', 'revert', 'build', 'style',
      ];
      for (const t of validTypes) {
        const r = runHook(`${t}: example subject\n`);
        expect(r.status, `type ${t} should be valid`).toBe(0);
      }
    });
  });

  describe('reject path — catches the violations from recent PRs', () => {
    it('rejects a subject exceeding the 100-char length limit (#131 shape)', () => {
      const longSubject = 'feat: ' + 'x'.repeat(105);
      const r = runHook(`${longSubject}\n`);
      expect(r.status).not.toBe(0);
      expect(r.stdout + r.stderr).toMatch(/header must not be longer|max-length/i);
    });

    it('rejects a type not in the enum (#132 shape — pre-`reliability`)', () => {
      const r = runHook('nope: bad type\n');
      expect(r.status).not.toBe(0);
      expect(r.stdout + r.stderr).toMatch(/type-enum|type must be one of/i);
    });

    it('rejects a subject with start-case/upper-case proper noun (#157 shape)', () => {
      const r = runHook('docs: CHANGELOG updates for release\n');
      expect(r.status).not.toBe(0);
      expect(r.stdout + r.stderr).toMatch(/subject-case|must not be/i);
    });
  });

  describe('defensive no-op', () => {
    it('exits cleanly when invoked with no argument', () => {
      const r = spawnSync('bash', [hookPath], { encoding: 'utf-8', cwd: repoRoot });
      // The hook warns and exits 0 — a broken invocation must not block commits.
      expect(r.status).toBe(0);
      expect(r.stderr).toMatch(/expected commit message file/);
    });
  });
});
