#!/usr/bin/env node
/**
 * Postbuild: write `dist/.build-info.json` so the installed CLI can
 * detect a stale-dist situation at runtime (per #144).
 *
 * The file records the git HEAD at build time + an ISO timestamp.
 * `macf update` + `macf self-update` compare this against the source
 * repo's current HEAD to decide whether the operator's linked CLI is
 * behind main.
 *
 * Fail-soft on `git` errors: on a shallow clone or npm tarball
 * install where `.git/` isn't available, write `commit: "unknown"`
 * so the CLI still ships cleanly. The stale-detect path treats
 * `unknown` as "don't know, don't warn."
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(SCRIPT_DIR);
const DIST_DIR = join(REPO_ROOT, 'dist');
const TARGET = join(DIST_DIR, '.build-info.json');

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

if (!existsSync(DIST_DIR)) {
  mkdirSync(DIST_DIR, { recursive: true });
}

const info = {
  commit: gitCommit(),
  built_at: new Date().toISOString(),
};

writeFileSync(TARGET, JSON.stringify(info, null, 2) + '\n');
console.log(`Wrote ${TARGET}: commit=${info.commit.slice(0, 7)} built_at=${info.built_at}`);
