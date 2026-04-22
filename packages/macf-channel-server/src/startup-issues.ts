/**
 * DEPRECATED (macf#192, 2026-04-22): the server no longer invokes
 * `checkPendingIssues` at boot. The prior call path hardcoded
 * `repo: 'groundnuty/macf', agentLabel: 'code-agent'`, which caused
 * cross-agent noise (every agent queried macf's code-agent issues at
 * startup regardless of identity).
 *
 * Replaced by the marketplace v0.1.7 `session-start-pickup.sh`
 * SessionStart hook, which queries per-agent-label across every
 * repo the agent's App installation covers (via
 * `gh api /installation/repositories`). Plugin-side is the right
 * layer for this — the agent's installation set is the single
 * source of truth for which repos are in scope; server-side code
 * doesn't need to know.
 *
 * This module remains exported for API back-compat — any external
 * consumer that imported `checkPendingIssues` via the public
 * `@macf/cli` index keeps working. Function may be removed in a
 * future major bump if no consumer surfaces.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Logger } from '@groundnuty/macf-core';

const execFileAsync = promisify(execFile);

interface PendingIssue {
  readonly number: number;
  readonly title: string;
}

/**
 * Query GitHub for open issues assigned to this agent and push
 * a startup_check notification for each one.
 *
 * @deprecated Not invoked by the server since macf#192. Use the
 *   marketplace plugin's `session-start-pickup.sh` SessionStart hook
 *   instead (handles per-agent-label + multi-repo installation
 *   enumeration correctly).
 */
export async function checkPendingIssues(config: {
  readonly repo: string;
  readonly agentLabel: string;
  readonly token: string;
  readonly onNotify: (payload: {
    readonly type: 'startup_check';
    readonly message: string;
    readonly issue_number: number;
    readonly title: string;
    readonly source: string;
  }) => Promise<void>;
  readonly logger: Logger;
}): Promise<void> {
  const { repo, agentLabel, token, onNotify, logger } = config;

  let issues: readonly PendingIssue[];
  try {
    const { stdout } = await execFileAsync('gh', [
      'issue', 'list',
      '--repo', repo,
      '--label', agentLabel,
      '--state', 'open',
      '--json', 'number,title',
    ], {
      encoding: 'utf-8',
      env: { ...process.env, GH_TOKEN: token },
    });

    issues = JSON.parse(stdout) as readonly PendingIssue[];
  } catch (err) {
    logger.warn('startup_issues_check_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (issues.length === 0) {
    logger.info('startup_issues_none', { repo, label: agentLabel });
    return;
  }

  logger.info('startup_issues_found', { count: issues.length });

  // One routing event per queued issue (#103 R1). Pre-fix, only the
  // first issue's metadata was delivered to the router — extras were
  // silently dropped. Sequential delivery matches the natural 1-issue-
  // 1-routing-event model and keeps the router's per-issue context
  // separate.
  for (const issue of issues) {
    await onNotify({
      type: 'startup_check',
      message: `Pending issue #${issue.number}: ${issue.title}`,
      issue_number: issue.number,
      title: issue.title,
      source: 'startup',
    });
  }
}
