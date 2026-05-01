/**
 * Tests for `macf init --local` (DR-024 / macf#322 PR-B).
 *
 * Covers:
 * - `--local` short-circuits App-cred prompts (App-cred fields not required).
 * - `--local` is alias for `--registry-type local` (both produce same config).
 * - `--path` overrides the default `~/.macf/registry/<project>.json`.
 * - Auto-CA generation: first invocation creates `<project>.ca.{crt,key}`;
 *   second invocation reuses them.
 * - FS perms: registry dir is `0700`, ca-key is `0600`.
 * - `--migrate-from` errors when target is `--local` (loud failure).
 *
 * Migration happy-path lives in a separate test file (`migrate.test.ts`)
 * so this file stays focused on init UX shape.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import {
  mkdirSync, rmSync, existsSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { initAgent } from '../../src/cli/commands/init.js';
import { readAgentConfig } from '../../src/cli/config.js';

function tempDir(): string {
  const dir = join(tmpdir(), `macf-init-local-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function tempRegistryPath(): string {
  // Co-locate registry + workspace under the same tmp parent so cleanup
  // trivially purges both.
  const dir = join(tmpdir(), `macf-local-reg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return join(dir, 'project.json');
}

describe('macf init --local (DR-024)', () => {
  let workspaceDir: string;
  let registryPath: string;

  beforeEach(() => {
    workspaceDir = tempDir();
    registryPath = tempRegistryPath();
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
    // Registry dir lives outside the workspace; clean its parent
    // independently. Use force so the dir-not-existing path doesn't
    // throw (an init that errored before mkdir won't have created it).
    const regDir = join(registryPath, '..');
    rmSync(regDir, { recursive: true, force: true });
  });

  it('--local short-circuits App-cred requirements', async () => {
    // No appId / installId / keyPath. In GitHub mode the validator
    // would throw "appId is required"; in local mode the App-cred
    // checks are skipped entirely.
    await initAgent(workspaceDir, {
      project: 'localp',
      role: 'paper-agent',
      registryType: 'local',
      registryPath,
    });

    const config = readAgentConfig(workspaceDir);
    expect(config).not.toBeNull();
    expect(config!.registry).toEqual({ type: 'local', path: registryPath });
    // No github_app block when running in local mode (DR-024).
    expect(config!.github_app).toBeUndefined();
  });

  it('--registry-type local is the granular form (same effect as --local)', async () => {
    // The CLI flag plumbing in `index.ts` collapses `--local` →
    // `registryType: 'local'`. This test exercises the underlying
    // initAgent contract directly with the granular form.
    await initAgent(workspaceDir, {
      project: 'granular',
      role: 'code-agent',
      registryType: 'local',
      registryPath,
    });

    const config = readAgentConfig(workspaceDir);
    expect(config!.registry.type).toBe('local');
    if (config!.registry.type === 'local') {
      expect(config!.registry.path).toBe(registryPath);
    }
  });

  it('--path defaults to ~/.macf/registry/<project>.json when unset', async () => {
    // Don't pass --path. The default path is computed from `homedir()`
    // at init time. Redirect HOME so the test doesn't pollute the real
    // user's `~/.macf/`. `os.homedir()` reads HOME on POSIX (USERPROFILE
    // on Windows). Skip on Windows where the env-redirect doesn't take.
    if (process.platform === 'win32') return;
    const fakeHome = tempDir();
    const realHome = process.env['HOME'];
    process.env['HOME'] = fakeHome;
    try {
      await initAgent(workspaceDir, {
        project: 'defaultedp',
        role: 'code-agent',
        registryType: 'local',
        // registryPath omitted → default
      });

      const config = readAgentConfig(workspaceDir);
      if (config!.registry.type === 'local') {
        expect(config!.registry.path).toBe(
          join(fakeHome, '.macf', 'registry', 'defaultedp.json'),
        );
      }
    } finally {
      if (realHome === undefined) {
        delete process.env['HOME'];
      } else {
        process.env['HOME'] = realHome;
      }
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('rejects relative --path (must be absolute per DR-024)', async () => {
    await expect(initAgent(workspaceDir, {
      project: 'rel',
      role: 'agent',
      registryType: 'local',
      registryPath: 'relative/registry.json',
    })).rejects.toThrow(/absolute/);
  });

  it('rejects --path with shell-special chars', async () => {
    await expect(initAgent(workspaceDir, {
      project: 'shell',
      role: 'agent',
      registryType: 'local',
      registryPath: '/tmp/$(evil)/reg.json',
    })).rejects.toThrow(/--path/);
  });

  it('first invocation generates CA at <dir>/<project>.ca.{crt,key}', async () => {
    await initAgent(workspaceDir, {
      project: 'firstca',
      role: 'agent-a',
      registryType: 'local',
      registryPath,
    });

    const regDir = join(registryPath, '..');
    expect(existsSync(join(regDir, 'firstca.ca.crt'))).toBe(true);
    expect(existsSync(join(regDir, 'firstca.ca.key'))).toBe(true);
  });

  it('second invocation in the same project reuses existing CA', async () => {
    // First agent
    await initAgent(workspaceDir, {
      project: 'sharedca',
      role: 'agent-a',
      registryType: 'local',
      registryPath,
    });
    const regDir = join(registryPath, '..');
    const caCertBefore = (await import('node:fs')).readFileSync(
      join(regDir, 'sharedca.ca.crt'),
      'utf8',
    );
    const caKeyBefore = (await import('node:fs')).readFileSync(
      join(regDir, 'sharedca.ca.key'),
      'utf8',
    );

    // Second agent in a fresh workspace, same registry
    const workspace2 = tempDir();
    try {
      await initAgent(workspace2, {
        project: 'sharedca',
        role: 'agent-b',
        registryType: 'local',
        registryPath,
      });

      const caCertAfter = (await import('node:fs')).readFileSync(
        join(regDir, 'sharedca.ca.crt'),
        'utf8',
      );
      const caKeyAfter = (await import('node:fs')).readFileSync(
        join(regDir, 'sharedca.ca.key'),
        'utf8',
      );
      expect(caCertAfter).toBe(caCertBefore);
      expect(caKeyAfter).toBe(caKeyBefore);
    } finally {
      rmSync(workspace2, { recursive: true, force: true });
    }
  });

  // Skip POSIX-perm assertions on Windows where mode bits aren't
  // 0700-shaped (DR-024 §"Filesystem-permission discipline" notes the
  // platform-best-effort caveat). Linux + Darwin run the assertions.
  const posix = process.platform !== 'win32';
  const itOnPosix = posix ? it : it.skip;

  itOnPosix('registry parent dir is created with mode 0700', async () => {
    await initAgent(workspaceDir, {
      project: 'permproj',
      role: 'agent',
      registryType: 'local',
      registryPath,
    });

    const regDir = join(registryPath, '..');
    const mode = statSync(regDir).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  itOnPosix('CA key file has mode 0600 after init', async () => {
    await initAgent(workspaceDir, {
      project: 'keyperm',
      role: 'agent',
      registryType: 'local',
      registryPath,
    });

    const regDir = join(registryPath, '..');
    const mode = statSync(join(regDir, 'keyperm.ca.key')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('rejects --migrate-from when target is --local (loud failure)', async () => {
    // Construct a syntactically-valid local-registry JSON to point at
    // — the validation fires before the source is read, but having a
    // real source file rules out other failure modes.
    const sourceDir = tempDir();
    const sourcePath = join(sourceDir, 'src.json');
    writeFileSync(sourcePath, JSON.stringify({
      schema_version: 1,
      project: 'src',
      agents: {},
    }));

    try {
      await expect(initAgent(workspaceDir, {
        project: 'tomigrate',
        role: 'agent',
        registryType: 'local',
        registryPath,
        migrateFrom: sourcePath,
      })).rejects.toThrow(/migrate-from.*--local/);
    } finally {
      rmSync(sourceDir, { recursive: true, force: true });
    }
  });

  it('writes claude.sh without GH_TOKEN block when local mode', async () => {
    await initAgent(workspaceDir, {
      project: 'shellgen',
      role: 'agent',
      registryType: 'local',
      registryPath,
    });

    const claudeSh = (await import('node:fs')).readFileSync(
      join(workspaceDir, 'claude.sh'),
      'utf8',
    );
    expect(claudeSh).not.toContain('macf-gh-token.sh');
    expect(claudeSh).not.toContain('export GH_TOKEN');
    expect(claudeSh).not.toContain('export APP_ID');
    expect(claudeSh).toContain('MACF_REGISTRY_TYPE="local"');
    expect(claudeSh).toContain(`MACF_REGISTRY_PATH="${registryPath}"`);
    expect(claudeSh).toContain('local-registry mode');
  });
});
