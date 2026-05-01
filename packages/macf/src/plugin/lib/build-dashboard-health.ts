import type { HealthResponse } from '@groundnuty/macf-core';
import type { OwnRegistration, PeerEntry } from './registry.js';

/**
 * Build the `ownHealth` + `peersWithHealth` arguments for `formatDashboard`
 * by probing each registered peer (and self if registered) over mTLS via
 * the injected probe function.
 *
 * Extracted from `macf-plugin-cli.ts` `status` case to make the wiring
 * testable without spawning the full binary. Probe dependency is injected
 * so tests can supply a stub instead of `probePeerHealth`.
 *
 * Surfaced by macf#327 — `status` case was previously a stub mapping
 * every peer to `health: null` (sister-class to the `peers` stub fixed in
 * macf#325 / PR #326).
 */
export async function buildDashboardHealth(
  ownRegistration: OwnRegistration | null,
  peers: readonly PeerEntry[],
  probe: (peer: PeerEntry) => Promise<HealthResponse | null>,
): Promise<{
  readonly ownHealth: HealthResponse | null;
  readonly peersWithHealth: ReadonlyArray<{ readonly name: string; readonly health: HealthResponse | null }>;
}> {
  const [ownHealth, peersWithHealth] = await Promise.all([
    ownRegistration
      ? probe({ name: ownRegistration.name, info: ownRegistration.info })
      : Promise.resolve(null),
    Promise.all(peers.map(async p => ({ name: p.name, health: await probe(p) }))),
  ]);
  return { ownHealth, peersWithHealth };
}
