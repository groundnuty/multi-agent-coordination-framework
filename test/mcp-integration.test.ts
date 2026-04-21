/**
 * MCP SDK integration smoke-test.
 *
 * Background (`memory/project_audit_phase2_backlog.md` watch-item):
 * `@modelcontextprotocol/sdk` has drifted from our original pin
 * `^1.12.x` to 1.29.x (17 minor versions). `src/mcp.ts`'s
 * `pushNotification()` calls `server.notification({method, params})`
 * against a Claude-Code-specific method name
 * (`notifications/claude/channel`) that isn't in the SDK's typed
 * notification union. We rely on the SDK passing it through at
 * runtime. The concern: a future SDK version silently drops
 * unrecognized methods, our call returns OK, nothing reaches the
 * transport, TUI sees nothing.
 *
 * The existing `test/mcp.test.ts` fully mocks the SDK so it can't
 * catch that class of regression. This test uses the REAL SDK with
 * a capturing transport to verify: when we push a notification, the
 * framed JSON-RPC message actually reaches the transport layer.
 *
 * If this test fails after an SDK bump, it's a signal to either
 * pin tighter, patch `src/mcp.ts` to the new API, or both — don't
 * just ignore.
 */
import { describe, it, expect } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { EXPECTED_VERSION } from './version-helper.js';

// Minimal Transport interface matching what the SDK expects
// (matches the SDK's internal Transport interface: start/send/close +
// optional callback properties). This avoids depending on unexported
// SDK types while still satisfying the connect() method's shape.
class CapturingTransport {
  public readonly sent: JSONRPCMessage[] = [];

  async start(): Promise<void> {
    // No-op: SDK calls start() after connect(); we don't need I/O.
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.sent.push(message);
  }

  async close(): Promise<void> {
    // No-op: SDK calls close() on shutdown.
  }

  // Optional callbacks — the SDK sets these after connect().
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
}

describe('MCP SDK integration smoke-test', () => {
  it('pushNotification via real Server surfaces as a framed JSON-RPC notification on the transport', async () => {
    // Build the Server exactly as `src/mcp.ts` does — same name,
    // version, capabilities. If the SDK ever rejects this ctor
    // shape, our code is broken and this test catches it.
    const server = new Server(
      { name: 'macf-test', version: EXPECTED_VERSION },
      {
        capabilities: { experimental: { 'claude/channel': {} } },
        instructions: 'test',
      },
    );

    const transport = new CapturingTransport();
    await server.connect(transport);

    // Call notification() with the exact method + params shape that
    // `src/mcp.ts#pushNotification` emits. Type-cast because the
    // method name isn't in the SDK's typed ServerNotification union
    // — same workaround as mcp.ts. If the SDK tightens that type in
    // a future version, this cast would fail loud (better than
    // silent drop).
    await (server.notification as (n: {
      readonly method: string;
      readonly params: { readonly content: string; readonly meta: Record<string, string> };
    }) => Promise<void>)({
      method: 'notifications/claude/channel',
      params: {
        content: 'Test notification body',
        meta: { type: 'mention', issue_number: '42' },
      },
    });

    // The framed JSON-RPC notification should be on the transport.
    // If the SDK silently dropped our unrecognized method name,
    // `sent` would be empty — the exact failure mode the watch-item
    // warned about.
    expect(transport.sent).toHaveLength(1);

    const sent = transport.sent[0]!;
    expect(sent).toMatchObject({
      jsonrpc: '2.0',
      method: 'notifications/claude/channel',
      params: {
        content: 'Test notification body',
        meta: { type: 'mention', issue_number: '42' },
      },
    });

    // Notifications in JSON-RPC 2.0 do NOT carry an `id` field
    // (that would make it a request). If the SDK started adding
    // one, TUI would receive it as a request expecting a response,
    // which would break the one-way-notification contract.
    expect(sent).not.toHaveProperty('id');

    await server.close();
  });

  it('multiple notifications frame independently (no leaking state)', async () => {
    const server = new Server(
      { name: 'macf-test', version: EXPECTED_VERSION },
      { capabilities: { experimental: { 'claude/channel': {} } } },
    );
    const transport = new CapturingTransport();
    await server.connect(transport);

    // Must call via server.notification — rebinding to a free variable
    // loses `this` and trips an internal _transport lookup.
    const notify = (msg: {
      readonly method: string;
      readonly params: { readonly content: string; readonly meta: Record<string, string> };
    }): Promise<void> =>
      (server.notification as (n: typeof msg) => Promise<void>).call(server, msg);

    await notify({
      method: 'notifications/claude/channel',
      params: { content: 'first', meta: { type: 'mention' } },
    });
    await notify({
      method: 'notifications/claude/channel',
      params: { content: 'second', meta: { type: 'issue_routed' } },
    });

    expect(transport.sent).toHaveLength(2);
    expect((transport.sent[0] as { params: { content: string } }).params.content).toBe('first');
    expect((transport.sent[1] as { params: { content: string } }).params.content).toBe('second');

    await server.close();
  });
});
