import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('@groundnuty/macf-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@groundnuty/macf-core')>();
  return {
    ...actual,
    generateToken: vi.fn(),
  };
});

import { mintFreshGitHubToken } from '../../../src/plugin/lib/fresh-github-token.js';
import { generateToken } from '@groundnuty/macf-core';

describe('mintFreshGitHubToken (#338)', () => {
  it('delegates to generateToken with forceMint: true (no source)', async () => {
    vi.mocked(generateToken).mockResolvedValue('ghs_FRESHLY_MINTED');

    const result = await mintFreshGitHubToken();

    expect(result).toBe('ghs_FRESHLY_MINTED');
    expect(generateToken).toHaveBeenCalledOnce();
    expect(generateToken).toHaveBeenCalledWith(undefined, { forceMint: true });
  });

  it('always passes { forceMint: true } — never the env-shortcut path', async () => {
    vi.mocked(generateToken).mockResolvedValue('ghs_X');
    await mintFreshGitHubToken();
    const callArgs = vi.mocked(generateToken).mock.calls[0];
    expect(callArgs?.[1]).toEqual({ forceMint: true });
    expect(callArgs?.[1]?.forceMint).toBe(true);
  });
});

describe('macf-plugin-cli call-site-coverage invariant (#338)', () => {
  // Source-level invariant: the bin file MUST NOT call `generateToken`
  // directly. All token-mint paths go through `mintFreshGitHubToken()`
  // helper so the forceMint behavior is enforced by the import boundary.
  // Pre-#339-revision, the science-agent caught a missed call-site
  // (status case at line 38) where I'd extended scope to "all 4 cases"
  // but my replace_all only matched 3 due to differing comment text.
  // This test pins the invariant so a future call-site addition can't
  // silently regress to the env-shortcut behavior.
  const binPath = fileURLToPath(
    new URL('../../../src/plugin/bin/macf-plugin-cli.ts', import.meta.url),
  );

  it('macf-plugin-cli.ts contains zero direct `generateToken(` calls', () => {
    const source = readFileSync(binPath, 'utf-8');
    // Match any call to generateToken( — but exclude:
    //  - imports (`import { generateToken }`)
    //  - comments referencing `generateToken()` by name
    // Strip line comments before matching.
    const lines = source.split('\n')
      .filter(line => !line.trim().startsWith('//'))
      .filter(line => !line.trim().startsWith('*'))
      .join('\n');

    // Match `await generateToken(` or `generateToken(` (not as part of
    // mintFreshGitHubToken).
    const directCalls = lines.matchAll(/\bgenerateToken\s*\(/g);
    const matches = [...directCalls].map(m => m[0]);

    expect(matches).toEqual([]);
  });

  it('macf-plugin-cli.ts uses mintFreshGitHubToken at exactly 4 call sites (status/peers/ping/issues)', () => {
    const source = readFileSync(binPath, 'utf-8');
    const lines = source.split('\n')
      .filter(line => !line.trim().startsWith('//'))
      .filter(line => !line.trim().startsWith('*'))
      .join('\n');

    // Match `await mintFreshGitHubToken(` invocations (not the import line).
    const calls = [...lines.matchAll(/await\s+mintFreshGitHubToken\s*\(/g)];

    expect(calls.length).toBe(4);
  });

  it('macf-plugin-cli.ts imports mintFreshGitHubToken from the lib helper', () => {
    const source = readFileSync(binPath, 'utf-8');
    expect(source).toMatch(
      /import\s*\{\s*mintFreshGitHubToken\s*\}\s*from\s*['"]\.\.\/lib\/fresh-github-token\.js['"]/,
    );
  });
});
