import { z } from 'zod';

// --- Notify payload (POST /notify body) ---

export const NotifyTypeSchema = z.enum([
  'issue_routed',
  'mention',
  'startup_check',
  // `ci_completion` landed with macf-actions v2.0.1 / #122 — routed
  // by the macf-actions route-by-ci-completion job when a check_suite
  // completes on an agent-authored PR. Prior to this variant, the job
  // shoehorned the notification into `type: 'mention'` with
  // `source: 'ci_completion'` as a discriminator.
  'ci_completion',
]);

export type NotifyType = z.infer<typeof NotifyTypeSchema>;

// Check suite conclusions reaching the receiver — match GitHub's
// terminal check_suite states that macf-actions treats as actionable
// (see macf-actions#6 and agent-router.yml).
export const CheckSuiteConclusionSchema = z.enum([
  'success', 'failure', 'timed_out', 'action_required',
]);

export type CheckSuiteConclusion = z.infer<typeof CheckSuiteConclusionSchema>;

export const NotifyPayloadSchema = z.object({
  type: NotifyTypeSchema,
  issue_number: z.number().int().positive().optional(),
  title: z.string().optional(),
  source: z.string().optional(),
  message: z.string().optional(),
  // CI-completion variant fields (#122). All optional at the top
  // level to preserve backward compat with producers that only send
  // the base shape. Producers that want a type-narrowed shape for
  // ci_completion can validate against CiCompletionPayloadSchema
  // below before POST.
  pr_number: z.number().int().positive().optional(),
  pr_title: z.string().optional(),
  pr_url: z.string().url().optional(),
  conclusion: CheckSuiteConclusionSchema.optional(),
  failing_check_name: z.string().nullable().optional(),
});

export type NotifyPayload = z.infer<typeof NotifyPayloadSchema>;

/**
 * Narrower schema for `ci_completion` payloads (#122). Producers
 * (notably the macf-actions route-by-ci-completion job, v2.0.1+)
 * should construct-and-validate against this schema for type-level
 * clarity, then send over the wire. The receiver parses against the
 * wider `NotifyPayloadSchema` (backward-compat across variants) and
 * narrows via the `type === 'ci_completion'` discriminator.
 *
 * Required fields: everything the receiver needs to render the
 * notification WITHOUT falling back to free-form `message` parsing.
 * `failing_check_name` is null when conclusion is 'success'; string
 * otherwise.
 */
export const CiCompletionPayloadSchema = z.object({
  type: z.literal('ci_completion'),
  source: z.literal('ci_completion'),
  pr_number: z.number().int().positive(),
  pr_title: z.string(),
  pr_url: z.string().url(),
  conclusion: CheckSuiteConclusionSchema,
  failing_check_name: z.string().nullable(),
  message: z.string(),
});

export type CiCompletionPayload = z.infer<typeof CiCompletionPayloadSchema>;

// --- Health response (GET /health body) ---

export const HealthResponseSchema = z.object({
  agent: z.string(),
  status: z.literal('online'),
  type: z.string(),
  uptime_seconds: z.number().int().nonnegative(),
  current_issue: z.number().int().positive().nullable(),
  version: z.string(),
  last_notification: z.string().nullable(),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

// --- Agent config (parsed from env vars) ---

export interface AgentConfig {
  readonly agentName: string;
  readonly agentType: string;
  readonly agentRole: string;
  readonly host: string;
  readonly advertiseHost: string;
  readonly port: number;
  readonly caCertPath: string;
  readonly caKeyPath: string;
  readonly agentCertPath: string;
  readonly agentKeyPath: string;
  readonly debug: boolean;
  readonly logPath: string | undefined;
  readonly project: string;
  readonly instanceId: string;
  readonly registry: import('./registry/types.js').RegistryConfig;
}

// --- Sign request (POST /sign body) ---
//
// Two-step challenge-response (DR-010, security fix per #80).
// Step 1: `{csr, agent_name, project?}` (no challenge_done, no challenge_id).
// Step 2: `{csr, agent_name, project?, challenge_done: true, challenge_id}`.
//
// Step 2 MUST include the `challenge_id` the server returned in step 1,
// and the client MUST have written the expected value to the registry
// using its own token. See src/certs/challenge.ts for the full protocol.

export const SignRequestSchema = z.object({
  csr: z.string().min(1),
  agent_name: z.string().min(1),
  project: z.string().optional(),
  challenge_done: z.boolean().optional(),
  challenge_id: z.string().uuid().optional(),
}).refine(
  (req) => !req.challenge_done || !!req.challenge_id,
  { message: 'challenge_id is required when challenge_done is true' },
);

export type SignRequest = z.infer<typeof SignRequestSchema>;

// --- Sign responses ---

export const SignChallengeResponseSchema = z.object({
  challenge_id: z.string(),
  instruction: z.string(),
});

export const SignCertResponseSchema = z.object({
  cert: z.string(),
});

// --- Notify endpoint response ---

export const NotifyResponseSchema = z.object({
  status: z.literal('received'),
});

// --- Error response ---

export const ErrorResponseSchema = z.object({
  error: z.string(),
});

// --- Logger interface ---

export interface Logger {
  readonly info: (event: string, data?: Record<string, unknown>) => void;
  readonly warn: (event: string, data?: Record<string, unknown>) => void;
  readonly error: (event: string, data?: Record<string, unknown>) => void;
}

// --- MCP channel interface ---

export interface McpChannel {
  readonly connect: () => Promise<void>;
  readonly pushNotification: (content: string, meta: Record<string, string>) => Promise<void>;
}

// --- HTTPS server interface ---

export interface HttpsServer {
  readonly start: (port: number, host: string) => Promise<{ readonly actualPort: number }>;
  readonly stop: () => Promise<void>;
}

// --- Health state interface ---

export interface HealthState {
  readonly getHealth: () => HealthResponse;
  readonly setCurrentIssue: (issueNumber: number | null) => void;
  readonly recordNotification: () => void;
}
