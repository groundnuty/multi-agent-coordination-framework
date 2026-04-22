/**
 * OpenTelemetry bootstrap — side-effecting import-first module.
 *
 * Import this as the FIRST statement in `src/server.ts` (before any
 * other module that might call `trace.getTracer()` at eval time).
 * Violations fail silently: `trace.getTracer()` returns the global
 * no-op tracer and every subsequent span is dropped.
 *
 * Zero-cost default (macf#194):
 *   - If `OTEL_EXPORTER_OTLP_ENDPOINT` is unset, we skip provider
 *     registration entirely. `trace.getTracer()` returns the no-op
 *     implementation + `startActiveSpan` allocates only the closure.
 *     No background work, no exporter queue, no memory pressure.
 *   - Operators opt in by setting the env var (typically in claude.sh
 *     when the observability stack is running). Science-agent's
 *     `ops/observability/` compose brings up Langfuse + OTEL collector
 *     on localhost:4318; operator sets
 *     `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` + restarts
 *     agents.
 *
 * Why manual-only (no `auto-instrumentations-node`):
 *   Auto-instrumentations monkey-patch core Node modules including
 *   HTTPS — and we rely on exact mTLS client-cert validation semantics
 *   in `src/https.ts`. Any patching layer between us and Node's TLS
 *   code is a correctness risk we don't need. Manual spans in the
 *   handlers that matter (/notify, /sign, startup, tmux-wake, mcp
 *   push) give us the trace hierarchy + attribute set science-agent
 *   wants for Langfuse, without the patched-HTTPS exposure.
 *
 * Version pinning:
 *   SDK-node packages (`@opentelemetry/sdk-trace-node` etc.) are still
 *   pre-1.0 (0.x). Breaking changes land in minor releases. Pin exact
 *   versions via package.json — do NOT use caret ranges.
 *
 * See DR-021 for the full rationale.
 */
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes, defaultResource } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

const endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
const serviceVersion = process.env['MACF_VERSION'] ?? '0.0.0';

if (endpoint !== undefined && endpoint !== '') {
  // Resource attributes inherit from the SDK's default detectors
  // (process.*, host.*, telemetry.sdk.*) via `defaultResource()`,
  // merged with our explicit service.* attributes on top.
  const resource = defaultResource().merge(
    resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env['OTEL_SERVICE_NAME'] ?? 'macf',
      [ATTR_SERVICE_VERSION]: serviceVersion,
    }),
  );

  const provider = new NodeTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
  });

  // register() installs the provider as global + sets W3C trace-
  // context propagator as default. After this call,
  // `trace.getTracer('macf')` from anywhere in the process returns a
  // recording tracer bound to this provider.
  provider.register();

  // Clean shutdown: flush queued spans before process exits. Without
  // these handlers, in-flight batches are dropped on SIGTERM/SIGINT —
  // the last few seconds of coordination events never reach Langfuse.
  const shutdown = async (): Promise<void> => {
    try {
      await provider.shutdown();
    } catch {
      // Silent — we're exiting regardless; don't spam stderr.
    }
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
