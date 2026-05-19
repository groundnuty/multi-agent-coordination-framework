/**
 * A2A v1.0 AgentCard discovery endpoint support for macf-channel-server.
 *
 * Implements the AgentCard JSON shape served at `/.well-known/agent-card.json`
 * per A2A Protocol v1.0 spec § 4.4.1 (AgentCard) and § 14.3 (Well-Known URI
 * Registration). Phase 1 of the A2A integration master tracking
 * (groundnuty/macf#370 → master #368). Zero behavior change: this is
 * purely additive discovery — existing MACF coordination flows
 * (POST /notify, POST /macf/sign) continue working identically.
 *
 * **SDK choice (Phase 1)**: hand-rolled Zod schema instead of
 * `@a2a-js/sdk`. The official npm SDK is v0.3.13 which implements A2A
 * v0.3, not v1.0 — v1.0 is on an alpha branch (`epic/1.0_breaking_changes`)
 * not yet released. Phase 1's scope is just the AgentCard endpoint (no
 * inbound JSON-RPC, no task lifecycle), so a 50-line Zod schema is the
 * right surface for now. Phase 2+ work can swap to `@a2a-js/sdk` v1.0
 * when it goes stable; the AgentCard schema here will match what the
 * SDK ships.
 *
 * **Normative spec source**: `a2aproject/A2A:spec/a2a.proto` per spec
 * § 1.4. The Zod schema below mirrors the .proto field names + JSON
 * shapes from the spec excerpt; verified against published spec text
 * 2026-05-18 via opentelemetry.io WebFetch (cited in PR body).
 *
 * **mTLS declaration**: per spec § 4.5.6, mTLS is declared via a
 * `MutualTlsSecurityScheme` entry in the `securitySchemes` map with
 * `type: "mutualTls"`. The corresponding `security` array references
 * the scheme by name. This module emits both.
 *
 * **`/macf/sign` is intentionally NOT advertised** — per #371 Path 2
 * decision, live cryptographic attestation is MACF-only and SHOULD
 * NOT appear in the public AgentCard. The skill list omits it; a
 * source-level test pins this invariant so future skill additions
 * don't accidentally re-include it.
 */
import { z } from 'zod';
import { A2A_ENDPOINT_PATH } from './a2a-types.js';

// ---------------------------------------------------------------------------
// Zod schema (hand-rolled from A2A v1.0 spec § 4.4.1 + § 4.4.5 + § 4.5.6)
// ---------------------------------------------------------------------------

/**
 * AgentSkill — per spec § 4.4.5. Required: id, name. Optional:
 * description, tags, examples, inputModes, outputModes, metadata,
 * extensions.
 */
export const AgentSkillSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  examples: z.array(z.string()).optional(),
  inputModes: z.array(z.string()).optional(),
  outputModes: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type AgentSkill = z.infer<typeof AgentSkillSchema>;

/**
 * MutualTlsSecurityScheme — per spec § 4.5.6. Type discriminator
 * `mutualTls`. No additional fields required at the scheme level;
 * the actual cert chain is exchanged at TLS-handshake time, not
 * declared here.
 */
export const MutualTlsSecuritySchemeSchema = z.object({
  type: z.literal('mutualTls'),
  description: z.string().optional(),
});

export type MutualTlsSecurityScheme = z.infer<typeof MutualTlsSecuritySchemeSchema>;

/**
 * AgentProvider — per spec § 4.4.1 (required `provider` sub-field).
 * Identifies the organization or system publishing the agent.
 */
export const AgentProviderSchema = z.object({
  organization: z.string().min(1),
  url: z.string().url().optional(),
});

export type AgentProvider = z.infer<typeof AgentProviderSchema>;

/**
 * AgentCapabilities — per spec § 4.4.1 (required `capabilities`).
 * v1.0 spec defines capabilities as a free-form object with
 * implementation-defined feature flags. Phase 1 emits an empty object
 * (the Phase 1 AgentCard doesn't claim any non-discovery capabilities;
 * Phase 2 will populate this when inbound JSON-RPC `message/send`
 * lands).
 */
export const AgentCapabilitiesSchema = z.object({
  streaming: z.boolean().optional(),
  pushNotifications: z.boolean().optional(),
}).catchall(z.unknown());

export type AgentCapabilities = z.infer<typeof AgentCapabilitiesSchema>;

/**
 * AgentCard — per spec § 4.4.1. Required: id, name, url, version,
 * provider, capabilities, securitySchemes. Optional: description,
 * defaultInputModes, defaultOutputModes, skills, extensions, security,
 * metadata.
 */
export const AgentCardSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  url: z.string().url(),
  version: z.string().min(1),
  provider: AgentProviderSchema,
  capabilities: AgentCapabilitiesSchema,
  // Phase 1 mTLS-only stance. Phase 2+ widening to a discriminated
  // union (OAuth/OIDC for external integrations per A2A spec § 4.5)
  // lives here when needed — replace `MutualTlsSecuritySchemeSchema`
  // with `z.discriminatedUnion('type', [MutualTls..., OAuth2..., ...])`.
  // Per #370 review (science-agent 2026-05-18).
  securitySchemes: z.record(z.string(), MutualTlsSecuritySchemeSchema),
  description: z.string().optional(),
  defaultInputModes: z.array(z.string()).optional(),
  defaultOutputModes: z.array(z.string()).optional(),
  skills: z.array(AgentSkillSchema).optional(),
  security: z.array(z.record(z.string(), z.array(z.string()))).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type AgentCard = z.infer<typeof AgentCardSchema>;

// ---------------------------------------------------------------------------
// AgentCard builder
// ---------------------------------------------------------------------------

/**
 * Inputs needed to build an AgentCard. Derived from `MacfConfig` at
 * server-start; passed into `buildAgentCard()` once and the result is
 * cached for the lifetime of the channel-server process (per spec, an
 * AgentCard is static between agent restarts — version-pinned).
 */
export interface AgentCardInputs {
  /** Agent's MACF identity (e.g. "code-agent"). Mapped to AgentCard.id + name suffix. */
  readonly agentName: string;
  /** Agent's role (e.g. "code-agent"). Surfaced in description. */
  readonly agentRole: string;
  /** Project namespace (e.g. "macf"). Mapped to AgentProvider.organization. */
  readonly project: string;
  /** Outward-facing URL (host:port). Mapped to AgentCard.url. */
  readonly url: string;
  /** Channel-server / framework version (e.g. "0.2.22"). Mapped to AgentCard.version. */
  readonly version: string;
}

/**
 * Build the AgentCard JSON for this agent.
 *
 * **`/macf/sign` is intentionally absent from the skills list** per #371.
 * Live cryptographic attestation stays a MACF-only endpoint; A2A-spec
 * clients SHOULD NOT depend on it. A source-level test in
 * `test/agent-card.test.ts` pins this invariant.
 *
 * Skills in Phase 2a (macf#390): MACF domain capabilities — what the
 * agent can DO, not what JSON-RPC methods it serves. Per spec § 4.4.5,
 * skills describe agent-specific actions on top of the A2A protocol
 * methods. Initial mapping (Phase 2a):
 *
 * - `macf.notify_peer` — Cross-Agent Notification (the canonical MACF
 *   coordination primitive; #267)
 * - `macf.checkpoint_to_memory` — Persist Context to Memory (the PreCompact
 *   checkpoint MCP tool; #271 DR-023 §UC-3)
 *
 * Phase 3+ will add role-specific skills if the MACF MCP-tool surface
 * grows. `/macf/sign` is intentionally absent — live cryptographic
 * attestation stays MACF-only per DR-010 Path 2 + #371; a source-level
 * test pins this invariant.
 *
 * `url` field: Phase 2a points AgentCard.url to the JSON-RPC endpoint
 * (`<inputs.url>/a2a/v1`). A2A clients discover via
 * `/.well-known/agent-card.json` then POST `message/send` to the
 * advertised url.
 */
export function buildAgentCard(inputs: AgentCardInputs): AgentCard {
  const card: AgentCard = {
    id: `${inputs.project}-${inputs.agentName}`,
    name: inputs.agentName,
    description: `MACF agent (${inputs.agentRole}) in project ${inputs.project}. Coordinates with peer MACF agents over mTLS-authenticated channels.`,
    url: `${inputs.url.replace(/\/+$/, '')}${A2A_ENDPOINT_PATH}`,
    version: inputs.version,
    provider: {
      organization: `groundnuty/macf (${inputs.project})`,
      url: 'https://github.com/groundnuty/macf',
    },
    capabilities: {
      streaming: false,
      pushNotifications: false,
    },
    securitySchemes: {
      mutual_tls: {
        type: 'mutualTls',
        description: 'mTLS via per-project CA. Each agent has a CA-signed cert with clientAuth EKU; the channel-server requires + verifies the peer cert on every request.',
      },
    },
    security: [{ mutual_tls: [] }],
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: [
      {
        id: 'macf.notify_peer',
        name: 'Cross-Agent Notification',
        description: 'Send a structured notification to a peer MACF agent. Used for issue/PR routing, CI-completion signaling, and ad-hoc cross-agent messaging. Sender-side delivery is mTLS-authenticated; receiver dispatches based on notification type.',
        tags: ['macf', 'coordination', 'notification'],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
      },
      {
        id: 'macf.checkpoint_to_memory',
        name: 'Persist Context to Memory',
        description: 'Checkpoint conversation context to the agent\'s persistent memory store. Invoked via PreCompact hook (DR-023 §UC-3) or manually before long pauses. Returns a memory-file reference for later recall.',
        tags: ['macf', 'memory', 'checkpoint'],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
      },
    ],
  };
  // Defense-in-depth: validate our own output before returning.
  // Catches bugs where a field shape drifts from the schema without
  // the schema test catching it.
  return AgentCardSchema.parse(card);
}
