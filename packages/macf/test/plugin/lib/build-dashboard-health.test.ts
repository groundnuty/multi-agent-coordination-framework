import { describe, it, expect, vi } from 'vitest';
import type { AgentInfo, HealthResponse } from '@groundnuty/macf-core';
import { buildDashboardHealth } from '../../../src/plugin/lib/build-dashboard-health.js';

const sampleInfo: AgentInfo = {
  host: '127.0.0.1',
  port: 9001,
  type: 'permanent',
  instance_id: 'a1b2c3',
  started: '2026-05-01T15:00:00Z',
};

const sampleHealth: HealthResponse = {
  agent_name: 'code-agent',
  agent_type: 'permanent',
  uptime_seconds: 42,
  current_issue: null,
  notifications_received: 0,
};

describe('buildDashboardHealth (#327 regression)', () => {
  it('probes own registration when present and returns its health (self-probe path)', async () => {
    const ownRegistration = { name: 'CODE_AGENT', info: sampleInfo };
    const probe = vi.fn().mockResolvedValue(sampleHealth);

    const result = await buildDashboardHealth(ownRegistration, [], probe);

    expect(result.ownHealth).toEqual(sampleHealth);
    expect(probe).toHaveBeenCalledWith({ name: 'CODE_AGENT', info: sampleInfo });
  });

  it('returns null ownHealth when ownRegistration is null (unregistered self)', async () => {
    const probe = vi.fn().mockResolvedValue(sampleHealth);

    const result = await buildDashboardHealth(null, [], probe);

    expect(result.ownHealth).toBeNull();
    // Probe must not be called for own-health when no own registration exists
    expect(probe).not.toHaveBeenCalled();
  });

  it('probes every peer in parallel and returns name+health pairs', async () => {
    const peers = [
      { name: 'CODE_AGENT', info: sampleInfo },
      { name: 'SCIENCE_AGENT', info: { ...sampleInfo, port: 9002 } },
    ];
    const probe = vi.fn()
      .mockResolvedValueOnce(sampleHealth)
      .mockResolvedValueOnce({ ...sampleHealth, agent_name: 'science-agent' });

    const result = await buildDashboardHealth(null, peers, probe);

    expect(result.peersWithHealth).toHaveLength(2);
    expect(result.peersWithHealth[0]).toEqual({ name: 'CODE_AGENT', health: sampleHealth });
    expect(result.peersWithHealth[1]!.health!.agent_name).toBe('science-agent');
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('returns null health for peers whose probe returns null (offline)', async () => {
    const peers = [
      { name: 'OFFLINE_AGENT', info: sampleInfo },
    ];
    const probe = vi.fn().mockResolvedValue(null);

    const result = await buildDashboardHealth(null, peers, probe);

    expect(result.peersWithHealth[0]).toEqual({ name: 'OFFLINE_AGENT', health: null });
  });

  it('combines own + peer probing in one Promise.all (parallel)', async () => {
    const ownRegistration = { name: 'CODE_AGENT', info: sampleInfo };
    const peers = [
      { name: 'CODE_AGENT', info: sampleInfo },  // self appears in registry list
      { name: 'SCIENCE_AGENT', info: { ...sampleInfo, port: 9002 } },
    ];
    const probe = vi.fn().mockResolvedValue(sampleHealth);

    const result = await buildDashboardHealth(ownRegistration, peers, probe);

    expect(result.ownHealth).toEqual(sampleHealth);
    expect(result.peersWithHealth).toHaveLength(2);
    // Self probed once for ownHealth + once as part of peers list (matches list-includes-self semantics)
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('handles empty peers list', async () => {
    const probe = vi.fn();

    const result = await buildDashboardHealth(null, [], probe);

    expect(result.ownHealth).toBeNull();
    expect(result.peersWithHealth).toEqual([]);
    expect(probe).not.toHaveBeenCalled();
  });
});
