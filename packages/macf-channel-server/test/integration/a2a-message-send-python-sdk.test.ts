/**
 * Integration test: official Python A2A SDK sends + parses MACF's
 * `/a2a/v1` JSON-RPC message/send + tasks/get + tasks/cancel responses.
 *
 * groundnuty/macf#398 — A2A Phase 2d. Extends `#385`'s harness (which
 * scoped to AgentCard discovery) with the inbound message-send surface
 * + the new tasks/get + tasks/cancel methods.
 *
 * **Pinned versions** (shared via fixtures/python-venv.ts):
 *   - a2a-sdk     == 1.0.3 (PyPI `a2a-sdk`; A2A v1.0)
 *   - A2A spec    == 1.0  (verified 2026-05-19 via a2a-protocol.org)
 *
 * **Why cross-implementation matters**: TS-side unit + E2E suites prove
 * "our JSON matches our Zod schema." A real A2A SDK parser confirms
 * "our wire body parses through the canonical protobuf model." Both
 * are needed — neither alone closes the silent-fallback hazard that
 * internal-schema-only validation creates.
 *
 * **Architecture**:
 *   - TS test spins up `createHttpsServer` with a real TaskStore wired
 *   - Python subprocess (devbox-pinned python3 + a2a-sdk venv) POSTs to
 *     `/a2a/v1` and parses the response through `a2a_pb2.Task` proto
 *   - Subprocess dumps the task summary as JSON to stdout
 *   - TS test compares parsed result against TaskStore mutation
 *
 * **Gating**: lives under `test/integration/` — default vitest run
 * excludes; opt-in via `npm run test:integration`. CI E2E workflow can
 * opt-in. See `e2e.yml` (#386 followup) for the CI hook.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createHttpsServer } from '../../src/https.js';
import { TaskStore } from '../../src/a2a-task.js';
import type { HealthResponse, Logger } from '@groundnuty/macf-core';
import { generateTestCerts, cleanupTestCerts, type TestCerts } from '../e2e/fixtures/gen-certs.js';
import { ensureA2aVenv, A2A_SDK_VERSION } from './fixtures/python-venv.js';

const PROBE_SCRIPT = new URL('./fixtures/a2a_message_send_probe.py', import.meta.url).pathname;

let certs: TestCerts;
let pythonPath: string;

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

async function startServer(opts: { readonly taskStore: TaskStore }): Promise<{
  readonly port: number;
  readonly stop: () => Promise<void>;
}> {
  const server = createHttpsServer({
    caCertPath: certs.caCert,
    agentCertPath: certs.agentCert,
    agentKeyPath: certs.agentKey,
    onNotify: vi.fn().mockResolvedValue(undefined),
    onHealth: () => ({}) as HealthResponse,
    taskStore: opts.taskStore,
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
 * Spawn the Python probe. MUST be async (not spawnSync): the channel-
 * server runs in the same Node process as the test, and spawnSync
 * blocks Node's event loop — so the server can't accept the inbound
 * TLS handshake while the subprocess waits to connect. Mirrors
 * `a2a-python-sdk.test.ts`'s pattern.
 */
function runProbe(args: {
  readonly baseUrl: string;
  readonly mode: 'message_send' | 'tasks_get' | 'tasks_cancel';
  readonly taskId?: string;
}): Promise<ProbeResult> {
  const argv = [
    PROBE_SCRIPT,
    '--base-url', args.baseUrl,
    '--ca-cert', certs.caCert,
    '--client-cert', certs.agentCert,
    '--client-key', certs.agentKey,
    '--mode', args.mode,
  ];
  if (args.taskId !== undefined) {
    argv.push('--task-id', args.taskId);
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

describe('A2A Python SDK message/send round-trip (macf#398 Phase 2d)', () => {
  describe('mode=message_send — happy path', () => {
    it('Python client → MACF server: fresh task → COMPLETED, SDK parses Task', async () => {
      const store = new TaskStore();
      const { port, stop } = await startServer({ taskStore: store });
      try {
        const result = await runProbe({
          baseUrl: `https://127.0.0.1:${port}`,
          mode: 'message_send',
        });
        expect(result.exitCode, `probe stderr: ${result.stderr}`).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.mode).toBe('message_send');
        expect(parsed.state).toBe('TASK_STATE_COMPLETED');
        expect(parsed.sdk_parsed_ok).toBe(true);
        // history contains the user message + agent reply.
        expect(parsed.history_len).toBeGreaterThanOrEqual(2);
        // A2A v1.0 spec § 3.6 invariant.
        expect(parsed.a2a_version_header).toBe('1.0');
        // Server-side state mutation matches what the SDK saw.
        expect(store.size()).toBe(1);
        expect(store.get(parsed.task_id)?.status.state).toBe('TASK_STATE_COMPLETED');
      } finally {
        await stop();
      }
    });
  });

  describe('mode=tasks_get — Phase 2d new method', () => {
    it('Python client fetches a previously-created task via tasks/get', async () => {
      const store = new TaskStore();
      const { port, stop } = await startServer({ taskStore: store });
      try {
        // Phase 1: create a task via message_send
        const sendResult = await runProbe({
          baseUrl: `https://127.0.0.1:${port}`,
          mode: 'message_send',
        });
        const sendParsed = JSON.parse(sendResult.stdout);
        const taskId = sendParsed.task_id;
        // Phase 2: fetch it via tasks_get
        const getResult = await runProbe({
          baseUrl: `https://127.0.0.1:${port}`,
          mode: 'tasks_get',
          taskId,
        });
        expect(getResult.exitCode, `probe stderr: ${getResult.stderr}`).toBe(0);
        const getParsed = JSON.parse(getResult.stdout);
        expect(getParsed.mode).toBe('tasks_get');
        expect(getParsed.task_id).toBe(taskId);
        expect(getParsed.state).toBe('TASK_STATE_COMPLETED');
        expect(getParsed.sdk_parsed_ok).toBe(true);
      } finally {
        await stop();
      }
    });
  });

  describe('mode=tasks_cancel — Phase 2d new method', () => {
    it('Python client cancels a non-terminal task', async () => {
      // Pre-populate a SUBMITTED task that the Python client will cancel
      // (the route-driven message_send drives to COMPLETED, which is
      // terminal + uncancelable — so we use a pre-populated task here).
      const store = new TaskStore();
      const created = store.create(
        { messageId: 'pre', role: 'ROLE_USER', parts: [{ text: 'pre' }] },
        { nowIso: new Date().toISOString() },
      );
      const { port, stop } = await startServer({ taskStore: store });
      try {
        const result = await runProbe({
          baseUrl: `https://127.0.0.1:${port}`,
          mode: 'tasks_cancel',
          taskId: created.id,
        });
        expect(result.exitCode, `probe stderr: ${result.stderr}`).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.task_id).toBe(created.id);
        expect(parsed.state).toBe('TASK_STATE_CANCELED');
        expect(parsed.sdk_parsed_ok).toBe(true);
        // Server-side mutation matches.
        expect(store.isTerminal(created.id)).toBe(true);
      } finally {
        await stop();
      }
    });

    it('Python client receives TASK_TERMINAL_STATE error envelope when canceling COMPLETED task', async () => {
      const store = new TaskStore();
      const { port, stop } = await startServer({ taskStore: store });
      try {
        // Drive a task to COMPLETED first.
        const sendResult = await runProbe({
          baseUrl: `https://127.0.0.1:${port}`,
          mode: 'message_send',
        });
        const taskId = JSON.parse(sendResult.stdout).task_id;
        // Now try to cancel it.
        const cancelResult = await runProbe({
          baseUrl: `https://127.0.0.1:${port}`,
          mode: 'tasks_cancel',
          taskId,
        });
        expect(cancelResult.exitCode, `probe stderr: ${cancelResult.stderr}`).toBe(0);
        const parsed = JSON.parse(cancelResult.stdout);
        // The probe returns an error envelope summary on cancel failure.
        expect(parsed.mode).toBe('tasks_cancel');
        expect(parsed.error_code).toBe(-32602);
        expect(parsed.error_reason).toBe('TASK_TERMINAL_STATE');
      } finally {
        await stop();
      }
    });
  });
});
