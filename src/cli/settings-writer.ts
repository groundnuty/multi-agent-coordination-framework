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
 * The hook filename used to identify MACF-managed entries on refresh
 * (so older entries with different flags or paths get replaced
 * cleanly).
 */
const MACF_HOOK_FILENAME = 'check-gh-token.sh';

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

  // Drop any prior MACF-managed entries (identified by containing our
  // hook filename somewhere in a command string) so we can replace
  // them cleanly — guards against stale flags from older CLI versions.
  const preserved = preToolUse.filter(
    (entry) => !entry.hooks.some((h) => h.command.includes(MACF_HOOK_FILENAME)),
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
