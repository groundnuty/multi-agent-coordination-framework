/**
 * CLI-flag-wiring regression test for `--no-migrate-env-files` (macf#347).
 *
 * **The bug**: pre-#347 `index.ts` registered:
 *
 *     .option('--no-migrate-env-files', '...', false)  // ← explicit false default
 *
 * Commander's `--no-<flag>` convention auto-defaults `opts.migrateEnvFiles`
 * to `true` (migration enabled) so the flag can flip it to `false`. Adding
 * an explicit `false` 3rd-arg default CONFLICTS with that convention and
 * makes `opts.migrateEnvFiles` always-`false` regardless of whether the
 * flag is passed. The action handler's `noMigrateEnvFiles =
 * opts.migrateEnvFiles === false` then evaluates to `true` always —
 * migration block in `update.ts` skips on every invocation.
 *
 * Operator hit this on CV workspaces 2026-05-03; v0.2.18 multi-file env
 * layout shipped its surface but not its operator-facing benefit because
 * `macf update --all --yes` silently skipped the entire migration unit.
 *
 * **The fix**: omit the explicit 3rd-arg default. Commander's canonical
 * `--no-` semantic then holds.
 *
 * **What this test pins**:
 * - Default (no flag): `opts.migrateEnvFiles === true`
 * - With `--no-migrate-env-files`: `opts.migrateEnvFiles === false`
 * - Therefore `noMigrateEnvFiles = opts.migrateEnvFiles === false`
 *   correctly distinguishes the two cases
 *
 * If anyone re-adds `, false` (or `, true`) as a 3rd arg, the default-case
 * test fails immediately — caught at unit-test time, not when an operator
 * runs `macf update --all --yes` and discovers migration silently skipped.
 */
import { describe, it, expect } from 'vitest';
import { Command } from 'commander';

/**
 * Reproduces the option registration shape from `index.ts`'s `update`
 * subcommand. Kept inline (not imported) because importing index.ts
 * triggers `program.parse(process.argv)` at module load — too coupled to
 * test the registration in isolation. This duplication is intentional
 * and is caught by a sister test asserting the source forms match.
 */
function buildUpdateCommand(): Command {
  const program = new Command();
  program
    .command('update')
    // Canonical form per macf#347 — NO explicit 3rd-arg default.
    .option(
      '--no-migrate-env-files',
      'Skip the macf#342 monolithic→multi-file claude.sh migration AND env-file refresh (operator opt-out)',
    )
    .action(() => undefined);
  return program;
}

function parseOpts(program: Command, argv: readonly string[]): Record<string, unknown> {
  let captured: Record<string, unknown> = {};
  program.commands.find((c) => c.name() === 'update')?.action((opts) => {
    captured = { ...opts };
  });
  program.parse(['node', 'macf', 'update', ...argv]);
  return captured;
}

describe('macf update --no-migrate-env-files flag wiring (macf#347 regression)', () => {
  it('default (no flag): opts.migrateEnvFiles === true (commander --no- auto-default)', () => {
    const opts = parseOpts(buildUpdateCommand(), []);
    expect(opts.migrateEnvFiles).toBe(true);
  });

  it('--no-migrate-env-files passed: opts.migrateEnvFiles === false', () => {
    const opts = parseOpts(buildUpdateCommand(), ['--no-migrate-env-files']);
    expect(opts.migrateEnvFiles).toBe(false);
  });

  it('the action-handler translation correctly distinguishes the two cases', () => {
    // The action handler does: `const noMigrateEnvFiles = opts.migrateEnvFiles === false;`
    // Assert it returns the intuitive opt-out shape used inside update().
    const defaultOpts = parseOpts(buildUpdateCommand(), []);
    const flaggedOpts = parseOpts(buildUpdateCommand(), ['--no-migrate-env-files']);
    expect(defaultOpts.migrateEnvFiles === false).toBe(false);  // default → DON'T skip
    expect(flaggedOpts.migrateEnvFiles === false).toBe(true);   // flagged → SKIP
  });
});

describe('macf update --no-migrate-env-files registration source-shape (macf#347 regression)', () => {
  // Static regression guard: read the actual index.ts source and assert
  // the option line does NOT include an explicit 3rd-arg default. A
  // future edit that adds `, false` or `, true` as a default would
  // reintroduce the bug; this test fails immediately at unit-test time.
  it('option registration in index.ts has NO explicit 3rd-arg default', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const indexPath = fileURLToPath(new URL('../../src/cli/index.ts', import.meta.url));
    const source = readFileSync(indexPath, 'utf-8');

    // Match the option registration line and assert it's the 2-arg form.
    // Tolerates whitespace + line-wrapping. Captures the args inside the
    // `.option(...)` call.
    const match = source.match(
      /\.option\(\s*'--no-migrate-env-files',\s*'[^']+'(\s*,\s*[^)]+)?\s*\)/,
    );
    expect(match).not.toBeNull();
    // The 1st capture group is the optional 3rd arg. It MUST be undefined
    // (no 3rd arg). If anyone re-adds `, false` or `, true`, this fails.
    expect(match?.[1]).toBeUndefined();
  });
});
