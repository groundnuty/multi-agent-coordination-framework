import { loadAllAgents, readAgentsIndex } from '../config.js';

/**
 * Default command: list all agents registered on this machine.
 */
export function listAgents(): void {
  const index = readAgentsIndex();

  if (index.agents.length === 0) {
    console.log('No agents registered. Run `macf init` in a project directory to set up an agent.');
    return;
  }

  const agents = loadAllAgents();

  if (agents.length === 0) {
    console.log('Agent index has entries but no valid configs found.');
    return;
  }

  console.log('macf agents:\n');
  for (const { path, config } of agents) {
    console.log(`  ${config.agent_name.padEnd(20)} ${config.agent_role.padEnd(15)} ${config.project.padEnd(10)} ${path}`);
  }
}
