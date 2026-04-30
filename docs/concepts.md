# Concepts

How MACF is put together, why each piece exists, and what design decisions drove the shape. Citations link to canonical artifacts (DRs, phase specs, insights). For terms unfamiliar from the start, see [glossary.md](glossary.md).

## What MACF is

A framework for running several Claude Code sessions in parallel — each with a specialized role — and coordinating them through standard GitHub primitives: issues, pull requests, labels, and a reusable routing workflow. No custom coordination layer; no proprietary protocol. If your team can read a GitHub issue thread, they understand what the agents are doing and why.

The design assumes **GitHub is the substrate** for both work and coordination. This is a deliberate choice — see [use-cases.md](use-cases.md) for the trade-offs vs Slack/Linear/in-process queues. The shorter version: GitHub provides a free, persistent, audit-grained, dogfoodable coordination plane that operators already understand.

## Architecture at a glance

```
┌─────────────────────────────────────────────────────────────────┐
│   Operator                                                      │
│   (terminal / phone via Tailscale / GitHub web UI)              │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     │ SSH + tmux attach  │  Comments + issue labels
                     │                    │
         ┌───────────▼───────┐   ┌────────▼────────────────────┐
         │   Agent VM        │   │   GitHub                    │
         │                   │   │                             │
         │  tmux: science    │   │  Issues / PRs               │
         │  tmux: code       │   │  Repo Variables (registry)  │
         │  tmux: writing    │   │  Reusable workflow (routing)│
         │  ...              │   │  GitHub Apps (per agent)    │
         │                   │   │                             │
         │  channel-servers  │◄──┤  routing-Action workflow    │
         │  (mTLS HTTPS)     │   │  (Stage 3 transport)        │
         └───────────────────┘   └─────────────────────────────┘
```

Five primitives, each with its own DR:

1. **`macf` CLI** ([P4](../design/phases/P4-cli.md)) — workspace setup, cert lifecycle, doctor, status/peers/cd/list helpers. Ships as `@groundnuty/macf` on npm.
2. **`macf-agent` plugin** ([P5](../design/phases/P5-plugin.md), [DR-013](../design/decisions/DR-013-plugin-versioning.md)) — distributed via [`groundnuty/macf-marketplace`](https://github.com/groundnuty/macf-marketplace). Provides 4 skills, 7 agent identity templates, SessionStart + Stop hooks, the MCP server entry that spawns the channel server.
3. **Channel server** ([P1](../design/phases/P1-channel-server.md), [DR-002](../design/decisions/DR-002-channel-per-agent.md), [DR-015](../design/decisions/DR-015-http-endpoints.md)) — per-agent HTTPS server (`@groundnuty/macf-channel-server` on npm). Accepts `POST /notify` for inbound coordination events; `POST /sign` for cert signing; `GET /health` for peer pings.
4. **Routing-Action** ([P6](../design/phases/P6-action-update.md), [DR-017](../design/decisions/DR-017-ssh-elimination.md)) — reusable GitHub Actions workflow at [`groundnuty/macf-actions`](https://github.com/groundnuty/macf-actions). Five route-by-* jobs delivering events to the recipient agent's channel server (Stage 3) or tmux session (Stage 2).
5. **GitHub Apps** ([DR-008](../design/decisions/DR-008-agent-identity.md), [DR-019](../design/decisions/DR-019-app-permissions.md)) — per-agent identity. One App per agent; permissions scoped to the 7 required types (metadata, contents, issues, pull_requests, actions_variables, workflows, actions).

## Coordination flow — what happens when an issue gets filed

Worked example: science-agent files an issue tagged `code-agent` on the project's coordination repo.

1. **Filer side** — science-agent posts `gh issue create --label code-agent --body "@macf-code-agent[bot] please implement X"`. The PreToolUse `check-mention-routing.sh` hook (Check A + Check B) validates the body before the API call: must have ≥1 routing-active `@<bot>[bot]` mention; must not have any describing-context leak. See [features.md § PreToolUse hooks](features.md).
2. **GitHub side** — issue creation fires the `issues.opened` webhook event.
3. **Routing-Action side** — the project's `agent-router.yml` workflow (`uses: groundnuty/macf-actions/.github/workflows/agent-router.yml@v3`) processes the event. The `route-by-label` job sees the `code-agent` label, looks up code-agent's address in the registry (`gh api repos/.../actions/variables/MACF_<PROJECT>_AGENT_CODE_AGENT`), then fires `curl -X POST https://<code-agent-host>:<port>/notify` (mTLS, signed by the project CA).
4. **Channel-server side** — code-agent's channel server receives the `/notify` payload, validates against the typed `NotifyPayloadSchema` (Zod, [DR-023](../design/decisions/DR-023-stage3-hook-mcp-tool-architecture.md)), runs the recipient-side handler chain (formatter, tracing, tmux-wake), returns HTTP 200.
5. **Recipient side** — code-agent's tmux session wakes; the prompt is delivered to its Claude Code TUI; agent picks up the issue per its assigned-label queue.

The whole loop typically completes in 2-5 seconds (GitHub webhook delay dominates). If any step fails, fail-loud surfaces it: the `agent-offline` label gets applied, the operator sees a missed routing in `gh run list`, and the routing-Action's `route-by-ci-completion` rolled up the failure.

## Why "agents talk through GitHub" (and not direct IPC)

The architecture deliberately avoids direct agent-to-agent messaging. Three reasons, each grounded in observed behavior:

### Auditability

GitHub issue threads are persistent, queryable, and operator-readable. After agents merge a PR, the conversation that led to it stays in the thread. Six months later, a maintainer revisiting "why was this done this way" reads the issue + linked PR; agents read the same. No black-box message bus to spelunk; no Slack history to scroll. Concrete: `gh issue view 80` recovers the full reasoning trail for [DR-010 challenge-response cert-signing](../design/decisions/DR-010-cert-signing.md) including the security bug code-agent caught during implementation.

### Operator intervention without protocol weirdness

An operator wanting to redirect an agent doesn't need a special "operator mode" — they file an issue or post a comment, like any other agent. The routing-Action treats human-vs-bot @-mentions identically (the recipient-side hook validates per `coordination.md §Communication`, not per-actor). This means the framework's coordination contract is symmetric: if a human and an agent can both do X via the same surface, the framework doesn't care which actor invoked it.

### Dogfoodability

MACF's own development happens through MACF. The maintainers open issues, agents pick them up, write PRs, review each other's work, merge after LGTM. Over the 2026-04-15 → 2026-04-30 development sprint, agents merged ~80 PRs developing the framework — including a full security-audit-and-fix cycle where code-agent audited its own codebase ([macf#80](https://github.com/groundnuty/macf/issues/80)), filed bugs as P0, and shipped fixes itself. If the framework works for the agents building the framework, it works for real project work.

## Asymmetric contexts (why the orchestrator is bigger)

Not all agents run with the same context window. The default configuration:

- **Orchestrator** (typically a "science-agent") — 1M-token context window. Curates broad project understanding across sessions; reads research notes, design docs, prior incident catalogs; coordinates other agents.
- **Workers** (code-agent, writing-agent, etc.) — 200K-token context window. Take focused tasks; don't carry project-wide context.

This produces two effects: (1) the orchestrator stays grounded in project-level goals without being consumed by implementation-detail noise, and (2) total token cost is lower than running everyone at 1M. The CPC predecessor measured **22.7% token savings** vs symmetric-max-context across an 11-day production run (128 issues, 175 PRs, ~10.5T tokens consumed). See `groundnuty/claude-plan-composer` for the empirical data.

The trade-off: communication between orchestrator and workers must be **explicit + persistent** (because the worker doesn't know what's in the orchestrator's head). GitHub issues + PR threads are the persistence layer; @-mentions are the explicit hand-off. This drives several discipline rules (no implicit cross-session state; reporter-owns-closure; addressing-vs-describing distinction). See [`coordination.md`](../packages/macf/plugin/rules/coordination.md).

## Three promotion paths for coordination discipline

Coordination discipline emerges through **substrate evolution** — agents notice a recurring breach, codify a rule, ship the codification to consumers via `macf update`. The codification can take three structural forms (see `groundnuty/macf-science-agent:insights/2026-04-30-coordination-rules-vs-routing-infrastructure.md` for the full framework):

### Path 1 — discipline-as-text (Markdown rule)

The rule lives in `packages/macf/plugin/rules/<rule>.md`, distributed by `macf init` / `macf update` to consumer workspaces. Consumed by agents via session-loaded prompt context. Examples: `coordination.md`, `pr-discipline.md`, `mention-routing-hygiene.md`, `silent-fallback-hazards.md`. Strength: captures embodied knowledge in re-readable form. Weakness: rules need to be internalized through correction cycles to become load-bearing — agents reading them cold may apply inconsistently.

### Path 2 — discipline-as-routing (infrastructure / hook)

The rule is encoded in a PreToolUse hook (bash script blocking `gh` ops on violation), an Actions workflow job, or a channel-server schema check. Violations are STRUCTURALLY impossible. Examples: `check-gh-token.sh` ([macf#140](https://github.com/groundnuty/macf/issues/140)) blocks `gh` calls when `GH_TOKEN` lacks `ghs_` prefix; `check-mention-routing.sh` Check A + Check B ([macf#272](https://github.com/groundnuty/macf/issues/272), [macf#244](https://github.com/groundnuty/macf/issues/244)) block describing-context leaks + missing addressing; `route-by-pr-review-state` ([macf-actions#39](https://github.com/groundnuty/macf-actions/issues/39)) fires LGTM-routing structurally on `pull_request_review.submitted`. Strength: consumer agents don't need to internalize the rule; the infrastructure makes the violation impossible. Each Path-2 promotion reduces discipline-burden on every future consumer agent. Weakness: can't encode permissive discipline that requires LLM cognition (e.g., "research before implementing" can't be a hook).

### Path 3 — discipline-as-assertion (detection script)

The rule is an assertion script that runs at the boundary and detects violation. Examples: `check-tempo-ingestion.sh` (asserts trace count > 0 in Tempo for the test window); `doctor-otel.sh` (checks each running claude process's `OTEL_SERVICE_NAME` against Tempo for recent traces); `macf doctor` (reads workspace settings + verifies DR-019 perms + Write/Edit allow-list). Strength: generalizes across instances; one script defends multiple boundaries. Weakness: runs AFTER the violation; doesn't prevent it. Useful as a tripwire, not a gate.

### Decision rule

When promoting substrate-evolved discipline:
1. **Can the violation be detected at the API boundary deterministically?** YES → Path 2; NO → Path 1 or Path 3.
2. **Does the discipline require LLM cognition to apply?** YES → Path 1 only; NO → Path 2 (preferred) or Path 3 (if detection-only).
3. **Is the violation a CLASS (recurring across surfaces) or a single instance?** CLASS → Path 3 (defense pattern that generalizes); SINGLE → Path 2 if blockable; Path 1 if cognitive.

## Stage 0 / 1 / 2 / 3 routing — successive generations

The routing transport has evolved through four generations. Stages 0 + 1 predate MACF (they're history, not current state):

| Stage | Transport | Status |
|---|---|---|
| 0 | Operator pastes between sessions | Pre-MACF; no automation |
| 1 | Single-issue label dispatch via Actions | Pre-MACF; no per-agent state |
| 2 | SSH + tmux delivery (`agent-router.yml` SSH'es in, `tmux send-keys`) | Substrate: permanent ([operator directive 2026-04-27](use-cases.md)) |
| 3 | mTLS HTTPS POST `/notify` against per-agent channel servers | Consumer-fleet target; v3.x in `macf-actions` |

The substrate-permanent-Stage-2 directive matters because Stage 2 has a known silent-fallback class (Instance 3 of `silent-fallback-hazards.md`): SSH + `tmux send-keys` returns success even if the recipient TUI is in Remote Control mode (which silently buffers but doesn't process the input). Stage 3's HTTPS `POST /notify` produces an HTTP 200 only after the recipient's `onNotify` handler runs the result-invariant assertion that the prompt was successfully injected. Pattern A applied at the routing layer.

Substrate retains Stage 2 because (a) it predates the canonical Stage 3 path, (b) substrate operates without `macf init` per operator directive, and (c) the Stage 2 → Stage 3 migration runbook ([formerly `stage2-to-stage3-migration.md`, reshaped per #273](../design/macf-consumer-onboarding.md)) was repurposed for new-consumer-onboarding instead.

## Identity model — why one GitHub App per agent

Every agent has its own GitHub App, with its own private key, its own installation token, and its own bot username (`<app-name>[bot]`). This gives:

- **Attribution**: actions are attributed to the App ("`macf-code-agent[bot]` opened PR #N"), not to a shared service account or a human's PAT. The audit trail in `gh api repos/.../events` cleanly separates per-agent activity.
- **Permission scoping**: each App has only the 7 permissions per [DR-019](../design/decisions/DR-019-app-permissions.md). The blast radius of a compromised agent is bounded.
- **Token isolation**: revoking one agent's App revokes only that agent. No shared-credential refactor.
- **Audit trail**: `git log --author='code-agent[bot]'` recovers per-agent commit history without filename heuristics.

The cost: 7+ GitHub Apps per project, each requiring one-time install + permission acceptance. The trade-off was accepted in [DR-008](../design/decisions/DR-008-agent-identity.md). For very small projects, a single shared App is theoretically possible but breaks attribution and audit; not recommended.

## Security posture

### mTLS for inter-agent traffic

Inter-agent `/notify` calls are mTLS-authenticated. The project CA (`~/.macf/certs/<project>/ca-cert.pem`) signs each agent's cert; channel servers reject any client cert not in the CA's chain. Specs: [DR-004](../design/decisions/DR-004-authentication-mtls.md), [DR-010](../design/decisions/DR-010-cert-signing.md), [DR-011](../design/decisions/DR-011-ca-key-backup.md). Hardening: PBKDF2 at OWASP 2023 levels, clientAuth EKU enforcement, `/sign` challenge verification ([macf#87](https://github.com/groundnuty/macf/issues/87)), schema-validated payloads ([DR-023](../design/decisions/DR-023-stage3-hook-mcp-tool-architecture.md)), `extractCN` rejects multi-CN + non-CN-prefix subjects ([macf#98](https://github.com/groundnuty/macf/issues/98)).

### Attribution-trap defense

`check-gh-token.sh` PreToolUse hook ([macf#140](https://github.com/groundnuty/macf/issues/140)) intercepts every `gh` and `git push` invocation; blocks (`exit 2`) if `GH_TOKEN` is missing or doesn't have the `ghs_` prefix. Catches `sudo gh`, `bash -c "gh ..."`, `bash -xc`, `GH_TOKEN=x gh`, and other wrapped forms. Moved the attribution trap from behavioral (5 recurrences in one day pre-fix) to structural.

### Workspace-permissions doctor (Path-3)

`macf doctor` reads the merged view of `.claude/settings.json` + `.claude/settings.local.json` (per Claude Code's canonical merge semantics — arrays union, scalars replace) and surfaces:
- DR-019 permission gaps on the agent's GitHub App
- Sandbox `/proc/self/fd` allowRead pattern (fixes Bash tool failures per [macf#200](https://github.com/groundnuty/macf/issues/200))
- Workspace `permissions.allow` Write/Edit absence (autonomous-coordination prerequisite, surfaces drift before mid-coordination block)

Severity classification: BLOCK (Write absent + no Bash fallback), WARN (degraded autonomy), INFO (deny rule present — likely deliberate). Doctor exit code is unchanged by the workspace-permissions check (warn-only); the operator can have deliberate restrictions.

## Substrate vs consumer (the canonicalization-distribution gap)

Two operating contexts exist for MACF agents:

- **Substrate workbench** — `groundnuty/macf` (code-agent), `groundnuty/macf-science-agent`, `groundnuty/macf-devops-toolkit`. Substrate develops MACF. Permanently on Stage 2 routing per operator directive 2026-04-27. Substrate workspaces never run `macf init`.
- **Consumer-fleet** — `groundnuty/academic-resume`, `groundnuty/cv-project-archaeologist` (CV agents), and future MACF-consumer projects. Consumers run `macf init` to bootstrap; receive canonical content via `macf init` + refresh via `macf update --plugin`.

The asymmetry: substrate **produces** canonical content (rules, hooks, scripts) but doesn't **consume** it back automatically. When code-agent + science-agent canonicalize a new rule (e.g., the closure-direction inversion clarifier in PR #304), consumer workspaces pick it up on next `macf update`. Substrate workspaces don't — they predate the bootstrap path. To get the rule into substrate's session-loaded context, a manual `cp` from canonical to substrate `.claude/rules/` is needed.

This is the canonicalization-distribution gap. It explains why substrate-authored rules sometimes get re-breached by their authors after canonicalization — the rule is in the canonical content but hasn't reached the rule-author's session yet. The fix: pair canonicalization PRs with manual substrate sync (per `macf-science-agent` operational discipline post-2026-04-30).

## Observability

The channel server bootstraps OpenTelemetry on session start when `OTEL_EXPORTER_OTLP_ENDPOINT` is set:

- **Traces** — every `/notify`, `/sign`, peer ping produces a span. GenAI semconv-aligned operation names (`invoke_agent`, `handoff`, `peer_notify`). Tracer provider registered globally; consumer modules emit via `trace.getTracer('macf')`.
- **Metrics** — `macf_notify_received_total`, `macf_notify_peer_total` counters with labels `{macf_agent, type, event, delivered}`. DELTA temporality per [macf#281 Phase 2](https://github.com/groundnuty/macf/issues/281) — process restarts don't corrupt the cumulative trajectory in Prometheus storage.

Specs: [DR-021](../design/decisions/DR-021-otel-instrumentation.md). Opt-out: unset `OTEL_EXPORTER_OTLP_ENDPOINT`.

## What MACF is NOT

To anchor expectations explicitly:

- **Not a productivity multiplier.** Multi-agent coordination has overhead. CPC measured 1.18× total cost vs single-agent for the same work. The value is qualitative (cross-agent peer review surfaces issues a single agent misses; see [macf#112](https://github.com/groundnuty/macf/issues/112), [#144](https://github.com/groundnuty/macf/issues/144)) + asymmetric (orchestrator-worker token savings) rather than headcount-multiplicative.
- **Not real-time interactive.** Routing latency is 2-5 seconds per hop (GitHub webhook delay dominates). Not appropriate for tasks needing interactive turn-around.
- **Not a managed service.** Operator runs a VM, configures GitHub Apps, pays for tokens, manages CA keys. The framework is open-source and self-hosted.
- **Not a Claude-only system in principle.** MACF's coordination surface is GitHub; the agent sessions happen to be Claude Code today. Replacing the agents with a different LLM-backed CLI would require porting the plugin + skills layer; the routing + identity + cert primitives stay.

For when to use MACF, see [use-cases.md](use-cases.md).

## Cross-references

- [glossary.md](glossary.md) — term definitions used above
- [features.md](features.md) — concrete inventory of what's in v0.2.9
- [use-cases.md](use-cases.md) — when to use, when not to, comparison to academic peers
- [`design/decisions/`](../design/decisions/) — 23 DRs
- [`design/phases/`](../design/phases/) — 7 phase specs (P1-P7)
- [`packages/macf/plugin/rules/`](../packages/macf/plugin/rules/) — 13 canonical rules (operational discipline)
- `groundnuty/macf-science-agent:insights/` — paper-grade observations
- `groundnuty/macf-science-agent:papers/` — academic-peer baseline
