import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the config module to control agent list
vi.mock('../../src/cli/config.js', () => ({
  loadAllAgents: vi.fn().mockReturnValue([
    {
      path: '/home/user/project1',
      config: { agent_name: 'code-agent', agent_role: 'code-agent', project: 'MACF' },
    },
    {
      path: '/home/user/project2',
      config: { agent_name: 'science-agent', agent_role: 'science-agent', project: 'MACF' },
    },
  ]),
}));

const { cdAgent } = await import('../../src/cli/commands/cd.js');

describe('macf cd', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = undefined;
  });

  it('prints path for known agent', () => {
    cdAgent('code-agent');
    expect(logSpy).toHaveBeenCalledWith('/home/user/project1');
  });

  it('prints path for second agent', () => {
    cdAgent('science-agent');
    expect(logSpy).toHaveBeenCalledWith('/home/user/project2');
  });

  it('sets exit code 1 for unknown agent', () => {
    cdAgent('nonexistent');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('not found'));
    expect(process.exitCode).toBe(1);
  });
});
