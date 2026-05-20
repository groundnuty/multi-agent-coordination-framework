/**
 * A2A v1.0 outbound client primitive (groundnuty/macf#396 Phase 3).
 *
 * MACF channel-server's outbound A2A capability — dispatches `message/send`
 * JSON-RPC to remote A2A v1.0-compliant agents + fetches their AgentCard
 * via `/.well-known/agent-card.json`.
 *
 * **Hand-rolled SDK** (consistent with Phase 1 + 2a + 2c decisions):
 * `@a2a-js/sdk` is at v0.3.13 (A2A v0.3 target); v1.0 not released.
 * Hand-rolled Zod schemas (Message + Task + JSON-RPC envelopes) +
 * `node:https` request are the minimal-blast-radius approach + reuse
 * the same shapes the inbound side validates. Re-evaluate at Phase 3.5
 * or Phase 4 if SDK reaches v1.0 stable.
 *
 * **Spec verification** (2026-05-19 via a2a-protocol.org):
 * - § 9 JSON-RPC binding: method `"message/send"`; envelope `{ jsonrpc: "2.0", id, method, params }`
 * - § 4.1.4 Message schema (reused from `a2a-types.ts`)
 * - § 4.1.1 Task return shape (reused from `a2a-types.ts`)
 * - § 14.3 well-known URL convention for AgentCard discovery
 * - W3C tracecontext propagation via HTTP `traceparent` header
 *   (`propagation.inject()` from `@opentelemetry/api`)
 *
 * **Design references**: design proposal posted on `#396` 2026-05-19
 * (science-agent approved with two notes — both addressed):
 * - Span name: `invoke_agent {target}` via `buildInvokeAgentSpanName()`
 *   helper from `tracing.ts:60-65`; NOT `macf.invoke_agent`
 * - AgentCard cache: folded into this file (NOT a separate `agent-card-cache.ts`);
 *   extract only if cache surface grows in a future phase
 *
 * **Retry policy** (per design Q4):
 * - `getAgentCard()`: idempotent + safe to retry. Up to 3 attempts on
 *   network errors with exponential backoff (1s/2s/4s; ~7s total).
 * - `sendMessage()`: NOT retried. The spec doesn't mandate `messageId`
 *   deduplication on the server side; re-sending may create a new task.
 *   Caller responsibility to handle network errors with explicit retry
 *   semantics (and a fresh `messageId` if they choose to).
 *
 * **AgentCard cache** (per design Q6):
 * - Per-target in-memory Map; 5-min TTL
 * - Fresh fetch on miss + on auth-failure (401/403)
 * - Sweep on process exit (matches Phase 2a TaskStore lifecycle)
 *
 * **mTLS configuration**:
 * - Per-project CA chain reused (DR-010 + DR-022)
 * - `node:https.Agent` with `keepAlive: true` for connection reuse
 * - `checkServerIdentity: () => undefined` since channel-server certs
 *   advertise CN-based identity, not SAN-matched hostname (matches
 *   existing `notify-peer.ts` outbound pattern)
 */
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https';
import { randomUUID } from 'node:crypto';
import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import { buildInvokeAgentSpanName, Attr, GenAiAttr } from './tracing.js';
import {
  JsonRpcSuccessResponseSchema,
  JsonRpcErrorResponseSchema,
  A2A_METHOD_MESSAGE_SEND,
  A2A_ENDPOINT_PATH,
} from './a2a-types.js';
import type { Message, Task } from './a2a-types.js';
import { AgentCardSchema } from './agent-card.js';
import type { AgentCard } from './agent-card.js';

/** Default request timeout for outbound A2A calls (synchronous message/send). */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Default per-target AgentCard cache TTL (5 minutes). */
export const AGENT_CARD_CACHE_TTL_MS = 5 * 60 * 1000;

/** Well-known URL path for AgentCard discovery (A2A spec § 14.3). */
const AGENT_CARD_PATH = '/.well-known/agent-card.json';

/** Retry policy for idempotent operations (AgentCard fetch). */
const IDEMPOTENT_RETRY_DELAYS_MS: ReadonlyArray<number> = [1000, 2000, 4000];

export interface A2aClientConfig {
  /** PEM-encoded client cert for mTLS handshake. */
  readonly mTlsClientCertPem: string;
  /** PEM-encoded client key for mTLS handshake. */
  readonly mTlsClientKeyPem: string;
  /** PEM-encoded CA cert chain to validate the remote server's cert. */
  readonly caCertPem: string;
  /** Optional override for per-request timeout (default 30s). */
  readonly timeoutMs?: number;
  /** Optional override for the AgentCard cache TTL (default 5min). */
  readonly agentCardCacheTtlMs?: number;
}

/** Cached AgentCard entry. */
interface CachedAgentCard {
  readonly card: AgentCard;
  readonly fetchedAt: number;
}

/** Error class for A2A client failures. */
export class A2aClientError extends Error {
  public readonly code: string;
  constructor(code: string, message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = 'A2aClientError';
    this.code = code;
  }
}

/**
 * Outbound A2A v1.0 client. Single instance per channel-server process.
 *
 * Hold the keep-alive https.Agent + AgentCard cache as instance state.
 * Stateless across calls otherwise — each `sendMessage` /
 * `getAgentCard` invocation is independent.
 */
export class A2aClient {
  readonly #config: A2aClientConfig;
  readonly #agent: HttpsAgent;
  readonly #agentCardCache: Map<string, CachedAgentCard> = new Map();

  constructor(config: A2aClientConfig) {
    this.#config = config;
    // keepAlive lets us reuse TLS sessions across per-target calls; the
    // agent-card-discovery flow typically does 2 calls (card fetch then
    // message/send) so keepAlive saves a TLS handshake on the second.
    this.#agent = new HttpsAgent({
      keepAlive: true,
      // Per-host concurrency cap. Channel-server's outbound is
      // typically low-concurrency (1-2 in flight), so default is fine.
      maxSockets: 8,
    });
  }

  /**
   * Dispatch a `message/send` JSON-RPC call to a remote A2A v1.0 endpoint.
   *
   * Wraps in OTel CLIENT span named `invoke_agent {target}` per the
   * canonical GenAI semconv (matches the existing `notify_peer` outbound
   * pattern post-macf#369). The `target` is derived from the target URL's
   * host:port pair when not explicitly provided.
   *
   * Returns the parsed `Task` on success.
   *
   * Throws `A2aClientError` on:
   * - Transport failure (TLS, connect timeout, etc.) — code `'TRANSPORT_ERROR'`
   * - HTTP non-200 — code `'HTTP_ERROR'`
   * - JSON-RPC error envelope (`error` field set in response) — code `'JSONRPC_ERROR'`
   *   with `.cause` carrying the structured error object
   * - Schema validation failure on response body — code `'INVALID_RESPONSE'`
   *
   * Does NOT retry on failure (per design Q4 — `message/send` is not idempotent).
   */
  async sendMessage(
    targetUrl: string,
    message: Message,
    opts: { readonly target?: string; readonly requestId?: string } = {},
  ): Promise<Task> {
    const tracer = trace.getTracer('macf');
    const spanTarget = opts.target ?? this.#deriveTargetHandle(targetUrl);
    const requestId = opts.requestId ?? `req-${randomUUID()}`;

    return tracer.startActiveSpan(
      buildInvokeAgentSpanName(spanTarget),
      {
        kind: SpanKind.CLIENT,
        attributes: {
          [GenAiAttr.System]: 'macf',
          [GenAiAttr.OperationName]: 'invoke_agent',
          ...(spanTarget !== '' ? { [GenAiAttr.AgentName]: spanTarget } : {}),
          // macf#396 Phase 3: distinguish A2A outbound from legacy
          // notify_peer outbound under a single span name (both emit
          // `invoke_agent` per OTel GenAI semconv; the `macf.outbound.
          // protocol` attribute tells operators which dispatch path
          // ran). Sister to the SERVER-side `macf.a2a.dispatch`
          // attribute set in https.ts.
          [Attr.OutboundProtocol]: 'a2a',
          [Attr.OutboundTargetUrl]: targetUrl,
        },
      },
      async (span) => {
        try {
          const envelope = {
            jsonrpc: '2.0' as const,
            id: requestId,
            method: A2A_METHOD_MESSAGE_SEND,
            params: { message },
          };
          const response = await this.#postJsonRpc(
            `${targetUrl}${A2A_ENDPOINT_PATH}`,
            envelope,
          );
          // Try success-shape first; fall through to error-shape.
          const success = JsonRpcSuccessResponseSchema.safeParse(response);
          if (success.success) {
            const task = success.data.result;
            span.setAttribute(Attr.A2aTaskId, task.id);
            span.setAttribute(Attr.A2aTaskState, task.status.state);
            span.setStatus({ code: SpanStatusCode.OK });
            return task;
          }
          const errorEnv = JsonRpcErrorResponseSchema.safeParse(response);
          if (errorEnv.success) {
            const err = new A2aClientError(
              'JSONRPC_ERROR',
              `A2A server returned JSON-RPC error: ${errorEnv.data.error.message}`,
              errorEnv.data.error,
            );
            span.recordException(err);
            span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
            throw err;
          }
          const err = new A2aClientError(
            'INVALID_RESPONSE',
            `Response matches neither success nor error envelope`,
          );
          span.recordException(err);
          span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
          throw err;
        } catch (err) {
          if (!(err instanceof A2aClientError)) {
            span.recordException(err as Error);
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: err instanceof Error ? err.message : String(err),
            });
          }
          throw err;
        } finally {
          span.end();
        }
      },
    );
  }

  /**
   * Fetch a target's AgentCard via the well-known URL. Caches the result
   * per `targetUrl` for `agentCardCacheTtlMs` (default 5min).
   *
   * Returns `null` if:
   * - The endpoint returns 404 (target doesn't publish an AgentCard)
   * - The endpoint returns 401/403 (auth failure — cache miss + signals
   *   to caller that they may need to refresh credentials)
   *
   * Throws `A2aClientError` on:
   * - Transport failure (TLS, connect timeout) — code `'TRANSPORT_ERROR'`
   * - HTTP 5xx — code `'HTTP_ERROR'` (caller may want to retry)
   * - Body fails AgentCard schema validation — code `'INVALID_AGENT_CARD'`
   *
   * Retry on network errors: 3 attempts with exponential backoff
   * (1s/2s/4s; total ~7s). HTTP responses (200, 404, 4xx, 5xx) are not
   * retried — they're authoritative server signals.
   */
  async getAgentCard(targetUrl: string): Promise<AgentCard | null> {
    const cached = this.#agentCardCache.get(targetUrl);
    const ttl = this.#config.agentCardCacheTtlMs ?? AGENT_CARD_CACHE_TTL_MS;
    if (cached !== undefined && Date.now() - cached.fetchedAt < ttl) {
      return cached.card;
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= IDEMPOTENT_RETRY_DELAYS_MS.length; attempt++) {
      try {
        const result = await this.#fetchAgentCardOnce(targetUrl);
        if (result === null) {
          // Auth/missing — don't cache; signal to caller.
          this.#agentCardCache.delete(targetUrl);
          return null;
        }
        this.#agentCardCache.set(targetUrl, { card: result, fetchedAt: Date.now() });
        return result;
      } catch (err) {
        lastError = err;
        if (err instanceof A2aClientError && err.code !== 'TRANSPORT_ERROR') {
          // HTTP-level error or schema-validation failure — authoritative;
          // don't retry.
          throw err;
        }
        // Transport error — back off + retry (if attempts remain).
        if (attempt < IDEMPOTENT_RETRY_DELAYS_MS.length) {
          await new Promise((r) =>
            setTimeout(r, IDEMPOTENT_RETRY_DELAYS_MS[attempt]),
          );
        }
      }
    }
    // Exhausted retries — surface the last error.
    throw lastError as Error;
  }

  /** Diagnostic: count of cached AgentCard entries (testing aid). */
  agentCardCacheSize(): number {
    return this.#agentCardCache.size;
  }

  /** Manually invalidate a cached AgentCard (e.g., after detected target rotation). */
  invalidateAgentCard(targetUrl: string): void {
    this.#agentCardCache.delete(targetUrl);
  }

  /**
   * Close the underlying https.Agent. Call on channel-server shutdown to
   * release pooled sockets cleanly.
   */
  close(): void {
    this.#agent.destroy();
    this.#agentCardCache.clear();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Derive a span-attribute target handle from a target URL. Prefer the
   * host:port pair; fall back to the bare URL if parsing fails.
   */
  #deriveTargetHandle(targetUrl: string): string {
    try {
      const u = new URL(targetUrl);
      return `${u.hostname}:${u.port}`;
    } catch {
      return targetUrl;
    }
  }

  /**
   * Single AgentCard fetch attempt. Returns null on 404/401/403; throws
   * on transport / 5xx / schema-validation failure.
   */
  async #fetchAgentCardOnce(targetUrl: string): Promise<AgentCard | null> {
    const fullUrl = `${targetUrl}${AGENT_CARD_PATH}`;
    const { status, body } = await this.#httpsGet(fullUrl);
    if (status === 404 || status === 401 || status === 403) {
      return null;
    }
    if (status >= 500) {
      throw new A2aClientError(
        'HTTP_ERROR',
        `AgentCard fetch returned HTTP ${status}`,
      );
    }
    if (status !== 200) {
      throw new A2aClientError(
        'HTTP_ERROR',
        `AgentCard fetch returned unexpected HTTP ${status}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (err) {
      throw new A2aClientError(
        'INVALID_AGENT_CARD',
        `AgentCard body is not valid JSON`,
        err,
      );
    }
    const validated = AgentCardSchema.safeParse(parsed);
    if (!validated.success) {
      throw new A2aClientError(
        'INVALID_AGENT_CARD',
        `AgentCard body fails schema validation: ${validated.error.message}`,
        validated.error,
      );
    }
    return validated.data;
  }

  /**
   * Issue a JSON-RPC POST. Returns the parsed response body on HTTP 200
   * (whether success or error envelope — caller discriminates). Throws
   * on transport / non-200 / non-JSON.
   *
   * Tracecontext is injected via `propagation.inject(context.active(),
   * headers)` — picks up the active span (set by `sendMessage`'s tracer
   * scope) and writes `traceparent` + `tracestate` headers.
   */
  async #postJsonRpc(url: string, envelope: unknown): Promise<unknown> {
    const bodyStr = JSON.stringify(envelope);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyStr).toString(),
    };
    propagation.inject(context.active(), headers);
    const { status, body } = await this.#httpsSend(url, 'POST', headers, bodyStr);
    if (status !== 200) {
      throw new A2aClientError(
        'HTTP_ERROR',
        `JSON-RPC POST returned HTTP ${status}: ${body.slice(0, 200)}`,
      );
    }
    try {
      return JSON.parse(body);
    } catch (err) {
      throw new A2aClientError(
        'INVALID_RESPONSE',
        `JSON-RPC response body is not valid JSON`,
        err,
      );
    }
  }

  /** Issue an HTTPS GET. */
  async #httpsGet(url: string): Promise<{ readonly status: number; readonly body: string }> {
    const headers: Record<string, string> = {};
    propagation.inject(context.active(), headers);
    return this.#httpsSend(url, 'GET', headers, null);
  }

  /**
   * Low-level HTTPS request with mTLS client cert + connection pooling.
   * Returns `{ status, body }` on completion; rejects on transport error
   * with `A2aClientError` `code: 'TRANSPORT_ERROR'`.
   */
  #httpsSend(
    url: string,
    method: 'GET' | 'POST',
    headers: Record<string, string>,
    body: string | null,
  ): Promise<{ readonly status: number; readonly body: string }> {
    return new Promise((resolve, reject) => {
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
      } catch (err) {
        reject(new A2aClientError('TRANSPORT_ERROR', `Invalid URL: ${url}`, err));
        return;
      }
      const req = httpsRequest(
        {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port,
          path: `${parsedUrl.pathname}${parsedUrl.search}`,
          method,
          headers,
          cert: this.#config.mTlsClientCertPem,
          key: this.#config.mTlsClientKeyPem,
          ca: this.#config.caCertPem,
          rejectUnauthorized: true,
          // Same rationale as notify-peer.ts: channel-server certs use
          // CN-based identity, not SAN-matched hostname.
          checkServerIdentity: () => undefined,
          agent: this.#agent,
          timeout: this.#config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf-8'),
            });
          });
        },
      );
      req.on('error', (err) => {
        reject(new A2aClientError('TRANSPORT_ERROR', err.message, err));
      });
      req.on('timeout', () => {
        req.destroy();
        reject(new A2aClientError('TRANSPORT_ERROR', 'request timeout'));
      });
      if (body !== null) {
        req.write(body);
      }
      req.end();
    });
  }
}
