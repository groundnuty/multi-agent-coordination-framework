/**
 * Integration test: official Python A2A SDK fetches + parses MACF's
 * `/.well-known/agent-card.json` discovery endpoint.
 *
 * groundnuty/macf#376 — closes the deferred Phase 1 acceptance
 * criterion from #370 ("Python A2A SDK reference client successfully
 * fetches and parses the AgentCard").
 *
 * **Pinned versions** (also stamped in commit message + fixtures/python-venv.ts):
 *   - a2a-sdk     == 1.0.3 (PyPI package name `a2a-sdk`; A2A v1.0)
 *   - A2A spec    == 1.0 (verified 2026-05-18 via a2a-protocol.org)
 *
 * **Why cross-implementation matters**: the TS unit suite + E2E suite
 * prove "our JSON matches our Zod schema." But "our schema correctly
 * encodes the spec" is an untested transitive step. A real A2A SDK
 * parser closes that gap — if the SDK's pydantic models reject our
 * card, our schema has drifted from the canonical spec model.
 *
 * **Architecture**:
 *   - TS test spins up `createHttpsServer` with a real AgentCard config
 *   - Python subprocess (devbox-pinned python3 + a2a-sdk venv) fetches
 *     the card via `A2ACardResolver` + parses with the SDK's pydantic
 *     AgentCard model
 *   - Subprocess dumps the parsed card as JSON to stdout
 *   - TS test compares parsed-card-from-Python against MACF-emitted-card
 *     for round-trip identity on the spec-required fields
 *
 * **Test-target gating**: this file lives under `test/integration/`
 * which the default vitest run excludes (see vitest.config.ts). It runs
 * via `npm run test:integration` (and is excluded from `make check`
 * because pip-install of the SDK adds first-run latency + a hard
 * dependency on devbox-python that the default check doesn't need).
 * The CI E2E workflow can opt-in.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createHttpsServer } from '../../src/https.js';
import { buildAgentCard } from '../../src/agent-card.js';
import type { HealthResponse, Logger } from '@groundnuty/macf-core';
import { generateTestCerts, cleanupTestCerts, type TestCerts } from '../e2e/fixtures/gen-certs.js';
import { ensureA2aVenv, A2A_SDK_VERSION, A2A_SPEC_VERSION } from './fixtures/python-venv.js';

const PROBE_SCRIPT = new URL('./fixtures/a2a_client_probe.py', import.meta.url).pathname;

let certs: TestCerts;
let pythonPath: string;

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const baseAgentCard = buildAgentCard({
  agentName: 'code-agent',
  agentRole: 'code-agent',
  project: 'macf',
  // Real port stamped in `beforeEach`-ish flow below — buildAgentCard
  // rejects placeholder schemes, so we use a syntactically-valid URL
  // here and verify the SDK-parsed shape against this baseline.
  url: 'https://127.0.0.1:8443',
  version: '0.2.26',
});

async function startServer(opts: {
  readonly agentCard?: unknown;
  readonly healthData?: HealthResponse;
} = {}): Promise<{ readonly port: number; readonly stop: () => Promise<void> }> {
  const server = createHttpsServer({
    caCertPath: certs.caCert,
    agentCertPath: certs.agentCert,
    agentKeyPath: certs.agentKey,
    onNotify: vi.fn().mockResolvedValue(undefined),
    onHealth: () => opts.healthData ?? ({} as HealthResponse),
    agentCard: opts.agentCard,
    logger: makeLogger(),
  });
  const { actualPort } = await server.start(0, '127.0.0.1');
  return { port: actualPort, stop: () => server.stop() };
}

interface ProbeResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Spawn the Python probe asynchronously. MUST be async (not `spawnSync`):
 * the MACF channel-server runs in the same Node process as the test,
 * and `spawnSync` blocks Node's event loop — so the server can't accept
 * the inbound TLS handshake while the subprocess waits to connect. The
 * Python `httpx` request times out with `ConnectTimeout('')` because
 * the server's `accept` callback never fires. Using `spawn` + Promise
 * lets the event loop run during the subprocess's connect attempt.
 */
function runProbe(args: {
  readonly baseUrl: string;
  readonly expect404?: boolean;
}): Promise<ProbeResult> {
  const argv = [
    PROBE_SCRIPT,
    '--base-url', args.baseUrl,
    '--ca-cert', certs.caCert,
    '--client-cert', certs.agentCert,
    '--client-key', certs.agentKey,
  ];
  if (args.expect404) {
    argv.push('--expect-404');
  }
  return new Promise((resolve, reject) => {
    const child = spawn(pythonPath, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => stdoutChunks.push(c));
    child.stderr.on('data', (c: Buffer) => stderrChunks.push(c));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Python probe timed out after 30s'));
    }, 30_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
      });
    });
  });
}

beforeAll(() => {
  certs = generateTestCerts();
  const venv = ensureA2aVenv();
  pythonPath = venv.pythonPath;
  // Sanity-check the python interpreter actually exists (idempotent
  // ensureA2aVenv should have populated it, but fail loud if not).
  if (!existsSync(pythonPath)) {
    throw new Error(`Python venv missing at ${pythonPath}`);
  }
  if (venv.sdkVersion !== A2A_SDK_VERSION) {
    throw new Error(
      `SDK version mismatch: helper returned ${venv.sdkVersion}, ` +
        `test expects ${A2A_SDK_VERSION}`,
    );
  }
});

afterAll(() => {
  cleanupTestCerts(certs);
});

describe('A2A Python SDK integration (macf#376 — closes #370 deferred AC)', () => {
  it(`pins a2a-sdk == ${A2A_SDK_VERSION} (A2A spec ${A2A_SPEC_VERSION})`, () => {
    // Tripwire test. If anyone bumps the pin in python-venv.ts without
    // updating this file's header comment + commit-msg note, this fires.
    expect(A2A_SDK_VERSION).toBe('1.0.3');
    expect(A2A_SPEC_VERSION).toBe('1.0');
  });

  describe('Happy path: Python SDK parses MACF AgentCard', () => {
    it('successfully fetches + parses the discovery endpoint', async () => {
      const { port, stop } = await startServer({ agentCard: baseAgentCard });
      try {
        const result = await runProbe({ baseUrl: `https://127.0.0.1:${port}` });
        // Diagnose on failure: stderr carries the structured error JSON
        // + traceback (see a2a_client_probe.py). The assertion message
        // includes it so test failures are self-explanatory.
        expect(result.exitCode, `probe stderr: ${result.stderr}`).toBe(0);
        const parsed = JSON.parse(result.stdout);
        // The Python SDK normalizes our JSON into its protobuf
        // representation — flat top-level `url` migrates into
        // `supportedInterfaces[]` per A2A v1.0 § 4.4.6 (the proto's
        // transport-vs-card-url split). The fields below survive
        // the round-trip unchanged.
        expect(parsed.name).toBe('code-agent');
        expect(parsed.version).toBe('0.2.26');
        expect(parsed.description).toContain('MACF agent');
      } finally {
        await stop();
      }
    });

    it('round-trip integrity: spec-stable fields match what MACF emitted', async () => {
      const { port, stop } = await startServer({ agentCard: baseAgentCard });
      try {
        const result = await runProbe({ baseUrl: `https://127.0.0.1:${port}` });
        expect(result.exitCode, `probe stderr: ${result.stderr}`).toBe(0);
        const parsed = JSON.parse(result.stdout);
        // Cross-implementation invariants: fields that the SDK's proto
        // schema models the same way our Zod schema does. `name` +
        // `version` are spec-required (§ 4.4.1) and have no proto-side
        // remapping; `provider.organization` likewise. The flat `url`
        // gets normalized into `supportedInterfaces[]` (asserted below)
        // so we don't compare it directly here.
        expect(parsed.name).toBe(baseAgentCard.name);
        expect(parsed.version).toBe(baseAgentCard.version);
        expect(parsed.provider.organization).toBe(
          baseAgentCard.provider.organization,
        );
      } finally {
        await stop();
      }
    });

    it('SDK preserves our URL through proto normalization (supportedInterfaces[])', async () => {
      // The proto model splits AgentCard.url (our flat top-level
      // attribute) into a `supportedInterfaces` array of transport
      // descriptors. A successful round-trip means our `url` MUST
      // appear somewhere on the SDK-parsed side — even if at a
      // different JSON path. Asserting this pins the proto-shape
      // assumption: if the SDK changes how it represents the URL
      // in a future version, this fails loud and we can re-encode.
      const { port, stop } = await startServer({ agentCard: baseAgentCard });
      try {
        const result = await runProbe({ baseUrl: `https://127.0.0.1:${port}` });
        expect(result.exitCode, `probe stderr: ${result.stderr}`).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(JSON.stringify(parsed)).toContain(baseAgentCard.url);
      } finally {
        await stop();
      }
    });

    it('Phase 1 invariant: /macf/sign NOT advertised in SDK-parsed skills', async () => {
      // The TS-side E2E test pins the wire body. This test pins the
      // SDK-parsed model. Together they prove the invariant survives
      // both the JSON-encoding step (TS-side) and the pydantic-parsing
      // step (Python-side) — neither layer accidentally synthesizes
      // a /macf/sign skill on round-trip.
      const { port, stop } = await startServer({ agentCard: baseAgentCard });
      try {
        const result = await runProbe({ baseUrl: `https://127.0.0.1:${port}` });
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        const skills: ReadonlyArray<{ readonly id?: string; readonly name?: string }> =
          parsed.skills ?? [];
        for (const skill of skills) {
          expect(skill.id ?? '').not.toContain('sign');
          expect(skill.name ?? '').not.toContain('sign');
        }
        expect(JSON.stringify(parsed)).not.toContain('/macf/sign');
      } finally {
        await stop();
      }
    });
  });

  describe('Error path: absent AgentCard config → SDK handles 404 cleanly', () => {
    it('Python SDK surfaces AgentCardResolutionError for 404', async () => {
      // Channel-servers without an agentCard input return 404 on the
      // discovery endpoint (proven by E2E test). The Python SDK should
      // raise AgentCardResolutionError with status_code=404 — NOT a
      // silent fallback to a default-shaped card.
      const { port, stop } = await startServer({ agentCard: undefined });
      try {
        const result = await runProbe({
          baseUrl: `https://127.0.0.1:${port}`,
          expect404: true,
        });
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.status).toBe('404-as-expected');
        expect(parsed.status_code).toBe(404);
        expect(parsed.error_class).toBe('AgentCardResolutionError');
      } finally {
        await stop();
      }
    });
  });
});
