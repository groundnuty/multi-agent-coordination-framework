import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';

/**
 * Mock node:https.request — capture call args + control the response /
 * error path per test. Returned via vi.mock factory below; tests inspect
 * `requestMock` directly.
 *
 * The mock returns an EventEmitter for the request, a similar emitter
 * for the response, and accepts `.write()` / `.end()` no-op calls.
 * Tests trigger response or error by emitting on the captured emitters.
 */
const requestMock = vi.fn();
vi.mock('node:https', () => ({
  request: (...args: unknown[]) => requestMock(...args),
}));

const { notifyPeer } = await import('../src/notify-peer.js');

interface FakeRegistry {
  get: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  register: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
}

const fakeLogger = {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
};

function makeDeps(reg: FakeRegistry) {
  return {
    registry: reg as unknown as Parameters<typeof notifyPeer>[0]['registry'],
    selfAgentName: 'self-agent',
    mTlsClientCertPem: 'test-cert',
    mTlsClientKeyPem: 'test-key',
    caCertPem: 'test-ca',
    logger: fakeLogger as unknown as Parameters<typeof notifyPeer>[0]['logger'],
  };
}

function makeRegistry(opts: {
  get?: Awaited<ReturnType<FakeRegistry['get']>>;
  list?: Awaited<ReturnType<FakeRegistry['list']>>;
}): FakeRegistry {
  return {
    get: vi.fn().mockResolvedValue(opts.get ?? null),
    list: vi.fn().mockResolvedValue(opts.list ?? []),
    register: vi.fn(),
    remove: vi.fn(),
  };
}

/**
 * Drive the next https.request call to return statusCode `code` synchronously.
 * The notifyPeer code does `req.on('error')` → resolve, or invokes the
 * callback with res. We simulate the latter; res.resume() + res.on('end')
 * are called after a microtask.
 */
function nextHttpsRespondsWith(statusCode: number): void {
  requestMock.mockImplementationOnce((...args: unknown[]) => {
    const cb = args[1] as ((res: EventEmitter & { statusCode: number; resume: () => void }) => void);
    const req = new EventEmitter() as EventEmitter & {
      write: () => void; end: () => void; destroy: () => void;
    };
    req.write = () => undefined;
    req.end = () => {
      const res = new EventEmitter() as EventEmitter & {
        statusCode: number; resume: () => void;
      };
      res.statusCode = statusCode;
      res.resume = () => undefined;
      cb(res);
      // Microtask-defer the end so callback's res.on('end') registers first.
      Promise.resolve().then(() => res.emit('end'));
    };
    req.destroy = () => undefined;
    return req;
  });
}

function nextHttpsErrorsWith(error: Error): void {
  requestMock.mockImplementationOnce((..._args: unknown[]) => {
    const req = new EventEmitter() as EventEmitter & {
      write: () => void; end: () => void; destroy: () => void;
    };
    req.write = () => undefined;
    req.end = () => {
      Promise.resolve().then(() => req.emit('error', error));
    };
    req.destroy = () => undefined;
    return req;
  });
}

describe('notify_peer tool', () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  describe('single-peer mode (`to` provided)', () => {
    it('returns offline when peer is not registered', async () => {
      const reg = makeRegistry({ get: null });
      const result = await notifyPeer(makeDeps(reg), {
        to: 'missing-peer',
        event: 'session-end',
      });
      expect(result).toEqual({
        delivered: false,
        channel_state: 'offline',
        peers_attempted: 0,
        peers_delivered: 0,
      });
      expect(reg.get).toHaveBeenCalledWith('missing-peer');
      expect(requestMock).not.toHaveBeenCalled();
    });

    it('returns delivered when peer responds 200', async () => {
      const reg = makeRegistry({
        get: { host: '127.0.0.1', port: 9000, type: 'permanent', instance_id: 'a', started: 't' },
      });
      nextHttpsRespondsWith(200);
      const result = await notifyPeer(makeDeps(reg), {
        to: 'peer-a',
        event: 'session-end',
        message: 'bye',
      });
      expect(result).toEqual({
        delivered: true,
        channel_state: 'online',
        peers_attempted: 1,
        peers_delivered: 1,
      });
    });

    it('returns delivered=false when peer responds non-200 (peer alive but rejected)', async () => {
      const reg = makeRegistry({
        get: { host: '127.0.0.1', port: 9000, type: 'permanent', instance_id: 'a', started: 't' },
      });
      nextHttpsRespondsWith(500);
      const result = await notifyPeer(makeDeps(reg), {
        to: 'peer-a',
        event: 'error',
      });
      expect(result.delivered).toBe(false);
      expect(result.channel_state).toBe('online'); // transport ok, peer alive
      expect(result.peers_attempted).toBe(1);
      expect(result.peers_delivered).toBe(0);
    });

    it('returns offline when transport fails', async () => {
      const reg = makeRegistry({
        get: { host: '127.0.0.1', port: 9999, type: 'permanent', instance_id: 'a', started: 't' },
      });
      nextHttpsErrorsWith(new Error('ECONNREFUSED'));
      const result = await notifyPeer(makeDeps(reg), {
        to: 'peer-dead',
        event: 'session-end',
      });
      expect(result.channel_state).toBe('offline');
      expect(result.peers_attempted).toBe(1);
      expect(result.peers_delivered).toBe(0);
    });

    it('returns offline immediately when `to` references self (cycle prevention)', async () => {
      const reg = makeRegistry({
        get: { host: '127.0.0.1', port: 9000, type: 'permanent', instance_id: 'a', started: 't' },
      });
      const result = await notifyPeer(makeDeps(reg), {
        to: 'self-agent', // matches selfAgentName in deps
        event: 'session-end',
      });
      expect(result.peers_attempted).toBe(0);
      expect(reg.get).not.toHaveBeenCalled(); // short-circuit before registry lookup
    });
  });

  describe('broadcast mode (`to` absent)', () => {
    it('returns offline+0 when no peers registered', async () => {
      const reg = makeRegistry({ list: [] });
      const result = await notifyPeer(makeDeps(reg), { event: 'session-end' });
      expect(result).toEqual({
        delivered: false,
        channel_state: 'offline',
        peers_attempted: 0,
        peers_delivered: 0,
      });
    });

    it('excludes self from broadcast (cycle prevention)', async () => {
      const reg = makeRegistry({
        list: [
          { name: 'self-agent', info: { host: '127.0.0.1', port: 9000, type: 'permanent', instance_id: 'a', started: 't' } },
        ],
      });
      const result = await notifyPeer(makeDeps(reg), { event: 'session-end' });
      expect(result.peers_attempted).toBe(0);
      expect(requestMock).not.toHaveBeenCalled();
    });

    it('broadcasts to all non-self peers in parallel; aggregates delivered count', async () => {
      const reg = makeRegistry({
        list: [
          { name: 'peer-a', info: { host: '127.0.0.1', port: 9001, type: 'permanent', instance_id: 'a', started: 't' } },
          { name: 'peer-b', info: { host: '127.0.0.1', port: 9002, type: 'permanent', instance_id: 'b', started: 't' } },
          { name: 'self-agent', info: { host: '127.0.0.1', port: 9003, type: 'permanent', instance_id: 's', started: 't' } },
        ],
      });
      nextHttpsRespondsWith(200);
      nextHttpsRespondsWith(200);
      const result = await notifyPeer(makeDeps(reg), { event: 'session-end' });
      expect(result.peers_attempted).toBe(2);
      expect(result.peers_delivered).toBe(2);
      expect(result.channel_state).toBe('online');
      expect(result.delivered).toBe(true);
      expect(requestMock).toHaveBeenCalledTimes(2);
    });

    it('partial-success counts as delivered=true (one peer ok, one offline)', async () => {
      const reg = makeRegistry({
        list: [
          { name: 'peer-a', info: { host: '127.0.0.1', port: 9001, type: 'permanent', instance_id: 'a', started: 't' } },
          { name: 'peer-b', info: { host: '127.0.0.1', port: 9999, type: 'permanent', instance_id: 'b', started: 't' } },
        ],
      });
      nextHttpsRespondsWith(200);
      nextHttpsErrorsWith(new Error('ECONNREFUSED'));
      const result = await notifyPeer(makeDeps(reg), { event: 'session-end' });
      expect(result.peers_attempted).toBe(2);
      expect(result.peers_delivered).toBe(1);
      expect(result.delivered).toBe(true);
      expect(result.channel_state).toBe('online'); // at least one transport-ok
    });

    it('returns offline when all peers transport-error', async () => {
      const reg = makeRegistry({
        list: [
          { name: 'peer-a', info: { host: '127.0.0.1', port: 9999, type: 'permanent', instance_id: 'a', started: 't' } },
        ],
      });
      nextHttpsErrorsWith(new Error('ECONNREFUSED'));
      const result = await notifyPeer(makeDeps(reg), { event: 'session-end' });
      expect(result.peers_attempted).toBe(1);
      expect(result.peers_delivered).toBe(0);
      expect(result.channel_state).toBe('offline');
    });
  });
});

// vitest's `beforeEach` is per-describe by default; declare top-level here too.
import { beforeEach } from 'vitest';
