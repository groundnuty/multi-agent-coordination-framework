/**
 * Tests for `src/cli/settings-writer.ts` — merge-preserving writer
 * for `<workspace>/.claude/settings.json` that installs the PreToolUse
 * entry for `check-gh-token.sh` without clobbering operator-authored
 * settings (per #140).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installGhTokenHook, MACF_HOOK_COMMAND, installPluginSkillPermissions, PLUGIN_SKILL_PERMISSIONS, installSandboxFdAllowRead, SANDBOX_FD_READ_PATTERN } from '../../src/cli/settings-writer.js';

describe('installGhTokenHook', () => {
  let tmpRoot: string;
  let settingsPath: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'macf-settings-test-'));
    settingsPath = join(tmpRoot, '.claude', 'settings.json');
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('creates .claude/settings.json when missing, with the hook entry', () => {
    installGhTokenHook(tmpRoot);

    expect(existsSync(settingsPath)).toBe(true);
    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(s.hooks.PreToolUse).toHaveLength(1);
    expect(s.hooks.PreToolUse[0].matcher).toBe('Bash');
    expect(s.hooks.PreToolUse[0].hooks[0].command).toBe(MACF_HOOK_COMMAND);
    expect(s.hooks.PreToolUse[0].hooks[0].type).toBe('command');
  });

  it('preserves existing unrelated settings keys', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      model: 'opus',
      env: { DEBUG: 'true' },
    }, null, 2));

    installGhTokenHook(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(s.model).toBe('opus');
    expect(s.env).toEqual({ DEBUG: 'true' });
    expect(s.hooks.PreToolUse[0].hooks[0].command).toBe(MACF_HOOK_COMMAND);
  });

  it('preserves other PreToolUse entries when adding ours', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: 'Edit', hooks: [{ type: 'command', command: './user-edit-hook.sh' }] },
        ],
      },
    }, null, 2));

    installGhTokenHook(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(s.hooks.PreToolUse).toHaveLength(2);
    const userHook = s.hooks.PreToolUse.find((e: { matcher: string }) => e.matcher === 'Edit');
    const macfHook = s.hooks.PreToolUse.find((e: { matcher: string }) => e.matcher === 'Bash');
    expect(userHook).toBeDefined();
    expect(userHook.hooks[0].command).toBe('./user-edit-hook.sh');
    expect(macfHook).toBeDefined();
    expect(macfHook.hooks[0].command).toBe(MACF_HOOK_COMMAND);
  });

  it('preserves other hook event types (SessionStart, Stop, etc.)', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: './user-session-hook.sh' }] }],
        Stop: [{ hooks: [{ type: 'command', command: './user-stop-hook.sh' }] }],
      },
    }, null, 2));

    installGhTokenHook(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(s.hooks.SessionStart).toHaveLength(1);
    expect(s.hooks.Stop).toHaveLength(1);
    expect(s.hooks.PreToolUse[0].hooks[0].command).toBe(MACF_HOOK_COMMAND);
  });

  it('is idempotent — second call does not duplicate the MACF entry', () => {
    installGhTokenHook(tmpRoot);
    installGhTokenHook(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const macfEntries = s.hooks.PreToolUse.filter((e: { hooks: { command: string }[] }) =>
      e.hooks.some((h) => h.command === MACF_HOOK_COMMAND),
    );
    expect(macfEntries).toHaveLength(1);
  });

  it('refreshes a stale MACF entry (replaces by command-path match)', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: '.claude/scripts/check-gh-token.sh --old-flag' }],
          },
        ],
      },
    }, null, 2));

    installGhTokenHook(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const macfEntries = s.hooks.PreToolUse.filter((e: { hooks: { command: string }[] }) =>
      e.hooks.some((h) => h.command.includes('check-gh-token.sh')),
    );
    expect(macfEntries).toHaveLength(1);
    expect(macfEntries[0].hooks[0].command).toBe(MACF_HOOK_COMMAND);
    // --old-flag should be gone.
    expect(macfEntries[0].hooks[0].command).not.toContain('--old-flag');
  });

  it('handles malformed settings.json by failing loud (does not silently clobber)', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, '{ not valid json');

    expect(() => installGhTokenHook(tmpRoot)).toThrow(/settings\.json/i);
    // File should NOT have been overwritten.
    expect(readFileSync(settingsPath, 'utf-8')).toBe('{ not valid json');
  });

  it('creates .claude/ directory if missing', () => {
    // tmpRoot exists but .claude/ does not yet.
    expect(existsSync(join(tmpRoot, '.claude'))).toBe(false);

    installGhTokenHook(tmpRoot);

    expect(existsSync(join(tmpRoot, '.claude'))).toBe(true);
    expect(existsSync(settingsPath)).toBe(true);
  });

  it('writes pretty-printed JSON (readable for operators)', () => {
    installGhTokenHook(tmpRoot);
    const raw = readFileSync(settingsPath, 'utf-8');
    // Pretty-printed JSON has newlines and indentation.
    expect(raw).toContain('\n');
    expect(raw).toMatch(/^\{\n  /); // starts with `{` then newline+2-space indent
  });

  it('does NOT misclassify operator files with similar basenames as MACF-managed', () => {
    // Per science-agent's #140 review — substring match on
    // `check-gh-token.sh` would also claim `my-check-gh-token.sh-wrapper`.
    // We use path-end/basename equality to defend against that.
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: './my-check-gh-token.sh-wrapper --flag' }],
          },
        ],
      },
    }, null, 2));

    installGhTokenHook(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    // Operator's lookalike hook must still be present.
    const operatorEntry = s.hooks.PreToolUse.find((e: { hooks: { command: string }[] }) =>
      e.hooks.some((h) => h.command === './my-check-gh-token.sh-wrapper --flag'),
    );
    expect(operatorEntry).toBeDefined();
    // And the real MACF entry landed alongside it.
    const macfEntry = s.hooks.PreToolUse.find((e: { hooks: { command: string }[] }) =>
      e.hooks.some((h) => h.command === MACF_HOOK_COMMAND),
    );
    expect(macfEntry).toBeDefined();
    expect(s.hooks.PreToolUse).toHaveLength(2);
  });
});

describe('installPluginSkillPermissions (macf#189 sub-item 2)', () => {
  let tmpRoot: string;
  let settingsPath: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'macf-skill-perm-test-'));
    settingsPath = join(tmpRoot, '.claude', 'settings.json');
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('creates .claude/settings.json with the 4 skill patterns when missing', () => {
    installPluginSkillPermissions(tmpRoot);

    expect(existsSync(settingsPath)).toBe(true);
    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(s.permissions.allow).toEqual(PLUGIN_SKILL_PERMISSIONS);
    // Spot-check the 4 skills we care about.
    expect(s.permissions.allow).toContain('Skill(macf-agent:macf-status)');
    expect(s.permissions.allow).toContain('Skill(macf-agent:macf-issues)');
    expect(s.permissions.allow).toContain('Skill(macf-agent:macf-peers)');
    expect(s.permissions.allow).toContain('Skill(macf-agent:macf-ping)');
  });

  it('preserves non-MACF permissions.allow entries', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      permissions: {
        allow: ['Bash(ls:*)', 'Skill(other-plugin:some-skill)'],
      },
    }, null, 2));

    installPluginSkillPermissions(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(s.permissions.allow).toContain('Bash(ls:*)');
    expect(s.permissions.allow).toContain('Skill(other-plugin:some-skill)');
    // MACF skills land after operator entries.
    for (const pattern of PLUGIN_SKILL_PERMISSIONS) {
      expect(s.permissions.allow).toContain(pattern);
    }
  });

  it('is idempotent — re-running does not duplicate MACF entries', () => {
    installPluginSkillPermissions(tmpRoot);
    installPluginSkillPermissions(tmpRoot);
    installPluginSkillPermissions(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    // Count macf-agent: entries — should equal the static list length
    // exactly, not triple.
    const macfEntries = (s.permissions.allow as string[]).filter(e => e.startsWith('Skill(macf-agent:'));
    expect(macfEntries).toHaveLength(PLUGIN_SKILL_PERMISSIONS.length);
  });

  it('refreshes stale MACF entries on re-run (pretends an old skill was removed)', () => {
    // Pre-seed with a fake stale entry that isn't in the current
    // PLUGIN_SKILL_PERMISSIONS list.
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      permissions: {
        allow: ['Skill(macf-agent:legacy-removed-skill)', 'Bash(git:*)'],
      },
    }, null, 2));

    installPluginSkillPermissions(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    // Stale macf-agent entry gone.
    expect(s.permissions.allow).not.toContain('Skill(macf-agent:legacy-removed-skill)');
    // Non-MACF entry preserved.
    expect(s.permissions.allow).toContain('Bash(git:*)');
    // Current skills all present.
    for (const pattern of PLUGIN_SKILL_PERMISSIONS) {
      expect(s.permissions.allow).toContain(pattern);
    }
  });

  it('preserves other settings.json keys (e.g. existing hooks block)', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './x.sh' }] }] },
      env: { SOME_OPERATOR_VAR: '1' },
    }, null, 2));

    installPluginSkillPermissions(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    // permissions.allow installed.
    expect(s.permissions.allow).toBeDefined();
    // Unrelated keys preserved.
    expect(s.hooks.PreToolUse).toHaveLength(1);
    expect(s.env.SOME_OPERATOR_VAR).toBe('1');
  });
});

describe('installSandboxFdAllowRead (macf#200)', () => {
  let tmpRoot: string;
  let settingsPath: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'macf-sandbox-fd-test-'));
    settingsPath = join(tmpRoot, '.claude', 'settings.json');
    delete process.env['MACF_SANDBOX_FD_FIX_SKIP'];
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env['MACF_SANDBOX_FD_FIX_SKIP'];
  });

  it('a) creates settings.json + sandbox.filesystem.allowRead when missing', () => {
    installSandboxFdAllowRead(tmpRoot);

    expect(existsSync(settingsPath)).toBe(true);
    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(s.sandbox.filesystem.allowRead).toEqual([SANDBOX_FD_READ_PATTERN]);
  });

  it('b) creates filesystem subblock when sandbox exists but filesystem does not', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      sandbox: { enabled: true },
    }, null, 2));

    installSandboxFdAllowRead(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(s.sandbox.enabled).toBe(true); // preserved
    expect(s.sandbox.filesystem.allowRead).toEqual([SANDBOX_FD_READ_PATTERN]);
  });

  it('c) creates allowRead when filesystem exists but allowRead does not', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      sandbox: {
        filesystem: {
          allowWrite: ['/tmp/**'],
          denyRead: ['/etc/shadow'],
        },
      },
    }, null, 2));

    installSandboxFdAllowRead(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(s.sandbox.filesystem.allowRead).toEqual([SANDBOX_FD_READ_PATTERN]);
    // Other filesystem sub-keys preserved.
    expect(s.sandbox.filesystem.allowWrite).toEqual(['/tmp/**']);
    expect(s.sandbox.filesystem.denyRead).toEqual(['/etc/shadow']);
  });

  it('d) appends to existing allowRead, preserving operator entries', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      sandbox: {
        filesystem: {
          allowRead: ['/etc/hosts', '/etc/resolv.conf'],
        },
      },
    }, null, 2));

    installSandboxFdAllowRead(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(s.sandbox.filesystem.allowRead).toContain('/etc/hosts');
    expect(s.sandbox.filesystem.allowRead).toContain('/etc/resolv.conf');
    expect(s.sandbox.filesystem.allowRead).toContain(SANDBOX_FD_READ_PATTERN);
    expect(s.sandbox.filesystem.allowRead).toHaveLength(3);
  });

  it('e) no-op when the fd pattern is already present', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    const before = {
      sandbox: {
        filesystem: {
          allowRead: ['/etc/hosts', SANDBOX_FD_READ_PATTERN],
        },
      },
    };
    writeFileSync(settingsPath, JSON.stringify(before, null, 2));
    const mtimeBefore = statSync(settingsPath).mtimeMs;

    installSandboxFdAllowRead(tmpRoot);

    const after = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(after.sandbox.filesystem.allowRead).toEqual(['/etc/hosts', SANDBOX_FD_READ_PATTERN]);
    // File not rewritten on no-op.
    expect(statSync(settingsPath).mtimeMs).toBe(mtimeBefore);
  });

  it('f) respects MACF_SANDBOX_FD_FIX_SKIP=1 opt-out', () => {
    process.env['MACF_SANDBOX_FD_FIX_SKIP'] = '1';
    installSandboxFdAllowRead(tmpRoot);

    // Nothing written — settings.json shouldn't exist.
    expect(existsSync(settingsPath)).toBe(false);
  });

  it('g) throws on malformed settings.json (consistent with installGhTokenHook)', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, '{ not valid json');

    expect(() => installSandboxFdAllowRead(tmpRoot))
      .toThrow(/Refusing to overwrite malformed/);
  });

  it('is idempotent — N calls produce same output as 1 call', () => {
    installSandboxFdAllowRead(tmpRoot);
    installSandboxFdAllowRead(tmpRoot);
    installSandboxFdAllowRead(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(s.sandbox.filesystem.allowRead).toEqual([SANDBOX_FD_READ_PATTERN]);
  });

  it('preserves other top-level settings.json keys + other sandbox keys', () => {
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './x.sh' }] }] },
      env: { SOME_OPERATOR_VAR: '1' },
      sandbox: {
        enabled: true,
        excludedCommands: ['gh:*'],
        filesystem: {
          allowRead: ['/etc/hosts'],
          denyWrite: ['/etc/**'],
        },
      },
    }, null, 2));

    installSandboxFdAllowRead(tmpRoot);

    const s = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(s.hooks.PreToolUse).toHaveLength(1);
    expect(s.env.SOME_OPERATOR_VAR).toBe('1');
    expect(s.sandbox.enabled).toBe(true);
    expect(s.sandbox.excludedCommands).toEqual(['gh:*']);
    expect(s.sandbox.filesystem.allowRead).toEqual(['/etc/hosts', SANDBOX_FD_READ_PATTERN]);
    expect(s.sandbox.filesystem.denyWrite).toEqual(['/etc/**']);
  });
});
