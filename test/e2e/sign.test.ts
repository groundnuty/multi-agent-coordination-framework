/**
 * E2E tests for POST /sign (DR-010 two-step challenge-response, #80/#87).
 *
 * Fills the E2E gap flagged in #137 — /sign was never exercised with a
 * real TLS handshake + CSR on the wire, only unit-tested at the handler
 * level. Tests cover:
 *
 *   - step 1: challenge issuance (challenge_done false → {challenge_id, instruction})
 *   - step 2: verify+sign (challenge_done true → {cert})
 *   - onSign absent → 503
 *   - onSign throws HttpError(401 mismatch) → 401 with generic message
 *   - onSign throws HttpError(503 CA unavailable) → 503
 *   - schema gate: missing csr → 400
 *   - schema gate: challenge_done without challenge_id → 400
 *   - malformed JSON → 400
 *   - wrong content type → 415
 *   - body > 64KB → 413
 *   - response surface on happy path carries the stubbed payload through unchanged
 *
 * onSign is stubbed rather than wired through the real challenge store
 * + varsClient because the E2E concern here is the /sign HTTP surface:
 * TLS handshake, header gates, JSON parse, schema validation, error-status
 * mapping. The challenge + verifyAndConsume logic is unit-tested in
 * test/certs/. Integrating both is P4 scope, not P3.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { createHttpsServer } from '../../src/https.js';
import { HttpError } from '../../src/errors.js';
import type { HealthResponse, Logger, SignRequest } from '../../src/types.js';
import { generateTestCerts, cleanupTestCerts, type TestCerts } from './fixtures/gen-certs.js';

let certs: TestCerts;

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function httpsRequest(
  port: number,
  options: {
    method: string;
    path: string;
    body?: string;
    headers?: Record<string, string>;
  },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        method: options.method,
        path: options.path,
        headers: options.headers,
        cert: readFileSync(certs.agentCert),
        key: readFileSync(certs.agentKey),
        ca: readFileSync(certs.caCert),
        rejectUnauthorized: true,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf-8'),
          }),
        );
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

interface ServerOpts {
  readonly onSign?: (req: SignRequest) => Promise<Record<string, unknown>>;
}

async function startServer(opts: ServerOpts = {}): Promise<{ port: number; stop: () => Promise<void> }> {
  const server = createHttpsServer({
    caCertPath: certs.caCert,
    agentCertPath: certs.agentCert,
    agentKeyPath: certs.agentKey,
    onNotify: vi.fn(),
    onHealth: () => ({} as HealthResponse),
    onSign: opts.onSign,
    logger: makeLogger(),
  });
  const { actualPort } = await server.start(0, '127.0.0.1');
  return { port: actualPort, stop: () => server.stop() };
}

beforeAll(() => {
  certs = generateTestCerts();
});

afterAll(() => {
  cleanupTestCerts(certs);
});

describe('POST /sign E2E (DR-010, #137)', () => {
  describe('happy path', () => {
    it('step 1: returns challenge_id + instruction when challenge_done is false', async () => {
      const onSign = vi.fn().mockResolvedValue({
        challenge_id: '123e4567-e89b-42d3-a456-556642440000',
        instruction: 'write this to registry variable MACF_CHALLENGE_code-agent',
      });
      const { port, stop } = await startServer({ onSign });

      try {
        const res = await httpsRequest(port, {
          method: 'POST',
          path: '/sign',
          body: JSON.stringify({ csr: 'dummy-csr', agent_name: 'code-agent' }),
          headers: { 'Content-Type': 'application/json' },
        });

        expect(res.status).toBe(200);
        const parsed = JSON.parse(res.body);
        expect(parsed.challenge_id).toBe('123e4567-e89b-42d3-a456-556642440000');
        expect(parsed.instruction).toContain('write this');
        expect(onSign).toHaveBeenCalledOnce();
        expect(onSign.mock.calls[0][0]).toMatchObject({
          csr: 'dummy-csr',
          agent_name: 'code-agent',
        });
      } finally {
        await stop();
      }
    });

    it('step 2: returns signed cert when challenge_done is true + challenge_id present', async () => {
      const onSign = vi.fn().mockResolvedValue({ cert: '-----BEGIN CERTIFICATE-----\nSTUB\n-----END CERTIFICATE-----' });
      const { port, stop } = await startServer({ onSign });

      try {
        const res = await httpsRequest(port, {
          method: 'POST',
          path: '/sign',
          body: JSON.stringify({
            csr: 'dummy-csr',
            agent_name: 'code-agent',
            challenge_done: true,
            challenge_id: '123e4567-e89b-42d3-a456-556642440000',
          }),
          headers: { 'Content-Type': 'application/json' },
        });

        expect(res.status).toBe(200);
        const parsed = JSON.parse(res.body);
        expect(parsed.cert).toContain('BEGIN CERTIFICATE');
        expect(onSign).toHaveBeenCalledOnce();
        expect(onSign.mock.calls[0][0].challenge_done).toBe(true);
      } finally {
        await stop();
      }
    });
  });

  describe('error-status mapping from onSign throws', () => {
    it('returns 401 when onSign throws HttpError(401) — challenge mismatch', async () => {
      // Generic 401 surface per server.ts: don't leak which check failed
      // (expired vs wrong-value vs agent-mismatch). Attack-surface minimization.
      const onSign = vi.fn().mockRejectedValue(new HttpError(401, 'challenge verification failed'));
      const { port, stop } = await startServer({ onSign });

      try {
        const res = await httpsRequest(port, {
          method: 'POST',
          path: '/sign',
          body: JSON.stringify({
            csr: 'x',
            agent_name: 'code-agent',
            challenge_done: true,
            challenge_id: '123e4567-e89b-42d3-a456-556642440000',
          }),
          headers: { 'Content-Type': 'application/json' },
        });
        expect(res.status).toBe(401);
        expect(JSON.parse(res.body).error).toContain('challenge verification failed');
      } finally {
        await stop();
      }
    });

    it('returns 503 when onSign throws HttpError(503) — CA key unavailable', async () => {
      const onSign = vi.fn().mockRejectedValue(new HttpError(503, 'CA key not available on this agent'));
      const { port, stop } = await startServer({ onSign });

      try {
        const res = await httpsRequest(port, {
          method: 'POST',
          path: '/sign',
          body: JSON.stringify({ csr: 'x', agent_name: 'code-agent' }),
          headers: { 'Content-Type': 'application/json' },
        });
        expect(res.status).toBe(503);
        expect(JSON.parse(res.body).error).toContain('CA key not available');
      } finally {
        await stop();
      }
    });

    it('returns 500 when onSign throws a non-HttpError', async () => {
      // Unexpected failures inside signing logic shouldn't leak internals —
      // the handler maps to 500 with the error message as-is (the logic
      // itself must be careful not to include secrets in exception text).
      const onSign = vi.fn().mockRejectedValue(new Error('unexpected crash'));
      const { port, stop } = await startServer({ onSign });

      try {
        const res = await httpsRequest(port, {
          method: 'POST',
          path: '/sign',
          body: JSON.stringify({ csr: 'x', agent_name: 'code-agent' }),
          headers: { 'Content-Type': 'application/json' },
        });
        expect(res.status).toBe(500);
        expect(JSON.parse(res.body).error).toBe('unexpected crash');
      } finally {
        await stop();
      }
    });
  });

  describe('endpoint-level gates (no onSign invocation)', () => {
    it('returns 503 when onSign is not configured on this server', async () => {
      // Agents without CA key access shouldn't offer signing at all —
      // server.ts only wires onSign when the agent has loadCA available.
      const { port, stop } = await startServer({}); // no onSign

      try {
        const res = await httpsRequest(port, {
          method: 'POST',
          path: '/sign',
          body: JSON.stringify({ csr: 'x', agent_name: 'code-agent' }),
          headers: { 'Content-Type': 'application/json' },
        });
        expect(res.status).toBe(503);
        expect(JSON.parse(res.body).error).toContain('Signing not available');
      } finally {
        await stop();
      }
    });

    it('returns 415 when Content-Type is not application/json', async () => {
      const onSign = vi.fn();
      const { port, stop } = await startServer({ onSign });

      try {
        const res = await httpsRequest(port, {
          method: 'POST',
          path: '/sign',
          body: '{}',
          headers: { 'Content-Type': 'text/plain' },
        });
        expect(res.status).toBe(415);
        expect(onSign).not.toHaveBeenCalled();
      } finally {
        await stop();
      }
    });

    it('returns 400 for malformed JSON body', async () => {
      const onSign = vi.fn();
      const { port, stop } = await startServer({ onSign });

      try {
        const res = await httpsRequest(port, {
          method: 'POST',
          path: '/sign',
          body: '{ not valid',
          headers: { 'Content-Type': 'application/json' },
        });
        expect(res.status).toBe(400);
        expect(JSON.parse(res.body).error).toContain('Invalid JSON');
        expect(onSign).not.toHaveBeenCalled();
      } finally {
        await stop();
      }
    });

    it('returns 400 when required csr field is missing', async () => {
      const onSign = vi.fn();
      const { port, stop } = await startServer({ onSign });

      try {
        const res = await httpsRequest(port, {
          method: 'POST',
          path: '/sign',
          body: JSON.stringify({ agent_name: 'code-agent' }),
          headers: { 'Content-Type': 'application/json' },
        });
        expect(res.status).toBe(400);
        expect(JSON.parse(res.body).error).toContain('Validation failed');
        expect(onSign).not.toHaveBeenCalled();
      } finally {
        await stop();
      }
    });

    it('returns 400 when required agent_name field is missing', async () => {
      const onSign = vi.fn();
      const { port, stop } = await startServer({ onSign });

      try {
        const res = await httpsRequest(port, {
          method: 'POST',
          path: '/sign',
          body: JSON.stringify({ csr: 'x' }),
          headers: { 'Content-Type': 'application/json' },
        });
        expect(res.status).toBe(400);
        expect(onSign).not.toHaveBeenCalled();
      } finally {
        await stop();
      }
    });

    it('returns 400 when challenge_done is true but challenge_id is missing (schema refine)', async () => {
      // SignRequestSchema's .refine() gate — step 2 requires challenge_id.
      const onSign = vi.fn();
      const { port, stop } = await startServer({ onSign });

      try {
        const res = await httpsRequest(port, {
          method: 'POST',
          path: '/sign',
          body: JSON.stringify({
            csr: 'x',
            agent_name: 'code-agent',
            challenge_done: true,
            // challenge_id deliberately missing
          }),
          headers: { 'Content-Type': 'application/json' },
        });
        expect(res.status).toBe(400);
        expect(JSON.parse(res.body).error).toContain('challenge_id');
        expect(onSign).not.toHaveBeenCalled();
      } finally {
        await stop();
      }
    });

    it('returns 400 when challenge_id is not a valid UUID', async () => {
      const onSign = vi.fn();
      const { port, stop } = await startServer({ onSign });

      try {
        const res = await httpsRequest(port, {
          method: 'POST',
          path: '/sign',
          body: JSON.stringify({
            csr: 'x',
            agent_name: 'code-agent',
            challenge_done: true,
            challenge_id: 'not-a-uuid',
          }),
          headers: { 'Content-Type': 'application/json' },
        });
        expect(res.status).toBe(400);
        expect(onSign).not.toHaveBeenCalled();
      } finally {
        await stop();
      }
    });
  });

  describe('transport-level edge cases', () => {
    it('handles body > 64KB — server destroys connection or returns 413', async () => {
      // Matches the /notify 413 test's pattern: server destroys socket on
      // oversized body, so we accept either 413 or a network-level throw.
      const onSign = vi.fn();
      const { port, stop } = await startServer({ onSign });

      try {
        const largeCsr = 'x'.repeat(65 * 1024);
        try {
          const res = await httpsRequest(port, {
            method: 'POST',
            path: '/sign',
            body: JSON.stringify({ csr: largeCsr, agent_name: 'code-agent' }),
            headers: { 'Content-Type': 'application/json' },
          });
          expect(res.status).toBe(413);
        } catch {
          // Connection destroyed — also valid.
        }
        expect(onSign).not.toHaveBeenCalled();
      } finally {
        await stop();
      }
    });

    it('rejects GET /sign — POST only', async () => {
      // /sign is write-semantic; GET falls through the method guards.
      const onSign = vi.fn();
      const { port, stop } = await startServer({ onSign });

      try {
        const res = await httpsRequest(port, { method: 'GET', path: '/sign' });
        expect(res.status).toBe(404);
        expect(onSign).not.toHaveBeenCalled();
      } finally {
        await stop();
      }
    });
  });
});
