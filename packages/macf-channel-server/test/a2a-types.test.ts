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
  TaskIdParamsSchema,
  resolveTaskId,
  A2A_METHOD_MESSAGE_SEND,
  A2A_METHOD_TASKS_GET,
  A2A_METHOD_TASKS_CANCEL,
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

describe('PartSchema (§ 4.1.5 + proto oneof; 4 content variants)', () => {
  // Verified 2026-05-19 against canonical spec/a2a.proto (the authoritative
  // normative source per § 1.4). Proto has 4 oneof variants — text / raw /
  // url / data — plus top-level optional metadata / filename / media_type.
  it('accepts a text part', () => {
    expect(PartSchema.safeParse({ text: 'hello' }).success).toBe(true);
  });

  it('accepts a raw (bytes-as-base64) part', () => {
    expect(PartSchema.safeParse({ raw: 'aGVsbG8=' }).success).toBe(true);
  });

  it('accepts a url part (proto field 3)', () => {
    expect(PartSchema.safeParse({ url: 'https://example.com/file.png' }).success).toBe(true);
  });

  it('accepts a data part with arbitrary value', () => {
    expect(PartSchema.safeParse({ data: { foo: 'bar', count: 5 } }).success).toBe(true);
  });

  it('accepts top-level metadata + filename + mediaType alongside content variant', () => {
    expect(PartSchema.safeParse({
      raw: 'aGVsbG8=',
      filename: 'hello.txt',
      mediaType: 'text/plain',
    }).success).toBe(true);
  });

  it('rejects an empty Part (no oneof variant set)', () => {
    expect(PartSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a Part with no content variant (only metadata-ish keys)', () => {
    // Per proto: at least one of text/raw/url/data must be present.
    // Filename without a content variant is not a valid Part.
    expect(PartSchema.safeParse({ filename: 'orphan.txt' }).success).toBe(false);
  });

  it('mediaType is camelCase (proto media_type → JSON canonical mapping)', () => {
    // Per protobuf-to-JSON canonical mapping, proto `media_type` becomes
    // JSON `mediaType`. The schema accepts mediaType only; snake_case
    // media_type would fail.
    expect(PartSchema.safeParse({
      text: 'hello',
      mediaType: 'text/plain',
    }).success).toBe(true);
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

describe('TaskIdParamsSchema + resolveTaskId (macf#398 Phase 2d)', () => {
  it('accepts bare id form `{ id }`', () => {
    const parsed = TaskIdParamsSchema.safeParse({ id: 'task-abc-123' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(resolveTaskId(parsed.data)).toBe('task-abc-123');
    }
  });

  it('accepts proto-canonical `{ name: "tasks/<id>" }` form', () => {
    const parsed = TaskIdParamsSchema.safeParse({ name: 'tasks/task-abc-123' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(resolveTaskId(parsed.data)).toBe('task-abc-123');
    }
  });

  it('strips the `tasks/` prefix from name to yield bare id', () => {
    const parsed = TaskIdParamsSchema.parse({ name: 'tasks/uuid-here' });
    expect(resolveTaskId(parsed)).toBe('uuid-here');
  });

  it('id takes precedence when both are present', () => {
    const parsed = TaskIdParamsSchema.parse({ id: 'from-id', name: 'tasks/from-name' });
    expect(resolveTaskId(parsed)).toBe('from-id');
  });

  it('returns bare name as-is if it lacks the `tasks/` prefix', () => {
    // Defensive — some clients may send `name` without the resource prefix.
    const parsed = TaskIdParamsSchema.parse({ name: 'raw-id-no-prefix' });
    expect(resolveTaskId(parsed)).toBe('raw-id-no-prefix');
  });

  it('rejects params with neither id nor name', () => {
    expect(TaskIdParamsSchema.safeParse({}).success).toBe(false);
    expect(TaskIdParamsSchema.safeParse({ metadata: { hint: 'x' } }).success).toBe(false);
  });

  it('rejects empty id / empty name', () => {
    expect(TaskIdParamsSchema.safeParse({ id: '' }).success).toBe(false);
    expect(TaskIdParamsSchema.safeParse({ name: '' }).success).toBe(false);
  });

  it('passes optional metadata through', () => {
    const parsed = TaskIdParamsSchema.parse({ id: 'x', metadata: { priority: 'high' } });
    expect(parsed.metadata).toEqual({ priority: 'high' });
  });
});

describe('Method constants (macf#398 Phase 2d)', () => {
  it('A2A_METHOD_TASKS_GET is the canonical slash-namespaced string', () => {
    expect(A2A_METHOD_TASKS_GET).toBe('tasks/get');
  });

  it('A2A_METHOD_TASKS_CANCEL is the canonical slash-namespaced string', () => {
    expect(A2A_METHOD_TASKS_CANCEL).toBe('tasks/cancel');
  });
});
