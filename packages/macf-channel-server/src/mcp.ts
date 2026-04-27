import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { McpChannelError } from '@groundnuty/macf-core';
import type { McpChannel } from '@groundnuty/macf-core';
import { PACKAGE_VERSION } from './package-version.js';

const CHANNEL_INSTRUCTIONS = `Events arrive as <channel source="macf-agent" type="..." ...>.

type="issue_routed": A GitHub issue was routed to you by the agent-router Action.
  Read the issue and work on it following your agent identity rules.

type="mention": You were @mentioned in an issue comment or PR review.
  Read the context and respond.

type="startup_check": Pending issues found at session startup.
  Review and pick up the most important one.`;

/**
 * Extended McpChannel surface — adds the underlying McpServer accessor
 * so callers (server.ts) can register MCP tools (notify_peer per
 * macf#256 / DR-023 UC-1) on the same MCP-stdio session that delivers
 * channel notifications. Without this, registering tools would require
 * a separate MCP server process; same-server keeps the dispatcher
 * single-tenant + matches DR-022 Amendment K (channel-server's tool
 * surface ships from the same package).
 */
export interface McpChannelWithTools extends McpChannel {
  readonly mcp: McpServer;
}

export function createMcpChannel(config: {
  readonly agentName: string;
  readonly instructions?: string;
}): McpChannelWithTools {
  const instructions = config.instructions ?? CHANNEL_INSTRUCTIONS;

  // Switched from low-level `Server` to `McpServer` per macf#256 (DR-023
  // implementation) — McpServer is the v1.x canonical API for tool
  // registration via `registerTool()`. The underlying `Server` is still
  // accessible via `.server` for the raw `notifications/claude/channel`
  // push (Claude-Code-extension method that sits outside MCP's typed
  // notification union).
  const mcp = new McpServer(
    { name: `macf-${config.agentName}`, version: PACKAGE_VERSION },
    {
      capabilities: {
        experimental: { 'claude/channel': {} },
      },
      instructions,
    },
  );

  return {
    mcp,

    async connect(): Promise<void> {
      const transport = new StdioServerTransport();
      await mcp.connect(transport);
    },

    async pushNotification(
      content: string,
      meta: Record<string, string>,
    ): Promise<void> {
      try {
        // notifications/claude/channel is a Claude Code extension not in MCP's
        // typed ServerNotification union, but Server.assertNotificationCapability
        // has no default case so unknown methods pass through at runtime.
        await (mcp.server.notification as (n: {
          readonly method: string;
          readonly params: {
            readonly content: string;
            readonly meta: Record<string, string>;
          };
        }) => Promise<void>)({
          method: 'notifications/claude/channel',
          params: { content, meta },
        });
      } catch (err) {
        throw new McpChannelError(
          `Failed to push notification: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}
