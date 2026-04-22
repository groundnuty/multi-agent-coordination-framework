/**
 * Merge-preserving writer for `<workspace>/.claude/settings.json`.
 *
 * Per #140, the attribution-trap PreToolUse hook (`check-gh-token.sh`)
 * needs a settings.json entry to actually fire. Workspaces may have
 * operator-authored settings there already (other hooks, env vars,
 * model preferences) — this module reads the existing JSON (default
 * `{}`), installs the MACF hook entry, and writes back without
 * clobbering unrelated keys.
 *
 * Identification of MACF-managed entries is by command-string match
 * on the hook script's filename (`check-gh-token.sh`). A stale entry
 * from an older CLI version is refreshed in place; non-MACF entries
 * and other hook event types (SessionStart, Stop, etc.) are preserved
 * verbatim.
 *
 * Malformed settings.json throws — we refuse to silently overwrite
 * bad JSON because that would erase user content if they hand-edited
 * broken syntax.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * The command path written into settings.json. Workspace-relative so
 * it matches what `copyCanonicalScripts` places at
 * `<workspace>/.claude/scripts/check-gh-token.sh`.
 */
export const MACF_HOOK_COMMAND = '.claude/scripts/check-gh-token.sh';

/**
 * The hook filename used to identify MACF-managed entries on refresh.
 * Matched by path-end equality (see isMacfManagedCommand) so operator
 * files with a similar-but-distinct basename are not misclassified.
 */
const MACF_HOOK_FILENAME = 'check-gh-token.sh';

/**
 * True iff the command string represents our managed hook — i.e. the
 * command invokes a file whose basename equals MACF_HOOK_FILENAME
 * (ignoring any trailing flags/arguments). Defensive against
 * operator-authored commands that happen to contain our filename as a
 * substring (e.g. `./my-check-gh-token.sh-wrapper --flag`).
 */
function isMacfManagedCommand(command: string): boolean {
  // Take the program path (first whitespace-delimited token), then
  // extract its basename. `/a/b/check-gh-token.sh --v2` → `check-gh-token.sh`.
  const program = command.trim().split(/\s+/)[0] ?? '';
  const slash = program.lastIndexOf('/');
  const basename = slash >= 0 ? program.slice(slash + 1) : program;
  return basename === MACF_HOOK_FILENAME;
}

interface HookCommand {
  readonly type: 'command';
  readonly command: string;
  readonly timeout?: number;
}

interface HookEntry {
  readonly matcher?: string;
  readonly hooks: readonly HookCommand[];
}

interface Settings {
  hooks?: {
    PreToolUse?: HookEntry[];
    [key: string]: HookEntry[] | undefined;
  };
  [key: string]: unknown;
}

function readSettings(path: string): Settings {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf-8');
  try {
    return JSON.parse(raw) as Settings;
  } catch (err) {
    throw new Error(
      `Refusing to overwrite malformed .claude/settings.json at ${path}: ${(err as Error).message}. ` +
        `Fix the JSON by hand, then re-run the command.`,
      { cause: err },
    );
  }
}

/**
 * Permission patterns pre-approving the 4 `macf-agent` plugin skills.
 * Without these, every first invocation of a skill (e.g. `/macf-status`
 * during the SessionStart auto-pickup hook) fires an interactive
 * approval dialog — blocking autonomy for the time operator takes to
 * click through. See macf#189 sub-item 2 (bilateral e2e demo friction
 * point: operator had to approve 4-5 dialogs per fresh workspace).
 *
 * Concrete patterns (not a wildcard `Skill(macf-agent:*)`): operator
 * deliberately installed the plugin at v0.1.N, so pre-trusting THE
 * SKILLS CURRENTLY KNOWN TO EXIST at this CLI version is safe. A
 * future plugin version adding new skills would need a `macf update`
 * run — which refreshes these patterns from the updated constant —
 * before the new skills auto-approve. Wildcard would auto-approve
 * anything shipped under the plugin namespace including future
 * unreviewed additions; we opt out of that security posture.
 *
 * Keep in lockstep with the 4 skills shipped by
 * `groundnuty/macf-marketplace/macf-agent/skills/`. When plugin adds
 * a skill, add its pattern here + bump CLI version.
 */
export const PLUGIN_SKILL_PERMISSIONS: readonly string[] = [
  'Skill(macf-agent:macf-status)',
  'Skill(macf-agent:macf-issues)',
  'Skill(macf-agent:macf-peers)',
  'Skill(macf-agent:macf-ping)',
];

/**
 * Sandbox filesystem read-allow pattern for Claude Code's Bash-tool
 * harness. Every Bash invocation's spawned zsh reads `/proc/self/fd/3`
 * (or higher fds in future builds) for stdin / command-input passed
 * by the harness. Without this pattern in the sandbox allowlist, the
 * read is denied → `zsh:4: permission denied: /proc/self/fd/3` →
 * every Bash tool call fails (or falls back to
 * `dangerouslyDisableSandbox`, defeating isolation). Hit every MACF
 * agent before macf#200.
 *
 * The `**` glob is future-proof — current builds use fd 3; future
 * builds may use 4, 5, etc. Still scoped to the calling process's
 * own descriptors, not a broader `/proc/*` allowance.
 */
export const SANDBOX_FD_READ_PATTERN = '/proc/self/fd/**';

/**
 * Install (or refresh) the `/proc/self/fd/**` entry in
 * `.claude/settings.json`'s `sandbox.filesystem.allowRead` array.
 * Creates each nested key if absent. Idempotent — repeated calls
 * don't duplicate. Operator-authored `allowRead` entries are
 * preserved.
 *
 * Opt-out: if `MACF_SANDBOX_FD_FIX_SKIP` is `1` or `true` at call
 * time (during `macf init` / `macf update`), no change is made. Lets
 * operators manage their own sandbox block entirely. Accepts both
 * shapes to stay aligned with `MACF_OTEL_DISABLED` (see
 * `claude-sh.ts` — same family of opt-out env knobs).
 *
 * See macf#200.
 */
export function installSandboxFdAllowRead(workspaceDir: string): void {
  const skip = process.env['MACF_SANDBOX_FD_FIX_SKIP'];
  if (skip === '1' || skip === 'true') return;

  const absDir = resolve(workspaceDir);
  const claudeDir = join(absDir, '.claude');
  const path = join(claudeDir, 'settings.json');

  mkdirSync(claudeDir, { recursive: true });

  const settings = readSettings(path);
  // Narrow the deep-nested read; operator-authored alien shapes at
  // any level default to a fresh empty branch rather than throwing.
  const sandboxRaw = (settings['sandbox'] as Record<string, unknown> | undefined) ?? {};
  const filesystemRaw = (sandboxRaw['filesystem'] as Record<string, unknown> | undefined) ?? {};
  const existingAllow = Array.isArray(filesystemRaw['allowRead'])
    ? (filesystemRaw['allowRead'] as readonly unknown[]).filter((v): v is string => typeof v === 'string')
    : [];

  if (existingAllow.includes(SANDBOX_FD_READ_PATTERN)) return;

  const updated: Settings = {
    ...settings,
    sandbox: {
      ...sandboxRaw,
      filesystem: {
        ...filesystemRaw,
        allowRead: [...existingAllow, SANDBOX_FD_READ_PATTERN],
      },
    },
  };

  writeFileSync(path, JSON.stringify(updated, null, 2) + '\n');
}

/**
 * Pattern that identifies MACF-managed skill-permission entries on
 * refresh. Any pattern starting with `Skill(macf-agent:` is
 * considered ours; mismatches are preserved verbatim.
 */
const MACF_SKILL_PATTERN_PREFIX = 'Skill(macf-agent:';

/**
 * Install (or refresh) the MACF plugin-skill pre-approval entries in
 * `.claude/settings.json`'s `permissions.allow` array. Idempotent:
 * stale entries (e.g. from a prior CLI version that listed a since-
 * removed skill) are dropped + replaced with the current set.
 * Non-MACF entries in `permissions.allow` are preserved.
 *
 * Creates the `.claude/` directory + settings.json if missing.
 */
export function installPluginSkillPermissions(workspaceDir: string): void {
  const absDir = resolve(workspaceDir);
  const claudeDir = join(absDir, '.claude');
  const path = join(claudeDir, 'settings.json');

  mkdirSync(claudeDir, { recursive: true });

  const settings = readSettings(path);
  const existingAllow = Array.isArray(settings['permissions'] && (settings['permissions'] as { allow?: unknown })['allow'])
    ? ((settings['permissions'] as { allow: readonly string[] }).allow)
    : [];

  // Drop any prior Skill(macf-agent:*) entries so we install the
  // current list fresh (handles "skill was removed in plugin v0.1.N"
  // case — otherwise the stale pre-approval lingers forever).
  const preserved = existingAllow.filter(
    (entry) => typeof entry !== 'string' || !entry.startsWith(MACF_SKILL_PATTERN_PREFIX),
  );

  const allow: string[] = [...preserved, ...PLUGIN_SKILL_PERMISSIONS];

  const existingPermissions = (settings['permissions'] as Record<string, unknown> | undefined) ?? {};
  const updated: Settings = {
    ...settings,
    permissions: {
      ...existingPermissions,
      allow,
    },
  };

  writeFileSync(path, JSON.stringify(updated, null, 2) + '\n');
}

/**
 * Install (or refresh) the MACF PreToolUse hook entry for
 * `check-gh-token.sh` in `<workspaceDir>/.claude/settings.json`.
 * Creates the `.claude/` directory and the file if either is missing.
 *
 * Idempotent: repeated calls don't duplicate the entry.
 */
export function installGhTokenHook(workspaceDir: string): void {
  const absDir = resolve(workspaceDir);
  const claudeDir = join(absDir, '.claude');
  const path = join(claudeDir, 'settings.json');

  mkdirSync(claudeDir, { recursive: true });

  const settings = readSettings(path);
  const hooks = settings.hooks ?? {};
  const preToolUse = hooks.PreToolUse ?? [];

  // Drop any prior MACF-managed entries so we can replace them cleanly
  // — guards against stale flags (e.g. `--old-flag`) from older CLI
  // versions. Match by path-end equality so an operator-authored file
  // with a similar-but-distinct name (e.g. `my-check-gh-token.sh-helper.sh`)
  // doesn't get misclassified as ours and accidentally clobbered.
  const preserved = preToolUse.filter(
    (entry) => !entry.hooks.some((h) => isMacfManagedCommand(h.command)),
  );

  const macfEntry: HookEntry = {
    matcher: 'Bash',
    hooks: [{ type: 'command', command: MACF_HOOK_COMMAND }],
  };

  const updated: Settings = {
    ...settings,
    hooks: {
      ...hooks,
      PreToolUse: [...preserved, macfEntry],
    },
  };

  writeFileSync(path, JSON.stringify(updated, null, 2) + '\n');
}
