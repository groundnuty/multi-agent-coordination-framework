/**
 * One-shot local-registry → GitHub-backed registry migration per
 * DR-024 §"Migration path — local → GitHub mode".
 *
 * Reads agent records from `~/.macf/registry/<project>.json` (or any
 * operator-supplied local-registry JSON file) and writes each into the
 * new registry via `createRegistryFromConfig`. The CA carries forward
 * separately — operators are expected to either re-run `macf certs init`
 * (publishes the new project's CA cert as a registry variable) or
 * preserve the existing CA via `--migrate-from` workflows on cert files.
 *
 * Migration is one-shot, one-direction (DR-024 §"Bi-directional sync —
 * explicitly out of scope"). Re-running on the same source is safe — every
 * write is idempotent (overwrites the same `<PROJECT>_AGENT_<NAME>`
 * variable).
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  AgentInfoSchema,
  createRegistryFromConfig,
  generateToken,
} from '@groundnuty/macf-core';
import type { AgentInfo } from '@groundnuty/macf-core';
import { tokenSourceFromConfig, readAgentConfig } from '../config.js';
import type { MacfAgentConfig } from '../config.js';

/**
 * Public-shape of the on-disk local-registry JSON. Mirrors
 * `RegistryFileSchema` from `@groundnuty/macf-core` but is re-declared here
 * so this command doesn't pull in a private-by-convention export. The
 * shape is stable per DR-024 §"File format" — `schema_version` 1 today.
 */
const LocalRegistryFileSchema = z.object({
  schema_version: z.literal(1),
  project: z.string().min(1),
  agents: z.record(z.string().min(1), AgentInfoSchema),
});

export type LocalRegistryFile = z.infer<typeof LocalRegistryFileSchema>;

/**
 * Read + validate a local-registry JSON file. Throws an actionable error
 * on missing file, malformed JSON, or schema mismatch. Exported for
 * tests + reuse.
 */
export function readLocalRegistryFile(path: string): LocalRegistryFile {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(`Local registry file not found: ${path}`, { cause: err });
    }
    throw new Error(
      `Failed to read local registry file ${path}: ${(err as Error).message}`,
      { cause: err },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Local registry file ${path} is not valid JSON: ${(err as Error).message}`,
      { cause: err },
    );
  }

  const result = LocalRegistryFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Local registry file ${path} does not match expected shape: ${result.error.message}`,
    );
  }

  return result.data;
}

/**
 * Migrate every agent record from a local-registry JSON file into the
 * GitHub-backed registry described by `targetRegistry`. The active agent
 * (the one running `macf init --migrate-from`) re-registers itself with
 * its own host/port at first launch — migration carries forward the
 * other peers' records.
 *
 * Token is minted from the just-written agent config (the new GitHub-mode
 * config has `github_app` populated). Each `register` call writes one
 * GitHub-Variables-API entry; failures on individual records surface as
 * thrown errors so operators see exactly which record didn't migrate.
 */
export async function migrateLocalToGitHub(
  workspaceDir: string,
  sourcePath: string,
  targetRegistry: MacfAgentConfig['registry'],
  project: string,
): Promise<void> {
  if (targetRegistry.type === 'local') {
    // Defense in depth — `validateInitOpts` rejects `--migrate-from` +
    // `--local`. If we ever reach this branch, surface the design
    // violation rather than silently no-op.
    throw new Error(
      'migrateLocalToGitHub called with a local target registry; this combination ' +
        'is rejected by validateInitOpts. Internal logic error.',
    );
  }

  const sourceFile = readLocalRegistryFile(sourcePath);

  if (sourceFile.project !== project) {
    process.stderr.write(
      `  Warning: source file's project "${sourceFile.project}" differs from ` +
        `target project "${project}". Records will be migrated under the target ` +
        `project's variable namespace; cross-check the agent names if mixing projects.\n`,
    );
  }

  // Mint token from the just-written agent config (read back so we
  // don't depend on the in-memory copy from initAgent's caller).
  const config = readAgentConfig(workspaceDir);
  if (!config) {
    throw new Error(
      `Cannot mint GitHub App token for migration — agent config at ${workspaceDir} not readable.`,
    );
  }
  if (!config.github_app) {
    throw new Error(
      'Migration target is GitHub-backed but agent config has no github_app block. ' +
        'Internal logic error — should have been caught upstream.',
    );
  }

  const token = await generateToken(tokenSourceFromConfig(workspaceDir, config));
  const registry = createRegistryFromConfig(targetRegistry, project, token);

  const entries = Object.entries(sourceFile.agents);
  console.log(`  Migrating ${entries.length} agent record(s) from ${sourcePath} → GitHub registry...`);

  let migrated = 0;
  const failures: Array<{ name: string; error: string }> = [];
  for (const [name, info] of entries) {
    try {
      await registry.register(name, info satisfies AgentInfo);
      migrated += 1;
    } catch (err) {
      failures.push({ name, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (failures.length > 0) {
    const detail = failures.map(f => `    - ${f.name}: ${f.error}`).join('\n');
    throw new Error(
      `Migrated ${migrated}/${entries.length} records; ${failures.length} failed:\n${detail}`,
    );
  }

  console.log(`  Migrated ${migrated}/${entries.length} agent record(s) to GitHub registry.`);
}
