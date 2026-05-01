import type { Registry, RegistryConfig } from './types.js';
import { createGitHubClient } from './github-client.js';
import { createRegistry } from './registry.js';
import { createLocalRegistry } from './local-client.js';

/**
 * Creates a Registry from config. The registry type determines the
 * backend:
 *   - org:     GitHub Variables under /orgs/{org}
 *   - profile: GitHub Variables under /repos/{user}/{user}
 *   - repo:    GitHub Variables under /repos/{owner}/{repo}
 *   - local:   Single-file JSON registry on the local filesystem (DR-024)
 *
 * The exhaustive `switch` on `config.type` is the structural-defense
 * pattern from DR-024 §"Decision rule for future PRs" — adding a fifth
 * variant in the future will fail compile here unless every consumer
 * site adds the new arm.
 *
 * `token` is unused for `local` mode; callers in local-mode contexts
 * pass an empty string. The argument is kept positional so the call
 * surface is identical across all four variants — one fewer per-site
 * dispatch decision for consumers.
 */
export function createRegistryFromConfig(
  config: RegistryConfig,
  project: string,
  token: string,
): Registry {
  switch (config.type) {
    case 'org': {
      const client = createGitHubClient(`/orgs/${config.org}`, token);
      return createRegistry(client, project);
    }
    case 'profile': {
      const client = createGitHubClient(`/repos/${config.user}/${config.user}`, token);
      return createRegistry(client, project);
    }
    case 'repo': {
      const client = createGitHubClient(`/repos/${config.owner}/${config.repo}`, token);
      return createRegistry(client, project);
    }
    case 'local':
      return createLocalRegistry({ path: config.path, project });
  }
}
