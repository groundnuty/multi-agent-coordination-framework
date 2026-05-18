/**
 * Tests for src/agent-card.ts — A2A v1.0 AgentCard schema + builder.
 *
 * Spec: A2A Protocol v1.0 § 4.4.1 (AgentCard) + § 4.4.5 (AgentSkill) +
 * § 4.5.6 (MutualTlsSecurityScheme).
 *
 * groundnuty/macf#370 — A2A Phase 1.
 */
import { describe, it, expect } from 'vitest';
import {
  buildAgentCard,
  AgentCardSchema,
  AgentSkillSchema,
  MutualTlsSecuritySchemeSchema,
  type AgentCardInputs,
} from '../src/agent-card.js';

const baseInputs: AgentCardInputs = {
  agentName: 'code-agent',
  agentRole: 'code-agent',
  project: 'macf',
  url: 'https://127.0.0.1:42501',
  version: '0.2.23',
};

describe('AgentCardSchema (A2A v1.0 § 4.4.1)', () => {
  it('validates a minimal-but-required AgentCard', () => {
    const minimal = {
      id: 'macf-code-agent',
      name: 'code-agent',
      url: 'https://127.0.0.1:42501',
      version: '0.2.23',
      provider: { organization: 'groundnuty/macf' },
      capabilities: {},
      securitySchemes: {
        mutual_tls: { type: 'mutualTls' as const },
      },
    };
    expect(AgentCardSchema.safeParse(minimal).success).toBe(true);
  });

  it('rejects an AgentCard missing required `id` field', () => {
    const invalid = {
      // id missing
      name: 'x',
      url: 'https://127.0.0.1:42501',
      version: '0.2.23',
      provider: { organization: 'x' },
      capabilities: {},
      securitySchemes: { mutual_tls: { type: 'mutualTls' } },
    };
    expect(AgentCardSchema.safeParse(invalid).success).toBe(false);
  });

  it('rejects AgentCard with non-URL `url` field', () => {
    const invalid = {
      id: 'x', name: 'x', url: 'not-a-url', version: '0.2.23',
      provider: { organization: 'x' },
      capabilities: {},
      securitySchemes: { mutual_tls: { type: 'mutualTls' } },
    };
    expect(AgentCardSchema.safeParse(invalid).success).toBe(false);
  });
});

describe('AgentSkillSchema (A2A v1.0 § 4.4.5)', () => {
  it('requires id + name', () => {
    expect(AgentSkillSchema.safeParse({ id: 'x', name: 'X' }).success).toBe(true);
    expect(AgentSkillSchema.safeParse({ id: 'x' }).success).toBe(false);
    expect(AgentSkillSchema.safeParse({ name: 'X' }).success).toBe(false);
  });

  it('accepts optional sub-fields', () => {
    const skill = {
      id: 'x',
      name: 'X',
      description: 'a thing',
      tags: ['tag1', 'tag2'],
      examples: ['ex1'],
      inputModes: ['application/json'],
      outputModes: ['text/plain'],
    };
    expect(AgentSkillSchema.safeParse(skill).success).toBe(true);
  });
});

describe('MutualTlsSecuritySchemeSchema (A2A v1.0 § 4.5.6)', () => {
  it('requires type=mutualTls discriminator literally', () => {
    expect(MutualTlsSecuritySchemeSchema.safeParse({ type: 'mutualTls' }).success).toBe(true);
    expect(MutualTlsSecuritySchemeSchema.safeParse({ type: 'bearer' }).success).toBe(false);
    expect(MutualTlsSecuritySchemeSchema.safeParse({}).success).toBe(false);
  });
});

describe('buildAgentCard (macf#370)', () => {
  it('builds a valid AgentCard from MACF identity inputs', () => {
    const card = buildAgentCard(baseInputs);
    // Round-trip through the schema — buildAgentCard does this
    // internally, but pin the invariant here too.
    expect(AgentCardSchema.safeParse(card).success).toBe(true);
  });

  it('maps project + agentName to id field as <project>-<agent>', () => {
    const card = buildAgentCard(baseInputs);
    expect(card.id).toBe('macf-code-agent');
  });

  it('maps url verbatim from inputs', () => {
    const card = buildAgentCard(baseInputs);
    expect(card.url).toBe('https://127.0.0.1:42501');
  });

  it('emits version from inputs (channel-server PACKAGE_VERSION at runtime)', () => {
    const card = buildAgentCard(baseInputs);
    expect(card.version).toBe('0.2.23');
  });

  it('declares mTLS as the only securityScheme (per #371 Path 2)', () => {
    const card = buildAgentCard(baseInputs);
    expect(Object.keys(card.securitySchemes)).toEqual(['mutual_tls']);
    expect(card.securitySchemes['mutual_tls']?.type).toBe('mutualTls');
  });

  it('references mTLS in default security requirements', () => {
    const card = buildAgentCard(baseInputs);
    expect(card.security).toEqual([{ mutual_tls: [] }]);
  });

  it('emits empty skills array in Phase 1 (no advertised skills yet)', () => {
    const card = buildAgentCard(baseInputs);
    expect(card.skills).toEqual([]);
  });

  it('emits empty capabilities object in Phase 1 (no claimed capabilities)', () => {
    const card = buildAgentCard(baseInputs);
    expect(card.capabilities).toEqual({});
  });

  // ---------------------------------------------------------------------
  // Invariants for #371 Path 2 lockstep — /macf/sign MUST NOT appear in
  // the AgentCard. Live-attestation is MACF-only per DR-010 Path 2.
  // ---------------------------------------------------------------------

  it('does NOT advertise /macf/sign in any skill (groundnuty/macf#371 Path 2 lockstep)', () => {
    const card = buildAgentCard(baseInputs);
    const serialized = JSON.stringify(card);
    expect(serialized).not.toContain('/macf/sign');
    expect(serialized).not.toContain('macf_sign');
    expect(serialized).not.toContain('sign_csr');
  });

  it('does NOT advertise /sign legacy path either', () => {
    const card = buildAgentCard(baseInputs);
    const serialized = JSON.stringify(card);
    // Defensive: future skill additions accidentally introducing the
    // legacy /sign string trip this invariant too.
    expect(serialized).not.toMatch(/"\/sign"/);
  });

  // ---------------------------------------------------------------------
  // Provider mapping
  // ---------------------------------------------------------------------

  it('AgentProvider.organization includes project context', () => {
    const card = buildAgentCard(baseInputs);
    expect(card.provider.organization).toContain('macf');
    expect(card.provider.organization).toContain('macf'); // project name appears
  });

  it('AgentProvider.url points to the macf repo', () => {
    const card = buildAgentCard(baseInputs);
    expect(card.provider.url).toBe('https://github.com/groundnuty/macf');
  });

  // ---------------------------------------------------------------------
  // Different project / agent inputs flow through
  // ---------------------------------------------------------------------

  it('id changes when project + agentName change', () => {
    const card = buildAgentCard({
      ...baseInputs,
      project: 'ppam-2026',
      agentName: 'science-agent',
    });
    expect(card.id).toBe('ppam-2026-science-agent');
    expect(card.name).toBe('science-agent');
  });

  it('description includes the agent role', () => {
    const card = buildAgentCard({ ...baseInputs, agentRole: 'reviewer' });
    expect(card.description).toContain('reviewer');
  });
});
