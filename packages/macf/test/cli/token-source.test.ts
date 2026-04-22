import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { tokenSourceFromConfig } from '../../src/cli/config.js';
import type { MacfAgentConfig } from '../../src/cli/config.js';

const baseConfig: MacfAgentConfig = {
  project: 'TEST',
  agent_name: 'test-agent',
  agent_role: 'code-agent',
  agent_type: 'permanent',
  registry: { type: 'repo', owner: 'o', repo: 'r' },
  github_app: { app_id: '3381541', install_id: '124031791', key_path: '.github-app-key.pem' },
  versions: { cli: '0.1.0', plugin: '0.1.0', actions: 'v1' },
};

describe('tokenSourceFromConfig', () => {
  it('copies app_id and install_id through unchanged', () => {
    const ts = tokenSourceFromConfig('/home/user/proj', baseConfig);
    expect(ts.appId).toBe('3381541');
    expect(ts.installId).toBe('124031791');
  });

  it('resolves relative key_path against projectDir', () => {
    const ts = tokenSourceFromConfig('/home/user/proj', baseConfig);
    expect(ts.keyPath).toBe(resolve('/home/user/proj', '.github-app-key.pem'));
  });

  it('keeps absolute key_path as-is', () => {
    const cfg: MacfAgentConfig = {
      ...baseConfig,
      github_app: { ...baseConfig.github_app, key_path: '/abs/path/to/key.pem' },
    };
    const ts = tokenSourceFromConfig('/home/user/proj', cfg);
    expect(ts.keyPath).toBe('/abs/path/to/key.pem');
  });

  it('resolves nested relative paths', () => {
    const cfg: MacfAgentConfig = {
      ...baseConfig,
      github_app: { ...baseConfig.github_app, key_path: 'secrets/app-key.pem' },
    };
    const ts = tokenSourceFromConfig('/home/user/proj', cfg);
    expect(ts.keyPath).toBe(resolve('/home/user/proj', 'secrets/app-key.pem'));
  });
});
