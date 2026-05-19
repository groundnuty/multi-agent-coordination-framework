/**
 * Unit tests for A2A v1.0 Zod schemas (macf#390 Phase 2a).
 *
 * Coverage:
 * - TaskState enum (8 v1.0 values; rejects unknowns)
 * - Role enum (SCREAMING_SNAKE_CASE)
 * - Part discriminated union (text / file / data variants)
 * - Message shape (required + optional fields; Message.taskId for resume)
 * - JSON-RPC envelope (jsonrpc:"2.0", method, id)
 * - MessageSendParams (wraps Message)
 * - Constants (method string, endpoint path, error codes)
 */
import { describe, it, expect } from 'vitest';
import {
  TaskStateSchema,
  RoleSchema,
  PartSchema,
  MessageSchema,
  TaskSchema,
  JsonRpcRequestSchema,
  MessageSendParamsSchema,
  A2A_METHOD_MESSAGE_SEND,
  A2A_ENDPOINT_PATH,
  A2A_ERROR_DOMAIN,
  TERMINAL_TASK_STATES,
  INTERRUPTED_TASK_STATES,
} from '../src/a2a-types.js';

describe('TaskStateSchema (§ 4.1.3)', () => {
  it('accepts all 8 v1.0 states', () => {
    for (const state of [
      'TASK_STATE_SUBMITTED',
      'TASK_STATE_WORKING',
      'TASK_STATE_INPUT_REQUIRED',
      'TASK_STATE_AUTH_REQUIRED',
      'TASK_STATE_COMPLETED',
      'TASK_STATE_FAILED',
      'TASK_STATE_CANCELED',
      'TASK_STATE_REJECTED',
    ]) {
      expect(TaskStateSchema.safeParse(state).success).toBe(true);
    }
  });

  it('rejects lowercase / v0.3-style values', () => {
    // v0.3 used kebab-case; v1.0 changed to SCREAMING_SNAKE_CASE.
    // The hand-rolled schema enforces v1.0; clients sending v0.3 shapes
    // fail validation here (which is the desired interop behavior).
    expect(TaskStateSchema.safeParse('submitted').success).toBe(false);
    expect(TaskStateSchema.safeParse('input-required').success).toBe(false);
    expect(TaskStateSchema.safeParse('').success).toBe(false);
  });

  it('TERMINAL_TASK_STATES contains exactly the 4 terminal states', () => {
    expect(TERMINAL_TASK_STATES.size).toBe(4);
    expect(TERMINAL_TASK_STATES.has('TASK_STATE_COMPLETED')).toBe(true);
    expect(TERMINAL_TASK_STATES.has('TASK_STATE_FAILED')).toBe(true);
    expect(TERMINAL_TASK_STATES.has('TASK_STATE_CANCELED')).toBe(true);
    expect(TERMINAL_TASK_STATES.has('TASK_STATE_REJECTED')).toBe(true);
    expect(TERMINAL_TASK_STATES.has('TASK_STATE_WORKING')).toBe(false);
  });

  it('INTERRUPTED_TASK_STATES contains the 2 resume-required states', () => {
    expect(INTERRUPTED_TASK_STATES.size).toBe(2);
    expect(INTERRUPTED_TASK_STATES.has('TASK_STATE_INPUT_REQUIRED')).toBe(true);
    expect(INTERRUPTED_TASK_STATES.has('TASK_STATE_AUTH_REQUIRED')).toBe(true);
  });
});

describe('RoleSchema (§ 4.1.4)', () => {
  it('accepts ROLE_USER + ROLE_AGENT', () => {
    expect(RoleSchema.safeParse('ROLE_USER').success).toBe(true);
    expect(RoleSchema.safeParse('ROLE_AGENT').success).toBe(true);
  });

  it('rejects v0.3-style lowercase + unknowns', () => {
    expect(RoleSchema.safeParse('user').success).toBe(false);
    expect(RoleSchema.safeParse('agent').success).toBe(false);
    expect(RoleSchema.safeParse('SYSTEM').success).toBe(false);
  });
});

describe('PartSchema (§ 4.1.5 OneOf semantics)', () => {
  it('accepts a text part', () => {
    expect(PartSchema.safeParse({ text: 'hello' }).success).toBe(true);
  });

  it('accepts a file part', () => {
    expect(PartSchema.safeParse({ file: { name: 'a.png', mimeType: 'image/png' } }).success).toBe(true);
  });

  it('accepts a data part with arbitrary key-value content', () => {
    expect(PartSchema.safeParse({ data: { foo: 'bar', count: 5 } }).success).toBe(true);
  });

  it('rejects an empty Part', () => {
    expect(PartSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a Part with no text+file+data keys (only metadata-ish keys)', () => {
    expect(PartSchema.safeParse({ unknownField: 'x' }).success).toBe(false);
  });
});

describe('MessageSchema (§ 4.1.4)', () => {
  it('accepts minimal valid message (messageId + role + parts)', () => {
    expect(MessageSchema.safeParse({
      messageId: 'msg-1',
      role: 'ROLE_USER',
      parts: [{ text: 'hello' }],
    }).success).toBe(true);
  });

  it('accepts message with optional taskId set (Phase 2b resume reference)', () => {
    expect(MessageSchema.safeParse({
      messageId: 'msg-resume-1',
      role: 'ROLE_USER',
      parts: [{ text: 'follow-up input' }],
      taskId: 'task-uuid-12345',
    }).success).toBe(true);
  });

  it('rejects message with empty parts array', () => {
    expect(MessageSchema.safeParse({
      messageId: 'msg-1',
      role: 'ROLE_USER',
      parts: [],
    }).success).toBe(false);
  });

  it('rejects message missing messageId', () => {
    expect(MessageSchema.safeParse({
      role: 'ROLE_USER',
      parts: [{ text: 'hello' }],
    }).success).toBe(false);
  });
});

describe('TaskSchema (§ 4.1.1)', () => {
  it('accepts minimal valid task', () => {
    expect(TaskSchema.safeParse({
      id: 'task-1',
      status: { state: 'TASK_STATE_SUBMITTED' },
    }).success).toBe(true);
  });

  it('rejects task with empty id', () => {
    expect(TaskSchema.safeParse({
      id: '',
      status: { state: 'TASK_STATE_SUBMITTED' },
    }).success).toBe(false);
  });
});

describe('JsonRpcRequestSchema (§ 9)', () => {
  it('accepts well-formed envelope', () => {
    expect(JsonRpcRequestSchema.safeParse({
      jsonrpc: '2.0',
      method: 'message/send',
      id: 'req-1',
      params: {},
    }).success).toBe(true);
  });

  it('accepts numeric id', () => {
    expect(JsonRpcRequestSchema.safeParse({
      jsonrpc: '2.0',
      method: 'message/send',
      id: 42,
    }).success).toBe(true);
  });

  it('rejects wrong jsonrpc version', () => {
    expect(JsonRpcRequestSchema.safeParse({
      jsonrpc: '1.0',
      method: 'message/send',
      id: 'req-1',
    }).success).toBe(false);
  });

  it('rejects missing method', () => {
    expect(JsonRpcRequestSchema.safeParse({
      jsonrpc: '2.0',
      id: 'req-1',
    }).success).toBe(false);
  });
});

describe('MessageSendParamsSchema (§ 9.4.1)', () => {
  it('accepts params wrapping a valid Message', () => {
    expect(MessageSendParamsSchema.safeParse({
      message: {
        messageId: 'msg-1',
        role: 'ROLE_USER',
        parts: [{ text: 'hello' }],
      },
    }).success).toBe(true);
  });

  it('rejects params missing message', () => {
    expect(MessageSendParamsSchema.safeParse({}).success).toBe(false);
  });
});

describe('Constants (spec citation anchors)', () => {
  it('A2A_METHOD_MESSAGE_SEND is the spec-canonical slash-namespaced string', () => {
    // Verified 2026-05-19 against a2a-protocol.org § 9 examples.
    expect(A2A_METHOD_MESSAGE_SEND).toBe('message/send');
  });

  it('A2A_ENDPOINT_PATH matches design decision 1 (versioned namespace)', () => {
    expect(A2A_ENDPOINT_PATH).toBe('/a2a/v1');
  });

  it('A2A_ERROR_DOMAIN matches v1.0 google.rpc.Status spec', () => {
    expect(A2A_ERROR_DOMAIN).toBe('a2a-protocol.org');
  });
});
