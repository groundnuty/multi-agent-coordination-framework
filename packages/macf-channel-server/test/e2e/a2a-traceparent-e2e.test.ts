/**
 * E2E test for W3C tracecontext propagation through the A2A v1.0 inbound
 * JSON-RPC endpoint (`POST /a2a/v1`).
 *
 * groundnuty/macf#398 — A2A Phase 2d. Verifies the property captured in
 * Phase 2b design decision 4: the inbound endpoint extracts traceparent
 * from request headers and the SERVER span's parent context matches.
 *
 * **Design note**: the AC suggested a mock OTLP HTTP listener as the
 * capture mechanism. We use OpenTelemetry's `InMemorySpanExporter`
 * instead because:
 *
 *   1. It's the canonical OTel testing primitive — exports spans at the
 *      SDK layer, before any OTLP wire-serialization. Decouples the
 *      tracecontext-propagation assertion (the actual AC) from OTLP
 *      protocol-decoding noise (which would only test the exporter's
 *      protobuf path, not the propagation we care about).
 *   2. The OTLP-wire smoke (does the SDK actually emit OTLP HTTP POST
 *      bodies when `OTEL_EXPORTER_OTLP_ENDPOINT` is set?) is covered
 *      separately by `otel.test.ts` + the live observability stack in
 *      `groundnuty/macf-devops-toolkit` k3d cluster.
 *
 * Together with `a2a-message-send.test.ts` (which covers route dispatch
 * + state mutation), this test closes the Phase 2d traceparent E2E
 * acceptance criterion.
 *
 * Spec references:
 *   - W3C Trace Context: https://www.w3.org/TR/trace-context/
 *   - A2A v1.0 § 3 + Phase 2b design decision 4 (header-only propagation)
 */
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import { request } from 'node:https';
import { readFileSync } from 'node:fs';
import { trace, propagation } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { createHttpsServer } from '../../src/https.js';
import { TaskStore } from '../../src/a2a-task.js';
import type { HealthResponse, Logger } from '@groundnuty/macf-core';
import { generateTestCerts, cleanupTestCerts, type TestCerts } from './fixtures/gen-certs.js';

let certs: TestCerts;
let spanExporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

interface HttpResult {
  readonly status: number;
  readonly body: string;
}

function httpsPostWithTraceparent(
  port: number,
  payload: unknown,
  traceparent: string,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(payload);
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        method: 'POST',
        path: '/a2a/v1',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr).toString(),
          // W3C tracecontext canonical header. Format:
          // <version>-<trace-id 32 hex>-<span-id 16 hex>-<flags 2 hex>
          traceparent,
        },
        cert: readFileSync(certs.agentCert),
        key: readFileSync(certs.agentKey),
        ca: readFileSync(certs.caCert),
        rejectUnauthorized: true,
        checkServerIdentity: () => undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf-8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

async function startServer(): Promise<{
  readonly port: number;
  readonly stop: () => Promise<void>;
}> {
  const server = createHttpsServer({
    caCertPath: certs.caCert,
    agentCertPath: certs.agentCert,
    agentKeyPath: certs.agentKey,
    onNotify: vi.fn().mockResolvedValue(undefined),
    onHealth: () => ({}) as HealthResponse,
    taskStore: new TaskStore(),
    logger: makeLogger(),
  });
  const { actualPort } = await server.start(0, '127.0.0.1');
  return { port: actualPort, stop: () => server.stop() };
}

beforeAll(() => {
  certs = generateTestCerts();
  // Install an in-memory tracer provider so getTracer('macf') in
  // https.ts emits spans we can introspect. This MUST run before the
  // first call to getTracer() — Node's module-level caching means a
  // late provider swap doesn't reach existing tracer references.
  spanExporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spanExporter)],
  });
  // Globally register so trace.getTracer('macf') from anywhere in the
  // process returns a tracer bound to this provider.
  trace.setGlobalTracerProvider(provider);
  // W3C tracecontext propagator: `propagation.extract(ctx, headers)` in
  // https.ts reads `traceparent` via the configured propagator. Without
  // this explicit setup, extract() is a no-op (the default noop
  // propagator silently drops the header). The production code path
  // gets this via `tracerProvider.register()` in otel.ts; tests must
  // wire it themselves.
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
});

afterAll(async () => {
  await provider.shutdown();
  cleanupTestCerts(certs);
});

beforeEach(() => {
  // Each test starts with an empty span buffer.
  spanExporter.reset();
});

describe('A2A traceparent E2E (macf#398 Phase 2d — W3C tracecontext propagation)', () => {
  it('extracts traceparent from inbound request and uses it as SERVER span parent', async () => {
    const { port, stop } = await startServer();
    try {
      // Synthesize a W3C tracecontext header — well-formed v00 with
      // sampled flag set. The 32-hex trace ID is the value we expect
      // to see on the captured SERVER span.
      const clientTraceId = 'abcdef0123456789abcdef0123456789';
      const clientSpanId = '0123456789abcdef';
      const traceparent = `00-${clientTraceId}-${clientSpanId}-01`;

      const res = await httpsPostWithTraceparent(
        port,
        {
          jsonrpc: '2.0',
          id: 'tp-1',
          method: 'message/send',
          params: {
            message: {
              messageId: 'msg-tp',
              role: 'ROLE_USER',
              parts: [{ text: 'hello' }],
            },
          },
        },
        traceparent,
      );
      expect(res.status).toBe(200);

      // Spans are exported synchronously by SimpleSpanProcessor; the
      // route handler's `span.end()` in its `finally` block triggers
      // the export before the response is sent.
      const spans = spanExporter.getFinishedSpans();
      const serverSpan = spans.find((s) => s.name === 'macf.a2a.message_send');
      expect(serverSpan, `expected a macf.a2a.message_send span; got: ${spans.map((s) => s.name).join(', ')}`).toBeDefined();

      // Critical assertion: the SERVER span's trace ID matches what the
      // client sent in `traceparent`. Confirms propagation extracts +
      // applies the inbound context.
      expect(serverSpan!.spanContext().traceId).toBe(clientTraceId);
      // Parent span ID matches what the client put in traceparent.
      expect(serverSpan!.parentSpanContext?.spanId).toBe(clientSpanId);
    } finally {
      await stop();
    }
  });

  it('creates a fresh trace ID when no traceparent is present (no false-context-attribution)', async () => {
    const { port, stop } = await startServer();
    try {
      // POST without traceparent — the route handler should still start
      // a span, but the trace ID should be freshly generated (NOT some
      // stale or zeroed value).
      const bodyStr = JSON.stringify({
        jsonrpc: '2.0',
        id: 'tp-noheader',
        method: 'message/send',
        params: {
          message: { messageId: 'msg-no-tp', role: 'ROLE_USER', parts: [{ text: 'x' }] },
        },
      });
      await new Promise<void>((resolve, reject) => {
        const req = request(
          {
            hostname: '127.0.0.1',
            port,
            method: 'POST',
            path: '/a2a/v1',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(bodyStr).toString(),
            },
            cert: readFileSync(certs.agentCert),
            key: readFileSync(certs.agentKey),
            ca: readFileSync(certs.caCert),
            rejectUnauthorized: true,
            checkServerIdentity: () => undefined,
          },
          (res) => {
            res.on('data', () => undefined);
            res.on('end', () => resolve());
          },
        );
        req.on('error', reject);
        req.write(bodyStr);
        req.end();
      });

      const spans = spanExporter.getFinishedSpans();
      const serverSpan = spans.find((s) => s.name === 'macf.a2a.message_send');
      expect(serverSpan).toBeDefined();
      // Fresh trace ID: 32 hex chars, not all zeros.
      const tid = serverSpan!.spanContext().traceId;
      expect(tid).toMatch(/^[0-9a-f]{32}$/);
      expect(tid).not.toBe('0'.repeat(32));
      // No parent span (root span in this trace).
      // parentSpanContext is undefined for root spans in OTel JS SDK.
      expect(serverSpan!.parentSpanContext?.spanId).toBeUndefined();
    } finally {
      await stop();
    }
  });

  it('SERVER span attributes include the A2A-canonical operation name', async () => {
    const { port, stop } = await startServer();
    try {
      const traceparent = `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`;
      await httpsPostWithTraceparent(
        port,
        {
          jsonrpc: '2.0',
          id: 'attr-1',
          method: 'message/send',
          params: {
            message: { messageId: 'msg-attr', role: 'ROLE_USER', parts: [{ text: 'x' }] },
          },
        },
        traceparent,
      );
      const spans = spanExporter.getFinishedSpans();
      const serverSpan = spans.find((s) => s.name === 'macf.a2a.message_send');
      expect(serverSpan).toBeDefined();
      // GenAI semconv attributes set in https.ts.
      expect(serverSpan!.attributes['gen_ai.system']).toBe('macf');
      expect(serverSpan!.attributes['gen_ai.operation.name']).toBe('a2a.message_send');
      // macf-specific dispatch attribute set by the route handler.
      expect(serverSpan!.attributes['macf.a2a.dispatch']).toBe('fresh');
      expect(serverSpan!.attributes['macf.a2a.task_state']).toBe('TASK_STATE_COMPLETED');
    } finally {
      await stop();
    }
  });
});
