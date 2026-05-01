/**
 * Unit tests for `checkpoint_to_memory` MCP tool (macf#271 / DR-023 UC-3).
 *
 * The tool is purely local-filesystem; no network, no MCP server. We
 * inject a temp dir as `projectsRootOverride` so each test gets a
 * fresh memory tree, and a fixed `nowOverride` so file naming is
 * deterministic across CI clocks.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';

import {
  checkpointToMemory,
  encodeProjectDir,
  resolveMemoryDir,
} from '../src/checkpoint.js';
import type { CheckpointToMemoryDeps, CheckpointToMemoryInput } from '../src/checkpoint.js';

const fakeLogger = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(),
};

function makeDeps(projectsRoot: string, now?: Date): CheckpointToMemoryDeps {
  return {
    selfAgentName: 'test-agent',
    logger: fakeLogger as unknown as CheckpointToMemoryDeps['logger'],
    projectsRootOverride: projectsRoot,
    nowOverride: now !== undefined ? () => now : undefined,
  };
}

function readBody(path: string): string {
  return readFileSync(path, 'utf8');
}

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'macf-checkpoint-'));
  fakeLogger.info.mockReset();
  fakeLogger.warn.mockReset();
  fakeLogger.error.mockReset();
});

afterEach(() => {
  // Restore writability on any chmod-locked dirs before rm.
  try { chmodSync(tmpRoot, 0o755); } catch { /* ignore */ }
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('encodeProjectDir', () => {
  it('replaces every `/` with `-`', () => {
    expect(encodeProjectDir('/Users/x/repos/y')).toBe('-Users-x-repos-y');
  });
  it('handles trailing slash', () => {
    expect(encodeProjectDir('/a/b/')).toBe('-a-b-');
  });
  it('handles cwd without leading slash', () => {
    expect(encodeProjectDir('relative/path')).toBe('relative-path');
  });
});

describe('resolveMemoryDir', () => {
  it('joins encoded cwd under projectsRoot', () => {
    expect(resolveMemoryDir('/x/y', '/root')).toBe('/root/-x-y/memory');
  });
});

describe('checkpoint_to_memory: happy path', () => {
  const fixedDate = new Date(Date.UTC(2026, 4, 1, 12, 0, 0)); // 2026-05-01

  function makeInput(overrides: Partial<CheckpointToMemoryInput> = {}): CheckpointToMemoryInput {
    return {
      session_id: 'sess-abc-123',
      transcript_path: '/tmp/fake-transcript.jsonl',
      cwd: '/Users/x/repos/proj',
      trigger: 'manual',
      ...overrides,
    };
  }

  it('writes checkpoint to expected path', async () => {
    const deps = makeDeps(tmpRoot, fixedDate);
    const result = await checkpointToMemory(deps, makeInput());

    expect(result.written).toBe(true);
    expect(result.deduplicated).toBe(false);
    expect(result.path).toBeDefined();
    expect(result.path).toBe(
      join(tmpRoot, '-Users-x-repos-proj', 'memory', 'project_session_handoff_2026_05_01.md'),
    );
    expect(existsSync(result.path!)).toBe(true);
  });

  it('writes well-formed frontmatter', async () => {
    const deps = makeDeps(tmpRoot, fixedDate);
    const result = await checkpointToMemory(deps, makeInput());
    const body = readBody(result.path!);
    expect(body).toMatch(/^---\n/);
    expect(body).toContain('name: 2026-05-01 session checkpoint (PreCompact auto-write)');
    expect(body).toContain('type: project');
    expect(body).toContain('originSessionId: sess-abc-123');
    // Frontmatter terminator
    expect(body.match(/^---$/gm)?.length).toBe(2);
  });

  it('embeds session metadata in body', async () => {
    const deps = makeDeps(tmpRoot, fixedDate);
    const result = await checkpointToMemory(deps, makeInput());
    const body = readBody(result.path!);
    expect(body).toContain('agent: `test-agent`');
    expect(body).toContain('session_id: `sess-abc-123`');
    expect(body).toContain('cwd: `/Users/x/repos/proj`');
    expect(body).toContain('trigger: `manual`');
    expect(body).toContain('transcript: `/tmp/fake-transcript.jsonl`');
  });

  it('embeds the summary when provided', async () => {
    const deps = makeDeps(tmpRoot, fixedDate);
    const result = await checkpointToMemory(deps, makeInput({
      summary: 'Worked on macf#271 PreCompact UC-3. Shipped tool + hook + DR-023 amendment.',
    }));
    const body = readBody(result.path!);
    expect(body).toContain('Worked on macf#271 PreCompact UC-3.');
  });

  it('uses stub when summary absent', async () => {
    const deps = makeDeps(tmpRoot, fixedDate);
    const result = await checkpointToMemory(deps, makeInput({ summary: undefined }));
    const body = readBody(result.path!);
    expect(body).toContain('Auto-checkpoint stub');
  });

  it('omits transcript line when transcript_path absent', async () => {
    const deps = makeDeps(tmpRoot, fixedDate);
    const result = await checkpointToMemory(deps, makeInput({ transcript_path: undefined }));
    const body = readBody(result.path!);
    expect(body).not.toContain('transcript: ');
  });

  it('handles "auto" trigger', async () => {
    const deps = makeDeps(tmpRoot, fixedDate);
    const result = await checkpointToMemory(deps, makeInput({ trigger: 'auto' }));
    const body = readBody(result.path!);
    expect(body).toContain('trigger: `auto`');
  });

  it('handles missing trigger as "unknown"', async () => {
    const deps = makeDeps(tmpRoot, fixedDate);
    const result = await checkpointToMemory(deps, makeInput({ trigger: undefined }));
    const body = readBody(result.path!);
    expect(body).toContain('trigger: `unknown`');
  });

  it('creates the memory directory if missing', async () => {
    const deps = makeDeps(tmpRoot, fixedDate);
    const result = await checkpointToMemory(deps, makeInput());
    expect(existsSync(join(tmpRoot, '-Users-x-repos-proj', 'memory'))).toBe(true);
    expect(result.written).toBe(true);
  });

  it('logs success via logger.info', async () => {
    const deps = makeDeps(tmpRoot, fixedDate);
    await checkpointToMemory(deps, makeInput());
    expect(fakeLogger.info).toHaveBeenCalledWith('checkpoint_written', expect.objectContaining({
      session_id: 'sess-abc-123',
      deduplicated: 'false',
    }));
  });
});

describe('checkpoint_to_memory: deduplication', () => {
  const fixedDate = new Date(Date.UTC(2026, 4, 1, 12, 0, 0));

  it('updates existing entry when same session_id fires twice', async () => {
    const deps = makeDeps(tmpRoot, fixedDate);
    const input: CheckpointToMemoryInput = {
      session_id: 'sess-dedup',
      cwd: '/Users/x/repos/proj',
      trigger: 'manual',
      summary: 'first invocation',
    };

    const r1 = await checkpointToMemory(deps, input);
    expect(r1.written).toBe(true);
    expect(r1.deduplicated).toBe(false);

    // Same session_id, updated summary — should overwrite.
    const r2 = await checkpointToMemory(deps, {
      ...input,
      summary: 'second invocation',
    });
    expect(r2.written).toBe(true);
    expect(r2.deduplicated).toBe(true);
    expect(r2.path).toBe(r1.path);
    const body = readBody(r2.path!);
    expect(body).toContain('second invocation');
    expect(body).not.toContain('first invocation');
  });

  it('allocates suffixed path when DIFFERENT session shares calendar date', async () => {
    const deps = makeDeps(tmpRoot, fixedDate);

    const r1 = await checkpointToMemory(deps, {
      session_id: 'sess-aaaaaaaa-1111',
      cwd: '/Users/x/repos/proj',
      trigger: 'manual',
    });
    expect(r1.written).toBe(true);
    expect(r1.deduplicated).toBe(false);

    const r2 = await checkpointToMemory(deps, {
      session_id: 'sess-bbbbbbbb-2222',
      cwd: '/Users/x/repos/proj',
      trigger: 'manual',
    });
    expect(r2.written).toBe(true);
    expect(r2.deduplicated).toBe(false);
    expect(r2.path).not.toBe(r1.path);
    expect(r2.path).toContain('project_session_handoff_2026_05_01_sess-bbb.md');
    expect(existsSync(r1.path!)).toBe(true);
    expect(existsSync(r2.path!)).toBe(true);
  });
});

describe('checkpoint_to_memory: failure paths', () => {
  const fixedDate = new Date(Date.UTC(2026, 4, 1, 12, 0, 0));

  it('returns {written: false} with reason when memory dir cannot be created', async () => {
    // Provide a projectsRoot that points at a regular FILE — mkdir
    // recursive will fail because a non-directory exists at the path.
    const blockerPath = join(tmpRoot, 'not-a-dir');
    writeFileSync(blockerPath, 'this is a file', 'utf8');
    const deps = makeDeps(blockerPath, fixedDate);
    const result = await checkpointToMemory(deps, {
      session_id: 'sess-fail',
      cwd: '/x/y',
      trigger: 'manual',
    });
    expect(result.written).toBe(false);
    expect(result.reason).toBeDefined();
    expect(result.reason!.length).toBeGreaterThan(0);
    // Doesn't throw — non-blocking guarantee
  });

  it('does NOT throw on any error path (non-blocking guarantee)', async () => {
    const deps = makeDeps('/nonexistent/parent/path/that/cannot/be/written/normally', fixedDate);
    // Even if mkdir fails, the function must return — never throw.
    await expect(
      checkpointToMemory(deps, {
        session_id: 'sess-noex',
        cwd: '/x',
        trigger: 'auto',
      }),
    ).resolves.toBeDefined();
  });

  it('logs warn on write failure (POSIX only — chmod doesn\'t restrict on Windows)', async () => {
    if (platform() === 'win32') {
      // Skip on Windows: chmod doesn't enforce write-protection the same way.
      return;
    }
    // Pre-create the memory dir, make it read-only, then attempt write.
    const projectDir = join(tmpRoot, '-x', 'memory');
    mkdirSync(projectDir, { recursive: true });
    chmodSync(projectDir, 0o555); // r-x only — writes fail

    const deps = makeDeps(tmpRoot, fixedDate);
    const result = await checkpointToMemory(deps, {
      session_id: 'sess-readonly',
      cwd: '/x',
      trigger: 'manual',
    });
    expect(result.written).toBe(false);
    expect(result.reason).toBeDefined();
    expect(fakeLogger.warn).toHaveBeenCalled();

    // Restore so afterEach cleanup can rm.
    chmodSync(projectDir, 0o755);
  });
});

describe('checkpoint_to_memory: unrelated entries are preserved', () => {
  const fixedDate = new Date(Date.UTC(2026, 4, 1, 12, 0, 0));

  it('does not mutate other memory files when scanning', async () => {
    const memDir = join(tmpRoot, '-Users-x-repos-proj', 'memory');
    mkdirSync(memDir, { recursive: true });
    const otherPath = join(memDir, 'feedback_some_unrelated.md');
    writeFileSync(otherPath, '# unrelated\n', 'utf8');
    const oldHandoff = join(memDir, 'project_session_handoff_2026_04_15.md');
    writeFileSync(oldHandoff, '---\nname: prev\noriginSessionId: old-session\n---\nbody\n', 'utf8');

    const deps = makeDeps(tmpRoot, fixedDate);
    const result = await checkpointToMemory(deps, {
      session_id: 'sess-fresh',
      cwd: '/Users/x/repos/proj',
      trigger: 'manual',
    });
    expect(result.written).toBe(true);
    expect(result.deduplicated).toBe(false);

    // Untouched
    expect(readBody(otherPath)).toBe('# unrelated\n');
    expect(readBody(oldHandoff)).toContain('originSessionId: old-session');
  });
});
