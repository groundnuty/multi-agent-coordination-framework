import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('generateToken', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    delete process.env['GH_TOKEN'];
    delete process.env['APP_ID'];
    delete process.env['INSTALL_ID'];
    delete process.env['KEY_PATH'];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('precedence', () => {
    it('returns GH_TOKEN env var when set (wins over everything)', async () => {
      process.env['GH_TOKEN'] = 'env-token-123';
      const { generateToken } = await import('../src/token.js');
      const token = await generateToken();
      expect(token).toBe('env-token-123');
    });

    it('GH_TOKEN wins even when TokenSource is provided', async () => {
      process.env['GH_TOKEN'] = 'from-env';
      const { generateToken } = await import('../src/token.js');
      const token = await generateToken({
        appId: '123', installId: '456', keyPath: '/abs/key.pem',
      });
      expect(token).toBe('from-env');
    });
  });

  describe('no credentials available', () => {
    it('throws when no GH_TOKEN, no TokenSource, no env vars', async () => {
      const { generateToken } = await import('../src/token.js');
      await expect(generateToken()).rejects.toThrow(/No GH_TOKEN/);
    });

    it('error message mentions all three options', async () => {
      const { generateToken } = await import('../src/token.js');
      try {
        await generateToken();
        expect.fail('should have thrown');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        expect(msg).toContain('GH_TOKEN');
        expect(msg).toContain('TokenSource');
        expect(msg).toContain('APP_ID');
      }
    });

    it('throws when TokenSource is partial (missing one field — passed as undefined)', async () => {
      const { generateToken } = await import('../src/token.js');
      // @ts-expect-error — intentionally passing bad input to test runtime validation
      await expect(generateToken({ appId: '1', installId: '2' })).rejects.toThrow();
    });
  });

  describe('TokenSource', () => {
    it('explicit source is used over env vars', async () => {
      // Set env vars to make sure they don't win.
      process.env['APP_ID'] = 'env-app';
      process.env['INSTALL_ID'] = 'env-install';
      process.env['KEY_PATH'] = '/env/key.pem';

      // Mock execFile to observe what args get passed
      vi.doMock('node:child_process', () => ({
        execFile: (cmd: string, args: string[], _opts: unknown, cb: (err: unknown, result: { stdout: string; stderr: string }) => void) => {
          // Assert we were called with the explicit source, not env
          expect(args).toContain('explicit-app');
          expect(args).toContain('explicit-install');
          expect(args).toContain('/explicit/key.pem');
          cb(null, { stdout: JSON.stringify({ token: 'from-explicit' }), stderr: '' });
          return {};
        },
      }));

      const { generateToken } = await import('../src/token.js');
      const token = await generateToken({
        appId: 'explicit-app',
        installId: 'explicit-install',
        keyPath: '/explicit/key.pem',
      });
      expect(token).toBe('from-explicit');
    });

    it('env vars are used when no TokenSource is provided', async () => {
      process.env['APP_ID'] = 'env-app';
      process.env['INSTALL_ID'] = 'env-install';
      process.env['KEY_PATH'] = '/env/key.pem';

      vi.doMock('node:child_process', () => ({
        execFile: (cmd: string, args: string[], _opts: unknown, cb: (err: unknown, result: { stdout: string; stderr: string }) => void) => {
          expect(args).toContain('env-app');
          expect(args).toContain('env-install');
          expect(args).toContain('/env/key.pem');
          cb(null, { stdout: JSON.stringify({ token: 'from-env-vars' }), stderr: '' });
          return {};
        },
      }));

      const { generateToken } = await import('../src/token.js');
      const token = await generateToken();
      expect(token).toBe('from-env-vars');
    });
  });
});
