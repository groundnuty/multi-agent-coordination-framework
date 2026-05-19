/**
 * E2E tests for the A2A v1.0 AgentCard discovery endpoint
 * (`/.well-known/agent-card.json`).
 *
 * groundnuty/macf#370 — A2A Phase 1.
 *
 * Spec: A2A Protocol v1.0 § 14.3 (well-known URL) + § 4.4.1 (AgentCard).
 *
 * These tests exercise the full request path:
 *   - mTLS handshake + EKU gate (existing infra)
 *   - GET /.well-known/agent-card.json dispatch
 *   - JSON body shape validation against AgentCardSchema
 *
 * Unit-level schema tests live in `test/agent-card.test.ts`; this file
 * pins the integration wiring so the endpoint stays reachable across
 * refactors of https.ts dispatch.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { request } from 'node:https';
import { readFileSync } from 'node:fs';
import { createHttpsServer } from '../../src/https.js';
import { buildAgentCard, AgentCardSchema } from '../../src/agent-card.js';
import type { HealthResponse, Logger, SignRequest } from '@groundnuty/macf-core';
import { generateTestCerts, cleanupTestCerts, type TestCerts } from './fixtures/gen-certs.js';

let certs: TestCerts;

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function httpsGet(
  clientCertPath: string,
  clientKeyPath: string,
  port: number,
  path: string,
): Promise<{ status: number; body: string; contentType: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        method: 'GET',
        path,
        cert: readFileSync(clientCertPath),
        key: readFileSync(clientKeyPath),
        ca: readFileSync(certs.caCert),
        rejectUnauthorized: true,
        checkServerIdentity: () => undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf-8'),
            contentType: res.headers['content-type'],
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const baseAgentCard = buildAgentCard({
  agentName: 'code-agent',
  agentRole: 'code-agent',
  project: 'macf',
  url: 'https://127.0.0.1:0',
  version: '0.2.23',
});

async function startServer(opts: {
  readonly agentCard?: unknown;
  readonly onSign?: (req: SignRequest) => Promise<Record<string, unknown>>;
  readonly healthData?: HealthResponse;
} = {}) {
  const server = createHttpsServer({
    caCertPath: certs.caCert,
    agentCertPath: certs.agentCert,
    agentKeyPath: certs.agentKey,
    onNotify: vi.fn().mockResolvedValue(undefined),
    onHealth: () => opts.healthData ?? ({} as HealthResponse),
    onSign: opts.onSign,
    agentCard: opts.agentCard,
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

describe('AgentCard discovery endpoint E2E (macf#370 — A2A Phase 1)', () => {
  describe('GET /.well-known/agent-card.json — happy path', () => {
    it('returns 200 + AgentCard JSON when agentCard is configured', async () => {
      const { port, stop } = await startServer({ agentCard: baseAgentCard });
      try {
        const res = await httpsGet(
          certs.agentCert,
          certs.agentKey,
          port,
          '/.well-known/agent-card.json',
        );
        expect(res.status).toBe(200);
        const parsed = JSON.parse(res.body);
        expect(AgentCardSchema.safeParse(parsed).success).toBe(true);
      } finally {
        await stop();
      }
    });

    it('returns valid A2A v1.0 AgentCard with required fields', async () => {
      const { port, stop } = await startServer({ agentCard: baseAgentCard });
      try {
        const res = await httpsGet(
          certs.agentCert,
          certs.agentKey,
          port,
          '/.well-known/agent-card.json',
        );
        const card = JSON.parse(res.body);
        // macf#393 Phase 2c: AgentCard shape is proto-canonical.
        // No top-level `id` or `url` (id is non-canonical; url moved
        // to supportedInterfaces[0].url per proto AgentInterface).
        expect(card.id).toBeUndefined();
        expect(card.url).toBeUndefined();
        expect(card.name).toBe('code-agent');
        expect(card.supportedInterfaces[0].url).toBe('https://127.0.0.1:0/a2a/v1');
        expect(card.supportedInterfaces[0].protocolBinding).toBe('JSONRPC');
        expect(card.supportedInterfaces[0].protocolVersion).toBe('1.0');
        expect(card.version).toBe('0.2.23');
        expect(card.provider.organization).toContain('macf');
        expect(card.securitySchemes.mutual_tls.type).toBe('mutualTls');
        // Required-per-proto fields all present
        expect(card.description.length).toBeGreaterThan(0);
        expect(card.defaultInputModes).toContain('application/json');
        expect(card.defaultOutputModes).toContain('application/json');
        expect(card.skills.length).toBeGreaterThan(0);
      } finally {
        await stop();
      }
    });

    it('declares mTLS as the default security requirement (Phase 1 + #371 lockstep)', async () => {
      const { port, stop } = await startServer({ agentCard: baseAgentCard });
      try {
        const res = await httpsGet(
          certs.agentCert,
          certs.agentKey,
          port,
          '/.well-known/agent-card.json',
        );
        const card = JSON.parse(res.body);
        expect(card.security).toEqual([{ mutual_tls: [] }]);
      } finally {
        await stop();
      }
    });

    it('does NOT advertise /macf/sign in skills (groundnuty/macf#371 Path 2 E2E)', async () => {
      // E2E-pin the #371 lockstep invariant: the live AgentCard JSON
      // body served on the wire MUST NOT contain any /macf/sign reference.
      // Unit-level test in test/agent-card.test.ts pins the builder;
      // this pins the HTTP-layer-served bytes.
      const { port, stop } = await startServer({ agentCard: baseAgentCard });
      try {
        const res = await httpsGet(
          certs.agentCert,
          certs.agentKey,
          port,
          '/.well-known/agent-card.json',
        );
        expect(res.body).not.toContain('/macf/sign');
        expect(res.body).not.toContain('/sign');
      } finally {
        await stop();
      }
    });
  });

  describe('GET /.well-known/agent-card.json — absent config', () => {
    it('returns 404 when agentCard is NOT configured', async () => {
      // Channel-servers built without an agentCard input (pre-#370 or
      // explicit opt-out) should return 404 on the discovery endpoint
      // — same as any unmatched URL. No crash, no leak.
      const { port, stop } = await startServer({ agentCard: undefined });
      try {
        const res = await httpsGet(
          certs.agentCert,
          certs.agentKey,
          port,
          '/.well-known/agent-card.json',
        );
        expect(res.status).toBe(404);
      } finally {
        await stop();
      }
    });
  });

  describe('GET /.well-known/agent-card.json — mTLS still gates', () => {
    it('rejects no-EKU cert with 403 (discovery endpoint not bypass-able)', async () => {
      // Mirror of health-eku.test.ts pattern: EKU gate fires at top of
      // handleRequest BEFORE dispatch. A regression that route-scoped
      // the gate would break this.
      const { port, stop } = await startServer({ agentCard: baseAgentCard });
      try {
        const res = await httpsGet(
          certs.noEkuCert,
          certs.noEkuKey,
          port,
          '/.well-known/agent-card.json',
        );
        expect(res.status).toBe(403);
      } finally {
        await stop();
      }
    });
  });

  describe('Existing endpoints still work (zero behavior change invariant)', () => {
    it('GET /health still works alongside the new endpoint', async () => {
      const { port, stop } = await startServer({
        agentCard: baseAgentCard,
        healthData: { status: 'ok' } as unknown as HealthResponse,
      });
      try {
        const res = await httpsGet(certs.agentCert, certs.agentKey, port, '/health');
        expect(res.status).toBe(200);
      } finally {
        await stop();
      }
    });

    it('unknown paths still 404 (no accidental match on prefix)', async () => {
      const { port, stop } = await startServer({ agentCard: baseAgentCard });
      try {
        const res = await httpsGet(
          certs.agentCert,
          certs.agentKey,
          port,
          '/.well-known/something-else',
        );
        expect(res.status).toBe(404);
      } finally {
        await stop();
      }
    });
  });
});
