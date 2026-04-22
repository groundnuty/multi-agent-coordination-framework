import { loadAllAgents } from '../config.js';

/**
 * Print the project path for a given agent name.
 * Usage: cd $(macf cd code-agent)
 */
export function cdAgent(agentName: string): void {
  const agents = loadAllAgents();
  const match = agents.find(a => a.config.agent_name === agentName);

  if (!match) {
    console.error(`Agent "${agentName}" not found in index.`);
    process.exitCode = 1;
    return;
  }

  // Print just the path — designed for shell substitution
  console.log(match.path);
}
