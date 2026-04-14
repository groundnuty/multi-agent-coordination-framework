import { readAgentConfig, projectMacfDir } from '../config.js';
import { join } from 'node:path';

/**
 * macf update: update plugin in current project's .macf/plugin/
 * Placeholder — full plugin distribution is P5 scope.
 */
export function updatePlugin(projectDir: string): void {
  const config = readAgentConfig(projectDir);
  if (!config) {
    console.error('No macf-agent.json found. Run `macf init` first.');
    process.exitCode = 1;
    return;
  }

  const pluginDir = join(projectMacfDir(projectDir), 'plugin');
  console.log(`Plugin directory: ${pluginDir}`);
  console.log('Plugin update is not yet implemented (P5 scope).');
  console.log('For now, manually clone/update the plugin in the directory above.');
}
