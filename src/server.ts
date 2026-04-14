import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createMcpChannel } from './mcp.js';
import { createHealthState } from './health.js';
import { createHttpsServer } from './https.js';
import type { NotifyPayload } from './types.js';

async function main(): Promise<void> {
  const config = loadConfig();

  const logger = createLogger({
    logPath: config.logPath,
    debug: config.debug,
  });

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

    const parts: string[] = [];
    if (payload.type === 'issue_routed' && payload.issue_number !== undefined) {
      parts.push(`Issue #${payload.issue_number} was routed to you`);
      if (payload.title) parts[0] += `: ${payload.title}`;
      health.setCurrentIssue(payload.issue_number);
    } else if (payload.type === 'mention') {
      parts.push(payload.message ?? 'You were mentioned');
    } else if (payload.type === 'startup_check') {
      parts.push(payload.message ?? 'Pending issues found at startup');
    }

    const content = parts.join('\n');

    logger.info('notify_received', {
      type: payload.type,
      issue: payload.issue_number,
    });

    await mcp.pushNotification(content, meta);
    health.recordNotification();

    logger.info('mcp_pushed', {
      type: payload.type,
      issue: payload.issue_number,
    });
  };

  const httpsServer = createHttpsServer({
    caCertPath: config.caCertPath,
    agentCertPath: config.agentCertPath,
    agentKeyPath: config.agentKeyPath,
    onNotify,
    onHealth: () => health.getHealth(),
    logger,
  });

  await mcp.connect();

  const { actualPort } = await httpsServer.start(config.port, config.host);

  logger.info('server_started', {
    port: actualPort,
    host: config.host,
    agent: config.agentName,
    type: config.agentType,
  });
}

main().catch((err) => {
  process.stderr.write(
    `Fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exitCode = 1;
});
