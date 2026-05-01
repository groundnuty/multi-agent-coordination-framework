import { readFileSync } from 'node:fs';
import { pingAgent } from './health.js';
import type { PeerEntry } from './registry.js';
import type { HealthResponse } from '@groundnuty/macf-core';

/**
 * Probe a peer's `/health` endpoint over mTLS using the cert paths set by
 * `claude.sh` (MACF_CA_CERT / MACF_AGENT_CERT / MACF_AGENT_KEY env vars).
 *
 * Returns `null` when env vars are missing or CA-cert read fails — caller's
 * UI layer renders that as "offline" (matches `formatPeerTable` behaviour).
 *
 * Used by the `peers` and `status` cases in `macf-plugin-cli.ts`. The `ping`
 * case keeps its own inline copy because it has a different UX contract:
 * operator-invoked `/macf-ping` should fail loudly when env is incomplete,
 * not silently render "offline".
 *
 * Surfaced by macf#325 — `peers` case was previously a stub mapping every
 * peer to `health: null`, producing misleading "all offline" output even
 * when channel-servers were running. This helper is the structural fix.
 */
export async function probePeerHealth(peer: PeerEntry): Promise<HealthResponse | null> {
  const caCertPath = process.env['MACF_CA_CERT'];
  const agentCertPath = process.env['MACF_AGENT_CERT'];
  const agentKeyPath = process.env['MACF_AGENT_KEY'];
  if (!caCertPath || !agentCertPath || !agentKeyPath) return null;
  let caCertPem: string;
  try {
    caCertPem = readFileSync(caCertPath, 'utf-8');
  } catch {
    return null;
  }
  return await pingAgent({
    host: peer.info.host,
    port: peer.info.port,
    caCertPem,
    certPath: agentCertPath,
    keyPath: agentKeyPath,
  });
}
