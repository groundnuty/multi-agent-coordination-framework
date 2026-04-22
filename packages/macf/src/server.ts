// macf#196: OTEL bootstrap is now async + dynamic. We still import
// the module eagerly (to get the function export), but the actual
// SDK packages are loaded only when the env is set, inside
// `bootstrapOtel()`. Calls to `trace.getTracer()` before the bootstrap
// runs return the global no-op tracer — harmless, since no spans are
// created before main() awaits the bootstrap.
import { bootstrapOtel } from './otel.js';

import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { getTracer, SpanNames } from './tracing.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createMcpChannel } from './mcp.js';
import { createHealthState } from './health.js';
import { createHttpsServer } from './https.js';
import { createRegistryFromConfig } from './registry/factory.js';
import { checkCollision, CollisionError } from './collision.js';
import { registerShutdownHandler } from './shutdown.js';
import { generateToken } from './token.js';
import { createChallenge, verifyAndConsumeChallenge } from './certs/challenge.js';
import { createChallengeStore } from './certs/challenge-store.js';
import { signCSR } from './certs/agent-cert.js';
import { loadCA } from './certs/ca.js';
import { HttpError } from './errors.js';
import { formatNotifyContent } from './notify-formatter.js';
import { wakeViaTmux } from './tmux-wake.js';
import type { NotifyPayload, SignRequest } from './types.js';

// NOTE: `checkPendingIssues` from './startup-issues.js' used to be
// called here at boot — but the call had a hardcoded
// `repo: 'groundnuty/macf', agentLabel: 'code-agent'`, so every
// agent (regardless of identity/workspace) queried macf's code-agent
// issues at startup + emitted a startup_check notification per hit.
// Created cross-agent noise on every fresh launch (macf#192).
// Removed in macf#192 because the marketplace v0.1.7
// `session-start-pickup.sh` SessionStart hook now handles this
// correctly — per-agent label from $MACF_AGENT_NAME + enumerates
// `/installation/repositories` so multi-repo agents are covered too.
// The function itself is still exported from src/startup-issues.ts
// for API back-compat; just not invoked here.
import type { AgentInfo } from './registry/types.js';

async function main(): Promise<void> {
  // Bootstrap OTEL BEFORE anything calls `trace.getTracer()` with
  // intent to record. Function is no-op when
  // OTEL_EXPORTER_OTLP_ENDPOINT is unset; when set, dynamic-imports
  // the SDK packages + registers the global provider. See macf#196.
  await bootstrapOtel();

  const config = loadConfig();

  const logger = createLogger({
    logPath: config.logPath,
    debug: config.debug,
  });

  // Partial-startup failures (MCP connected, port bound, then registry
  // or collision fails) would otherwise crash with only the stderr
  // message from the outer catch — channel.log would show the agent
  // starting and then go silent, leaving operators with no signal.
  // Wrap the startup body so post-logger failures land in the log.
  // Ultrareview finding H5.
  try {
    await runStartup();
  } catch (err) {
    logger.error('startup_failed', {
      error: err instanceof Error ? err.message : String(err),
      code: (err as { code?: string }).code ?? 'unknown',
    });
    throw err;
  }

  async function runStartup(): Promise<void> {
  const mcp = createMcpChannel({ agentName: config.agentName });
  const health = createHealthState(config.agentName, config.agentType);

  const onNotify = async (payload: NotifyPayload): Promise<void> => {
    const meta: Record<string, string> = { type: payload.type };
    if (payload.issue_number !== undefined) {
      meta['issue_number'] = String(payload.issue_number);
    }
    if (payload.source !== undefined) {
      meta['source'] = payload.source;
    }

    const { content, issueNumber } = formatNotifyContent(payload);
    if (issueNumber !== undefined) {
      health.setCurrentIssue(issueNumber);
    }

    logger.info('notify_received', {
      type: payload.type,
      issue: payload.issue_number,
    });

    // macf#194: wrap MCP push in an INTERNAL child span of the active
    // notify span. Shows up in Langfuse as a timed hop between the
    // inbound HTTP and the tmux wake.
    const tracer = getTracer();
    await tracer.startActiveSpan(
      SpanNames.McpPush,
      { kind: SpanKind.INTERNAL },
      async (span) => {
        try {
          await mcp.pushNotification(content, meta);
          span.setStatus({ code: SpanStatusCode.OK });
        } catch (err) {
          span.recordException(err as Error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: err instanceof Error ? err.message : String(err),
          });
          throw err;
        } finally {
          span.end();
        }
      },
    );
    health.recordNotification();

    logger.info('mcp_pushed', {
      type: payload.type,
      issue: payload.issue_number,
    });

    // macf#185: sidecar wake via tmux-send-to-claude.sh. The MCP push
    // above deposits the notification in the channel-server's
    // observable state but does NOT interrupt a running Claude TUI
    // with a new prompt — /notify ≠ wake without this step. Tmux
    // injection surfaces the notification as the TUI's next input
    // turn, so the agent actually processes it. Fail-silent on any
    // path where tmux isn't available (no workspace dir, no tmux
    // session, helper missing, tmux command errors).
    if (config.workspaceDir !== undefined) {
      // Use the formatted content as the wake prompt — same text
      // Claude would see via the MCP channel, just delivered
      // through the input buffer path so it becomes an actual turn.
      wakeViaTmux(content, {
        workspaceDir: config.workspaceDir,
        session: config.tmuxSession,
        window: config.tmuxWindow,
        logger,
      });
    } else {
      logger.info('tmux_wake_skipped', {
        reason: 'no_workspace_dir',
        detail: 'MACF_WORKSPACE_DIR unset',
      });
    }
  };

  // P2: Generate token early — needed for /sign endpoint and registry
  const token = await generateToken();
  const registry = createRegistryFromConfig(config.registry, config.project, token);
  const { createGitHubClient } = await import('./registry/github-client.js');

  // Build the variables client for the /sign challenge flow
  let signPathPrefix: string;
  switch (config.registry.type) {
    case 'org': signPathPrefix = `/orgs/${config.registry.org}`; break;
    case 'profile': signPathPrefix = `/repos/${config.registry.user}/${config.registry.user}`; break;
    case 'repo': signPathPrefix = `/repos/${config.registry.owner}/${config.registry.repo}`; break;
  }
  const varsClient = createGitHubClient(signPathPrefix, token);

  // In-memory challenge store (DR-010, #80). Process-local; server restart
  // between step 1 and step 2 of a flow invalidates outstanding challenges.
  const challengeStore = createChallengeStore();

  // /sign endpoint handler — two-step challenge-response (DR-010).
  // Step 1: allocate challenge, return id + instruction (no registry write).
  // Step 2: verify challenge_id + registry-observed value, sign CSR.
  const onSign = async (request: SignRequest): Promise<Record<string, unknown>> => {
    // Try to load CA key — if not available, this agent can't sign.
    let ca: { certPem: string; keyPem: string };
    try {
      ca = loadCA(config.caCertPath, config.caKeyPath);
    } catch {
      throw new HttpError(503, 'CA key not available on this agent');
    }

    if (!request.challenge_done) {
      // Step 1: allocate in-memory challenge, return id + instruction.
      const challenge = createChallenge({
        project: config.project,
        agentName: request.agent_name,
        store: challengeStore,
      });
      logger.info('sign_challenge_created', {
        agent_name: request.agent_name,
        challenge_id: challenge.challengeId,
      });
      return {
        challenge_id: challenge.challengeId,
        instruction: challenge.instruction,
      };
    }

    // Step 2: verify challenge + sign CSR. The refine() on SignRequestSchema
    // already guarantees challenge_id is present when challenge_done is true.
    const result = await verifyAndConsumeChallenge({
      project: config.project,
      agentName: request.agent_name,
      challengeId: request.challenge_id!,
      store: challengeStore,
      client: varsClient,
    });

    if (result === 'mismatch') {
      // Generic error — do not leak which check failed (no oracle for
      // attackers probing expired/mismatched-agent/wrong-value, etc).
      logger.warn('sign_challenge_failed', { agent_name: request.agent_name });
      throw new HttpError(401, 'challenge verification failed');
    }

    logger.info('sign_challenge_verified', { agent_name: request.agent_name });

    const certPem = await signCSR({
      csrPem: request.csr,
      agentName: request.agent_name,
      caCertPem: ca.certPem,
      caKeyPem: ca.keyPem,
    });

    logger.info('sign_cert_issued', { agent_name: request.agent_name });
    return { cert: certPem };
  };

  const httpsServer = createHttpsServer({
    caCertPath: config.caCertPath,
    agentCertPath: config.agentCertPath,
    agentKeyPath: config.agentKeyPath,
    onNotify,
    onHealth: () => health.getHealth(),
    onSign,
    logger,
  });

  // P1: Connect MCP channel
  await mcp.connect();

  // P1: Bind port
  const { actualPort } = await httpsServer.start(config.port, config.host);

  // P2: Collision detection
  const collisionResult = await checkCollision(
    config.agentName,
    registry,
    {
      caCertPath: config.caCertPath,
      agentCertPath: config.agentCertPath,
      agentKeyPath: config.agentKeyPath,
    },
    logger,
  );

  if (collisionResult.action === 'abort') {
    await httpsServer.stop();
    throw new CollisionError(
      config.agentName,
      collisionResult.existing.host,
      collisionResult.existing.port,
    );
  }

  // P2: Register in GitHub variable (use advertiseHost, not bind address)
  const agentInfo: AgentInfo = {
    host: config.advertiseHost,
    port: actualPort,
    type: config.agentType as 'permanent' | 'worker',
    instance_id: config.instanceId,
    started: new Date().toISOString(),
  };

  await registry.register(config.agentName, agentInfo);
  logger.info('registered', {
    agent: config.agentName,
    host: config.advertiseHost,
    port: actualPort,
    instance_id: config.instanceId,
  });

  // P2: Register shutdown handler
  registerShutdownHandler({
    agentName: config.agentName,
    registry,
    httpsServer,
    logger,
  });

  logger.info('server_started', {
    port: actualPort,
    host: config.advertiseHost,
    agent: config.agentName,
    type: config.agentType,
    instance_id: config.instanceId,
  });
  }  // end runStartup
}

main().catch((err) => {
  process.stderr.write(
    `Fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exitCode = 1;
});
