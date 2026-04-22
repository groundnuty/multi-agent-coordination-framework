/**
 * E2E tests for the clientAuth EKU gate (#121, DR-004 v2 step 3).
 *
 * Fills Chunk 3 of #137's test backfill. The EKU predicate
 * (`peerCertHasClientAuthEKU`) is unit-tested in `test/https-eku.test.ts`,
 * but the integration wiring — where src/https.ts checks the peer cert
 * on every request BEFORE method/URL dispatch — is only ever exercised
 * on the happy path by existing E2E tests. If the predicate stays
 * correct but the integration drifts (e.g. someone moves the gate into
 * a per-route check and forgets /health, or swaps `!peerCertHasClientAuthEKU`
 * for `peerCertHasClientAuthEKU` in a refactor), no test fails.
 *
 * These cases pin the gate's invariants E2E:
 *   - CA-trusted cert WITHOUT clientAuth EKU → 403 on every endpoint
 *     (uniform rejection; no route-level leak)
 *   - Error message points at `macf certs rotate` (operator guidance)
 *   - CA-trusted cert WITH clientAuth EKU → happy-path baseline passes
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { createHttpsServer } from '../../src/https.js';
import type { HealthResponse, Logger, SignRequest } from '@groundnuty/macf-core';
import { generateTestCerts, cleanupTestCerts, type TestCerts } from './fixtures/gen-certs.js';
import { EXPECTED_VERSION } from '../version-helper.js';

let certs: TestCerts;

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function httpsRequestAs(
  clientCertPath: string,
  clientKeyPath: string,
  port: number,
  options: { method: string; path: string; body?: string; headers?: Record<string, string> },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        method: options.method,
        path: options.path,
        headers: options.headers,
        cert: readFileSync(clientCertPath),
        key: readFileSync(clientKeyPath),
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
  readonly healthData?: HealthResponse;
}

async function startServer(opts: ServerOpts = {}): Promise<{ port: number; stop: () => Promise<void> }> {
  const server = createHttpsServer({
    caCertPath: certs.caCert,
    agentCertPath: certs.agentCert,
    agentKeyPath: certs.agentKey,
    onNotify: vi.fn().mockResolvedValue(undefined),
    onHealth: () => opts.healthData ?? ({} as HealthResponse),
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

describe('clientAuth EKU gate E2E (#121, #137 Chunk 3)', () => {
  describe('reject path — no-EKU cert hits 403 on every endpoint', () => {
    it('GET /health with no-EKU cert → 403 with operator guidance', async () => {
      const { port, stop } = await startServer();
      try {
        const res = await httpsRequestAs(
          certs.noEkuCert,
          certs.noEkuKey,
          port,
          { method: 'GET', path: '/health' },
        );
        expect(res.status).toBe(403);
        const body = JSON.parse(res.body);
        expect(body.error).toContain('clientAuth');
        expect(body.error).toContain('Extended Key Usage');
        // Error must point at the recovery command — operator guidance
        // is a core UX property of the #121 landing.
        expect(body.error).toContain('macf certs rotate');
      } finally {
        await stop();
      }
    });

    it('POST /notify with no-EKU cert → 403 (same uniform gate)', async () => {
      const { port, stop } = await startServer();
      try {
        const res = await httpsRequestAs(
          certs.noEkuCert,
          certs.noEkuKey,
          port,
          {
            method: 'POST',
            path: '/notify',
            body: JSON.stringify({ type: 'startup_check' }),
            headers: { 'Content-Type': 'application/json' },
          },
        );
        expect(res.status).toBe(403);
        expect(JSON.parse(res.body).error).toContain('clientAuth');
      } finally {
        await stop();
      }
    });

    it('POST /sign with no-EKU cert → 403 (gate fires BEFORE /sign-specific checks)', async () => {
      // Even though this server configures onSign (signing is available),
      // the EKU gate runs at the top of handleRequest and rejects before
      // reaching the /sign dispatch. Asserts the gate isn't route-specific —
      // a regression that moved it into /health only would break /sign's
      // rejection too.
      const onSign = vi.fn();
      const { port, stop } = await startServer({ onSign });
      try {
        const res = await httpsRequestAs(
          certs.noEkuCert,
          certs.noEkuKey,
          port,
          {
            method: 'POST',
            path: '/sign',
            body: JSON.stringify({ csr: 'x', agent_name: 'code-agent' }),
            headers: { 'Content-Type': 'application/json' },
          },
        );
        expect(res.status).toBe(403);
        expect(onSign).not.toHaveBeenCalled();
      } finally {
        await stop();
      }
    });

    it('GET /unknown-route with no-EKU cert → 403 (gate runs BEFORE 404 dispatch)', async () => {
      // The EKU check happens before the method/URL dispatch, so even a
      // bogus route returns 403 rather than 404. This is the right shape:
      // we should not leak routing information to un-authorized peers.
      const { port, stop } = await startServer();
      try {
        const res = await httpsRequestAs(
          certs.noEkuCert,
          certs.noEkuKey,
          port,
          { method: 'GET', path: '/this-route-does-not-exist' },
        );
        expect(res.status).toBe(403);
      } finally {
        await stop();
      }
    });
  });

  describe('allow path — EKU cert passes the gate (regression baseline)', () => {
    it('GET /health with EKU cert → 200', async () => {
      const healthData: HealthResponse = {
        agent: 'code-agent',
        status: 'online',
        type: 'permanent',
        uptime_seconds: 100,
        current_issue: null,
        version: EXPECTED_VERSION,
        last_notification: null,
      };
      const { port, stop } = await startServer({ healthData });
      try {
        const res = await httpsRequestAs(
          certs.agentCert,
          certs.agentKey,
          port,
          { method: 'GET', path: '/health' },
        );
        expect(res.status).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.agent).toBe('code-agent');
      } finally {
        await stop();
      }
    });
  });
});
