import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdirSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createRegistryFromConfig } from '../../src/registry/factory.js';

// Mock the GitHub-backed underlying module. The local-client module is
// NOT mocked — its perms-validation is fast and uses node fs primitives
// directly, so we exercise it with a real tmpdir.
vi.mock('../../src/registry/github-client.js', () => ({
  createGitHubClient: vi.fn().mockReturnValue({
    writeVariable: vi.fn(),
    readVariable: vi.fn(),
    listVariables: vi.fn(),
    deleteVariable: vi.fn(),
  }),
}));

const { createGitHubClient } = await import('../../src/registry/github-client.js');

describe('createRegistryFromConfig', () => {
  it('creates org registry with correct path prefix', () => {
    createRegistryFromConfig({ type: 'org', org: 'my-org' }, 'MACF', 'token');

    expect(createGitHubClient).toHaveBeenCalledWith('/orgs/my-org', 'token');
  });

  it('creates profile registry with user/user path prefix', () => {
    createRegistryFromConfig({ type: 'profile', user: 'groundnuty' }, 'MACF', 'token');

    expect(createGitHubClient).toHaveBeenCalledWith('/repos/groundnuty/groundnuty', 'token');
  });

  it('creates repo registry with owner/repo path prefix', () => {
    createRegistryFromConfig(
      { type: 'repo', owner: 'groundnuty', repo: 'macf' },
      'MACF',
      'token',
    );

    expect(createGitHubClient).toHaveBeenCalledWith('/repos/groundnuty/macf', 'token');
  });

  it('returns a Registry with standard interface methods', () => {
    const registry = createRegistryFromConfig(
      { type: 'repo', owner: 'o', repo: 'r' },
      'TEST',
      'tok',
    );

    expect(typeof registry.register).toBe('function');
    expect(typeof registry.get).toBe('function');
    expect(typeof registry.list).toBe('function');
    expect(typeof registry.remove).toBe('function');
  });

  describe('local registry variant (DR-024)', () => {
    let dir: string;
    let filePath: string;

    beforeEach(() => {
      dir = path.join(tmpdir(), `macf-factory-local-${randomBytes(6).toString('hex')}`);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (process.platform !== 'win32') chmodSync(dir, 0o700);
      filePath = path.join(dir, 'TEST.json');
    });

    afterEach(async () => {
      if (process.platform !== 'win32') chmodSync(dir, 0o700);
      await fs.rm(dir, { recursive: true, force: true });
    });

    it('creates a Registry from a local config without consulting createGitHubClient', () => {
      vi.mocked(createGitHubClient).mockClear();

      const registry = createRegistryFromConfig(
        { type: 'local', path: filePath },
        'TEST',
        // Token argument is unused for local — empty string is the
        // documented call-shape.
        '',
      );

      expect(createGitHubClient).not.toHaveBeenCalled();
      expect(typeof registry.register).toBe('function');
      expect(typeof registry.get).toBe('function');
      expect(typeof registry.list).toBe('function');
      expect(typeof registry.remove).toBe('function');
    });

    it('local-mode register writes to the configured filesystem path', async () => {
      const registry = createRegistryFromConfig(
        { type: 'local', path: filePath },
        'TEST',
        '',
      );

      await registry.register('a', {
        host: '127.0.0.1', port: 9000, type: 'permanent',
        instance_id: 'x', started: '2026-05-01T00:00:00Z',
      });

      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      expect(parsed.project).toBe('TEST');
      expect(parsed.agents.a.port).toBe(9000);
    });
  });
});
