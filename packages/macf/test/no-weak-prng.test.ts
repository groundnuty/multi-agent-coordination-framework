/**
 * Global weak-PRNG guard — no `Math.random` anywhere in `src/`.
 *
 * #109 H1 added a source-scan guard for `src/https.ts` specifically.
 * This extends the pattern repo-wide: security-adjacent or not, the
 * canonical random source in this codebase is `crypto.randomInt` /
 * `crypto.randomUUID` / `crypto.randomBytes`. `Math.random` is not
 * cryptographically safe and its seed is observable via timing +
 * output — banning it at the source level prevents future refactors
 * from silently reintroducing it.
 *
 * Per the phase-2 audit backlog memory (2026-04-17 + 2026-04-20
 * sessions): flagged as a "file-when-drift-bites" watch-item. Filing
 * proactively here because the current src/ has zero occurrences and
 * the guard is near-free to maintain.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(repoRoot, 'src');

function* walkTsFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      yield* walkTsFiles(full);
    } else if (stat.isFile() && entry.endsWith('.ts')) {
      yield full;
    }
  }
}

describe('no weak PRNG in src/', () => {
  it('no Math.random usage in any src/**/*.ts file', () => {
    const offenders: string[] = [];
    for (const path of walkTsFiles(srcDir)) {
      const content = readFileSync(path, 'utf-8');
      // Match `Math.random` but skip lines that look like a comment
      // explicitly banning it — lets the guard itself reference the
      // banned symbol in its own explanatory prose without tripping.
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (!/Math\.random/.test(line)) continue;
        if (/^\s*(\*|\/\/)/.test(line)) continue; // comment line
        offenders.push(`${path.slice(repoRoot.length + 1)}:${i + 1}: ${line.trim()}`);
      }
    }
    expect(
      offenders,
      `Math.random found in src/ — use crypto.randomInt / randomUUID / randomBytes instead:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
