import type { MacfAgentConfig } from './config.js';
import { createGitHubClient } from 'macf-core';
import type { GitHubVariablesClient } from 'macf-core';

/**
 * Build the GitHub Variables API path prefix from agent config.
 */
export function registryPathPrefix(registry: MacfAgentConfig['registry']): string {
  switch (registry.type) {
    case 'org': return `/orgs/${registry.org}`;
    case 'profile': return `/repos/${registry.user}/${registry.user}`;
    case 'repo': return `/repos/${registry.owner}/${registry.repo}`;
  }
}

/**
 * Create a GitHubVariablesClient from agent config and token.
 */
export function createClientFromConfig(
  registry: MacfAgentConfig['registry'],
  token: string,
): GitHubVariablesClient {
  return createGitHubClient(registryPathPrefix(registry), token);
}
