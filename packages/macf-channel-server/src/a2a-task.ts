/**
 * A2A v1.0 task lifecycle state machine + in-memory `TaskStore`.
 *
 * Per spec § 4.1.1–4.1.3 (Task / TaskStatus / TaskState). State machine
 * declares all v1.0 transitions; Phase 2a exercises only the happy-path
 * subset (SUBMITTED → WORKING → COMPLETED). Phase 2b will exercise
 * INPUT_REQUIRED / AUTH_REQUIRED + resume via `Message.taskId`.
 *
 * **Persistence**: in-memory only for Phase 2 (per design decision 2 on
 * macf#390). `Map<taskId, Task>` indexed by UUIDv4. Process-exit sweep
 * is implicit (no on-disk state). Phase 2.5 sub-issue if longer-lived
 * persistence becomes a need.
 *
 * **Transition validation**: `transition()` rejects illegal moves
 * (e.g., COMPLETED → WORKING). Sister-shape to Pattern A from
 * `silent-fallback-hazards.md` — result-invariant on the state field,
 * not just exit-code success. The state machine is the authoritative
 * source for "what's allowed."
 */
import { randomUUID } from 'node:crypto';
import type { Task, TaskState, Message } from './a2a-types.js';
import { TERMINAL_TASK_STATES } from './a2a-types.js';

// ---------------------------------------------------------------------------
// Transition table — per A2A v1.0 § 4.1.3 (TaskState + lifecycle text)
// ---------------------------------------------------------------------------

/**
 * Map of from-state → set of legal to-states.
 *
 * v1.0 canonical transitions:
 *
 *   SUBMITTED       → WORKING | REJECTED | CANCELED | FAILED
 *   WORKING         → COMPLETED | FAILED | CANCELED | INPUT_REQUIRED | AUTH_REQUIRED
 *   INPUT_REQUIRED  → WORKING | CANCELED | FAILED  (resume on Message.taskId)
 *   AUTH_REQUIRED   → WORKING | CANCELED | FAILED  (resume on Message.taskId after auth)
 *   COMPLETED       → (terminal — no transitions)
 *   FAILED          → (terminal)
 *   CANCELED        → (terminal)
 *   REJECTED        → (terminal)
 *
 * REJECTED is a terminal state introduced in v1.0 for "agent declined to
 * process" — distinct from FAILED (which is "agent tried + errored").
 */
const ALLOWED_TRANSITIONS: Readonly<Record<TaskState, ReadonlySet<TaskState>>> = {
  TASK_STATE_SUBMITTED: new Set<TaskState>([
    'TASK_STATE_WORKING',
    'TASK_STATE_REJECTED',
    'TASK_STATE_CANCELED',
    'TASK_STATE_FAILED',
  ]),
  TASK_STATE_WORKING: new Set<TaskState>([
    'TASK_STATE_COMPLETED',
    'TASK_STATE_FAILED',
    'TASK_STATE_CANCELED',
    'TASK_STATE_INPUT_REQUIRED',
    'TASK_STATE_AUTH_REQUIRED',
  ]),
  TASK_STATE_INPUT_REQUIRED: new Set<TaskState>([
    'TASK_STATE_WORKING',
    'TASK_STATE_CANCELED',
    'TASK_STATE_FAILED',
  ]),
  TASK_STATE_AUTH_REQUIRED: new Set<TaskState>([
    'TASK_STATE_WORKING',
    'TASK_STATE_CANCELED',
    'TASK_STATE_FAILED',
  ]),
  TASK_STATE_COMPLETED: new Set<TaskState>(),
  TASK_STATE_FAILED: new Set<TaskState>(),
  TASK_STATE_CANCELED: new Set<TaskState>(),
  TASK_STATE_REJECTED: new Set<TaskState>(),
};

/** True iff `from → to` is a legal transition per the v1.0 spec table. */
export function isTransitionAllowed(from: TaskState, to: TaskState): boolean {
  return ALLOWED_TRANSITIONS[from]?.has(to) ?? false;
}

/** Error class for illegal state transitions. */
export class InvalidTaskTransitionError extends Error {
  public readonly code = 'INVALID_TASK_TRANSITION';
  constructor(
    public readonly from: TaskState,
    public readonly to: TaskState,
    public readonly taskId: string,
  ) {
    super(`Illegal task transition ${from} → ${to} for task ${taskId}`);
    this.name = 'InvalidTaskTransitionError';
  }
}

// ---------------------------------------------------------------------------
// TaskStore — in-memory; Phase 2 scope
// ---------------------------------------------------------------------------

/**
 * In-memory task store. NOT durable across channel-server restarts;
 * Phase 2.5 will revisit if longer-lived persistence becomes a need.
 *
 * Concurrency: single-threaded Node.js event loop; no locking needed
 * between request handlers. Map operations are atomic per-event-loop-turn.
 */
export class TaskStore {
  readonly #tasks: Map<string, Task> = new Map();

  /**
   * Create a fresh task in SUBMITTED state. Returns the task; caller
   * is responsible for any subsequent transition.
   *
   * `contextId` is propagated from the inbound Message if present
   * (per spec § 4.1.4 — contextId associates with a conversational
   * group); otherwise undefined.
   */
  create(initialMessage: Message, opts: { readonly nowIso: string }): Task {
    const id = randomUUID();
    const task: Task = {
      id,
      status: {
        state: 'TASK_STATE_SUBMITTED',
        timestamp: opts.nowIso,
      },
      contextId: initialMessage.contextId,
      history: [initialMessage],
    };
    this.#tasks.set(id, task);
    return task;
  }

  /**
   * Look up a task by ID. Used for resume flows (Message.taskId set)
   * + idempotent retries. Returns `undefined` if no such task.
   */
  get(taskId: string): Task | undefined {
    return this.#tasks.get(taskId);
  }

  /**
   * Apply a state transition. Validates against the spec table; throws
   * `InvalidTaskTransitionError` on illegal moves. Returns the updated
   * task (mutated in-place + immutable references returned for callers).
   *
   * Side effect: updates `task.status.state` + `task.status.timestamp`.
   * `task.status.message` is set when the caller provides an
   * accompanying message (e.g., agent's response).
   */
  transition(
    taskId: string,
    to: TaskState,
    opts: { readonly nowIso: string; readonly message?: Message },
  ): Task {
    const task = this.#tasks.get(taskId);
    if (task === undefined) {
      throw new InvalidTaskTransitionError(
        'TASK_STATE_SUBMITTED',
        to,
        taskId,
      );
    }
    const from = task.status.state;
    if (!isTransitionAllowed(from, to)) {
      throw new InvalidTaskTransitionError(from, to, taskId);
    }
    const updated: Task = {
      ...task,
      status: {
        state: to,
        timestamp: opts.nowIso,
        ...(opts.message !== undefined ? { message: opts.message } : {}),
      },
      ...(opts.message !== undefined
        ? { history: [...(task.history ?? []), opts.message] }
        : {}),
    };
    this.#tasks.set(taskId, updated);
    return updated;
  }

  /** True iff a task's current state is terminal. */
  isTerminal(taskId: string): boolean {
    const task = this.#tasks.get(taskId);
    if (task === undefined) return false;
    return TERMINAL_TASK_STATES.has(task.status.state);
  }

  /** Diagnostic: count of currently-tracked tasks. */
  size(): number {
    return this.#tasks.size;
  }

  /**
   * Phase 2a helper: drive a fresh task through the happy path
   * SUBMITTED → WORKING → COMPLETED in one call. Returns the final
   * task. Used by the inbound `message/send` route when the message
   * is a non-resume submission with no intermediate-state needs.
   *
   * `responseMessage` is the agent's reply (role=ROLE_AGENT) attached
   * to the COMPLETED status. Phase 2b will replace this with a real
   * dispatch to MACF tooling that can return INPUT_REQUIRED.
   */
  completeHappyPath(
    initialMessage: Message,
    responseMessage: Message,
    opts: { readonly nowIso: string },
  ): Task {
    const created = this.create(initialMessage, opts);
    this.transition(created.id, 'TASK_STATE_WORKING', opts);
    return this.transition(created.id, 'TASK_STATE_COMPLETED', {
      nowIso: opts.nowIso,
      message: responseMessage,
    });
  }
}
