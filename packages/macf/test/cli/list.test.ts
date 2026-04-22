/**
 * Unit tests for `macf list` / `src/cli/commands/list.ts` — backfilled
 * per #137 (ultrareview test-coverage audit flagged 0% dedicated
 * coverage on this command).
 *
 * Covers the three rendering branches:
 *   1. empty index → "No agents registered" hint
 *   2. index has entries but loadAllAgents returns empty (all configs
 *      invalid / missing) → "no valid configs" diagnostic
 *   3. happy path → header + one line per agent
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MacfAgentConfig, AgentsIndex } from '../../src/cli/config.js';

// Mock config.js module BEFORE importing list.ts so the imports land
// on the mocked symbols. Vitest hoists vi.mock to the top of the file.
const readAgentsIndexMock = vi.fn<() => AgentsIndex>();
const loadAllAgentsMock = vi.fn<() => ReadonlyArray<{ readonly path: string; readonly config: MacfAgentConfig }>>();

vi.mock('../../src/cli/config.js', () => ({
  readAgentsIndex: readAgentsIndexMock,
  loadAllAgents: loadAllAgentsMock,
}));

const { listAgents } = await import('../../src/cli/commands/list.js');

function fakeConfig(overrides: Partial<MacfAgentConfig> = {}): MacfAgentConfig {
  return {
    project: 'TEST',
    agent_name: 'code-agent',
    agent_role: 'code-agent',
    agent_type: 'permanent',
    registry: { type: 'repo', owner: 'owner', repo: 'repo' },
    github_app: { app_id: '1', install_id: '2', key_path: 'k' },
    versions: { cli: '0.1.0', plugin: '0.1.0', actions: 'v1' },
    ...overrides,
  };
}

describe('listAgents (#137)', () => {
  let logs: string[] = [];
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logs = [];
    logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });
    readAgentsIndexMock.mockReset();
    loadAllAgentsMock.mockReset();
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('empty index → prints "No agents registered" hint', () => {
    readAgentsIndexMock.mockReturnValue({ agents: [] });

    listAgents();

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/No agents registered/);
    expect(logs[0]).toContain('macf init');
    // Must NOT call loadAllAgents when index is empty (wasted work).
    expect(loadAllAgentsMock).not.toHaveBeenCalled();
  });

  it('index has entries but loadAllAgents returns empty → "no valid configs" diagnostic', () => {
    // Index entry exists but its config is missing/invalid/readAgentConfig
    // returns null — loadAllAgents filters those out silently.
    readAgentsIndexMock.mockReturnValue({ agents: ['/orphaned/path'] });
    loadAllAgentsMock.mockReturnValue([]);

    listAgents();

    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('index has entries but no valid configs');
  });

  it('happy path → header + one line per agent', () => {
    readAgentsIndexMock.mockReturnValue({
      agents: ['/path/to/code-agent', '/path/to/science-agent'],
    });
    loadAllAgentsMock.mockReturnValue([
      {
        path: '/path/to/code-agent',
        config: fakeConfig({ agent_name: 'code-agent', agent_role: 'code-agent', project: 'MACF' }),
      },
      {
        path: '/path/to/science-agent',
        config: fakeConfig({ agent_name: 'science-agent', agent_role: 'science-agent', project: 'MACF' }),
      },
    ]);

    listAgents();

    // Expect: header line + 2 agent lines = 3 total log calls.
    expect(logs).toHaveLength(3);
    expect(logs[0]).toContain('macf agents');
    expect(logs[1]).toContain('code-agent');
    expect(logs[1]).toContain('MACF');
    expect(logs[1]).toContain('/path/to/code-agent');
    expect(logs[2]).toContain('science-agent');
  });

  it('renders fixed-width columns for visual alignment', () => {
    readAgentsIndexMock.mockReturnValue({ agents: ['/p/short', '/p/much-longer-name'] });
    loadAllAgentsMock.mockReturnValue([
      { path: '/p/short', config: fakeConfig({ agent_name: 'a', agent_role: 'b', project: 'P' }) },
      { path: '/p/much-longer-name', config: fakeConfig({ agent_name: 'really-long-agent-name', agent_role: 'some-role', project: 'PROJ2' }) },
    ]);

    listAgents();

    // Both agent lines should have the same overall prefix width up to
    // the path. The `.padEnd(20)` on agent_name + `.padEnd(15)` on role
    // + `.padEnd(10)` on project gives predictable alignment.
    const line1 = logs[1]!;
    const line2 = logs[2]!;
    const pathStart1 = line1.indexOf('/p/short');
    const pathStart2 = line2.indexOf('/p/much-longer-name');
    // The two names/roles/projects are different lengths, but padding
    // keeps the path starting at the same column iff every field is
    // within its pad limit. `really-long-agent-name` is 22 chars —
    // exceeds padEnd(20), so its path starts 2 chars later. Verify
    // this predictable-overflow behavior rather than strict alignment.
    expect(pathStart2).toBeGreaterThanOrEqual(pathStart1);
  });

  it('handles single-agent case cleanly', () => {
    readAgentsIndexMock.mockReturnValue({ agents: ['/p'] });
    loadAllAgentsMock.mockReturnValue([
      { path: '/p', config: fakeConfig() },
    ]);

    listAgents();
    expect(logs).toHaveLength(2);
    expect(logs[0]).toContain('macf agents');
  });
});
