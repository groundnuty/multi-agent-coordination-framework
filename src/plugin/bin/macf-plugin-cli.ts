#!/usr/bin/env node
/**
 * MACF Plugin CLI — internal binary invoked by skills.
 * NOT the `macf` npm CLI (P4). This runs INSIDE Claude Code sessions.
 *
 * Usage:
 *   node macf-plugin-cli.js status
 *   node macf-plugin-cli.js peers
 *   node macf-plugin-cli.js ping <agent-name>
 *   node macf-plugin-cli.js issues
 */
import 'reflect-metadata';
import { formatDashboard, formatPeerTable, formatIssues } from '../lib/format.js';
import { listPeers } from '../lib/registry.js';
import { checkIssues } from '../lib/work.js';
import { createRegistryFromConfig } from '../../registry/factory.js';
import { generateToken } from '../../token.js';
import type { RegistryConfig } from '../../registry/types.js';

/**
 * Resolve which issue label `/macf-issues` should query (see #83).
 *
 * Precedence: explicit override > agent role > agent name > legacy fallback.
 * Each agent's `claude.sh` sets MACF_AGENT_ROLE; defaulting from that
 * makes every agent see their own queue, not a hardcoded 'code-agent'
 * queue.
 *
 * Exported for unit tests.
 */
export function resolveAgentLabel(env: Readonly<Record<string, string | undefined>>): string {
  return env['MACF_AGENT_LABEL']
    ?? env['MACF_AGENT_ROLE']
    ?? env['MACF_AGENT_NAME']
    ?? 'code-agent';
}

const command = process.argv[2];

function getRegistryConfig(): RegistryConfig {
  const repoEnv = process.env['MACF_REGISTRY_REPO'];
  if (repoEnv) {
    const parts = repoEnv.split('/');
    if (parts.length === 2 && parts[0] && parts[1]) {
      return { type: 'repo', owner: parts[0], repo: parts[1] };
    }
  }
  const orgEnv = process.env['MACF_REGISTRY_ORG'];
  if (orgEnv) return { type: 'org', org: orgEnv };
  const userEnv = process.env['MACF_REGISTRY_USER'];
  if (userEnv) return { type: 'profile', user: userEnv };
  // Default fallback
  return { type: 'repo', owner: 'groundnuty', repo: 'macf' };
}

async function main(): Promise<void> {
  const agentName = process.env['MACF_AGENT_NAME'] ?? 'unknown';
  const project = process.env['MACF_PROJECT'] ?? 'MACF';
  const registryConfig = getRegistryConfig();

  switch (command) {
    case 'status': {
      const token = await generateToken();
      const registry = createRegistryFromConfig(registryConfig, project, token);
      const peers = await listPeers(registry);
      console.log(formatDashboard(agentName, null, peers.map(p => ({ name: p.name, health: null }))));
      break;
    }

    case 'peers': {
      const token = await generateToken();
      const registry = createRegistryFromConfig(registryConfig, project, token);
      const peers = await listPeers(registry);
      console.log(formatPeerTable(peers.map(p => ({ ...p, health: null }))));
      break;
    }

    case 'ping': {
      const targetName = process.argv[3];
      if (!targetName) {
        console.error('Usage: macf-plugin-cli ping <agent-name>');
        process.exitCode = 1;
        return;
      }
      console.log(`Pinging ${targetName}... (requires mTLS certs — use /macf-status for full health check)`);
      break;
    }

    case 'issues': {
      const token = await generateToken();
      const repo = process.env['MACF_REGISTRY_REPO'] ?? 'groundnuty/macf';
      const label = resolveAgentLabel(process.env);
      const issues = await checkIssues({ repo, label, token });
      console.log(formatIssues(issues));
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.error('Available: status, peers, ping <name>, issues');
      process.exitCode = 1;
  }
}

main().catch((err: Error) => {
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
});
