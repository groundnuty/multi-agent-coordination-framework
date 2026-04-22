/**
 * Tests for src/otel.ts — macf#196 bootstrapOtel fix.
 *
 * Covers the 3 AC states from #196:
 *   1. env unset → silent no-op, no module-resolution cost, no error
 *      even if @opentelemetry/sdk-* packages aren't installed
 *   2. env set + packages available → bootstrap succeeds (provider
 *      registered, global tracer now records)
 *   3. env set + packages missing → process.exit(1) with actionable
 *      stderr message
 *
 * Strategy: state 1 is a direct invocation; state 2 relies on the
 * SDK packages being in node_modules (they are, via package.json);
 * state 3 stubs `await import(...)` via a vi.mock of
 * `@opentelemetry/sdk-trace-node` to throw, then asserts the
 * process.stderr + process.exit behavior.
 *
 * We don't test the actual span emission or OTLP wire format here —
 * those are integration concerns (`test/e2e/` scope, follow-up PR).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { bootstrapOtel } from '../src/otel.js';

describe('bootstrapOtel', () => {
  let originalEnv: string | undefined;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalEnv = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // process.exit returns never — the type assertion swallows the
    // unreachability annotation so the spy can return undefined.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number): never => {
      throw new Error(`process.exit(${_code}) called in test`);
    }) as () => never);
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
    else process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = originalEnv;
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
    vi.resetModules();
  });

  describe('AC1: env unset → silent no-op', () => {
    it('returns undefined without writing to stderr when env is unset', async () => {
      delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
      await expect(bootstrapOtel()).resolves.toBeUndefined();
      expect(stderrSpy).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('treats empty-string env as unset (no-op)', async () => {
      process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = '';
      await expect(bootstrapOtel()).resolves.toBeUndefined();
      expect(stderrSpy).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });

  describe('AC2: env set + packages available → bootstrap succeeds', () => {
    it('resolves without throwing when env is set + SDK packages are importable', async () => {
      // Packages are in devDeps via package.json, so the dynamic
      // imports resolve. This asserts the happy path doesn't throw;
      // span-emission verification is integration-level.
      process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'http://localhost:4318';
      await expect(bootstrapOtel()).resolves.toBeUndefined();
      expect(stderrSpy).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });

  describe('AC3: env set + packages missing → fail-loud exit(1)', () => {
    it('calls process.exit(1) + writes actionable stderr when an SDK import fails', async () => {
      // We can't uninstall the SDK packages for one test case, so we
      // simulate the missing-module condition via vi.doMock making
      // one of the imports throw. The import is a dynamic `await
      // import('@opentelemetry/sdk-trace-node')` → vitest's mock
      // system hooks it. `vi.resetModules` in afterEach undoes for
      // other tests.
      vi.doMock('@opentelemetry/sdk-trace-node', () => {
        throw new Error(`Cannot find package '@opentelemetry/sdk-trace-node'`);
      });
      // Re-import the module fresh so the doMock takes effect for
      // its dynamic imports.
      vi.resetModules();
      const { bootstrapOtel: freshBootstrap } =
        await import('../src/otel.js');

      process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'http://localhost:4318';

      await expect(freshBootstrap()).rejects.toThrow(
        /process\.exit\(1\) called in test/,
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
      // Stderr received the actionable error + recovery hint.
      expect(stderrSpy).toHaveBeenCalled();
      const stderrOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(stderrOutput).toContain('FATAL');
      expect(stderrOutput).toContain('OTEL_EXPORTER_OTLP_ENDPOINT');
      expect(stderrOutput).toContain('@opentelemetry/*');
      // Recovery hint mentions both fix paths (install OR unset).
      expect(stderrOutput).toContain('install');
      expect(stderrOutput).toContain('unset');

      vi.doUnmock('@opentelemetry/sdk-trace-node');
    });
  });
});
