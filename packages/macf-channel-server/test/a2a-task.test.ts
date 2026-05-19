/**
 * Unit tests for the A2A task state machine + TaskStore (macf#390 Phase 2a).
 *
 * Coverage:
 * - Transition validity table (all 8 v1.0 states; legal + illegal moves)
 * - TaskStore CRUD + happy-path drive
 * - Terminal-state immutability (no further transitions after COMPLETED/FAILED/CANCELED/REJECTED)
 * - Resume-shape readiness (Phase 2a doesn't exercise INPUT_REQUIRED resume,
 *   but the transition table allows it for Phase 2b)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  TaskStore,
  isTransitionAllowed,
  InvalidTaskTransitionError,
  TaskNotFoundError,
  TaskNotResumableError,
} from '../src/a2a-task.js';
import type { Message } from '../src/a2a-types.js';

const NOW = '2026-05-19T20:00:00.000Z';

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    messageId: 'msg-test-1',
    role: 'ROLE_USER',
    parts: [{ text: 'hello' }],
    ...overrides,
  };
}

describe('isTransitionAllowed (A2A v1.0 § 4.1.3 transition table)', () => {
  it('SUBMITTED → WORKING is legal (happy-path start)', () => {
    expect(isTransitionAllowed('TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING')).toBe(true);
  });

  it('SUBMITTED → REJECTED is legal (agent declines)', () => {
    expect(isTransitionAllowed('TASK_STATE_SUBMITTED', 'TASK_STATE_REJECTED')).toBe(true);
  });

  it('WORKING → COMPLETED is legal (happy-path end)', () => {
    expect(isTransitionAllowed('TASK_STATE_WORKING', 'TASK_STATE_COMPLETED')).toBe(true);
  });

  it('WORKING → INPUT_REQUIRED is legal (Phase 2b resume path)', () => {
    expect(isTransitionAllowed('TASK_STATE_WORKING', 'TASK_STATE_INPUT_REQUIRED')).toBe(true);
  });

  it('WORKING → AUTH_REQUIRED is legal (Phase 2b resume path)', () => {
    expect(isTransitionAllowed('TASK_STATE_WORKING', 'TASK_STATE_AUTH_REQUIRED')).toBe(true);
  });

  it('INPUT_REQUIRED → WORKING is legal (resume after input)', () => {
    expect(isTransitionAllowed('TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_WORKING')).toBe(true);
  });

  it('AUTH_REQUIRED → WORKING is legal (resume after auth)', () => {
    expect(isTransitionAllowed('TASK_STATE_AUTH_REQUIRED', 'TASK_STATE_WORKING')).toBe(true);
  });

  it('COMPLETED → WORKING is ILLEGAL (terminal)', () => {
    expect(isTransitionAllowed('TASK_STATE_COMPLETED', 'TASK_STATE_WORKING')).toBe(false);
  });

  it('FAILED → WORKING is ILLEGAL (terminal)', () => {
    expect(isTransitionAllowed('TASK_STATE_FAILED', 'TASK_STATE_WORKING')).toBe(false);
  });

  it('CANCELED → WORKING is ILLEGAL (terminal)', () => {
    expect(isTransitionAllowed('TASK_STATE_CANCELED', 'TASK_STATE_WORKING')).toBe(false);
  });

  it('REJECTED → WORKING is ILLEGAL (terminal)', () => {
    expect(isTransitionAllowed('TASK_STATE_REJECTED', 'TASK_STATE_WORKING')).toBe(false);
  });

  it('SUBMITTED → COMPLETED is ILLEGAL (must pass through WORKING)', () => {
    // Spec § 4.1.3: WORKING is the legal precursor to COMPLETED. Skipping
    // it makes the lifecycle nonsensical (no work was done).
    expect(isTransitionAllowed('TASK_STATE_SUBMITTED', 'TASK_STATE_COMPLETED')).toBe(false);
  });

  it('SUBMITTED → INPUT_REQUIRED is ILLEGAL (must enter WORKING first)', () => {
    expect(isTransitionAllowed('TASK_STATE_SUBMITTED', 'TASK_STATE_INPUT_REQUIRED')).toBe(false);
  });
});

describe('TaskStore', () => {
  let store: TaskStore;

  beforeEach(() => {
    store = new TaskStore();
  });

  it('creates a task in SUBMITTED with a fresh UUID id', () => {
    const msg = makeMessage();
    const task = store.create(msg, { nowIso: NOW });
    expect(task.status.state).toBe('TASK_STATE_SUBMITTED');
    expect(task.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(task.history).toEqual([msg]);
    expect(task.status.timestamp).toBe(NOW);
  });

  it('returns a different id on each create (UUID collision-resistance)', () => {
    const t1 = store.create(makeMessage(), { nowIso: NOW });
    const t2 = store.create(makeMessage(), { nowIso: NOW });
    expect(t1.id).not.toBe(t2.id);
  });

  it('propagates contextId from initial message if present', () => {
    const msg = makeMessage({ contextId: 'ctx-12345' });
    const task = store.create(msg, { nowIso: NOW });
    expect(task.contextId).toBe('ctx-12345');
  });

  it('get() retrieves by id', () => {
    const t = store.create(makeMessage(), { nowIso: NOW });
    expect(store.get(t.id)).toEqual(t);
  });

  it('get() returns undefined for unknown id', () => {
    expect(store.get('not-a-real-id')).toBeUndefined();
  });

  it('transition() advances SUBMITTED → WORKING', () => {
    const t = store.create(makeMessage(), { nowIso: NOW });
    const updated = store.transition(t.id, 'TASK_STATE_WORKING', { nowIso: NOW });
    expect(updated.status.state).toBe('TASK_STATE_WORKING');
    expect(store.get(t.id)?.status.state).toBe('TASK_STATE_WORKING');
  });

  it('transition() to terminal state with response message appends history', () => {
    const initial = makeMessage();
    const response = makeMessage({ messageId: 'msg-test-2', role: 'ROLE_AGENT' });
    const t = store.create(initial, { nowIso: NOW });
    store.transition(t.id, 'TASK_STATE_WORKING', { nowIso: NOW });
    const completed = store.transition(t.id, 'TASK_STATE_COMPLETED', { nowIso: NOW, message: response });
    expect(completed.status.state).toBe('TASK_STATE_COMPLETED');
    expect(completed.status.message).toEqual(response);
    expect(completed.history).toEqual([initial, response]);
  });

  it('transition() throws InvalidTaskTransitionError on illegal move', () => {
    const t = store.create(makeMessage(), { nowIso: NOW });
    expect(() => store.transition(t.id, 'TASK_STATE_COMPLETED', { nowIso: NOW }))
      .toThrow(InvalidTaskTransitionError);
  });

  it('transition() throws on unknown task id', () => {
    expect(() => store.transition('nonexistent', 'TASK_STATE_WORKING', { nowIso: NOW }))
      .toThrow(InvalidTaskTransitionError);
  });

  it('terminal states reject further transitions', () => {
    const t = store.create(makeMessage(), { nowIso: NOW });
    store.transition(t.id, 'TASK_STATE_WORKING', { nowIso: NOW });
    store.transition(t.id, 'TASK_STATE_COMPLETED', { nowIso: NOW });
    expect(() => store.transition(t.id, 'TASK_STATE_WORKING', { nowIso: NOW }))
      .toThrow(InvalidTaskTransitionError);
    expect(store.isTerminal(t.id)).toBe(true);
  });

  it('isTerminal() reflects spec terminal-state set', () => {
    const t = store.create(makeMessage(), { nowIso: NOW });
    expect(store.isTerminal(t.id)).toBe(false);
    store.transition(t.id, 'TASK_STATE_WORKING', { nowIso: NOW });
    expect(store.isTerminal(t.id)).toBe(false);
    store.transition(t.id, 'TASK_STATE_FAILED', { nowIso: NOW });
    expect(store.isTerminal(t.id)).toBe(true);
  });

  it('completeHappyPath() drives SUBMITTED → WORKING → COMPLETED in one call', () => {
    const initial = makeMessage();
    const response = makeMessage({ messageId: 'resp-1', role: 'ROLE_AGENT' });
    const final = store.completeHappyPath(initial, response, { nowIso: NOW });
    expect(final.status.state).toBe('TASK_STATE_COMPLETED');
    expect(final.history).toEqual([initial, response]);
    expect(store.isTerminal(final.id)).toBe(true);
  });

  it('size() reflects tracked task count', () => {
    expect(store.size()).toBe(0);
    store.create(makeMessage(), { nowIso: NOW });
    expect(store.size()).toBe(1);
    store.create(makeMessage(), { nowIso: NOW });
    expect(store.size()).toBe(2);
  });
});

// macf#392 Phase 2b — resume + reject coverage
describe('TaskStore.resume (macf#392 Phase 2b)', () => {
  let store: TaskStore;

  beforeEach(() => {
    store = new TaskStore();
  });

  function setupInputRequiredTask(): { taskId: string } {
    const created = store.create(makeMessage(), { nowIso: NOW });
    store.transition(created.id, 'TASK_STATE_WORKING', { nowIso: NOW });
    store.transition(created.id, 'TASK_STATE_INPUT_REQUIRED', { nowIso: NOW });
    return { taskId: created.id };
  }

  it('resumes a task from INPUT_REQUIRED → WORKING with ROLE_USER message', () => {
    const { taskId } = setupInputRequiredTask();
    const resumeMsg = makeMessage({
      messageId: 'resume-1',
      role: 'ROLE_USER',
      parts: [{ text: 'follow-up input' }],
      taskId,
    });
    const resumed = store.resume(taskId, resumeMsg, { nowIso: NOW });
    expect(resumed.status.state).toBe('TASK_STATE_WORKING');
    expect(resumed.history).toHaveLength(2);
    expect(resumed.history?.[1]?.messageId).toBe('resume-1');
  });

  it('resumes a task from AUTH_REQUIRED → WORKING', () => {
    const created = store.create(makeMessage(), { nowIso: NOW });
    store.transition(created.id, 'TASK_STATE_WORKING', { nowIso: NOW });
    store.transition(created.id, 'TASK_STATE_AUTH_REQUIRED', { nowIso: NOW });
    const resumeMsg = makeMessage({
      messageId: 'resume-auth-1',
      role: 'ROLE_USER',
      taskId: created.id,
    });
    const resumed = store.resume(created.id, resumeMsg, { nowIso: NOW });
    expect(resumed.status.state).toBe('TASK_STATE_WORKING');
  });

  it('throws TaskNotFoundError when taskId is unknown', () => {
    expect(() => store.resume('nonexistent', makeMessage(), { nowIso: NOW }))
      .toThrow(TaskNotFoundError);
  });

  it('throws TaskNotResumableError when from-state is SUBMITTED (not yet WORKING)', () => {
    const created = store.create(makeMessage(), { nowIso: NOW });
    // SUBMITTED is not in INTERRUPTED_TASK_STATES — resume must reject.
    expect(() => store.resume(created.id, makeMessage(), { nowIso: NOW }))
      .toThrow(TaskNotResumableError);
  });

  it('throws TaskNotResumableError when from-state is WORKING (not paused)', () => {
    const created = store.create(makeMessage(), { nowIso: NOW });
    store.transition(created.id, 'TASK_STATE_WORKING', { nowIso: NOW });
    expect(() => store.resume(created.id, makeMessage(), { nowIso: NOW }))
      .toThrow(TaskNotResumableError);
  });

  it('throws TaskNotResumableError when from-state is terminal (COMPLETED)', () => {
    const created = store.create(makeMessage(), { nowIso: NOW });
    store.transition(created.id, 'TASK_STATE_WORKING', { nowIso: NOW });
    store.transition(created.id, 'TASK_STATE_COMPLETED', { nowIso: NOW });
    expect(() => store.resume(created.id, makeMessage(), { nowIso: NOW }))
      .toThrow(TaskNotResumableError);
  });

  it('rejects resume with non-ROLE_USER message (per spec § 4.1.5 client→server direction)', () => {
    const { taskId } = setupInputRequiredTask();
    const agentResumeMsg = makeMessage({
      messageId: 'agent-msg',
      role: 'ROLE_AGENT', // wrong direction for resume
      taskId,
    });
    expect(() => store.resume(taskId, agentResumeMsg, { nowIso: NOW }))
      .toThrow(/ROLE_USER/);
  });

  it('TaskNotResumableError carries the current state for error mapping', () => {
    const created = store.create(makeMessage(), { nowIso: NOW });
    store.transition(created.id, 'TASK_STATE_WORKING', { nowIso: NOW });
    store.transition(created.id, 'TASK_STATE_COMPLETED', { nowIso: NOW });
    try {
      store.resume(created.id, makeMessage(), { nowIso: NOW });
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TaskNotResumableError);
      expect((err as TaskNotResumableError).currentState).toBe('TASK_STATE_COMPLETED');
    }
  });
});

describe('TaskStore.rejectFresh (macf#392 Phase 2b — REJECTED transition test fixture)', () => {
  let store: TaskStore;

  beforeEach(() => {
    store = new TaskStore();
  });

  it('drives SUBMITTED → REJECTED with reason message in TaskStatus.message', () => {
    const initial = makeMessage();
    const reason = makeMessage({
      messageId: 'reject-reason-1',
      role: 'ROLE_AGENT',
      parts: [{ text: 'Synthetic rejection' }],
    });
    const rejected = store.rejectFresh(initial, reason, { nowIso: NOW });
    expect(rejected.status.state).toBe('TASK_STATE_REJECTED');
    expect(rejected.status.message?.messageId).toBe('reject-reason-1');
    expect(store.isTerminal(rejected.id)).toBe(true);
  });

  it('REJECTED is terminal — no further transitions allowed', () => {
    const rejected = store.rejectFresh(makeMessage(), makeMessage({ role: 'ROLE_AGENT' }), { nowIso: NOW });
    expect(() => store.transition(rejected.id, 'TASK_STATE_WORKING', { nowIso: NOW }))
      .toThrow(InvalidTaskTransitionError);
  });
});
