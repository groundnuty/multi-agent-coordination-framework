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

describe('AgentCardSchema (canonical proto a2a.proto message AgentCard, macf#393 Phase 2c)', () => {
  it('validates a minimal-but-required AgentCard (proto-canonical shape)', () => {
    // Per canonical proto: name, description, supportedInterfaces,
    // version, capabilities, defaultInputModes, defaultOutputModes,
    // skills are all REQUIRED. NO top-level id/url (removed Phase 2c).
    const minimal = {
      name: 'code-agent',
      description: 'MACF code-agent test fixture',
      supportedInterfaces: [
        { url: 'https://127.0.0.1:42501/a2a/v1', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
      ],
      version: '0.2.23',
      capabilities: {},
      defaultInputModes: ['application/json'],
      defaultOutputModes: ['application/json'],
      skills: [
        { id: 's1', name: 'Skill 1', description: 'A skill', tags: ['tag-a'] },
      ],
    };
    expect(AgentCardSchema.safeParse(minimal).success).toBe(true);
  });

  it('rejects an AgentCard missing required `description` field', () => {
    const invalid = {
      name: 'x',
      // description missing
      supportedInterfaces: [
        { url: 'https://x/a2a/v1', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
      ],
      version: '0.2.23',
      capabilities: {},
      defaultInputModes: ['application/json'],
      defaultOutputModes: ['application/json'],
      skills: [{ id: 's1', name: 'S', description: 'd', tags: ['t'] }],
    };
    expect(AgentCardSchema.safeParse(invalid).success).toBe(false);
  });

  it('rejects an AgentCard missing required `supportedInterfaces` (Phase 2c proto requirement)', () => {
    const invalid = {
      name: 'x',
      description: 'd',
      // supportedInterfaces missing
      version: '0.2.23',
      capabilities: {},
      defaultInputModes: ['application/json'],
      defaultOutputModes: ['application/json'],
      skills: [{ id: 's1', name: 'S', description: 'd', tags: ['t'] }],
    };
    expect(AgentCardSchema.safeParse(invalid).success).toBe(false);
  });

  it('rejects AgentInterface with non-URL `url` field', () => {
    const invalid = {
      name: 'x', description: 'd', version: '0.2.23',
      supportedInterfaces: [
        { url: 'not-a-url', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
      ],
      capabilities: {},
      defaultInputModes: ['application/json'],
      defaultOutputModes: ['application/json'],
      skills: [{ id: 's1', name: 'S', description: 'd', tags: ['t'] }],
    };
    expect(AgentCardSchema.safeParse(invalid).success).toBe(false);
  });
});

describe('AgentSkillSchema (canonical proto a2a.proto message AgentSkill, macf#393 Phase 2c)', () => {
  it('requires id, name, description, tags (per proto fields 1-4 [REQUIRED])', () => {
    expect(AgentSkillSchema.safeParse({
      id: 'x', name: 'X', description: 'A test skill', tags: ['tag'],
    }).success).toBe(true);
    // Phase 2c: description + tags upgraded from optional to required.
    expect(AgentSkillSchema.safeParse({ id: 'x', name: 'X' }).success).toBe(false);
    expect(AgentSkillSchema.safeParse({
      id: 'x', name: 'X', description: 'd', // missing tags
    }).success).toBe(false);
    expect(AgentSkillSchema.safeParse({
      id: 'x', name: 'X', tags: ['t'], // missing description
    }).success).toBe(false);
    expect(AgentSkillSchema.safeParse({
      id: 'x', name: 'X', description: 'd', tags: [], // empty tags array
    }).success).toBe(false);
  });

  it('accepts optional sub-fields (examples, inputModes, outputModes)', () => {
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

  it('does NOT emit a top-level `id` field (macf#393 Phase 2c — proto has no AgentCard.id)', () => {
    // Phase 1's top-level `id` was non-canonical (proto has no such
    // field at AgentCard level). Phase 2c removes it. Strict-validating
    // A2A clients (Bedrock AgentCore canonical parser, Microsoft Agent
    // Framework, etc.) reject AgentCards with unexpected top-level fields.
    const card = buildAgentCard(baseInputs);
    expect((card as Record<string, unknown>)['id']).toBeUndefined();
  });

  it('does NOT emit a top-level `url` field (macf#393 Phase 2c — endpoint URL lives in supportedInterfaces)', () => {
    // Phase 1+2a had `url` at top level; canonical proto puts the
    // endpoint URL inside `supportedInterfaces[].url`. Phase 2c
    // relocates per proto.
    const card = buildAgentCard(baseInputs);
    expect((card as Record<string, unknown>)['url']).toBeUndefined();
  });

  it('exposes endpoint URL at supportedInterfaces[0].url (macf#393 — canonical relocation)', () => {
    const card = buildAgentCard(baseInputs);
    expect(card.supportedInterfaces).toHaveLength(1);
    const iface = card.supportedInterfaces[0];
    expect(iface?.url).toBe('https://127.0.0.1:42501/a2a/v1');
    expect(iface?.protocolBinding).toBe('JSONRPC');
    expect(iface?.protocolVersion).toBe('1.0');
  });

  it('emits version from inputs (channel-server PACKAGE_VERSION at runtime)', () => {
    const card = buildAgentCard(baseInputs);
    expect(card.version).toBe('0.2.23');
  });

  it('declares mTLS as the only securityScheme (per #371 Path 2)', () => {
    const card = buildAgentCard(baseInputs);
    expect(card.securitySchemes).toBeDefined();
    expect(Object.keys(card.securitySchemes ?? {})).toEqual(['mutual_tls']);
    expect((card.securitySchemes ?? {})['mutual_tls']?.type).toBe('mutualTls');
  });

  it('references mTLS in default security requirements', () => {
    const card = buildAgentCard(baseInputs);
    expect(card.security).toEqual([{ mutual_tls: [] }]);
  });

  it('emits MACF capability skills in Phase 2a (notify_peer + checkpoint_to_memory)', () => {
    // macf#390 Phase 2a: AgentSkills describe MACF DOMAIN capabilities
    // (per A2A v1.0 § 4.4.5), not JSON-RPC protocol methods. Initial
    // mapping: notify_peer + checkpoint_to_memory.
    const card = buildAgentCard(baseInputs);
    const ids = (card.skills ?? []).map((s) => s.id);
    expect(ids).toContain('macf.notify_peer');
    expect(ids).toContain('macf.checkpoint_to_memory');
  });

  it('emits non-empty capabilities in Phase 2a (streaming + pushNotifications declared false)', () => {
    // macf#390 Phase 2a: synchronous-only path; streaming + push
    // explicitly false. Phase 2.5/3 may flip these.
    const card = buildAgentCard(baseInputs);
    expect(card.capabilities['streaming']).toBe(false);
    expect(card.capabilities['pushNotifications']).toBe(false);
  });

  it('exposes /a2a/v1 endpoint via supportedInterfaces (macf#393 Phase 2c — proto-canonical relocation)', () => {
    const card = buildAgentCard(baseInputs);
    expect(card.supportedInterfaces[0]?.url).toMatch(/\/a2a\/v1$/);
  });

  it('defaultInputModes + defaultOutputModes populated with conservative pair (macf#393 Phase 2c)', () => {
    // Per proto: both are REQUIRED + repeated string. MACF advertises
    // the conservative ["text/plain", "application/json"] pair; skills
    // can narrow via their own inputModes/outputModes overrides.
    const card = buildAgentCard(baseInputs);
    expect(card.defaultInputModes).toContain('application/json');
    expect(card.defaultInputModes).toContain('text/plain');
    expect(card.defaultOutputModes).toContain('application/json');
    expect(card.defaultOutputModes).toContain('text/plain');
  });

  it('each AgentSkill has required description + tags (macf#393 Phase 2c)', () => {
    const card = buildAgentCard(baseInputs);
    for (const skill of card.skills) {
      expect(skill.description.length).toBeGreaterThan(0);
      expect(skill.tags.length).toBeGreaterThan(0);
    }
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
    expect(card.provider?.organization).toContain('macf');
  });

  it('AgentProvider.url points to the macf repo', () => {
    const card = buildAgentCard(baseInputs);
    expect(card.provider?.url).toBe('https://github.com/groundnuty/macf');
  });

  // ---------------------------------------------------------------------
  // Different project / agent inputs flow through
  // ---------------------------------------------------------------------

  it('name + endpoint URL change when project + agentName change (macf#393 — no top-level id)', () => {
    const card = buildAgentCard({
      ...baseInputs,
      project: 'ppam-2026',
      agentName: 'science-agent',
    });
    expect(card.name).toBe('science-agent');
    expect(card.description).toContain('ppam-2026');
  });

  it('description includes the agent role', () => {
    const card = buildAgentCard({ ...baseInputs, agentRole: 'reviewer' });
    expect(card.description).toContain('reviewer');
  });
});
