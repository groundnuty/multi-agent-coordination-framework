import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyCanonicalRules, canonicalRulesDir, findCliPackageRoot } from '../../src/cli/rules.js';

describe('findCliPackageRoot', () => {
  it('locates the CLI package root by walking up for package.json', () => {
    const root = findCliPackageRoot();
    expect(existsSync(join(root, 'package.json'))).toBe(true);
    // The repo package.json contains our bin entry — sanity check.
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
    expect(pkg.name).toBe('macf');
  });
});

describe('canonicalRulesDir', () => {
  it('points to <repo>/plugin/rules/ in dev layout', () => {
    const dir = canonicalRulesDir();
    expect(dir.endsWith(join('plugin', 'rules'))).toBe(true);
    expect(existsSync(dir)).toBe(true);
  });

  it('coordination.md exists in the canonical dir', () => {
    const dir = canonicalRulesDir();
    expect(existsSync(join(dir, 'coordination.md'))).toBe(true);
  });
});

describe('copyCanonicalRules', () => {
  let tmpRoot: string;
  let fakeCanonical: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'macf-rules-test-'));
    fakeCanonical = join(tmpRoot, 'canonical');
    mkdirSync(fakeCanonical, { recursive: true });
    writeFileSync(join(fakeCanonical, 'coordination.md'), '# Coordination\n\nBody text.\n');
    writeFileSync(join(fakeCanonical, 'other.md'), '# Other rule\n');
    // A non-markdown file should be ignored.
    writeFileSync(join(fakeCanonical, 'README.txt'), 'ignore me');
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('copies every .md file to <workspace>/.claude/rules/', () => {
    const workspace = join(tmpRoot, 'workspace');
    mkdirSync(workspace);

    const copied = copyCanonicalRules(workspace, { canonicalDir: fakeCanonical });

    expect(copied).toContain('coordination.md');
    expect(copied).toContain('other.md');
    expect(copied).not.toContain('README.txt');

    const rulesDir = join(workspace, '.claude', 'rules');
    expect(existsSync(rulesDir)).toBe(true);
    const files = readdirSync(rulesDir).sort();
    expect(files).toEqual(['coordination.md', 'other.md']);
  });

  it('prepends a managed-file warning header', () => {
    const workspace = join(tmpRoot, 'workspace');
    mkdirSync(workspace);

    copyCanonicalRules(workspace, { canonicalDir: fakeCanonical });

    const copied = readFileSync(join(workspace, '.claude', 'rules', 'coordination.md'), 'utf-8');
    expect(copied.startsWith('<!--')).toBe(true);
    expect(copied).toContain('managed by `macf`');
    expect(copied).toContain('# Coordination');
  });

  it('overwrites existing workspace copies on re-run', () => {
    const workspace = join(tmpRoot, 'workspace');
    const rulesDir = join(workspace, '.claude', 'rules');
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, 'coordination.md'), '# stale edits by user\n');

    copyCanonicalRules(workspace, { canonicalDir: fakeCanonical });

    const out = readFileSync(join(rulesDir, 'coordination.md'), 'utf-8');
    expect(out).not.toContain('stale edits by user');
    expect(out).toContain('# Coordination');
  });

  it('does not double-prepend the header when canonical file already has one', () => {
    // If a canonical file ever starts with <!-- (perhaps someone added a comment),
    // the copy shouldn't stack another managed header on top. Simulate by writing
    // a canonical file that already begins with <!--.
    writeFileSync(join(fakeCanonical, 'coordination.md'),
      '<!-- This is a pre-existing comment -->\n# Coordination\n');

    const workspace = join(tmpRoot, 'workspace');
    mkdirSync(workspace);

    copyCanonicalRules(workspace, { canonicalDir: fakeCanonical });

    const copied = readFileSync(join(workspace, '.claude', 'rules', 'coordination.md'), 'utf-8');
    const openingComments = copied.match(/<!--/g) ?? [];
    expect(openingComments.length).toBe(1);
  });

  it('creates .claude/rules/ when it does not exist', () => {
    const workspace = join(tmpRoot, 'fresh-workspace');
    mkdirSync(workspace);
    expect(existsSync(join(workspace, '.claude'))).toBe(false);

    copyCanonicalRules(workspace, { canonicalDir: fakeCanonical });

    expect(existsSync(join(workspace, '.claude', 'rules', 'coordination.md'))).toBe(true);
  });

  it('returns empty array when canonical dir does not exist (no crash)', () => {
    const workspace = join(tmpRoot, 'workspace');
    mkdirSync(workspace);

    const copied = copyCanonicalRules(workspace, {
      canonicalDir: join(tmpRoot, 'does-not-exist'),
    });

    expect(copied).toEqual([]);
    expect(existsSync(join(workspace, '.claude'))).toBe(false);
  });
});
