/**
 * Multi-Agent Coordination Framework (MACF)
 *
 * Coordinates multiple Claude Code agents via GitHub,
 * using MCP channels (HTTP/mTLS) for communication.
 */

export { MacfError, ConfigError, McpChannelError, HttpsServerError, PortUnavailableError, PortExhaustedError, ValidationError } from 'macf-core';
export { createMcpChannel } from './mcp.js';
export { createHttpsServer } from './https.js';
export { createHealthState } from './health.js';
export { createLogger } from 'macf-core';
export { loadConfig } from 'macf-core';
export {
  NotifyPayloadSchema, NotifyTypeSchema, HealthResponseSchema,
  CiCompletionPayloadSchema, CheckSuiteConclusionSchema,
} from 'macf-core';
export type {
  NotifyPayload, NotifyType, HealthResponse, AgentConfig, Logger,
  McpChannel, HttpsServer, HealthState,
  CiCompletionPayload, CheckSuiteConclusion,
} from 'macf-core';

// P2: Registry & Discovery
export { createRegistryFromConfig, createRegistry, createGitHubClient, GitHubApiError, AgentInfoSchema, RegistryConfigSchema } from 'macf-core';
export type { AgentInfo, Registry, RegistryConfig, GitHubVariablesClient } from 'macf-core';
export { checkCollision, CollisionError } from './collision.js';
export type { CollisionResult } from './collision.js';
export { registerShutdownHandler } from './shutdown.js';
export { generateToken } from 'macf-core';
export { checkPendingIssues } from './startup-issues.js';

// P3: Certificate Management
export { createCA, backupCAKey, recoverCAKey, encryptCAKey, decryptCAKey, loadCA, CaError } from 'macf-core';
export type { CaKeyPair } from 'macf-core';
export { generateAgentCert, generateCSR, signCSR, AgentCertError } from 'macf-core';
export type { AgentCertResult } from 'macf-core';
export { createChallenge, verifyAndConsumeChallenge, ChallengeError } from 'macf-core';
export { SignRequestSchema, SignChallengeResponseSchema, SignCertResponseSchema } from 'macf-core';
export type { SignRequest } from 'macf-core';
