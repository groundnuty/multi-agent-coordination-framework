/**
 * Shared meter + metric instrument conventions for MACF channel server.
 *
 * Single source of truth for instrument names + attribute keys (parallels
 * `tracing.ts` for spans). Counter increments scattered across `https.ts`
 * (server-side `/notify` handler) and `notify-peer.ts` (client-side
 * outbound) read from this module so the canonical names + label sets
 * stay synchronized.
 *
 * Closes testbed#242 T6 (deferred metrics AC) per macf#278:
 *   - `macf.notify_received_total{type, agent}` — server-side counter,
 *     incremented per inbound /notify request after schema validation
 *   - `macf.notify_peer_total{event, delivered, agent}` — client-side
 *     counter, incremented per notify_peer broadcast (one increment per
 *     attempted peer; `delivered` label distinguishes success / failure)
 *
 * Both counters fire only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set;
 * `getMeter()` returns a no-op meter (zero-cost) when unset, mirroring
 * `getTracer()`'s pattern in `tracing.ts`. See DR-021 for the
 * zero-cost-default doctrine.
 *
 * Naming convention: `macf.<area>.<metric>_<unit>` per OTel semantic
 * conventions guidance. Counters end in `_total`; histograms (none yet)
 * would end in their unit (e.g., `_duration_ms`).
 */
import { metrics } from '@opentelemetry/api';
import type { Counter, Meter } from '@opentelemetry/api';

/** The single meter instance used across the MACF channel-server codebase. */
export function getMeter(): Meter {
  return metrics.getMeter('macf');
}

/** Metric instrument names — centralized for easy rename + grep. */
export const MetricNames = {
  /**
   * Server-side counter incremented per inbound /notify request after
   * schema validation. Labels: `type` (NotifyType variant), `agent`
   * (this server's agent name). Use to compute scenario-08-style
   * delivery rates + per-type traffic breakdown in Prometheus.
   */
  NotifyReceivedTotal: 'macf.notify_received_total',
  /**
   * Client-side counter incremented per notify_peer broadcast attempt
   * (one increment per attempted peer; `delivered=true|false` label
   * distinguishes outcomes). Labels: `event` (peer_notification event
   * name), `delivered` (bool stringified), `agent` (sender's agent name).
   * Pairs with `NotifyReceivedTotal` for end-to-end counter correlation.
   */
  NotifyPeerTotal: 'macf.notify_peer_total',
} as const;

/** Metric attribute keys — separate from span attributes (`Attr` in tracing.ts). */
export const MetricAttr = {
  /** NotifyType variant for the inbound /notify request (mention, peer_notification, etc.). */
  NotifyType: 'macf.notify.type',
  /** This server's agent name (denormalized into the metric for cross-agent aggregation). */
  Agent: 'macf.agent',
  /** Stringified boolean — was this peer's notification HTTP-200'd? */
  Delivered: 'macf.notify.delivered',
  /** peer_notification event name (session-end, turn-complete, error, custom). */
  Event: 'macf.notify.event',
} as const;

/**
 * Lazy-created counter instances. The api's `metrics.getMeter('macf')`
 * returns a no-op meter when no global MeterProvider is registered (the
 * zero-cost default), so calling `.add()` on instruments created from it
 * is safe + free. Re-creation per call would be wasteful but harmless;
 * we cache for the common path.
 */
let cachedNotifyReceivedCounter: Counter | undefined;
let cachedNotifyPeerCounter: Counter | undefined;

/**
 * Get the cached `macf.notify_received_total` counter, creating it
 * on first access. Safe to call before `bootstrapOtel()` runs — the
 * no-op meter returns no-op instruments when OTEL is disabled.
 */
export function getNotifyReceivedCounter(): Counter {
  cachedNotifyReceivedCounter ??= getMeter().createCounter(MetricNames.NotifyReceivedTotal, {
    description: 'Inbound /notify requests received after schema validation',
    unit: '1',
  });
  return cachedNotifyReceivedCounter;
}

/**
 * Get the cached `macf.notify_peer_total` counter, creating it on
 * first access. Same lazy-create pattern as `getNotifyReceivedCounter`.
 */
export function getNotifyPeerCounter(): Counter {
  cachedNotifyPeerCounter ??= getMeter().createCounter(MetricNames.NotifyPeerTotal, {
    description: 'Outbound notify_peer broadcast attempts (one increment per attempted peer)',
    unit: '1',
  });
  return cachedNotifyPeerCounter;
}

/**
 * Reset cached instruments. ONLY for use in tests that need to swap in
 * a fresh MeterProvider between cases. Do not call from production
 * code — the cache is correct under any normal lifecycle.
 */
export function resetMetricsCacheForTesting(): void {
  cachedNotifyReceivedCounter = undefined;
  cachedNotifyPeerCounter = undefined;
}
