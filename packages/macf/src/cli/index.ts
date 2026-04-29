#!/usr/bin/env node
import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import { listAgents } from './commands/list.js';
import { cdAgent } from './commands/cd.js';
import { initAgent } from './commands/init.js';
import { update } from './commands/update.js';
import { showStatus } from './commands/status.js';
import { listPeers } from './commands/peers.js';
import { certsInit, certsRecover, certsRotate, issueRoutingClient } from './commands/certs.js';
import { repoInit } from './commands/repo-init.js';
import { rulesRefresh } from './commands/rules-refresh.js';
import { runDoctor } from './commands/doctor.js';
import { selfUpdate } from './commands/self-update.js';
import { findProjectRoot } from './config.js';
import { findCliPackageRoot } from './rules.js';
import { PACKAGE_VERSION } from '../package-version.js';

/**
 * Resolve the project directory for project-scoped commands.
 * Walks up from cwd looking for .macf/macf-agent.json. Exits with a clear
 * error if not found. Commands that bootstrap new projects (init, repo-init)
 * use `--dir` or cwd directly instead of this.
 */
function requireProjectRoot(): string {
  const dir = findProjectRoot(process.cwd());
  if (!dir) {
    console.error(
      'Not in a MACF project (no .macf/macf-agent.json found walking up from cwd).\n' +
      'Either cd into a project or run `macf init` first.',
    );
    process.exit(1);
  }
  return dir;
}

/**
 * Validate an explicit --dir value: resolve and confirm it contains
 * .macf/macf-agent.json. No walk-up — the user gave an exact path.
 */
function validateProjectDir(path: string): string {
  const abs = resolve(path);
  if (!existsSync(join(abs, '.macf', 'macf-agent.json'))) {
    console.error(`Not a MACF project: ${abs} has no .macf/macf-agent.json`);
    process.exit(1);
  }
  return abs;
}

/**
 * Resolve the project directory from either --dir (explicit) or auto-discovery.
 * Explicit --dir wins. Both paths exit with a clear error if no project is found.
 */
function resolveProjectDir(optsDir: string | undefined): string {
  return optsDir ? validateProjectDir(optsDir) : requireProjectRoot();
}

const program = new Command();

program
  .name('macf')
  .description('Multi-Agent Coordination Framework CLI')
  .version(PACKAGE_VERSION)
  .action(() => {
    listAgents();
  });

program
  .command('init')
  .description('Set up a project directory for an agent')
  .requiredOption('--project <name>', 'Project name (e.g., macf)')
  .requiredOption('--role <role>', 'Agent role (e.g., code-agent)')
  .option('--name <name>', 'Agent name (defaults to role)')
  .option('--type <type>', 'Agent type: permanent or worker', 'permanent')
  .requiredOption('--app-id <id>', 'GitHub App ID')
  .requiredOption('--install-id <id>', 'GitHub App Installation ID')
  .requiredOption('--key-path <path>', 'Path to GitHub App private key')
  .option('--registry-type <type>', 'Registry: org, profile, or repo', 'repo')
  .option('--registry-org <org>', 'Org name (for org registry)')
  .option('--registry-user <user>', 'User name (for profile registry)')
  .option('--registry-repo <repo>', 'owner/repo (for repo registry)')
  .option('--advertise-host <host>', 'Host the channel server advertises in its registry entry + includes in its cert SAN (e.g., Tailscale IP). Defaults to 127.0.0.1 when unset.')
  .option('--tmux-session <name>', 'Tmux session name for on-notify wake (macf#185). When set, channel server\'s /notify handler injects the prompt into this tmux session via tmux-send-to-claude.sh after the MCP push. If unset, auto-detects from $TMUX.')
  .option('--tmux-window <idx-or-name>', 'Tmux window index or name within the session (e.g., "0", "cv-architect"). Optional — defaults to the session\'s current window.')
  .option('--cli-version <semver>', 'Pin @macf/cli version (e.g., 0.1.0)')
  .option('--plugin-version <semver>', 'Pin macf-agent plugin version (e.g., 0.1.0)')
  .option('--actions-version <tag>', 'Pin macf-actions version (e.g., v1, v1.0.0)')
  .option('--dir <path>', 'Project directory (defaults to current working directory)')
  .action(async (opts) => {
    const projectDir = opts.dir ? resolve(opts.dir) : process.cwd();
    await initAgent(projectDir, {
      project: opts.project,
      role: opts.role,
      name: opts.name,
      type: opts.type,
      appId: opts.appId,
      installId: opts.installId,
      keyPath: opts.keyPath,
      registryType: opts.registryType,
      registryOrg: opts.registryOrg,
      registryUser: opts.registryUser,
      registryRepo: opts.registryRepo,
      advertiseHost: opts.advertiseHost,
      tmuxSession: opts.tmuxSession,
      tmuxWindow: opts.tmuxWindow,
      cliVersion: opts.cliVersion,
      pluginVersion: opts.pluginVersion,
      actionsVersion: opts.actionsVersion,
    });
  });

program
  .command('update')
  .description(
    'Refresh canonical assets + bump pinned versions. ' +
    'ALWAYS regenerates claude.sh, coordination rules, helper scripts, ' +
    'sandbox + hook entries from the installed CLI (template-evolution sync; ' +
    'independent of the --cli/--plugin/--actions selection). The flags below ' +
    'gate ONLY which version pins in macf-agent.json get bumped + when the ' +
    'plugin dir gets re-fetched. See `update --help` notes below for details.',
  )
  .addHelpText('after', `
Important — what gets refreshed UNCONDITIONALLY (independent of --cli/--plugin/--actions):
  - .claude/scripts/        helper scripts (macf-gh-token.sh, check-gh-token.sh, etc.)
  - .claude/rules/          coordination.md + other canonical rules
  - .claude/settings.json   gh-token PreToolUse hook + plugin-skill permissions +
                             sandbox.filesystem.allowRead + sandbox.excludedCommands
                             entries (merge-preserving — operator-authored entries kept)
  - claude.sh               regenerated from the installed CLI's launcher template
                             so template-evolution lands without re-running \`macf init\`
                             (e.g., #60 added --plugin-dir; #283 fixed retired :4318
                             OTLP endpoint). The generated file carries a managed-file
                             warning header.

What the flags actually control:
  --cli       bump versions.cli pin to latest
  --plugin    bump versions.plugin pin + re-fetch .macf/plugin/ if pin bumped
  --actions   bump versions.actions pin to latest
  --all       bump all three non-interactively
  --yes       skip per-pin confirmation prompts
  --dry-run   show diff + would-bump list, write nothing

Implication for reproducible bootstrap (cv-e2e-test, harness pinning, etc.):
  The CLI BINARY's installed version determines what claude.sh template lands.
  Pin via \`npx -y @groundnuty/macf@<version> update\` instead of bare \`macf update\`
  if the bootstrap needs to use a specific binary version (vs whatever brew/system
  has). See macf#291 for the surfacing context.
`)
  .option('--all', 'Bump all version pins non-interactively', false)
  .option('--cli', 'Bump only the CLI version pin', false)
  .option('--plugin', 'Bump only the plugin version pin (+ re-fetch .macf/plugin/ if bumped)', false)
  .option('--actions', 'Bump only the macf-actions version pin', false)
  .option('--yes', 'Skip per-pin confirmation prompts', false)
  .option('--dry-run', 'Show the diff but do not write the config', false)
  .option('--dir <path>', 'Project directory (defaults to auto-discovery from cwd)')
  .action(async (opts) => {
    const code = await update(resolveProjectDir(opts.dir), {
      all: opts.all,
      cli: opts.cli,
      plugin: opts.plugin,
      actions: opts.actions,
      yes: opts.yes,
      dryRun: opts.dryRun,
    });
    process.exitCode = code;
  });

program
  .command('status')
  .description('Ping all agents and show status')
  .option('--dir <path>', 'Scope to a specific project (defaults to all agents in global index)')
  .action(async (opts) => {
    const dir = opts.dir ? validateProjectDir(opts.dir) : undefined;
    await showStatus(dir);
  });

program
  .command('peers')
  .description('List peers from the registry')
  .option('--dir <path>', 'Scope to a specific project (defaults to all agents in global index)')
  .action(async (opts) => {
    const dir = opts.dir ? validateProjectDir(opts.dir) : undefined;
    await listPeers(dir);
  });

const certs = program
  .command('certs')
  .description('Certificate management');

certs
  .command('init')
  .description('Create CA certificate and upload to registry')
  .option('--dir <path>', 'Project directory (defaults to auto-discovery from cwd)')
  .action(async (opts) => {
    await certsInit(resolveProjectDir(opts.dir));
  });

certs
  .command('recover')
  .description('Recover CA key from encrypted backup in registry')
  .option('--dir <path>', 'Project directory (defaults to auto-discovery from cwd)')
  .action(async (opts) => {
    await certsRecover(resolveProjectDir(opts.dir));
  });

certs
  .command('rotate')
  .description('Regenerate agent certificate with existing CA')
  .option('--dir <path>', 'Project directory (defaults to auto-discovery from cwd)')
  .action(async (opts) => {
    await certsRotate(resolveProjectDir(opts.dir));
  });

certs
  .command('issue-routing-client')
  .description('Mint a CA-signed client cert (CN=routing-action) for the routing Action (macf-actions#8)')
  .option('--dir <path>', 'Project directory (defaults to auto-discovery from cwd)')
  .option('--out-dir <path>', 'Write cert/key files here instead of printing to stdout')
  .option('--validity-days <n>', 'Cert validity in days (default 365; warns above 730)')
  .action(async (opts) => {
    const validityDays = opts.validityDays ? Number(opts.validityDays) : undefined;
    await issueRoutingClient(resolveProjectDir(opts.dir), {
      outDir: opts.outDir,
      validityDays,
    });
  });

program
  .command('self-update')
  .description(
    'Pull origin/main + rebuild the installed CLI\'s dist/ (for npm-link dev installs). ' +
    'Note: this command only helps CLI versions >= 0.1.1 (#144); pre-#144 installs were silent.',
  )
  .action(() => {
    try {
      selfUpdate(findCliPackageRoot());
    } catch (err) {
      console.error(`self-update failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

program
  .command('doctor')
  .description('Verify the workspace\'s bot token satisfies the MACF App permission doctrine (DR-019)')
  .option('--dir <path>', 'Project directory (defaults to auto-discovery from cwd)')
  .action(async (opts) => {
    const code = await runDoctor(resolveProjectDir(opts.dir));
    process.exitCode = code;
  });

const rules = program
  .command('rules')
  .description('Canonical coordination rules distribution');

rules
  .command('refresh')
  .description('Copy canonical rules + helper scripts into a workspace\'s .claude/ (does NOT require macf init)')
  .option('--dir <path>', 'Target workspace directory (defaults to current working directory)')
  .action((opts) => {
    const target = opts.dir ? resolve(opts.dir) : process.cwd();
    try {
      rulesRefresh(target);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

program
  .command('cd <agent-name>')
  .description('Print agent project path (for shell: cd $(macf cd code-agent))')
  .action((agentName: string) => {
    cdAgent(agentName);
  });

program
  .command('repo-init')
  .description('Bootstrap a repo for MACF routing (generates workflow + config, creates labels)')
  .option('--repo <owner/repo>', 'Target GitHub repo (defaults to current dir\'s origin remote)')
  .option('--actions-version <version>', 'macf-actions tag to pin to', 'v1')
  .option('--agents <list>', 'Comma-separated agent names to scaffold (e.g., code-agent,science-agent)')
  .option('--session-name <name>', 'Shared tmux session name; when set with multiple --agents, each agent gets a window inside this session')
  .option('--force', 'Overwrite existing files', false)
  .option('--dir <path>', 'Target directory (defaults to current working directory)')
  .action(async (opts) => {
    const projectDir = opts.dir ? resolve(opts.dir) : process.cwd();
    await repoInit(projectDir, {
      repo: opts.repo,
      actionsVersion: opts.actionsVersion,
      agents: opts.agents,
      sessionName: opts.sessionName,
      force: opts.force,
    });
  });

program.parseAsync(process.argv).catch((err: Error) => {
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
});
