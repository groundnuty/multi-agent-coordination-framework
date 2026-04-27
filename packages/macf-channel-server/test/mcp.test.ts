import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpChannelError } from '@groundnuty/macf-core';
import { EXPECTED_VERSION } from './version-helper.js';

// Mock the MCP SDK before importing the module under test.
// macf#256: switched from `Server` (low-level) to `McpServer` (v1.x
// canonical with `registerTool` API). McpServer wraps Server and
// exposes the underlying instance via `.server`; we mock both to
// preserve the previous test surface (`.connect()` + `.notification()`
// via `.server.notification()`) plus add a `.registerTool()` mock for
// the new tool-registration path used by `notify_peer`.
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockNotification = vi.fn().mockResolvedValue(undefined);
const mockRegisterTool = vi.fn();

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.connect = mockConnect;
    this.registerTool = mockRegisterTool;
    this.server = { notification: mockNotification };
  }),
}));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: vi.fn(),
}));

// Import after mock setup
const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
const { createMcpChannel } = await import('../src/mcp.js');

describe('createMcpChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates channel with correct server name', () => {
    createMcpChannel({ agentName: 'code-agent' });

    expect(McpServer).toHaveBeenCalledWith(
      { name: 'macf-code-agent', version: EXPECTED_VERSION },
      expect.objectContaining({
        capabilities: { experimental: { 'claude/channel': {} } },
        instructions: expect.stringContaining('issue_routed'),
      }),
    );
  });

  it('includes all three notification types in default instructions', () => {
    createMcpChannel({ agentName: 'test' });

    const callArgs = vi.mocked(McpServer).mock.calls[0]!;
    const options = callArgs[1] as { instructions: string };
    expect(options.instructions).toContain('issue_routed');
    expect(options.instructions).toContain('mention');
    expect(options.instructions).toContain('startup_check');
  });

  it('connects via StdioServerTransport', async () => {
    const channel = createMcpChannel({ agentName: 'code-agent' });
    await channel.connect();

    expect(mockConnect).toHaveBeenCalledOnce();
  });

  it('pushes notification with correct method and params', async () => {
    const channel = createMcpChannel({ agentName: 'code-agent' });

    await channel.pushNotification('Issue #42 was routed', {
      type: 'issue_routed',
      issue_number: '42',
    });

    expect(mockNotification).toHaveBeenCalledWith({
      method: 'notifications/claude/channel',
      params: {
        content: 'Issue #42 was routed',
        meta: { type: 'issue_routed', issue_number: '42' },
      },
    });
  });

  it('wraps notification errors in McpChannelError', async () => {
    mockNotification.mockRejectedValueOnce(new Error('transport closed'));

    const channel = createMcpChannel({ agentName: 'code-agent' });

    await expect(
      channel.pushNotification('test', {}),
    ).rejects.toThrow(McpChannelError);
  });

  it('accepts custom instructions', () => {
    createMcpChannel({
      agentName: 'test',
      instructions: 'Custom instructions',
    });

    const callArgs = vi.mocked(McpServer).mock.calls[0]!;
    const options = callArgs[1] as { instructions: string };
    expect(options.instructions).toBe('Custom instructions');
  });

  it('exposes the underlying McpServer for tool registration (macf#256)', () => {
    const channel = createMcpChannel({ agentName: 'code-agent' });

    // The `mcp` property is the typed McpServer that callers (server.ts)
    // use to register tools like notify_peer.
    expect(channel.mcp).toBeDefined();
    expect(channel.mcp.registerTool).toBeDefined();
  });
});
