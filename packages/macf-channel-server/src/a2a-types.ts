/**
 * A2A v1.0 protocol types for inbound JSON-RPC `message/send` handling.
 *
 * Hand-rolled Zod schemas per A2A v1.0 spec sections:
 * - § 4.1.1 Task
 * - § 4.1.2 TaskStatus
 * - § 4.1.3 TaskState (8-state enum, SCREAMING_SNAKE_CASE)
 * - § 4.1.4 Message
 * - § 4.1.5 Part (OneOf semantics: text | file | data; v1.0 dropped the `kind` discriminator per Appendix A.2.1)
 * - § 9 JSON-RPC Protocol Binding (method `"message/send"`)
 *
 * **SDK choice**: continuing hand-rolled (per Phase 1 #370 + #385 decision).
 * `@a2a-js/sdk` is still v0.3.13 (A2A v0.3 target); v1.0 not released.
 * Re-evaluate at Phase 3 (outbound A2A) when the bidirectional surface
 * pushes the build-vs-buy delta further.
 *
 * **Verified against spec text**: 2026-05-19 via a2a-protocol.org WebFetch.
 * Section references in JSDoc above each schema preserve the citation
 * trail for future re-verification.
 *
 * **macf#390 Phase 2a scope**: full 8-state TaskState enum + Message
 * schema + Part text-variant; happy-path SUBMITTED → WORKING → COMPLETED.
 * INPUT_REQUIRED / AUTH_REQUIRED transitions + file/data Part variants
 * declared in types but exercised in Phase 2b.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// TaskState — § 4.1.3 (SCREAMING_SNAKE_CASE per v1.0 enum convention)
// ---------------------------------------------------------------------------

export const TaskStateSchema = z.enum([
  'TASK_STATE_SUBMITTED',
  'TASK_STATE_WORKING',
  'TASK_STATE_INPUT_REQUIRED',
  'TASK_STATE_AUTH_REQUIRED',
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
]);

export type TaskState = z.infer<typeof TaskStateSchema>;

/** Terminal states — no further transitions allowed once entered. */
export const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
]);

/** Interrupted states — task pauses awaiting client follow-up via `Message.taskId`. */
export const INTERRUPTED_TASK_STATES: ReadonlySet<TaskState> = new Set([
  'TASK_STATE_INPUT_REQUIRED',
  'TASK_STATE_AUTH_REQUIRED',
]);

// ---------------------------------------------------------------------------
// Role — § 4.1.4 (SCREAMING_SNAKE_CASE per v1.0)
// ---------------------------------------------------------------------------

export const RoleSchema = z.enum(['ROLE_USER', 'ROLE_AGENT']);
export type Role = z.infer<typeof RoleSchema>;

// ---------------------------------------------------------------------------
// Part — § 4.1.5 + canonical proto (spec/a2a.proto)
// ---------------------------------------------------------------------------
//
// Per the canonical proto (single authoritative source per spec § 1.4 —
// "spec/a2a.proto is the single authoritative normative definition"):
//
//   message Part {
//     oneof content {
//       string text = 1;
//       bytes raw = 2;
//       string url = 3;
//       google.protobuf.Value data = 4;
//     }
//     google.protobuf.Struct metadata = 5;
//     string filename = 6;
//     string media_type = 7;
//   }
//
// Four `oneof content` variants (text / raw / url / data) — exactly one
// present. Optional top-level `metadata` + `filename` + `mediaType`
// (NOT inside a nested FilePart wrapper; v1.0 flattened the v0.3 shape).
//
// JSON wire-form names per protobuf-to-JSON canonical mapping:
// - `media_type` (proto snake_case) → `mediaType` (JSON camelCase)
// - `filename` → `filename` (single word, no transform)
// - `raw` is `bytes` in the proto → base64-encoded string on JSON wire
// - `data` is `google.protobuf.Value` → arbitrary JSON value
//
// Encoded as `z.union` of 4 separate variants (matching the proto's
// oneof discipline) rather than a single object with refine — clearer
// type discrimination for downstream consumers.
//
// Phase 2a only exercises the text variant; declaring the full proto
// shape so Phase 2b / Phase 3 don't need to refactor.

/** Shared optional fields present on all Part variants per proto §§ 5–7. */
const PartCommonFields = {
  metadata: z.record(z.string(), z.unknown()).optional(),
  filename: z.string().optional(),
  mediaType: z.string().optional(),
} as const;

const TextPartSchema = z.object({
  text: z.string(),
  ...PartCommonFields,
});

const RawPartSchema = z.object({
  raw: z.string(), // base64-encoded bytes per proto3 JSON mapping
  ...PartCommonFields,
});

const UrlPartSchema = z.object({
  url: z.string(),
  ...PartCommonFields,
});

// `data: z.unknown()` would accept undefined (Zod treats z.unknown as
// also-undefined), making empty objects pass DataPartSchema spuriously.
// The refine pins the key-presence requirement so the union correctly
// rejects `{}` + `{ filename: '...' }`-only inputs.
const DataPartSchema = z
  .object({
    data: z.unknown(),
    ...PartCommonFields,
  })
  .refine((obj) => Object.prototype.hasOwnProperty.call(obj, 'data'), {
    message: 'Part: `data` property must be present (oneof discriminator)',
  });

export const PartSchema = z.union([
  TextPartSchema,
  RawPartSchema,
  UrlPartSchema,
  DataPartSchema,
]);
export type Part = z.infer<typeof PartSchema>;

// ---------------------------------------------------------------------------
// Message — § 4.1.4
// ---------------------------------------------------------------------------

export const MessageSchema = z.object({
  messageId: z.string().min(1),
  role: RoleSchema,
  parts: z.array(PartSchema).min(1),
  contextId: z.string().optional(),
  /**
   * `taskId` — canonical A2A v1.0 resume reference. When set, the receiver
   * dispatches to the existing task (used for INPUT_REQUIRED / AUTH_REQUIRED
   * resume flows in Phase 2b). Phase 2a creates fresh tasks; the field
   * lands in the schema but isn't exercised yet.
   */
  taskId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  extensions: z.array(z.string()).optional(),
  referenceTaskIds: z.array(z.string()).optional(),
});

export type Message = z.infer<typeof MessageSchema>;

// ---------------------------------------------------------------------------
// TaskStatus — § 4.1.2
// ---------------------------------------------------------------------------

export const TaskStatusSchema = z.object({
  state: TaskStateSchema,
  /** Optional human-readable message accompanying the state. */
  message: MessageSchema.optional(),
  /** RFC 3339 / ISO 8601 timestamp of the last state change. */
  timestamp: z.string().optional(),
});

export type TaskStatus = z.infer<typeof TaskStatusSchema>;

// ---------------------------------------------------------------------------
// Task — § 4.1.1
// ---------------------------------------------------------------------------

export const TaskSchema = z.object({
  id: z.string().min(1),
  status: TaskStatusSchema,
  contextId: z.string().optional(),
  /** History of all messages exchanged on this task. */
  history: z.array(MessageSchema).optional(),
  /** Artifacts produced by the agent (responses, files, etc.). */
  artifacts: z.array(z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type Task = z.infer<typeof TaskSchema>;

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 envelope — § 9 (`method: "message/send"`)
// ---------------------------------------------------------------------------

/** JSON-RPC 2.0 request envelope. `id` is required for `message/send` (not a notification). */
export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.string().min(1),
  id: z.union([z.string(), z.number()]),
  params: z.unknown().optional(),
});

export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;

/** Params for `message/send` — wraps a Message. */
export const MessageSendParamsSchema = z.object({
  message: MessageSchema,
  /** Optional `configuration` / `metadata` keys per spec § 9.4.1 (not exercised in Phase 2a). */
  configuration: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type MessageSendParams = z.infer<typeof MessageSendParamsSchema>;

/**
 * JSON-RPC 2.0 success response envelope. `result` for `message/send`
 * is either a Task or a Message per spec § 9.4.1 — Phase 2a always
 * returns a Task (synchronous happy-path COMPLETED).
 */
export const JsonRpcSuccessResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]),
  result: TaskSchema,
});

export type JsonRpcSuccessResponse = z.infer<typeof JsonRpcSuccessResponseSchema>;

/**
 * JSON-RPC 2.0 error envelope. Per A2A v1.0 spec § 9 (and v1.0 change
 * notes), errors use the `google.rpc.Status` representation with
 * `ErrorInfo` extensions: `reason` in UPPER_SNAKE_CASE + domain
 * `"a2a-protocol.org"`.
 *
 * Standard JSON-RPC `code`/`message` + `data.reason`/`data.domain` for
 * the A2A-specific reason classification.
 */
export const JsonRpcErrorResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]),
  error: z.object({
    code: z.number(),
    message: z.string(),
    data: z
      .object({
        reason: z.string().optional(),
        domain: z.string().optional(),
      })
      .passthrough()
      .optional(),
  }),
});

export type JsonRpcErrorResponse = z.infer<typeof JsonRpcErrorResponseSchema>;

// ---------------------------------------------------------------------------
// JSON-RPC error code constants (spec § 9 + JSON-RPC 2.0 §5.1)
// ---------------------------------------------------------------------------

/** JSON-RPC 2.0 standard error codes. */
export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;

/** A2A-specific reason codes (UPPER_SNAKE_CASE per v1.0 § 9 ErrorInfo). */
export const A2A_ERROR_DOMAIN = 'a2a-protocol.org';
export const A2A_REASON_INVALID_MESSAGE = 'INVALID_MESSAGE';
export const A2A_REASON_TASK_NOT_FOUND = 'TASK_NOT_FOUND';
export const A2A_REASON_METHOD_NOT_SUPPORTED = 'METHOD_NOT_SUPPORTED';

/** Canonical JSON-RPC method string for the inbound message exchange (spec § 9 examples). */
export const A2A_METHOD_MESSAGE_SEND = 'message/send';

/** Canonical AgentCard.url path for this server's A2A endpoint. */
export const A2A_ENDPOINT_PATH = '/a2a/v1';
