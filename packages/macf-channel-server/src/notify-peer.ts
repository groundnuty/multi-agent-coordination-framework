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
// macf#267 Findings 3+4: OTel span on outbound notify_peer + W3C
// traceparent propagation to receiver. `propagation.inject()` writes
// the traceparent + tracestate headers; `trace.getTracer()` provides
// the per-call CLIENT span. See @opentelemetry/api 1.x propagation
// API (canonical, verified at impl time).
import { context, propagation, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { SpanNames, Attr, GenAiAttr } from './tracing.js';
import { getNotifyPeerCounter, MetricAttr } from './metrics.js';

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
    // macf#267 Finding 4: inject W3C traceparent on outbound POST so
    // receiver's NotifyReceived span becomes a child of the calling
    // agent's notify_peer span (cross-channel-server trace correlation).
    // propagation.inject() writes into the headers carrier using the
    // global propagator (ProvidedBy NodeTracerProvider in src/otel.ts).
    // The carrier is a plain object; node:https consumes it as request
    // headers verbatim.
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body).toString(),
    };
    propagation.inject(context.active(), headers);
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
        headers,
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
 * Per-peer timeout is 5s (macf#267 Finding 1 fix; was 1s in v0.2.3,
 * which cut off mid-receiver-wake; comfortable margin even after
 * Finding 2's Option (d) makes /notify return ~5ms for peer_notification).
 *
 * macf#267 Finding 3: wraps in OTel CLIENT span (`macf.tool.notify_peer`)
 * with attributes (target, event, peers_attempted, peers_delivered) so
 * sender-side latency + outcome are visible in Phase D / Claim 1b traces.
 *
 * macf#267 Finding 4: per-peer postToPeer injects W3C traceparent on
 * outbound POST so receiver's NotifyReceived span becomes a child of
 * this notify_peer span (cross-channel-server trace correlation).
 */
export async function notifyPeer(
  deps: NotifyPeerDeps,
  input: NotifyPeerInput,
): Promise<NotifyPeerResult> {
  const tracer = trace.getTracer('macf');
  return tracer.startActiveSpan(
    SpanNames.ToolNotifyPeer,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        [GenAiAttr.System]: 'macf',
        [GenAiAttr.OperationName]: 'peer_notify',
        [Attr.NotifyType]: 'peer_notification',
        [Attr.NotifyEvent]: input.event,
        [Attr.NotifyTarget]: input.to ?? 'broadcast',
      },
    },
    async (span) => {
      try {
        const peers = await resolveTargetPeers(deps, input.to);
        if (peers.length === 0) {
          span.setAttribute(Attr.PeersAttempted, 0);
          span.setAttribute(Attr.PeersDelivered, 0);
          span.setStatus({ code: SpanStatusCode.OK });
          return {
            delivered: false,
            channel_state: 'offline' as const,
            peers_attempted: 0,
            peers_delivered: 0,
          };
        }

        const payload = {
          type: 'peer_notification',
          source: deps.selfAgentName,
          event: input.event,
          ...(input.message !== undefined ? { message: input.message } : {}),
          ...(input.context !== undefined ? { context: input.context } : {}),
        };

        const results = await Promise.all(
          peers.map(p => postToPeer(deps, p, payload, 5000)),
        );

        const peers_delivered = results.filter(r => r.httpOk).length;
        const peers_reachable = results.filter(r => r.transportOk).length;

        // testbed#242 T6 / macf#278: notify_peer counter increments
        // ONCE per attempted peer (not once per call). delivered=true|
        // false label distinguishes outcomes so Prometheus can compute
        // delivery rate via `sum(rate(macf_notify_peer_total{delivered=
        // "true"}[5m])) / sum(rate(macf_notify_peer_total[5m]))`.
        // Counter increments BEFORE span finalization so OTel's
        // periodic reader picks them up regardless of span outcome
        // (consistent with the receiver-side notify_received pattern).
        const peerCounter = getNotifyPeerCounter();
        for (const result of results) {
          peerCounter.add(1, {
            [MetricAttr.Event]: input.event,
            [MetricAttr.Delivered]: result.httpOk ? 'true' : 'false',
            [MetricAttr.Agent]: deps.selfAgentName,
          });
        }

        span.setAttribute(Attr.PeersAttempted, peers.length);
        span.setAttribute(Attr.PeersDelivered, peers_delivered);
        span.setStatus({ code: SpanStatusCode.OK });

        return {
          delivered: peers_delivered > 0,
          channel_state: peers_reachable > 0 ? 'online' as const : 'offline' as const,
          peers_attempted: peers.length,
          peers_delivered,
        };
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}
