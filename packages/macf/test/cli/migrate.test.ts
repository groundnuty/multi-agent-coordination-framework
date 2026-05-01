/**
 * Tests for the local-registry → GitHub migration helper (DR-024 §"Migration
 * path — local → GitHub mode"). Focuses on the source-file parsing layer.
 * Full migration (which writes via GitHub Variables API) requires a token
 * + network and is exercised in E2E coverage.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLocalRegistryFile } from '../../src/cli/commands/migrate.js';

function tempFile(content: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'macf-migrate-test-'));
  const path = join(dir, 'reg.json');
  writeFileSync(path, content);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('readLocalRegistryFile (DR-024 migration source parser)', () => {
  it('reads + validates a well-formed registry file', () => {
    const valid = JSON.stringify({
      schema_version: 1,
      project: 'sample',
      agents: {
        'agent-a': {
          host: '127.0.0.1',
          port: 9001,
          type: 'permanent',
          instance_id: 'abc123',
          started: '2026-05-01T12:00:00Z',
        },
        'agent-b': {
          host: '127.0.0.1',
          port: 9002,
          type: 'worker',
          instance_id: 'def456',
          started: '2026-05-01T12:30:00Z',
        },
      },
    });

    const { path, cleanup } = tempFile(valid);
    try {
      const file = readLocalRegistryFile(path);
      expect(file.project).toBe('sample');
      expect(Object.keys(file.agents)).toHaveLength(2);
      expect(file.agents['agent-a']!.host).toBe('127.0.0.1');
      expect(file.agents['agent-b']!.type).toBe('worker');
    } finally {
      cleanup();
    }
  });

  it('throws on missing file', () => {
    expect(() =>
      readLocalRegistryFile('/tmp/macf-doesnotexist-zzz.json'),
    ).toThrow(/not found/i);
  });

  it('throws on malformed JSON', () => {
    const { path, cleanup } = tempFile('{not json');
    try {
      expect(() => readLocalRegistryFile(path)).toThrow(/not valid JSON/);
    } finally {
      cleanup();
    }
  });

  it('throws on schema mismatch (wrong shape)', () => {
    const wrongShape = JSON.stringify({
      schema_version: 1,
      project: 'wrong',
      // `agents` should be an object; this is an array
      agents: ['not', 'an', 'object'],
    });

    const { path, cleanup } = tempFile(wrongShape);
    try {
      expect(() => readLocalRegistryFile(path)).toThrow(/expected shape/);
    } finally {
      cleanup();
    }
  });

  it('throws on schema_version mismatch (unknown version)', () => {
    const wrongVersion = JSON.stringify({
      schema_version: 999,
      project: 'futureschema',
      agents: {},
    });

    const { path, cleanup } = tempFile(wrongVersion);
    try {
      expect(() => readLocalRegistryFile(path)).toThrow();
    } finally {
      cleanup();
    }
  });
});
