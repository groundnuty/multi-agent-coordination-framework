import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs, chmodSync, mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  createLocalRegistry,
  LocalRegistryError,
  REGISTRY_SCHEMA_VERSION,
} from '../../src/registry/local-client.js';
import type { AgentInfo } from '../../src/registry/types.js';

const IS_WIN = process.platform === 'win32';
const PROJECT = 'test-project';

const SAMPLE_AGENT: AgentInfo = {
  host: '127.0.0.1',
  port: 9001,
  type: 'permanent',
  instance_id: 'a1b2c3',
  started: '2026-05-01T15:00:00Z',
};

const SAMPLE_AGENT_2: AgentInfo = {
  host: '127.0.0.1',
  port: 9002,
  type: 'permanent',
  instance_id: 'd4e5f6',
  started: '2026-05-01T15:00:30Z',
};

interface Sandbox {
  readonly dir: string;
  readonly filePath: string;
}

/**
 * Create a fresh sandbox directory with `0700` perms and return the
 * intended (not-yet-created) registry file path. The file itself is
 * left absent unless tests want to seed it.
 */
function makeSandbox(): Sandbox {
  const dir = path.join(tmpdir(), `macf-local-registry-test-${randomBytes(6).toString('hex')}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // recursive:true ignores the mode on parents — re-set explicitly.
  if (!IS_WIN) chmodSync(dir, 0o700);
  return { dir, filePath: path.join(dir, `${PROJECT}.json`) };
}

async function cleanup(sb: Sandbox): Promise<void> {
  // Tighten/relax perms so cleanup works even if a test left perms loose.
  if (!IS_WIN && existsSync(sb.dir)) {
    chmodSync(sb.dir, 0o700);
  }
  await fs.rm(sb.dir, { recursive: true, force: true });
}

function seedFile(sb: Sandbox, contents: string): void {
  writeFileSync(sb.filePath, contents, { mode: 0o600 });
  if (!IS_WIN) chmodSync(sb.filePath, 0o600);
}

function seedRegistry(sb: Sandbox, agents: Record<string, AgentInfo>): void {
  const json = JSON.stringify({
    schema_version: REGISTRY_SCHEMA_VERSION,
    project: PROJECT,
    agents,
  });
  seedFile(sb, json);
}

describe('createLocalRegistry — constructor', () => {
  let sb: Sandbox;
  beforeEach(() => { sb = makeSandbox(); });
  afterEach(() => cleanup(sb));

  it('accepts a writable 0700 directory with no file present', () => {
    expect(() => createLocalRegistry({ path: sb.filePath, project: PROJECT })).not.toThrow();
  });

  it('rejects relative paths', () => {
    expect(() => createLocalRegistry({ path: 'not/absolute.json', project: PROJECT }))
      .toThrow(/must be absolute/);
  });

  it('rejects relative paths with LOCAL_REGISTRY_PATH_NOT_ABSOLUTE code', () => {
    try {
      createLocalRegistry({ path: 'rel.json', project: PROJECT });
      throw new Error('should not reach');
    } catch (err) {
      expect(err).toBeInstanceOf(LocalRegistryError);
      expect((err as LocalRegistryError).code).toBe('LOCAL_REGISTRY_PATH_NOT_ABSOLUTE');
    }
  });

  it('throws LOCAL_REGISTRY_DIR_MISSING when parent dir does not exist', () => {
    const missing = path.join(sb.dir, 'no-such-subdir', 'r.json');
    try {
      createLocalRegistry({ path: missing, project: PROJECT });
      throw new Error('should not reach');
    } catch (err) {
      expect((err as LocalRegistryError).code).toBe('LOCAL_REGISTRY_DIR_MISSING');
      expect((err as Error).message).toMatch(/Directory does not exist/);
    }
  });

  it.skipIf(IS_WIN)('throws LOCAL_REGISTRY_DIR_PERMS when parent dir is 0755', () => {
    chmodSync(sb.dir, 0o755);
    try {
      createLocalRegistry({ path: sb.filePath, project: PROJECT });
      throw new Error('should not reach');
    } catch (err) {
      expect((err as LocalRegistryError).code).toBe('LOCAL_REGISTRY_DIR_PERMS');
      expect((err as Error).message).toMatch(/mode 755/);
      expect((err as Error).message).toMatch(/chmod 700/);
    }
  });

  it.skipIf(IS_WIN)('throws LOCAL_REGISTRY_DIR_PERMS when parent dir is 0777', () => {
    chmodSync(sb.dir, 0o777);
    expect(() => createLocalRegistry({ path: sb.filePath, project: PROJECT }))
      .toThrow(/mode 777/);
  });

  it.skipIf(IS_WIN)('accepts existing file with 0600 perms', () => {
    seedFile(sb, '{}');
    chmodSync(sb.filePath, 0o600);
    // Note: 0600 file with malformed JSON shape is fine at construct time —
    // perms are checked in the constructor; JSON shape only at read time.
    expect(() => createLocalRegistry({ path: sb.filePath, project: PROJECT })).not.toThrow();
  });

  it.skipIf(IS_WIN)('throws LOCAL_REGISTRY_FILE_PERMS when existing file is 0644', () => {
    seedFile(sb, '{}');
    chmodSync(sb.filePath, 0o644);
    try {
      createLocalRegistry({ path: sb.filePath, project: PROJECT });
      throw new Error('should not reach');
    } catch (err) {
      expect((err as LocalRegistryError).code).toBe('LOCAL_REGISTRY_FILE_PERMS');
      expect((err as Error).message).toMatch(/mode 644/);
      expect((err as Error).message).toMatch(/chmod 600/);
    }
  });

  it.skipIf(IS_WIN)('throws LOCAL_REGISTRY_FILE_PERMS when existing file is 0666', () => {
    seedFile(sb, '{}');
    chmodSync(sb.filePath, 0o666);
    expect(() => createLocalRegistry({ path: sb.filePath, project: PROJECT }))
      .toThrow(/mode 666/);
  });

  it('throws when the registry path points at a directory, not a file', () => {
    const dirAsRegistry = path.join(sb.dir, 'subdir');
    mkdirSync(dirAsRegistry, { mode: 0o700 });
    try {
      createLocalRegistry({ path: dirAsRegistry, project: PROJECT });
      throw new Error('should not reach');
    } catch (err) {
      expect((err as LocalRegistryError).code).toBe('LOCAL_REGISTRY_FILE_NOT_REGULAR');
    }
  });
});

describe('createLocalRegistry — register', () => {
  let sb: Sandbox;
  beforeEach(() => { sb = makeSandbox(); });
  afterEach(() => cleanup(sb));

  it('creates the registry file on first registration', async () => {
    const reg = createLocalRegistry({ path: sb.filePath, project: PROJECT });
    await reg.register('paper-agent', SAMPLE_AGENT);

    const raw = await fs.readFile(sb.filePath, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.schema_version).toBe(REGISTRY_SCHEMA_VERSION);
    expect(parsed.project).toBe(PROJECT);
    expect(parsed.agents['paper-agent']).toEqual(SAMPLE_AGENT);
  });

  it('writes file with restrictive 0600 permissions on creation', async () => {
    const reg = createLocalRegistry({ path: sb.filePath, project: PROJECT });
    await reg.register('a', SAMPLE_AGENT);

    if (!IS_WIN) {
      const mode = statSync(sb.filePath).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it('appends a second agent without losing the first', async () => {
    const reg = createLocalRegistry({ path: sb.filePath, project: PROJECT });
    await reg.register('paper-agent', SAMPLE_AGENT);
    await reg.register('code-agent', SAMPLE_AGENT_2);

    const raw = await fs.readFile(sb.filePath, 'utf8');
    const parsed = JSON.parse(raw);
    expect(Object.keys(parsed.agents)).toEqual(['paper-agent', 'code-agent']);
    expect(parsed.agents['paper-agent']).toEqual(SAMPLE_AGENT);
    expect(parsed.agents['code-agent']).toEqual(SAMPLE_AGENT_2);
  });

  it('overwrites existing agent on re-register (last-write-wins)', async () => {
    const reg = createLocalRegistry({ path: sb.filePath, project: PROJECT });
    await reg.register('paper-agent', SAMPLE_AGENT);
    const updated = { ...SAMPLE_AGENT, port: 9999 };
    await reg.register('paper-agent', updated);

    const raw = await fs.readFile(sb.filePath, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.agents['paper-agent'].port).toBe(9999);
  });

  it('rejects an AgentInfo with missing required fields (Zod-validated)', async () => {
    const reg = createLocalRegistry({ path: sb.filePath, project: PROJECT });
    // @ts-expect-error — intentional bad shape
    await expect(reg.register('bad', { host: 'h' })).rejects.toThrow();
  });

  it('rejects an AgentInfo with negative port', async () => {
    const reg = createLocalRegistry({ path: sb.filePath, project: PROJECT });
    const bad = { ...SAMPLE_AGENT, port: -1 };
    await expect(reg.register('bad', bad)).rejects.toThrow();
  });

  it('cleans up temp files on success (no .tmp.* siblings remain)', async () => {
    const reg = createLocalRegistry({ path: sb.filePath, project: PROJECT });
    await reg.register('a', SAMPLE_AGENT);
    await reg.register('b', SAMPLE_AGENT_2);

    const entries = await fs.readdir(sb.dir);
    const tempFiles = entries.filter(e => e.includes('.tmp.'));
    expect(tempFiles).toHaveLength(0);
  });

  it('hyphenated agent names are stored verbatim (no sanitization, unlike GitHub backend)', async () => {
    const reg = createLocalRegistry({ path: sb.filePath, project: PROJECT });
    await reg.register('cv-architect', SAMPLE_AGENT);

    const raw = await fs.readFile(sb.filePath, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.agents['cv-architect']).toEqual(SAMPLE_AGENT);
  });
});

describe('createLocalRegistry — get', () => {
  let sb: Sandbox;
  beforeEach(() => { sb = makeSandbox(); });
  afterEach(() => cleanup(sb));

  it('returns the agent when present', async () => {
    seedRegistry(sb, { 'paper-agent': SAMPLE_AGENT });
    const reg = createLocalRegistry({ path: sb.filePath, project: PROJECT });
    const got = await reg.get('paper-agent');
    expect(got).toEqual(SAMPLE_AGENT);
  });

  it('returns null when the agent is not present', async () => {
    seedRegistry(sb, { 'paper-agent': SAMPLE_AGENT });
    const reg = createLocalRegistry({ path: sb.filePath, project: PROJECT });
    const got = await reg.get('missing-agent');
    expect(got).toBeNull();
  });

  it('returns null when the registry file does not exist', async () => {
    const reg = createLocalRegistry({ path: sb.filePath, project: PROJECT });
    const got = await reg.get('any');
    expect(got).toBeNull();
  });

  it('throws LOCAL_REGISTRY_MALFORMED_JSON on corrupt JSON', async () => {
    seedFile(sb, '{ this is : not json');
    const reg = createLocalRegistry({ path: sb.filePath, project: PROJECT });
    try {
      await reg.get('any');
      throw new Error('should not reach');
    } catch (err) {
      expect((err as LocalRegistryError).code).toBe('LOCAL_REGISTRY_MALFORMED_JSON');
      expect((err as Error).message).toMatch(/not valid JSON/);
    }
  });

  it('throws LOCAL_REGISTRY_SCHEMA_MISMATCH on unsupported schema_version', async () => {
    seedFile(sb, JSON.stringify({
      schema_version: 999,
      project: PROJECT,
      agents: {},
    }));
    const reg = createLocalRegistry({ path: sb.filePath, project: PROJECT });
    try {
      await reg.get('any');
      throw new Error('should not reach');
    } catch (err) {
      expect((err as LocalRegistryError).code).toBe('LOCAL_REGISTRY_SCHEMA_MISMATCH');
      expect((err as Error).message).toMatch(/schema_version 999/);
    }
  });

  it('throws LOCAL_REGISTRY_INVALID_SHAPE on JSON missing the agents map', async () => {
    seedFile(sb, JSON.stringify({
      schema_version: REGISTRY_SCHEMA_VERSION,
      project: PROJECT,
      // agents missing
    }));
    const reg = createLocalRegistry({ path: sb.filePath, project: PROJECT });
    await expect(reg.get('any')).rejects.toThrow(LocalRegistryError);
  });

  it('throws on registry whose per-agent record fails AgentInfoSchema', async () => {
    seedFile(sb, JSON.stringify({
      schema_version: REGISTRY_SCHEMA_VERSION,
      project: PROJECT,
      agents: { bad: { host: 'h', /* port missing */ } },
    }));
    const reg = createLocalRegistry({ path: sb.filePath, project: PROJECT });
    await expect(reg.get('bad')).rejects.toThrow(LocalRegistryError);
  });
});

describe('createLocalRegistry — list', () => {
  let sb: Sandbox;
  beforeEach(() => { sb = makeSandbox(); });
  afterEach(() => cleanup(sb));

  it('returns empty array when file does not exist', async () => {
    const reg = createLocalRegistry({ path: sb.filePath, project: PROJECT });
    const all = await reg.list('');
    expect(all).toEqual([]);
  });

  it('returns all agents when prefix is empty', async () => {
    seedRegistry(sb, {
      'paper-agent': SAMPLE_AGENT,
      'code-agent': SAMPLE_AGENT_2,
    });
    const reg = createLocalRegistry({ path: sb.filePath, project: PROJECT });
    const all = await reg.list('');
    expect(all).toHaveLength(2);
    expect(all.map(r => r.name).sort()).toEqual(['code-agent', 'paper-agent']);
  });

  it('filters by exact prefix match', async () => {
    seedRegistry(sb, {
      'cv-architect': SAMPLE_AGENT,
      'cv-runner': SAMPLE_AGENT_2,
      'science-agent': SAMPLE_AGENT,
    });
    const reg = createLocalRegistry({ path: sb.filePath, project: PROJECT });
    const cv = await reg.list('cv-');
    expect(cv).toHaveLength(2);
    expect(cv.map(r => r.name).sort()).toEqual(['cv-architect', 'cv-runner']);
  });

  it('returns the AgentInfo unchanged for each entry', async () => {
    seedRegistry(sb, { 'paper-agent': SAMPLE_AGENT });
    const reg = createLocalRegistry({ path: sb.filePath, project: PROJECT });
    const all = await reg.list('');
    expect(all[0]!.info).toEqual(SAMPLE_AGENT);
  });

  it('returns empty array when prefix matches nothing', async () => {
    seedRegistry(sb, { 'paper-agent': SAMPLE_AGENT });
    const reg = createLocalRegistry({ path: sb.filePath, project: PROJECT });
    const empty = await reg.list('nope-');
    expect(empty).toEqual([]);
  });
});

describe('createLocalRegistry — remove', () => {
  let sb: Sandbox;
  beforeEach(() => { sb = makeSandbox(); });
  afterEach(() => cleanup(sb));

  it('removes an existing agent', async () => {
    seedRegistry(sb, {
      'paper-agent': SAMPLE_AGENT,
      'code-agent': SAMPLE_AGENT_2,
    });
    const reg = createLocalRegistry({ path: sb.filePath, project: PROJECT });
    await reg.remove('paper-agent');

    const all = await reg.list('');
    expect(all).toHaveLength(1);
    expect(all[0]!.name).toBe('code-agent');
  });

  it('is a no-op when the agent does not exist', async () => {
    seedRegistry(sb, { 'paper-agent': SAMPLE_AGENT });
    const reg = createLocalRegistry({ path: sb.filePath, project: PROJECT });
    await expect(reg.remove('missing')).resolves.toBeUndefined();

    const all = await reg.list('');
    expect(all).toHaveLength(1);
  });

  it('is a no-op when the registry file does not exist', async () => {
    const reg = createLocalRegistry({ path: sb.filePath, project: PROJECT });
    await expect(reg.remove('any')).resolves.toBeUndefined();
    expect(existsSync(sb.filePath)).toBe(false);
  });

  it('preserves remaining agents when removing one', async () => {
    seedRegistry(sb, {
      a: SAMPLE_AGENT,
      b: SAMPLE_AGENT_2,
      c: SAMPLE_AGENT,
    });
    const reg = createLocalRegistry({ path: sb.filePath, project: PROJECT });
    await reg.remove('b');

    const raw = await fs.readFile(sb.filePath, 'utf8');
    const parsed = JSON.parse(raw);
    expect(Object.keys(parsed.agents).sort()).toEqual(['a', 'c']);
  });
});

describe('createLocalRegistry — concurrent writes', () => {
  let sb: Sandbox;
  beforeEach(() => { sb = makeSandbox(); });
  afterEach(() => cleanup(sb));

  it('serializes concurrent registers without losing entries', async () => {
    const reg = createLocalRegistry({ path: sb.filePath, project: PROJECT });

    const agents: Record<string, AgentInfo> = {};
    const writes: Array<Promise<void>> = [];
    for (let i = 0; i < 10; i++) {
      const name = `agent-${i}`;
      const info: AgentInfo = { ...SAMPLE_AGENT, port: 9000 + i, instance_id: `id-${i}` };
      agents[name] = info;
      writes.push(reg.register(name, info));
    }

    await Promise.all(writes);

    const all = await reg.list('');
    expect(all).toHaveLength(10);

    // Every entry registered must be present, no corruption, no losses.
    const nameSet = new Set(all.map(r => r.name));
    for (const expected of Object.keys(agents)) {
      expect(nameSet.has(expected)).toBe(true);
    }
  });

  it('keeps the file parseable after a concurrent register burst', async () => {
    const reg = createLocalRegistry({ path: sb.filePath, project: PROJECT });

    const writes: Array<Promise<void>> = [];
    for (let i = 0; i < 5; i++) {
      writes.push(reg.register(`a-${i}`, { ...SAMPLE_AGENT, port: 9000 + i }));
    }
    await Promise.all(writes);

    const raw = await fs.readFile(sb.filePath, 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
    const parsed = JSON.parse(raw);
    expect(parsed.schema_version).toBe(REGISTRY_SCHEMA_VERSION);
    expect(parsed.project).toBe(PROJECT);
  });

  it('mixed concurrent register + remove leaves the file valid', async () => {
    seedRegistry(sb, { existing: SAMPLE_AGENT });
    const reg = createLocalRegistry({ path: sb.filePath, project: PROJECT });

    await Promise.all([
      reg.register('new1', SAMPLE_AGENT),
      reg.register('new2', SAMPLE_AGENT_2),
      reg.remove('existing'),
      reg.register('new3', SAMPLE_AGENT),
    ]);

    const all = await reg.list('');
    const names = all.map(r => r.name).sort();
    // `existing` may or may not be present depending on remove vs
    // register interleaving; what matters is that the file stays valid
    // and contains the new entries (which were registered AFTER the
    // serializing lock acquired).
    expect(names).toContain('new1');
    expect(names).toContain('new2');
    expect(names).toContain('new3');

    const raw = await fs.readFile(sb.filePath, 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});

describe('createLocalRegistry — round-trip with full DR-024 file shape', () => {
  let sb: Sandbox;
  beforeEach(() => { sb = makeSandbox(); });
  afterEach(() => cleanup(sb));

  it('produces a file matching the shape DR-024 §"File format" specifies', async () => {
    const reg = createLocalRegistry({ path: sb.filePath, project: 'my-paper-project' });
    await reg.register('paper-agent', {
      host: '127.0.0.1', port: 9001, type: 'permanent',
      instance_id: 'a1b2c3', started: '2026-05-01T15:00:00Z',
    });
    await reg.register('code-agent', {
      host: '127.0.0.1', port: 9002, type: 'permanent',
      instance_id: 'd4e5f6', started: '2026-05-01T15:00:30Z',
    });

    const raw = await fs.readFile(sb.filePath, 'utf8');
    const parsed = JSON.parse(raw);

    // Mirror the example block in DR-024 §"File format" exactly.
    expect(parsed).toEqual({
      schema_version: 1,
      project: 'my-paper-project',
      agents: {
        'paper-agent': {
          host: '127.0.0.1', port: 9001, type: 'permanent',
          instance_id: 'a1b2c3', started: '2026-05-01T15:00:00Z',
        },
        'code-agent': {
          host: '127.0.0.1', port: 9002, type: 'permanent',
          instance_id: 'd4e5f6', started: '2026-05-01T15:00:30Z',
        },
      },
    });
  });
});
