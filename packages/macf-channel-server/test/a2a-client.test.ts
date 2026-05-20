/**
 * Unit tests for A2A v1.0 outbound client (`A2aClient`).
 *
 * groundnuty/macf#396 — A2A Phase 3.
 *
 * Coverage:
 * - AgentCard cache TTL + invalidation
 * - sendMessage success / error envelope dispatch
 * - HTTP/transport error mapping to A2aClientError codes
 * - mTLS cert plumbing (verified via cert-loading not erroring)
 *
 * End-to-end tests (real HTTPS server + Python SDK round-trip) live in
 * `test/integration/a2a-python-sdk-server.test.ts`. This file keeps to
 * unit-level scope — uses the live `node:https` request but talks to a
 * test-local HTTPS server fixture.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createServer, type Server as NodeHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { A2aClient, A2aClientError, AGENT_CARD_CACHE_TTL_MS } from '../src/a2a-client.js';
import type { Message } from '../src/a2a-types.js';
import { generateTestCerts, cleanupTestCerts, type TestCerts } from './e2e/fixtures/gen-certs.js';

let certs: TestCerts;
let server: NodeHttpsServer | undefined;
let port: number;

interface ServerScript {
  readonly path: string;
  readonly status: number;
  readonly body: string;
  readonly headers?: Record<string, string>;
}

let scripts: ServerScript[] = [];

function makeClient(opts: { readonly agentCardCacheTtlMs?: number } = {}) {
  return new A2aClient({
    mTlsClientCertPem: readFileSync(certs.agentCert, 'utf-8'),
    mTlsClientKeyPem: readFileSync(certs.agentKey, 'utf-8'),
    caCertPem: readFileSync(certs.caCert, 'utf-8'),
    ...(opts.agentCardCacheTtlMs !== undefined
      ? { agentCardCacheTtlMs: opts.agentCardCacheTtlMs }
      : {}),
  });
}

function baseUrl(): string {
  return `https://127.0.0.1:${port}`;
}

function startServer(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer(
      {
        cert: readFileSync(certs.agentCert),
        key: readFileSync(certs.agentKey),
        ca: readFileSync(certs.caCert),
        requestCert: true,
        rejectUnauthorized: true,
      },
      (req, res) => {
        const script = scripts.shift();
        if (script === undefined) {
          res.writeHead(500);
          res.end('test server has no more scripted responses');
          return;
        }
        res.writeHead(script.status, {
          'Content-Type': 'application/json',
          ...(script.headers ?? {}),
        });
        res.end(script.body);
      },
    );
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const actualPort = typeof addr === 'object' && addr !== null ? addr.port : 0;
      server = srv;
      resolve(actualPort);
    });
    srv.on('error', reject);
  });
}

function stopServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (server === undefined) return resolve();
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

beforeAll(async () => {
  certs = generateTestCerts();
  port = await startServer();
});

afterAll(async () => {
  await stopServer();
  cleanupTestCerts(certs);
});

beforeEach(() => {
  scripts = [];
});

const SAMPLE_MESSAGE: Message = {
  messageId: 'msg-1',
  role: 'ROLE_USER',
  parts: [{ text: 'hello' }],
};

const SAMPLE_TASK = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  status: { state: 'TASK_STATE_COMPLETED' as const, timestamp: '2026-05-20T00:00:00Z' },
  history: [SAMPLE_MESSAGE],
};

const SAMPLE_AGENT_CARD = {
  name: 'test-agent',
  description: 'Test agent for a2a-client unit tests',
  supportedInterfaces: [
    { url: 'https://127.0.0.1:0/a2a/v1', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
  ],
  version: '0.2.30',
  provider: { organization: 'test' },
  capabilities: {},
  defaultInputModes: ['application/json'],
  defaultOutputModes: ['application/json'],
  skills: [
    { id: 'echo', name: 'echo', description: 'echo skill', tags: ['test'] },
  ],
};

describe('A2aClient.sendMessage', () => {
  it('returns Task on JSON-RPC success envelope', async () => {
    scripts.push({
      path: '/a2a/v1',
      status: 200,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'req-1',
        result: SAMPLE_TASK,
      }),
    });
    const client = makeClient();
    try {
      const task = await client.sendMessage(baseUrl(), SAMPLE_MESSAGE, { requestId: 'req-1' });
      expect(task.id).toBe(SAMPLE_TASK.id);
      expect(task.status.state).toBe('TASK_STATE_COMPLETED');
    } finally {
      client.close();
    }
  });

  it('throws A2aClientError(JSONRPC_ERROR) on JSON-RPC error envelope', async () => {
    scripts.push({
      path: '/a2a/v1',
      status: 200,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'req-1',
        error: {
          code: -32602,
          message: 'Invalid params',
          data: { reason: 'INVALID_MESSAGE', domain: 'a2a-protocol.org' },
        },
      }),
    });
    const client = makeClient();
    try {
      await expect(
        client.sendMessage(baseUrl(), SAMPLE_MESSAGE, { requestId: 'req-1' }),
      ).rejects.toMatchObject({ code: 'JSONRPC_ERROR' });
    } finally {
      client.close();
    }
  });

  it('throws A2aClientError(HTTP_ERROR) on non-200 status', async () => {
    scripts.push({
      path: '/a2a/v1',
      status: 500,
      body: 'Internal Server Error',
    });
    const client = makeClient();
    try {
      await expect(
        client.sendMessage(baseUrl(), SAMPLE_MESSAGE, { requestId: 'req-1' }),
      ).rejects.toMatchObject({ code: 'HTTP_ERROR' });
    } finally {
      client.close();
    }
  });

  it('throws A2aClientError(INVALID_RESPONSE) on unparseable JSON-RPC envelope', async () => {
    scripts.push({
      path: '/a2a/v1',
      status: 200,
      body: JSON.stringify({ jsonrpc: '2.0', id: 'req-1' }), // neither result nor error
    });
    const client = makeClient();
    try {
      await expect(
        client.sendMessage(baseUrl(), SAMPLE_MESSAGE, { requestId: 'req-1' }),
      ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    } finally {
      client.close();
    }
  });

  it('throws A2aClientError(TRANSPORT_ERROR) on unreachable target', async () => {
    const client = makeClient();
    try {
      await expect(
        // Port 1 should refuse connection.
        client.sendMessage('https://127.0.0.1:1', SAMPLE_MESSAGE),
      ).rejects.toMatchObject({ code: 'TRANSPORT_ERROR' });
    } finally {
      client.close();
    }
  });
});

describe('A2aClient.getAgentCard', () => {
  it('returns AgentCard on 200 with valid schema', async () => {
    scripts.push({
      path: '/.well-known/agent-card.json',
      status: 200,
      body: JSON.stringify(SAMPLE_AGENT_CARD),
    });
    const client = makeClient();
    try {
      const card = await client.getAgentCard(baseUrl());
      expect(card).not.toBeNull();
      expect(card!.name).toBe('test-agent');
      expect(card!.supportedInterfaces[0]?.protocolBinding).toBe('JSONRPC');
    } finally {
      client.close();
    }
  });

  it('returns null on 404 (target does not publish AgentCard)', async () => {
    scripts.push({
      path: '/.well-known/agent-card.json',
      status: 404,
      body: '{"error":"not found"}',
    });
    const client = makeClient();
    try {
      const card = await client.getAgentCard(baseUrl());
      expect(card).toBeNull();
    } finally {
      client.close();
    }
  });

  it('returns null on 401 (signals auth refresh need)', async () => {
    scripts.push({
      path: '/.well-known/agent-card.json',
      status: 401,
      body: '{"error":"unauthorized"}',
    });
    const client = makeClient();
    try {
      const card = await client.getAgentCard(baseUrl());
      expect(card).toBeNull();
    } finally {
      client.close();
    }
  });

  it('throws A2aClientError(INVALID_AGENT_CARD) when body fails schema', async () => {
    scripts.push({
      path: '/.well-known/agent-card.json',
      status: 200,
      body: JSON.stringify({ name: 'incomplete' }), // missing required fields
    });
    const client = makeClient();
    try {
      await expect(client.getAgentCard(baseUrl())).rejects.toMatchObject({
        code: 'INVALID_AGENT_CARD',
      });
    } finally {
      client.close();
    }
  });

  it('throws A2aClientError(INVALID_AGENT_CARD) on non-JSON body', async () => {
    scripts.push({
      path: '/.well-known/agent-card.json',
      status: 200,
      body: 'not-json',
    });
    const client = makeClient();
    try {
      await expect(client.getAgentCard(baseUrl())).rejects.toMatchObject({
        code: 'INVALID_AGENT_CARD',
      });
    } finally {
      client.close();
    }
  });

  it('caches the AgentCard for subsequent calls within TTL', async () => {
    scripts.push({
      path: '/.well-known/agent-card.json',
      status: 200,
      body: JSON.stringify(SAMPLE_AGENT_CARD),
    });
    const client = makeClient();
    try {
      const card1 = await client.getAgentCard(baseUrl());
      expect(card1).not.toBeNull();
      expect(client.agentCardCacheSize()).toBe(1);
      // Second call should hit cache (no scripted response remaining;
      // server would return 500 if a real request were made).
      const card2 = await client.getAgentCard(baseUrl());
      expect(card2).toEqual(card1);
    } finally {
      client.close();
    }
  });

  it('honors invalidateAgentCard() — next call re-fetches', async () => {
    scripts.push({
      path: '/.well-known/agent-card.json',
      status: 200,
      body: JSON.stringify(SAMPLE_AGENT_CARD),
    });
    scripts.push({
      path: '/.well-known/agent-card.json',
      status: 200,
      body: JSON.stringify({ ...SAMPLE_AGENT_CARD, version: '0.2.31' }),
    });
    const client = makeClient();
    try {
      const card1 = await client.getAgentCard(baseUrl());
      expect(card1!.version).toBe('0.2.30');
      client.invalidateAgentCard(baseUrl());
      expect(client.agentCardCacheSize()).toBe(0);
      const card2 = await client.getAgentCard(baseUrl());
      expect(card2!.version).toBe('0.2.31');
    } finally {
      client.close();
    }
  });

  it('respects custom TTL', async () => {
    vi.useFakeTimers();
    try {
      scripts.push({
        path: '/.well-known/agent-card.json',
        status: 200,
        body: JSON.stringify(SAMPLE_AGENT_CARD),
      });
      scripts.push({
        path: '/.well-known/agent-card.json',
        status: 200,
        body: JSON.stringify({ ...SAMPLE_AGENT_CARD, version: '0.2.31' }),
      });
      const client = makeClient({ agentCardCacheTtlMs: 100 });
      try {
        const card1 = await client.getAgentCard(baseUrl());
        expect(card1!.version).toBe('0.2.30');
        // Advance past TTL.
        vi.setSystemTime(new Date(Date.now() + 200));
        const card2 = await client.getAgentCard(baseUrl());
        expect(card2!.version).toBe('0.2.31');
      } finally {
        client.close();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT cache null results (404/401/403)', async () => {
    scripts.push({
      path: '/.well-known/agent-card.json',
      status: 404,
      body: '{"error":"not found"}',
    });
    scripts.push({
      path: '/.well-known/agent-card.json',
      status: 200,
      body: JSON.stringify(SAMPLE_AGENT_CARD),
    });
    const client = makeClient();
    try {
      const card1 = await client.getAgentCard(baseUrl());
      expect(card1).toBeNull();
      expect(client.agentCardCacheSize()).toBe(0);
      const card2 = await client.getAgentCard(baseUrl());
      expect(card2).not.toBeNull();
    } finally {
      client.close();
    }
  });
});

describe('A2aClient.close', () => {
  it('clears the AgentCard cache', async () => {
    scripts.push({
      path: '/.well-known/agent-card.json',
      status: 200,
      body: JSON.stringify(SAMPLE_AGENT_CARD),
    });
    const client = makeClient();
    await client.getAgentCard(baseUrl());
    expect(client.agentCardCacheSize()).toBe(1);
    client.close();
    expect(client.agentCardCacheSize()).toBe(0);
  });
});

describe('Constants (sanity)', () => {
  it('AGENT_CARD_CACHE_TTL_MS is 5 minutes', () => {
    expect(AGENT_CARD_CACHE_TTL_MS).toBe(5 * 60 * 1000);
  });

  it('A2aClientError exposes code field', () => {
    const err = new A2aClientError('TEST_CODE', 'test message');
    expect(err.code).toBe('TEST_CODE');
    expect(err.name).toBe('A2aClientError');
  });
});
