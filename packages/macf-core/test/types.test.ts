import { describe, it, expect } from 'vitest';
import {
  NotifyPayloadSchema, NotifyTypeSchema, HealthResponseSchema,
  CiCompletionPayloadSchema, CheckSuiteConclusionSchema,
  PeerNotificationPayloadSchema,
} from '../src/types.js';

describe('NotifyTypeSchema', () => {
  it('accepts valid types', () => {
    expect(NotifyTypeSchema.parse('issue_routed')).toBe('issue_routed');
    expect(NotifyTypeSchema.parse('mention')).toBe('mention');
    expect(NotifyTypeSchema.parse('startup_check')).toBe('startup_check');
    expect(NotifyTypeSchema.parse('ci_completion')).toBe('ci_completion');
    expect(NotifyTypeSchema.parse('peer_notification')).toBe('peer_notification');
  });

  it('rejects unknown types', () => {
    expect(() => NotifyTypeSchema.parse('unknown')).toThrow();
  });
});

describe('NotifyPayloadSchema', () => {
  it('accepts minimal payload', () => {
    const result = NotifyPayloadSchema.parse({ type: 'mention' });
    expect(result.type).toBe('mention');
    expect(result.issue_number).toBeUndefined();
  });

  it('accepts full payload', () => {
    const result = NotifyPayloadSchema.parse({
      type: 'issue_routed',
      issue_number: 42,
      title: 'Fix bug',
      source: 'agent-router',
      message: 'Routed to you',
    });
    expect(result.type).toBe('issue_routed');
    expect(result.issue_number).toBe(42);
    expect(result.title).toBe('Fix bug');
    expect(result.source).toBe('agent-router');
    expect(result.message).toBe('Routed to you');
  });

  it('rejects missing type', () => {
    expect(() => NotifyPayloadSchema.parse({ issue_number: 1 })).toThrow();
  });

  it('rejects invalid issue_number', () => {
    expect(() => NotifyPayloadSchema.parse({ type: 'mention', issue_number: -1 })).toThrow();
    expect(() => NotifyPayloadSchema.parse({ type: 'mention', issue_number: 0 })).toThrow();
    expect(() => NotifyPayloadSchema.parse({ type: 'mention', issue_number: 1.5 })).toThrow();
  });
});

describe('PeerNotificationPayloadSchema (macf#256, DR-023 UC-1)', () => {
  it('accepts minimal valid payload', () => {
    const result = PeerNotificationPayloadSchema.parse({
      type: 'peer_notification',
      source: 'macf-tester-1-agent',
      event: 'session-end',
    });
    expect(result.type).toBe('peer_notification');
    expect(result.source).toBe('macf-tester-1-agent');
    expect(result.event).toBe('session-end');
  });

  it('accepts full payload with optional fields', () => {
    const result = PeerNotificationPayloadSchema.parse({
      type: 'peer_notification',
      source: 'macf-tester-1-agent',
      event: 'turn-complete',
      message: 'wrapped up issue #42',
      context: { issue_number: 42 },
    });
    expect(result.message).toBe('wrapped up issue #42');
    expect(result.context).toEqual({ issue_number: 42 });
  });

  it('accepts all four event values', () => {
    for (const event of ['session-end', 'turn-complete', 'error', 'custom'] as const) {
      const result = PeerNotificationPayloadSchema.parse({
        type: 'peer_notification', source: 'a', event,
      });
      expect(result.event).toBe(event);
    }
  });

  it('rejects unknown event', () => {
    expect(() => PeerNotificationPayloadSchema.parse({
      type: 'peer_notification', source: 'a', event: 'unknown-event',
    })).toThrow();
  });

  it('rejects missing source', () => {
    expect(() => PeerNotificationPayloadSchema.parse({
      type: 'peer_notification', event: 'session-end',
    })).toThrow();
  });

  it('parses cleanly via wider NotifyPayloadSchema discriminator', () => {
    // Receivers parse via wider schema + discriminate on type. This
    // mirrors the channel server's /notify dispatch path.
    const wide = NotifyPayloadSchema.parse({
      type: 'peer_notification',
      source: 'macf-tester-1-agent',
      event: 'session-end',
      message: 'bye',
    });
    expect(wide.type).toBe('peer_notification');
    expect(wide.source).toBe('macf-tester-1-agent');
    expect(wide.event).toBe('session-end');
  });
});

describe('HealthResponseSchema', () => {
  it('accepts valid health response', () => {
    const data = {
      agent: 'code-agent',
      status: 'online' as const,
      type: 'permanent',
      uptime_seconds: 3600,
      current_issue: null,
      version: '0.1.0',
      last_notification: null,
    };
    const result = HealthResponseSchema.parse(data);
    expect(result.agent).toBe('code-agent');
    expect(result.status).toBe('online');
  });

  it('accepts health with current issue', () => {
    const data = {
      agent: 'code-agent',
      status: 'online' as const,
      type: 'worker',
      uptime_seconds: 0,
      current_issue: 42,
      version: '0.1.0',
      last_notification: '2026-03-28T18:01:00Z',
    };
    const result = HealthResponseSchema.parse(data);
    expect(result.current_issue).toBe(42);
    expect(result.last_notification).toBe('2026-03-28T18:01:00Z');
  });

  it('rejects negative uptime', () => {
    expect(() => HealthResponseSchema.parse({
      agent: 'test',
      status: 'online',
      type: 'permanent',
      uptime_seconds: -1,
      current_issue: null,
      version: '0.1.0',
      last_notification: null,
    })).toThrow();
  });
});

describe('CheckSuiteConclusionSchema', () => {
  it('accepts all four actionable conclusions', () => {
    for (const v of ['success', 'failure', 'timed_out', 'action_required']) {
      expect(CheckSuiteConclusionSchema.parse(v)).toBe(v);
    }
  });

  it('rejects non-actionable conclusions', () => {
    for (const v of ['neutral', 'cancelled', 'skipped', 'stale', 'unknown']) {
      expect(() => CheckSuiteConclusionSchema.parse(v), v).toThrow();
    }
  });
});

describe('CiCompletionPayloadSchema (#122)', () => {
  const base = {
    type: 'ci_completion' as const,
    source: 'ci_completion' as const,
    pr_number: 42,
    pr_title: 'fix: do a thing',
    pr_url: 'https://github.com/owner/repo/pull/42',
    conclusion: 'success' as const,
    failing_check_name: null,
    message: 'PR #42: CI SUCCESS. ...',
  };

  it('accepts a success payload with failing_check_name null', () => {
    const result = CiCompletionPayloadSchema.parse(base);
    expect(result.conclusion).toBe('success');
    expect(result.failing_check_name).toBeNull();
  });

  it('accepts a failure payload with failing_check_name string', () => {
    const result = CiCompletionPayloadSchema.parse({
      ...base,
      conclusion: 'failure',
      failing_check_name: 'check / build',
      message: 'PR #42: CI FAILED. First failing check: \'check / build\'. ...',
    });
    expect(result.conclusion).toBe('failure');
    expect(result.failing_check_name).toBe('check / build');
  });

  it('accepts timed_out and action_required conclusions', () => {
    expect(CiCompletionPayloadSchema.parse({ ...base, conclusion: 'timed_out' }).conclusion)
      .toBe('timed_out');
    expect(CiCompletionPayloadSchema.parse({ ...base, conclusion: 'action_required' }).conclusion)
      .toBe('action_required');
  });

  it('rejects wrong literal type', () => {
    expect(() => CiCompletionPayloadSchema.parse({ ...base, type: 'mention' })).toThrow();
  });

  it('rejects wrong literal source', () => {
    expect(() => CiCompletionPayloadSchema.parse({ ...base, source: 'label' })).toThrow();
  });

  it('rejects missing pr_number', () => {
    const { pr_number: _pn, ...withoutPrNumber } = base;
    void _pn;
    expect(() => CiCompletionPayloadSchema.parse(withoutPrNumber)).toThrow();
  });

  it('rejects non-URL pr_url', () => {
    expect(() => CiCompletionPayloadSchema.parse({ ...base, pr_url: 'not a url' })).toThrow();
  });

  it('rejects non-actionable conclusion (cancelled, neutral, etc.)', () => {
    expect(() => CiCompletionPayloadSchema.parse({ ...base, conclusion: 'cancelled' })).toThrow();
  });

  it('rejects undefined failing_check_name (must be null or string, not omitted)', () => {
    const { failing_check_name: _fcn, ...withoutFcn } = base;
    void _fcn;
    expect(() => CiCompletionPayloadSchema.parse(withoutFcn)).toThrow();
  });

  it('also round-trips through the wider NotifyPayloadSchema (backward-compat)', () => {
    // Receivers parse against NotifyPayloadSchema (backward-compat
    // across variants) and narrow via type discriminator — verify
    // that a valid CiCompletionPayload also parses cleanly through
    // the wider schema.
    const result = NotifyPayloadSchema.parse(base);
    expect(result.type).toBe('ci_completion');
    expect(result.pr_number).toBe(42);
    expect(result.conclusion).toBe('success');
    expect(result.failing_check_name).toBeNull();
  });
});

describe('NotifyPayloadSchema (#122 additions)', () => {
  it('accepts ci_completion type', () => {
    const result = NotifyPayloadSchema.parse({
      type: 'ci_completion',
      pr_number: 99,
      conclusion: 'success',
    });
    expect(result.type).toBe('ci_completion');
  });

  it('rejects bad conclusion even on the wider schema', () => {
    expect(() => NotifyPayloadSchema.parse({
      type: 'ci_completion',
      conclusion: 'junk',
    })).toThrow();
  });

  it('rejects malformed pr_url even on the wider schema', () => {
    expect(() => NotifyPayloadSchema.parse({
      type: 'ci_completion',
      pr_url: 'not a url',
    })).toThrow();
  });
});
