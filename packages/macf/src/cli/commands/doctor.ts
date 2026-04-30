/**
 * macf doctor — verify the workspace's bot token satisfies the MACF App
 * permission doctrine (DR-019).
 *
 * GitHub's installation-token response body includes the permissions
 * granted to the installation, so we don't need to probe individual
 * endpoints: one `gh token generate` (without --token-only) gives us
 * the full permission map. Compare against the required set; print a
 * formatted checklist; exit 0 if satisfied, 1 if not.
 *
 * This is the automated counterpart to DR-019's manual verification
 * section. Run at onboarding time or whenever routing breaks for a
 * reason that smells like a missing permission (401 on a specific
 * endpoint while others work — see coordination.md Token & Git Hygiene
 * for the attribution-trap class this prevents).
 */
import { execFileSync } from 'node:child_process';
import { readAgentConfig, tokenSourceFromConfig } from '../config.js';
import {
  getPermissionsAllow,
  getPermissionsDeny,
  getSandboxAllowRead,
  SANDBOX_FD_READ_PATTERN,
} from '../settings-writer.js';

/**
 * One required permission entry from DR-019.
 */
export interface RequiredPermission {
  readonly name: string;
  readonly level: 'read' | 'write';
  readonly why: string;
}

/**
 * DR-019 permission doctrine. Keep in sync with
 * design/decisions/DR-019-app-permissions.md and
 * templates/macf-app-manifest.json.
 *
 * Names here are GitHub's CANONICAL API names (as returned by
 * `GET /app/installations/:id` in the `permissions` field), which
 * differ from the App settings UI labels for some entries — notably
 * Variables → `actions_variables`. We use canonical names everywhere
 * to avoid false negatives (an installation with `actions_variables`
 * would be flagged as missing `variables` if we used the UI label).
 */
export const MACF_REQUIRED_PERMISSIONS: readonly RequiredPermission[] = [
  { name: 'metadata',          level: 'read',  why: 'Mandatory by GitHub — cannot be omitted' },
  { name: 'contents',          level: 'write', why: 'Push commits, PRs to feature branches' },
  { name: 'issues',            level: 'write', why: 'Comment, label, edit issues — primary coordination surface' },
  { name: 'pull_requests',     level: 'write', why: 'Create/merge PRs, submit reviews' },
  { name: 'actions_variables', level: 'write', why: 'Agent registry lives in repo/org/user variables (UI label: Variables)' },
  { name: 'workflows',         level: 'write', why: 'macf repo-init writes .github/workflows/' },
  { name: 'actions',           level: 'read',  why: 'gh run list / view --log-failed for self-debug' },
];

export interface DoctorFinding {
  /** Missing: the token has no entry at all for this permission. */
  readonly missing: readonly RequiredPermission[];
  /** Present but at a lower level than required (`read` where we want `write`). */
  readonly insufficient: readonly {
    readonly required: RequiredPermission;
    readonly actual: string;
  }[];
}

/**
 * Pure comparison: given the actual permission map from a token response,
 * return what's missing or insufficient against MACF_REQUIRED_PERMISSIONS.
 */
export function diffPermissions(actual: Readonly<Record<string, string>>): DoctorFinding {
  const missing: RequiredPermission[] = [];
  const insufficient: { required: RequiredPermission; actual: string }[] = [];
  for (const req of MACF_REQUIRED_PERMISSIONS) {
    const actualLevel = actual[req.name];
    if (!actualLevel) {
      missing.push(req);
      continue;
    }
    // 'write' required but only 'read' granted is a gap; the reverse
    // ('read' required with 'write' granted) is fine — user exceeds.
    if (req.level === 'write' && actualLevel === 'read') {
      insufficient.push({ required: req, actual: actualLevel });
    }
  }
  return { missing, insufficient };
}

/**
 * Symbol + label for the output table. Exported so tests can assert on it.
 */
export function formatPermissionRow(
  req: RequiredPermission,
  actual: string | undefined,
): string {
  const name = req.name.padEnd(15);
  const required = `${req.level}`.padEnd(6);
  if (!actual) {
    return `✗ ${name} required=${required} actual=MISSING    — ${req.why}`;
  }
  const actualStr = actual.padEnd(6);
  if (req.level === 'write' && actual === 'read') {
    return `⚠ ${name} required=${required} actual=${actualStr} — need write, have read`;
  }
  return `✓ ${name} required=${required} actual=${actualStr}`;
}

/**
 * Result of the sandbox-filesystem check (macf#202). PASS iff the
 * workspace's `.claude/settings.json` has `/proc/self/fd` in
 * `sandbox.filesystem.allowRead`. FAIL if absent, or if reading the
 * file threw (malformed JSON → we don't silently report PASS).
 *
 * Note: an earlier CLI version wrote `/proc/self/fd/**` (glob) which
 * the sandbox treated as a literal — silently didn't match; macf#208
 * corrected the pattern to bare `/proc/self/fd`.
 */
export interface SandboxFdCheck {
  readonly status: 'PASS' | 'FAIL';
  /** Human-readable diagnostic — e.g. JSON parse error message. Empty on PASS. */
  readonly detail: string;
}

/**
 * Pure check: does this workspace's `.claude/settings.json` contain
 * the `/proc/self/fd` sandbox pattern? See macf#200 for why this
 * matters (without it every Bash tool call fails on the harness fd),
 * and macf#208 for why the pattern is bare (not a glob).
 *
 * Uses `getSandboxAllowRead` from `settings-writer.ts` so the JSON-
 * read + deep-narrow logic lives in one place. Malformed JSON
 * surfaces as a FAIL with the parse error in `detail` — operator
 * still needs to see what broke.
 */
export function checkSandboxFdAllowRead(workspaceDir: string): SandboxFdCheck {
  let allowRead: readonly string[];
  try {
    allowRead = getSandboxAllowRead(workspaceDir);
  } catch (err) {
    return { status: 'FAIL', detail: err instanceof Error ? err.message : String(err) };
  }
  if (allowRead.includes(SANDBOX_FD_READ_PATTERN)) {
    return { status: 'PASS', detail: '' };
  }
  return {
    status: 'FAIL',
    detail: `allowRead does not contain ${SANDBOX_FD_READ_PATTERN} — run \`macf update\` to refresh`,
  };
}

/**
 * Tools whose absence from `permissions.allow` blocks autonomous
 * coordination — Claude Code prompts the operator on each first
 * invocation, stalling agents that can't dismiss the prompt.
 *
 * Surfaced empirically during cv-e2e-test rehearsal #11b
 * (2026-04-30): cv-architect on `groundnuty/academic-resume` blocked
 * mid-test on a Write tool prompt because the workspace's
 * `permissions.allow` lacked `Write`. Sister CV agent
 * `cv-project-archaeologist` had the entry; this was operator-
 * authored drift.
 */
export const AUTONOMY_REQUIRED_TOOLS: readonly string[] = ['Write', 'Edit'];

/**
 * Returns true if `allow` grants the named tool unrestricted use:
 *   - Bare tool name (`"Write"`) — Claude Code's "tool only" form
 *   - Glob form (`"Write(*)"`)
 *
 * Scoped patterns like `Write(/specific/path)` are NOT considered
 * "fully present" — they cover only that path; calls to other paths
 * still prompt. Conservative-by-design: an operator with scoped Write
 * still gets a warning that surfaces the partial coverage.
 */
export function isToolFullyAllowed(allow: readonly string[], tool: string): boolean {
  return allow.includes(tool) || allow.includes(`${tool}(*)`);
}

/**
 * Returns true if `deny` has any entry referencing the named tool —
 * either bare (`"Write"`) or scoped (`"Write(/path)"`). Used to
 * contextualise an allow-list gap as deliberate (security-driven,
 * common in operator-restricted workspaces) rather than accidental
 * drift. Soft signal — doctor still warns, just with a different
 * framing.
 */
export function hasToolDeny(deny: readonly string[], tool: string): boolean {
  for (const entry of deny) {
    if (entry === tool || entry.startsWith(`${tool}(`)) return true;
  }
  return false;
}

/**
 * One per-tool finding from the permissions-allow check.
 *
 * `severity`:
 *   - `WARN` — tool absent but Bash fallback exists (Edit absent, OR
 *     Write absent + Bash present). Autonomous coordination still works
 *     for code paths that use Bash; tool-using paths prompt.
 *   - `INFO` — tool absent AND deny rule exists. Treated as deliberate
 *     operator decision (security posture) rather than drift. Surfaces
 *     the gap so it's visible, but doesn't recommend fix.
 *   - `BLOCK` — tool absent AND no fallback (Write + Edit + Bash all
 *     absent). Autonomous coordination fails entirely on first agentic
 *     file op.
 *
 * Doctor exit code is unchanged by this check (per #296 AC: warn-only,
 * no error). Severity drives output formatting + remediation suggestion.
 */
export interface PermissionFinding {
  readonly tool: string;
  readonly severity: 'WARN' | 'INFO' | 'BLOCK';
  readonly hasBashFallback: boolean;
  readonly hasDenyRule: boolean;
  readonly message: string;
  readonly remediation: string;
}

/**
 * Result of the permissions-allow check (macf#296). `findings` lists
 * one entry per missing autonomy-required tool; `status` summarises
 * across them — `PASS` if no findings, `WARN` if any non-INFO finding,
 * `INFO` if all findings are deliberate-deny cases.
 */
export interface PermissionsAllowCheckResult {
  readonly status: 'PASS' | 'WARN' | 'INFO';
  readonly findings: readonly PermissionFinding[];
  /** Set when the JSON was malformed; `findings` will be empty. */
  readonly readError?: string;
}

/**
 * Check that `permissions.allow` grants the autonomy-required tools
 * (`Write`, `Edit`). For each absent tool, build a `PermissionFinding`
 * with severity tuned to the failure mode (BLOCK if no Bash fallback,
 * WARN if Bash works, INFO if a deny rule signals deliberate scope).
 *
 * Sister CV reference: cv-project-archaeologist's settings.json has
 * Write+Edit; academic-resume drifted without them. Surfaces here at
 * health-check time rather than mid-coordination block.
 *
 * Schema reference: Claude Code permissions.allow accepts both bare
 * tool names ("Write") and patterned forms ("Write(*)", "Write(/path)").
 * Verified against the canonical settings.json schema documented in
 * Claude Code's update-config skill (stable form across recent versions).
 */
export function checkPermissionsAllow(workspaceDir: string): PermissionsAllowCheckResult {
  let allow: readonly string[];
  let deny: readonly string[];
  try {
    allow = getPermissionsAllow(workspaceDir);
    deny = getPermissionsDeny(workspaceDir);
  } catch (err) {
    return {
      status: 'WARN',
      findings: [],
      readError: err instanceof Error ? err.message : String(err),
    };
  }

  const hasBashFallback = isToolFullyAllowed(allow, 'Bash');
  const findings: PermissionFinding[] = [];

  for (const tool of AUTONOMY_REQUIRED_TOOLS) {
    if (isToolFullyAllowed(allow, tool)) continue;

    const hasDenyRule = hasToolDeny(deny, tool);
    const isWrite = tool === 'Write';

    let severity: PermissionFinding['severity'];
    let message: string;
    if (hasDenyRule) {
      severity = 'INFO';
      message =
        `${tool} absent from permissions.allow; deny rule present — likely deliberate scope ` +
        `(security posture). Autonomous file ops via ${tool} will prompt; agents can fall ` +
        `back to Bash where allowed.`;
    } else if (isWrite && !hasBashFallback) {
      severity = 'BLOCK';
      message =
        `Write absent AND Bash absent — autonomous file creation impossible. ` +
        `Agents will block on every Write/Bash invocation waiting for operator click-through.`;
    } else {
      severity = 'WARN';
      message =
        `${tool} absent from permissions.allow — autonomous ${tool} tool calls fire interactive ` +
        `permission prompts. Sister CV agent cv-project-archaeologist has this entry; if this ` +
        `workspace is also a CV/coordination consumer, the gap is likely operator-authored drift ` +
        `(empirical incident: cv-e2e-test rehearsal #11b 2026-04-30).` +
        (isWrite ? ' Bash fallback is present, so file-write via shell still works (degraded autonomy).' : '');
    }

    const remediation =
      `Add to .claude/settings.json under permissions.allow: "${tool}" (bare; allows all paths) ` +
      `OR "${tool}(*)" (glob form). For scoped use, prefer "${tool}(/path/*)" patterns + matching ` +
      `deny rules for sensitive paths.`;

    findings.push({
      tool,
      severity,
      hasBashFallback,
      hasDenyRule,
      message,
      remediation,
    });
  }

  if (findings.length === 0) return { status: 'PASS', findings: [] };
  const allInfo = findings.every((f) => f.severity === 'INFO');
  return { status: allInfo ? 'INFO' : 'WARN', findings };
}

/**
 * Format a non-leaking error message when `gh token generate --jwt` returns
 * output that doesn't look like a JWT. Shows only the first 6 characters
 * plus length — enough to distinguish empty / error-message / binary-garbage
 * / genuinely-wrong-prefix, without exposing credential material if the
 * branch fires on a genuinely-valid JWT due to a locale/whitespace/plugin
 * edge case. See #86. Exported for unit tests.
 */
export function describeNonJwtOutput(jwt: string): string {
  const safePrefix = jwt.length > 0 ? jwt.slice(0, 6) : '(empty)';
  return (
    `gh token generate --jwt returned unexpected output ` +
    `(prefix='${safePrefix}', length=${jwt.length})`
  );
}

/**
 * Fetch the installation's GRANTED permissions by querying
 * `GET /app/installations/:id` with an App JWT. We do NOT use the
 * install-token response's `permissions` field here — it doesn't
 * surface all granted permissions (verified empirically: an App with
 * `actions_variables: write` may report an incomplete set in the
 * install-token response but the full set via JWT query). See
 * discussion on issue #74 for the evidence.
 */
export async function fetchInstallationPermissions(
  appId: string,
  installId: string,
  keyPath: string,
): Promise<Record<string, string>> {
  // Get a JWT signed with the App's private key. `gh token generate --jwt`
  // does the RS256 signing for us, avoiding a Node crypto reimplementation.
  let jwt: string;
  try {
    jwt = execFileSync('gh', [
      'token', 'generate',
      '--app-id', appId,
      '--key', keyPath,
      '--jwt',
      '--token-only',
    ], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `gh token generate --jwt failed: ${msg}. ` +
      `See coordination.md Token & Git Hygiene for diagnostics.`,
      { cause: err },
    );
  }
  if (!jwt.startsWith('eyJ')) {
    throw new Error(describeNonJwtOutput(jwt));
  }

  const response = await fetch(`https://api.github.com/app/installations/${installId}`, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '<no body>');
    throw new Error(
      `GET /app/installations/${installId} returned ${response.status}: ${body.slice(0, 200)}`,
    );
  }
  const parsed = (await response.json()) as { permissions?: unknown };
  if (!parsed.permissions || typeof parsed.permissions !== 'object') {
    throw new Error('/app/installations/:id response missing `permissions` field');
  }
  return parsed.permissions as Record<string, string>;
}

/**
 * Main entry for `macf doctor`. Returns the shell exit code: 0 if all
 * required permissions are present, 1 if any are missing or insufficient.
 */
export async function runDoctor(projectDir: string): Promise<number> {
  const config = readAgentConfig(projectDir);
  if (!config) {
    console.error('No macf-agent.json found. Run `macf init` first.');
    return 1;
  }

  const source = tokenSourceFromConfig(projectDir, config);
  let permissions: Record<string, string>;
  try {
    permissions = await fetchInstallationPermissions(
      source.appId, source.installId, source.keyPath,
    );
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const finding = diffPermissions(permissions);

  console.log('MACF doctor report');
  console.log('──────────────────────────────────────────────────────────────');
  for (const req of MACF_REQUIRED_PERMISSIONS) {
    console.log(`  ${formatPermissionRow(req, permissions[req.name])}`);
  }
  console.log('');

  const totalRequired = MACF_REQUIRED_PERMISSIONS.length;
  const satisfied = totalRequired - finding.missing.length - finding.insufficient.length;
  const status = finding.missing.length === 0 && finding.insufficient.length === 0
    ? '✓ all required permissions present'
    : `✗ ${finding.missing.length + finding.insufficient.length} of ${totalRequired} required permissions missing or insufficient`;
  console.log(`  ${status} (${satisfied}/${totalRequired} satisfied)`);

  if (finding.missing.length > 0) {
    console.log('');
    console.log('Missing:');
    for (const req of finding.missing) {
      console.log(`  - ${req.name}: ${req.level} — ${req.why}`);
    }
  }
  if (finding.insufficient.length > 0) {
    console.log('');
    console.log('Insufficient:');
    for (const { required, actual } of finding.insufficient) {
      console.log(`  - ${required.name}: have ${actual}, need ${required.level} — ${required.why}`);
    }
  }

  if (finding.missing.length > 0 || finding.insufficient.length > 0) {
    console.log('');
    console.log('See design/decisions/DR-019-app-permissions.md for the full doctrine,');
    console.log('and GitHub → Settings → Developer settings → GitHub Apps → <your App> → Permissions');
    console.log('to update the App. Users with the App installed must accept the new permissions.');
  }

  console.log('');
  console.log('Sandbox filesystem (macf#200)');
  console.log('──────────────────────────────────────────────────────────────');
  const sandboxCheck = checkSandboxFdAllowRead(projectDir);
  if (sandboxCheck.status === 'PASS') {
    console.log(`  ✓ sandbox.filesystem.allowRead contains ${SANDBOX_FD_READ_PATTERN}  [PASS]`);
  } else {
    console.log(`  ✗ sandbox.filesystem.allowRead missing ${SANDBOX_FD_READ_PATTERN}   [FAIL — run \`macf update\` to fix]`);
    if (sandboxCheck.detail) console.log(`    ${sandboxCheck.detail}`);
  }

  console.log('');
  console.log('Workspace permissions (macf#296)');
  console.log('──────────────────────────────────────────────────────────────');
  const permsCheck = checkPermissionsAllow(projectDir);
  if (permsCheck.readError) {
    console.log(`  ⚠ could not parse .claude/settings.json: ${permsCheck.readError}`);
  } else if (permsCheck.status === 'PASS') {
    console.log(`  ✓ permissions.allow grants Write + Edit (autonomous coordination unblocked)  [PASS]`);
  } else {
    const summary = permsCheck.status === 'INFO'
      ? `ℹ ${permsCheck.findings.length} autonomy-required tool(s) absent (deny rules present — likely deliberate)  [INFO]`
      : `⚠ ${permsCheck.findings.length} autonomy-required tool(s) absent or scoped  [WARN]`;
    console.log(`  ${summary}`);
    for (const f of permsCheck.findings) {
      const symbol = f.severity === 'BLOCK' ? '✗' : (f.severity === 'WARN' ? '⚠' : 'ℹ');
      console.log(`    ${symbol} ${f.tool}: ${f.message}`);
      console.log(`      Fix: ${f.remediation}`);
    }
  }

  const permissionsFailed = finding.missing.length > 0 || finding.insufficient.length > 0;
  const sandboxFailed = sandboxCheck.status === 'FAIL';
  return permissionsFailed || sandboxFailed ? 1 : 0;
}
