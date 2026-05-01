/**
 * `checkpoint_to_memory` MCP tool implementation per macf#271 / DR-023 UC-3.
 *
 * Registered on the channel-server's MCP surface; called by Claude Code's
 * plugin loader when the `PreCompact` hook fires (per
 * `packages/macf/plugin/hooks/hooks.json`). The tool writes a structured
 * session-handoff entry to the agent's per-project memory directory
 * (`~/.claude/projects/<encoded-cwd>/memory/`) so the next session can
 * read the entry via the standard MEMORY.md index lookup pattern.
 *
 * Hook event: `PreCompact` (NOT `Stop`).
 *
 * The original macf#271 issue body framed UC-3 as a `Stop` hook. That
 * was wrong-cadence: per `feedback_stop_hook_fires_on_turn_end_not_session_exit.md`
 * + Claude Code 2.1.118+ behaviour, `Stop` fires after every LLM turn
 * completes, not at session exit / before compaction. `/exit` is a TUI-
 * local command and bypasses Stop hooks entirely. The natural trigger
 * for "synthesize before context loss" is `PreCompact` — fires before
 * BOTH `/compact` (manual) and auto-compaction. Confirmed in macf#271
 * comment exchange between code-agent + science-agent (2026-05-01);
 * DR-023 §UC-3 amendment in this PR codifies the resolution.
 *
 * Failure semantics (per DR-023 §UC-3 + §"Failure-mode contract"):
 *
 *   The hook layer is observational + non-blocking by default. Memory
 *   directory missing, file write failure, malformed input — all log a
 *   diagnostic event and return `{written: false, reason}` to the hook
 *   without raising. The caller (server.ts tool wrapper) returns
 *   `isError: false` regardless so the PreCompact event always proceeds.
 *   A failed checkpoint is recoverable: the operator can manually
 *   author a handoff entry post-compaction (the existing
 *   `synthesize-before-compaction` discipline).
 *
 *   Critically: the hook MUST NOT block compaction even on failure.
 *   PreCompact CAN block (`{decision: "block", reason}`) but the design
 *   choice here is observational — checkpoint is best-effort, missing
 *   one is a lost paragraph, not a safety violation.
 */
import { writeFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '@groundnuty/macf-core';
import { z } from 'zod';
import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { SpanNames, Attr, GenAiAttr } from './tracing.js';

export const CheckpointToMemoryInputSchema = {
  session_id: z.string().min(1)
    .describe('Claude Code session identifier (UUID). Substituted from PreCompact hook input ${session_id}.'),
  transcript_path: z.string().optional()
    .describe('Absolute path to session transcript (jsonl). Substituted from ${transcript_path}.'),
  cwd: z.string().min(1)
    .describe('Workspace directory the session is operating in. Substituted from ${cwd}. Used to resolve the per-project memory directory.'),
  trigger: z.enum(['manual', 'auto']).optional()
    .describe('What triggered compaction — "manual" (`/compact` invocation) or "auto" (token threshold). Substituted from PreCompact matcher.'),
  summary: z.string().optional()
    .describe('Optional human-authored synthesis text to embed in the checkpoint body. When omitted, a stub body is written with metadata only — the LLM can populate it post-compaction or operator can author manually.'),
} as const;

export const CheckpointToMemoryOutputSchema = {
  written: z.boolean()
    .describe('True if the checkpoint file was successfully written to disk.'),
  path: z.string().optional()
    .describe('Absolute path of the written or updated checkpoint file. Present when `written=true`.'),
  deduplicated: z.boolean()
    .describe('True if a pre-existing checkpoint for this session_id was updated (rather than a new file created).'),
  reason: z.string().optional()
    .describe('Diagnostic reason when `written=false`. Present on failure paths only.'),
} as const;

export interface CheckpointToMemoryDeps {
  readonly selfAgentName: string;
  readonly logger: Logger;
  /**
   * Override for `~/.claude/projects` location. Production code uses
   * `os.homedir()`; tests inject a temp dir. Optional — when absent,
   * defaults to `${HOME}/.claude/projects`.
   */
  readonly projectsRootOverride?: string;
  /**
   * Override for `new Date()` so dedup-naming is testable against
   * fixed dates. Production: undefined (uses real clock). Test: returns
   * a fixed Date.
   */
  readonly nowOverride?: () => Date;
}

export interface CheckpointToMemoryInput {
  readonly session_id: string;
  readonly transcript_path?: string;
  readonly cwd: string;
  readonly trigger?: 'manual' | 'auto';
  readonly summary?: string;
}

export interface CheckpointToMemoryResult {
  readonly written: boolean;
  readonly path?: string;
  readonly deduplicated: boolean;
  readonly reason?: string;
}

/**
 * Encode an absolute filesystem path into Claude Code's per-project
 * directory naming scheme used under `~/.claude/projects/`.
 *
 * Empirical scheme (verified by listing existing project dirs in the
 * env): every `/` is replaced with `-`. The resulting string is the
 * directory name; no other normalization is applied (case + spaces
 * preserved).
 */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

/**
 * Resolve the canonical memory directory for a given project cwd.
 * Pure function — does not touch the filesystem.
 */
export function resolveMemoryDir(cwd: string, projectsRoot: string): string {
  return join(projectsRoot, encodeProjectDir(cwd), 'memory');
}

/** Format YYYY_MM_DD per `project_session_handoff_<date>.md` convention. */
function formatDate(d: Date): string {
  const yyyy = d.getUTCFullYear().toString().padStart(4, '0');
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = d.getUTCDate().toString().padStart(2, '0');
  return `${yyyy}_${mm}_${dd}`;
}

/**
 * Look for a pre-existing checkpoint with the same `originSessionId`
 * in this memory directory. If found, return its absolute path so the
 * caller can OVERWRITE it (deduplication: PreCompact may fire multiple
 * times in a single session for sequential auto-compactions). If
 * not found, return undefined.
 *
 * Scans only files matching the `project_session_handoff_*.md` glob
 * to keep cost bounded (memory dirs accumulate ~50-100 entries; reading
 * all of them on every PreCompact would be wasteful).
 */
async function findExistingCheckpoint(
  memoryDir: string,
  sessionId: string,
): Promise<string | undefined> {
  let entries: ReadonlyArray<string>;
  try {
    entries = await readdir(memoryDir);
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.startsWith('project_session_handoff_') || !entry.endsWith('.md')) {
      continue;
    }
    const fullPath = join(memoryDir, entry);
    let body: string;
    try {
      body = await readFile(fullPath, 'utf8');
    } catch {
      continue;
    }
    // Frontmatter is YAML at top of file: ---\n...\n---
    // Look for `originSessionId: <sessionId>` line within first ~20
    // lines (frontmatter is short by convention).
    const head = body.split('\n', 25).join('\n');
    if (head.includes(`originSessionId: ${sessionId}`)) {
      return fullPath;
    }
  }
  return undefined;
}

/**
 * Build the checkpoint markdown body. Frontmatter follows the existing
 * `project_session_handoff_*.md` convention (verified against actual
 * memory entries: name, description, type=project, originSessionId).
 *
 * Body shape: when `summary` provided, embeds it directly. Without
 * summary, writes a minimal-stub body so the file is well-formed +
 * findable; future tools can append.
 *
 * Why ISO-8601 date in the description: matches the existing entries'
 * pattern (e.g., "2026-04-30 session handoff — three release cycles
 * (v0.2.5 → v0.2.7) ...") so the MEMORY.md index renders consistently
 * if/when an entry for this checkpoint is added.
 */
function buildCheckpointBody(
  input: CheckpointToMemoryInput,
  agentName: string,
  date: Date,
): string {
  const isoDate = date.toISOString();
  const dateOnly = formatDate(date).replace(/_/g, '-');
  const trigger = input.trigger ?? 'unknown';
  const transcriptLine = input.transcript_path !== undefined
    ? `\n- transcript: \`${input.transcript_path}\``
    : '';
  const description = `Auto-checkpoint written by ${agentName} on ${dateOnly} via PreCompact hook (trigger=${trigger}).`;
  const bodyContent = input.summary !== undefined && input.summary.length > 0
    ? input.summary
    : '_Auto-checkpoint stub — body not populated by hook input. The next session reads this frontmatter for session-id correlation; populate the body manually if a synthesis paragraph is needed._';

  return `---
name: ${dateOnly} session checkpoint (PreCompact auto-write)
description: ${description}
type: project
originSessionId: ${input.session_id}
---
**Auto-checkpoint** written by \`${agentName}\` at \`${isoDate}\` via PreCompact hook (DR-023 UC-3).

## Session metadata

- agent: \`${agentName}\`
- session_id: \`${input.session_id}\`
- cwd: \`${input.cwd}\`
- trigger: \`${trigger}\`${transcriptLine}

## Body

${bodyContent}
`;
}

/**
 * Tool body — resolves memory dir, dedups by session-id, writes file.
 *
 * Wrapped in OTel span `macf.tool.checkpoint_to_memory` (SpanKind.INTERNAL —
 * pure local filesystem op, no outbound network) per DR-023 telemetry
 * pattern. Span attributes mirror the input shape so checkpoint cadence
 * + outcome are visible in Tempo: trigger, deduplicated, written.
 *
 * Non-blocking: any error path resolves with `written: false` + a
 * `reason` string. Never throws to the caller. The caller (server.ts
 * tool wrapper) returns `isError: false` so PreCompact proceeds.
 */
export async function checkpointToMemory(
  deps: CheckpointToMemoryDeps,
  input: CheckpointToMemoryInput,
): Promise<CheckpointToMemoryResult> {
  const tracer = trace.getTracer('macf');
  return tracer.startActiveSpan(
    SpanNames.ToolCheckpointToMemory,
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        [GenAiAttr.System]: 'macf',
        [GenAiAttr.OperationName]: 'checkpoint_to_memory',
        [Attr.CheckpointTrigger]: input.trigger ?? 'unknown',
      },
    },
    async (span) => {
      try {
        const projectsRoot = deps.projectsRootOverride
          ?? join(homedir(), '.claude', 'projects');
        const memoryDir = resolveMemoryDir(input.cwd, projectsRoot);

        // Ensure dir exists. mkdir recursive is idempotent.
        try {
          await mkdir(memoryDir, { recursive: true });
        } catch (err) {
          const reason = `mkdir_failed: ${err instanceof Error ? err.message : String(err)}`;
          deps.logger.warn('checkpoint_mkdir_failed', {
            memory_dir: memoryDir,
            error: reason,
          });
          span.setAttribute(Attr.CheckpointWritten, false);
          span.setStatus({ code: SpanStatusCode.OK });
          return { written: false, deduplicated: false, reason };
        }

        // Dedup: if an existing entry has originSessionId === input.session_id,
        // overwrite it. Otherwise allocate a fresh path. Naming pattern matches
        // existing convention `project_session_handoff_<YYYY_MM_DD>.md`; if
        // multiple session-ids hit the same date, the second (and later) get
        // a short-session-id suffix to avoid collision.
        const existing = await findExistingCheckpoint(memoryDir, input.session_id);

        const now = (deps.nowOverride ?? (() => new Date()))();
        let targetPath: string;
        let deduplicated: boolean;
        if (existing !== undefined) {
          targetPath = existing;
          deduplicated = true;
        } else {
          deduplicated = false;
          const baseName = `project_session_handoff_${formatDate(now)}.md`;
          const base = join(memoryDir, baseName);
          // If `base` exists and belongs to a DIFFERENT session, suffix
          // with the first 8 chars of the session-id so two sessions in
          // a single calendar-date both land cleanly.
          let collides = false;
          try {
            const existingBody = await readFile(base, 'utf8');
            const head = existingBody.split('\n', 25).join('\n');
            // Different session-id already at the canonical path
            if (!head.includes(`originSessionId: ${input.session_id}`)) {
              collides = true;
            } else {
              // Same session-id; the readdir scan above should have caught
              // this — fallthrough to overwrite (defensive: still a write).
              targetPath = base;
              const body = buildCheckpointBody(input, deps.selfAgentName, now);
              await writeFile(targetPath, body, 'utf8');
              span.setAttribute(Attr.CheckpointWritten, true);
              span.setAttribute(Attr.CheckpointDeduplicated, true);
              span.setStatus({ code: SpanStatusCode.OK });
              deps.logger.info('checkpoint_written', {
                path: targetPath,
                session_id: input.session_id,
                deduplicated: 'true',
              });
              return { written: true, path: targetPath, deduplicated: true };
            }
          } catch {
            // ENOENT or read error → no collision; use base.
            collides = false;
          }
          if (collides) {
            const shortSid = input.session_id.slice(0, 8);
            targetPath = join(
              memoryDir,
              `project_session_handoff_${formatDate(now)}_${shortSid}.md`,
            );
          } else {
            targetPath = base;
          }
        }

        const body = buildCheckpointBody(input, deps.selfAgentName, now);
        try {
          await writeFile(targetPath, body, 'utf8');
        } catch (err) {
          const reason = `write_failed: ${err instanceof Error ? err.message : String(err)}`;
          deps.logger.warn('checkpoint_write_failed', {
            path: targetPath,
            error: reason,
          });
          span.setAttribute(Attr.CheckpointWritten, false);
          span.setStatus({ code: SpanStatusCode.OK });
          return { written: false, deduplicated, reason };
        }

        span.setAttribute(Attr.CheckpointWritten, true);
        span.setAttribute(Attr.CheckpointDeduplicated, deduplicated);
        span.setStatus({ code: SpanStatusCode.OK });
        deps.logger.info('checkpoint_written', {
          path: targetPath,
          session_id: input.session_id,
          deduplicated: deduplicated ? 'true' : 'false',
        });
        return { written: true, path: targetPath, deduplicated };
      } catch (err) {
        // Defense-in-depth: any unexpected throw inside the body still
        // surfaces as a non-blocking outcome to the caller.
        span.recordException(err as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        const reason = `unexpected_error: ${err instanceof Error ? err.message : String(err)}`;
        deps.logger.error('checkpoint_unexpected_error', {
          error: reason,
        });
        return { written: false, deduplicated: false, reason };
      } finally {
        span.end();
      }
    },
  );
}

// Suppress unused-import lint for `context` — kept for future
// trace-correlation use (parent-span handoff) symmetric with notify-peer.ts.
void context;
