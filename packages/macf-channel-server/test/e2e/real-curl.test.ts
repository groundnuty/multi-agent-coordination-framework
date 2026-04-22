/**
 * Real-curl-against-real-agent smoke test (macf#182).
 *
 * Closes a cert-EKU blind spot in the regular E2E suite. `gen-certs.ts`
 * in `test/e2e/fixtures/` builds test certs via direct `openssl` calls
 * — those produce RFC-compliant EKU extensions by construction. The
 * production cert-generation path in `@groundnuty/macf-core` uses
 * `@peculiar/x509` + Node's WebCrypto, which historically emitted
 * malformed or missing EKU extensions that Node's TLS stack tolerates
 * but `curl` / `openssl s_client` reject (see macf#180 — missing
 * `serverAuth` EKU).
 *
 * Strategy here: generate certs via the PRODUCTION path
 * (`createCA` + `generateAgentCert`), spin up a real `createHttpsServer`
 * bound to `127.0.0.1:<random>`, then use `curl` (external OpenSSL-
 * backed binary) and `openssl x509` (external validator) to exercise:
 *
 *   1. `GET /health` over mTLS — asserts server-role TLS validation
 *      (serverAuth EKU on the presented agent cert) passes curl's
 *      strict cert-purpose check
 *   2. `POST /notify` with a valid payload over mTLS — same TLS check
 *      plus client-role TLS validation (clientAuth EKU on the client
 *      cert we present), plus application-layer cert parsing
 *   3. `openssl x509 -ext extendedKeyUsage` inspection on the agent
 *      cert — asserts both `TLS Web Server Authentication` and
 *      `TLS Web Client Authentication` are present in the EKU list
 *
 * Any future cert-generation regression that produces EKU bytes the
 * Node TLS stack accepts but OpenSSL rejects gets caught here —
 * well before it surfaces on an operator's real curl / routing-Action
 * handshake. See macf#182.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { createCA, generateAgentCert } from '@groundnuty/macf-core';
import type { HealthResponse, Logger } from '@groundnuty/macf-core';
import { createHttpsServer } from '../../src/https.js';

interface RealCerts {
  readonly dir: string;
  readonly caCert: string;
  readonly caKey: string;
  readonly agentCert: string;
  readonly agentKey: string;
}

/**
 * Build CA + agent cert via the production path
 * (`@groundnuty/macf-core`'s `createCA` + `generateAgentCert`), not
 * via `openssl req -x509`. This is the path whose output we're
 * validating against external tools — using `openssl` to build the
 * test fixture would defeat the purpose.
 */
async function generateProductionCerts(): Promise<RealCerts> {
  const dir = join(tmpdir(), `macf-real-curl-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });

  const caCert = join(dir, 'ca-cert.pem');
  const caKey = join(dir, 'ca-key.pem');
  const agentCert = join(dir, 'agent-cert.pem');
  const agentKey = join(dir, 'agent-key.pem');

  await createCA({
    project: 'macf-182-test',
    certPath: caCert,
    keyPath: caKey,
  });

  const caCertPem = readFileSync(caCert, 'utf-8');
  const caKeyPem = readFileSync(caKey, 'utf-8');

  await generateAgentCert({
    agentName: 'code-agent',
    caCertPem,
    caKeyPem,
    certPath: agentCert,
    keyPath: agentKey,
  });

  return { dir, caCert, caKey, agentCert, agentKey };
}

function cleanup(certs: RealCerts): void {
  rmSync(certs.dir, { recursive: true, force: true });
}

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

let certs: RealCerts;

/**
 * Preflight-determined flag: does `curl` in this environment actually
 * reach the loopback interface on a just-listening port? Some dev
 * containers / sandboxed devbox shells have namespace isolation that
 * breaks external-binary → loopback connections even though Node's
 * own TLS sockets work. In such envs the curl tests are environmental
 * false-negatives, not product bugs — skipped individually with a
 * clear reason rather than letting the whole suite go red.
 *
 * CI runners (GitHub Actions ubuntu-latest) don't have this issue;
 * the curl tests run + enforce there, which is where the #180-class
 * regression guard actually needs to bite.
 */
let curlReachable = true;

beforeAll(async () => {
  certs = await generateProductionCerts();

  const { createServer } = await import('node:http');
  const server = createServer((_, res) => { res.writeHead(200); res.end('ok'); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  const preflight = spawnSync('curl', ['-sS', '--max-time', '3', `http://127.0.0.1:${port}/`], {
    encoding: 'utf-8',
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));

  curlReachable = preflight.status === 0 && preflight.stdout === 'ok';
  if (!curlReachable) {
    // eslint-disable-next-line no-console
    console.warn(
      `[real-curl.test] curl can't reach 127.0.0.1 loopback in this env ` +
      `(preflight: status=${preflight.status}, stderr='${preflight.stderr?.trim()}'). ` +
      `Curl-based assertions skip; openssl-based EKU checks still run.`,
    );
  }
});

afterAll(() => {
  cleanup(certs);
});

describe('real curl against real agent (macf#182)', () => {
  it('curl GET /health succeeds with production-generated cert (serverAuth EKU)', async (ctx) => {
    if (!curlReachable) {
      ctx.skip();
      return;
    }
    const healthData: HealthResponse = {
      agent: 'code-agent',
      status: 'online',
      type: 'permanent',
      uptime_seconds: 42,
      current_issue: null,
      version: '0.2.0',
      last_notification: null,
    };

    const server = createHttpsServer({
      caCertPath: certs.caCert,
      agentCertPath: certs.agentCert,
      agentKeyPath: certs.agentKey,
      onNotify: vi.fn(),
      onHealth: () => healthData,
      logger: makeLogger(),
    });

    const { actualPort } = await server.start(0, '127.0.0.1');

    try {
      // --cacert: trust this CA. --cert/--key: present client cert.
      // -sS: silent but show errors. -w '%{http_code}': print status.
      // --max-time: defensive so a hang doesn't block the whole suite.
      const result = spawnSync('curl', [
        '-sS',
        '--cacert', certs.caCert,
        '--cert', certs.agentCert,
        '--key', certs.agentKey,
        '--max-time', '10',
        '-w', '\\n%{http_code}',
        `https://127.0.0.1:${actualPort}/health`,
      ], { encoding: 'utf-8' });

      // curl exit 0 means the TLS handshake cleared — this is the #180
      // regression guard. If the agent cert lacks serverAuth EKU, curl
      // exits 60 with "SSL certificate problem: unsuitable certificate
      // purpose" and this assertion fails.
      expect(result.status, `curl stderr: ${result.stderr}`).toBe(0);

      const lines = result.stdout.split('\n');
      const statusCode = lines[lines.length - 1];
      expect(statusCode).toBe('200');

      const body = lines.slice(0, -1).join('\n');
      const parsed = JSON.parse(body);
      expect(parsed.agent).toBe('code-agent');
      expect(parsed.status).toBe('online');
    } finally {
      await server.stop();
    }
  });

  it('curl POST /notify succeeds with production-generated cert (both EKUs)', async (ctx) => {
    if (!curlReachable) {
      ctx.skip();
      return;
    }
    const onNotify = vi.fn().mockResolvedValue(undefined);

    const server = createHttpsServer({
      caCertPath: certs.caCert,
      agentCertPath: certs.agentCert,
      agentKeyPath: certs.agentKey,
      onNotify,
      onHealth: () => ({} as HealthResponse),
      logger: makeLogger(),
    });

    const { actualPort } = await server.start(0, '127.0.0.1');

    try {
      const payloadPath = join(certs.dir, 'payload.json');
      writeFileSync(payloadPath, JSON.stringify({
        type: 'issue_routed',
        issue_number: 182,
        title: 'real-curl smoke test',
      }));

      const result = spawnSync('curl', [
        '-sS',
        '--cacert', certs.caCert,
        '--cert', certs.agentCert,
        '--key', certs.agentKey,
        '--max-time', '10',
        '-w', '\\n%{http_code}',
        '-X', 'POST',
        '-H', 'Content-Type: application/json',
        '--data-binary', `@${payloadPath}`,
        `https://127.0.0.1:${actualPort}/notify`,
      ], { encoding: 'utf-8' });

      expect(result.status, `curl stderr: ${result.stderr}`).toBe(0);

      const lines = result.stdout.split('\n');
      const statusCode = lines[lines.length - 1];
      expect(statusCode).toBe('200');

      expect(onNotify).toHaveBeenCalledWith({
        type: 'issue_routed',
        issue_number: 182,
        title: 'real-curl smoke test',
      });
    } finally {
      await server.stop();
    }
  });

  it('openssl x509 -ext extendedKeyUsage reports both serverAuth + clientAuth on the agent cert', () => {
    // Direct cert inspection via the external OpenSSL binary. Catches
    // EKU-encoding regressions that a curl round-trip wouldn't surface
    // (e.g., both OIDs present but byte-order malformed, or a non-
    // critical flag set where OpenSSL tolerates it but some stricter
    // validator wouldn't).
    const result = spawnSync('openssl', [
      'x509', '-in', certs.agentCert,
      '-noout', '-ext', 'extendedKeyUsage',
    ], { encoding: 'utf-8' });

    expect(result.status, `openssl stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/TLS Web Server Authentication/);
    expect(result.stdout).toMatch(/TLS Web Client Authentication/);
  });

  it('openssl verify confirms the agent cert chains to the CA', () => {
    // Sanity check the CA-to-agent signing chain via OpenSSL's own
    // verifier, independent of whatever our x509 library emits. If a
    // future refactor of createCA / buildPeerCert produces a cert
    // with an invalid signature, misaligned issuer names, or bad
    // serial numbers, this catches it before any curl call would.
    const result = spawnSync('openssl', [
      'verify', '-CAfile', certs.caCert, certs.agentCert,
    ], { encoding: 'utf-8' });

    expect(result.status, `openssl stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/OK\s*$/);
  });
});
