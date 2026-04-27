/**
 * `notify_peer` MCP tool implementation per macf#256 / DR-023 UC-1.
 *
 * Registered on the channel-server's MCP surface; called by Claude Code's
 * plugin loader when the `Stop` hook fires (per `packages/macf/plugin/hooks/hooks.json`).
 * The tool resolves the peer agent's channel-server URL from the project
 * registry, then sends a notification payload to the peer's `/notify`
 * HTTP endpoint over mTLS.
 *
 * Failure semantics (per DR-023 §"Failure-mode contract" + §UC-1):
 *
 *   The hook layer is observational + non-blocking by default. All errors
 *   (peer unreachable, TLS handshake failure, peer rejected payload) are
 *   surfaced as `isError: true` — the LLM sees the error in the tool
 *   response + can self-correct, but the `Stop` event itself is NOT
 *   blocked. Polling-fallback (existing pattern: peer's SessionStart
 *   hook checks GitHub queue) catches missed notifications.
 *
 * `to` field semantic (refinement from DR-023 design — see macf#256
 * Option A):
 *
 *   `to` is OPTIONAL. When absent, the tool fans out to all peer
 *   agents registered in the project (registry `list()`). When
 *   present, it's a single-peer POST. This keeps the plugin-shipped
 *   hook entry universal across consumer workspaces (no per-agent
 *   `to:` customization needed).
 */
import { request as httpsRequest } from 'node:https';
import type { Registry, AgentInfo } from '@groundnuty/macf-core';
import type { Logger } from '@groundnuty/macf-core';
import { toVariableSegment } from '@groundnuty/macf-core';
import { z } from 'zod';

export const NotifyPeerInputSchema = {
  to: z.string().optional()
    .describe('Peer agent name to notify. If omitted, broadcasts to all registered peers in the project.'),
  event: z.enum(['session-end', 'turn-complete', 'error', 'custom'])
    .describe('Event type triggering the notification.'),
  message: z.string().optional()
    .describe('Optional human-readable message body.'),
  context: z.record(z.string(), z.unknown()).optional()
    .describe('Optional structured context payload (string-keyed object).'),
} as const;

export const NotifyPeerOutputSchema = {
  delivered: z.boolean()
    .describe('True if at least one peer received HTTP 200 from /notify.'),
  channel_state: z.enum(['online', 'offline'])
    .describe('Aggregate state — "online" if at least one peer reachable, "offline" otherwise.'),
  peers_attempted: z.number().int().nonnegative()
    .describe('Number of peers the tool attempted to notify.'),
  peers_delivered: z.number().int().nonnegative()
    .describe('Subset of attempted peers that returned HTTP 200.'),
} as const;

export interface NotifyPeerDeps {
  readonly registry: Registry;
  readonly selfAgentName: string;
  readonly mTlsClientCertPem: string;
  readonly mTlsClientKeyPem: string;
  readonly caCertPem: string;
  readonly logger: Logger;
}

export interface NotifyPeerInput {
  readonly to?: string;
  readonly event: 'session-end' | 'turn-complete' | 'error' | 'custom';
  readonly message?: string;
  readonly context?: Record<string, unknown>;
}

export interface NotifyPeerResult {
  readonly delivered: boolean;
  readonly channel_state: 'online' | 'offline';
  readonly peers_attempted: number;
  readonly peers_delivered: number;
}

/**
 * Resolve target peer list. Single-peer mode if `to` provided; broadcast
 * to all-but-self otherwise. Always excludes self to prevent the
 * (server, tool, input) deduplication cycle DR-023 §"Cycle prevention"
 * warns about.
 *
 * Self-exclusion comparison normalizes via `toVariableSegment` because
 * Registry.list() returns names in GitHub-Variables-canonical form
 * (uppercased, hyphens-to-underscores per
 * `@groundnuty/macf-core:registry/variable-name.ts`), while
 * `selfAgentName` is the canonical agent identity (lowercased,
 * hyphenated). Comparing raw strings would never match → broadcasts
 * would loop back to self, triggering the dedup-cycle the §"Cycle
 * prevention" decision tree warns about. Bug surfaced in macf#256
 * empirical validation; fix scoped here per Option B.
 */
async function resolveTargetPeers(
  deps: NotifyPeerDeps,
  to: string | undefined,
): Promise<ReadonlyArray<{ readonly name: string; readonly info: AgentInfo }>> {
  const selfNormalized = toVariableSegment(deps.selfAgentName);
  if (to !== undefined && to !== '') {
    if (toVariableSegment(to) === selfNormalized) return [];
    const info = await deps.registry.get(to);
    if (info === null) return [];
    return [{ name: to, info }];
  }
  // Broadcast: list all registered peers, exclude self. Normalize BOTH
  // sides since Registry.list() can return names in either canonical
  // or variable form depending on the GitHubVariablesClient impl —
  // safest comparison normalizes both.
  const all = await deps.registry.list('');
  return all.filter(p => toVariableSegment(p.name) !== selfNormalized);
}

/**
 * Send a single mTLS POST to `https://${host}:${port}/notify` with the
 * payload as JSON. Returns true on HTTP 200, false on any other status
 * (peer alive but rejected) or transport error (peer unreachable).
 *
 * Distinguishes "peer alive + rejected" from "peer unreachable" via the
 * caller's outer aggregation (peer-alive returns false; transport-error
 * also returns false, but the next channel_state derivation can use the
 * stats to surface aggregate health).
 */
function postToPeer(
  deps: NotifyPeerDeps,
  peer: { readonly name: string; readonly info: AgentInfo },
  payload: object,
  timeoutMs: number,
): Promise<{ readonly httpOk: boolean; readonly transportOk: boolean }> {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = httpsRequest(
      {
        hostname: peer.info.host,
        port: peer.info.port,
        path: '/notify',
        method: 'POST',
        cert: deps.mTlsClientCertPem,
        key: deps.mTlsClientKeyPem,
        ca: deps.caCertPem,
        // Channel server's cert SAN may not match host name when
        // advertise_host=127.0.0.1 (the canonical loopback case);
        // mTLS ensures identity via cert chain, not hostname.
        rejectUnauthorized: true,
        checkServerIdentity: () => undefined,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body).toString(),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const httpOk = res.statusCode === 200;
        // Drain response body so socket can free; we don't care about content.
        res.resume();
        res.on('end', () => resolve({ httpOk, transportOk: true }));
      },
    );
    req.on('error', (err) => {
      deps.logger.warn('notify_peer_transport_error', {
        peer: peer.name,
        host: peer.info.host,
        port: String(peer.info.port),
        error: err.message,
      });
      resolve({ httpOk: false, transportOk: false });
    });
    req.on('timeout', () => {
      deps.logger.warn('notify_peer_timeout', {
        peer: peer.name,
        host: peer.info.host,
        port: String(peer.info.port),
        timeoutMs: String(timeoutMs),
      });
      req.destroy();
      resolve({ httpOk: false, transportOk: false });
    });
    req.write(body);
    req.end();
  });
}

/**
 * Tool body — resolves peers, fans out, aggregates.
 *
 * Per-peer timeout is 1s (well under DR-023 Stop event's 500ms typical
 * budget for the whole tool call; broadcasts to N peers run in parallel
 * so wall-clock is max(per-peer-time), not sum).
 */
export async function notifyPeer(
  deps: NotifyPeerDeps,
  input: NotifyPeerInput,
): Promise<NotifyPeerResult> {
  const peers = await resolveTargetPeers(deps, input.to);
  if (peers.length === 0) {
    return {
      delivered: false,
      channel_state: 'offline',
      peers_attempted: 0,
      peers_delivered: 0,
    };
  }

  // macf#256 Bug 2 fix: payload `type` MUST match the receiver's
  // /notify endpoint enum (NotifyTypeSchema in @groundnuty/macf-core
  // types). The original v0.2.2 sent `type: input.event` (e.g.,
  // "session-end"), which isn't a valid NotifyType → /notify HTTP 400.
  // v0.2.3 sends the new dedicated `peer_notification` type (added to
  // NotifyTypeSchema in macf-core in this PR per Option B), with the
  // hook-event in a dedicated `event` field. Receiver discriminates
  // via `type === 'peer_notification'` and renders the event in the
  // notification (notify-formatter.ts).
  const payload = {
    type: 'peer_notification',
    source: deps.selfAgentName,
    event: input.event,
    ...(input.message !== undefined ? { message: input.message } : {}),
    ...(input.context !== undefined ? { context: input.context } : {}),
  };

  const results = await Promise.all(
    peers.map(p => postToPeer(deps, p, payload, 1000)),
  );

  const peers_delivered = results.filter(r => r.httpOk).length;
  const peers_reachable = results.filter(r => r.transportOk).length;

  return {
    delivered: peers_delivered > 0,
    channel_state: peers_reachable > 0 ? 'online' : 'offline',
    peers_attempted: peers.length,
    peers_delivered,
  };
}
