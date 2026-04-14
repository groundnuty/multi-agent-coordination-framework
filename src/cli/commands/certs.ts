import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  readAgentConfig, agentCertPath, agentKeyPath,
  MACF_GLOBAL_DIR, CA_KEY_PATH,
} from '../config.js';
import { createCA, backupCAKey, recoverCAKey, loadCA } from '../../certs/ca.js';
import { generateAgentCert } from '../../certs/agent-cert.js';
import { createGitHubClient } from '../../registry/github-client.js';
import { generateToken } from '../../token.js';

function promptPassphrase(message: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function getVariablesClient(config: ReturnType<typeof readAgentConfig>, token: string) {
  if (!config) throw new Error('No macf-agent.json found. Run `macf init` first.');

  let pathPrefix: string;
  switch (config.registry.type) {
    case 'org': pathPrefix = `/orgs/${config.registry.org}`; break;
    case 'profile': pathPrefix = `/repos/${config.registry.user}/${config.registry.user}`; break;
    case 'repo': pathPrefix = `/repos/${config.registry.owner}/${config.registry.repo}`; break;
  }
  return createGitHubClient(pathPrefix, token);
}

/**
 * macf certs init: create CA, upload cert + encrypted key to registry
 */
export async function certsInit(projectDir: string): Promise<void> {
  const config = readAgentConfig(projectDir);
  if (!config) {
    console.error('No macf-agent.json found. Run `macf init` first.');
    process.exitCode = 1;
    return;
  }

  const token = await generateToken();
  const client = getVariablesClient(config, token);

  const caCertPath = join(MACF_GLOBAL_DIR, 'ca-cert.pem');

  console.log(`Creating CA for project "${config.project}"...`);

  const ca = await createCA({
    project: config.project,
    certPath: caCertPath,
    keyPath: CA_KEY_PATH,
    client,
  });

  console.log(`  CA cert: ${caCertPath}`);
  console.log(`  CA key:  ${CA_KEY_PATH}`);
  console.log(`  CA cert uploaded to registry as ${config.project.toUpperCase()}_CA_CERT`);

  // Encrypted backup
  const passphrase = await promptPassphrase('Enter passphrase for CA key backup: ');
  if (!passphrase) {
    console.warn('No passphrase provided — skipping encrypted backup.');
    return;
  }

  await backupCAKey({
    project: config.project,
    keyPem: ca.keyPem,
    passphrase,
    client,
  });

  console.log(`  Encrypted CA key backed up to registry as ${config.project.toUpperCase()}_CA_KEY_ENCRYPTED`);
  console.log('\nCA initialization complete.');
}

/**
 * macf certs recover: download and decrypt CA key from registry
 */
export async function certsRecover(projectDir: string): Promise<void> {
  const config = readAgentConfig(projectDir);
  if (!config) {
    console.error('No macf-agent.json found. Run `macf init` first.');
    process.exitCode = 1;
    return;
  }

  const token = await generateToken();
  const client = getVariablesClient(config, token);

  const passphrase = await promptPassphrase('Enter passphrase for CA key recovery: ');
  if (!passphrase) {
    console.error('Passphrase is required for recovery.');
    process.exitCode = 1;
    return;
  }

  console.log('Recovering CA key from registry...');

  await recoverCAKey({
    project: config.project,
    passphrase,
    keyPath: CA_KEY_PATH,
    client,
  });

  console.log(`  CA key recovered to: ${CA_KEY_PATH}`);
  console.log('Recovery complete.');
}

/**
 * macf certs rotate: regenerate agent cert with existing CA
 */
export async function certsRotate(projectDir: string): Promise<void> {
  const config = readAgentConfig(projectDir);
  if (!config) {
    console.error('No macf-agent.json found. Run `macf init` first.');
    process.exitCode = 1;
    return;
  }

  const caCertPath = join(MACF_GLOBAL_DIR, 'ca-cert.pem');
  if (!existsSync(caCertPath) || !existsSync(CA_KEY_PATH)) {
    console.error('CA cert or key not found. Run `macf certs init` or `macf certs recover` first.');
    process.exitCode = 1;
    return;
  }

  const ca = loadCA(caCertPath, CA_KEY_PATH);

  const certP = agentCertPath(projectDir);
  const keyP = agentKeyPath(projectDir);

  console.log(`Rotating certificate for "${config.agent_name}"...`);

  await generateAgentCert({
    agentName: config.agent_name,
    caCertPem: ca.certPem,
    caKeyPem: ca.keyPem,
    certPath: certP,
    keyPath: keyP,
  });

  console.log(`  Cert: ${certP}`);
  console.log(`  Key:  ${keyP}`);
  console.log('Rotation complete.');
}
