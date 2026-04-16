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
    return 1;
  }

  return 0;
}
