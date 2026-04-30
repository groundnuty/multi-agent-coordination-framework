# Silent-Fallback Hazards (canonical, shared)

**This file is the single source of truth for recognizing the silent-fallback hazard class — failure modes where tool/API operations succeed at the API boundary but produce semantically wrong outcomes that are invisible until something downstream breaks.** It is copied into each agent workspace's `.claude/rules/` by `macf init` and refreshed by `macf update` / `macf rules refresh`. Do not edit workspace copies directly — edit the canonical file at `groundnuty/macf:packages/macf/plugin/rules/silent-fallback-hazards.md` and re-run the distribution.

> **Workspaces without full `macf init`** (e.g. `groundnuty/macf` itself, or any Claude Code workspace operated by a bot that isn't a MACF-registered agent) can still get this canonical rule via `macf rules refresh --dir <workspace>`. Same copy, no App credentials or registry required.

This rule names the CLASS so agents recognize the shape on first encounter rather than re-discovering each instance from scratch. Eight specific instances are documented below as worked examples spanning different architectural layers (identity, parsing, TUI binding, observability routing, config substitution, multi-agent coordination protocol, metric-instrumentation lifecycle, observability-endpoint routing). Six of eight have structural defenses applied or in flight — the pattern of defense generalizes alongside the pattern of hazard.

---

## The hazard shape

```
API call → exit 0 / HTTP 200 / no error
         → semantic outcome: WRONG identity / scope / target
         → downstream consumer assumes API success implies semantic success
         → failure invisible until something breaks elsewhere
```

The trap is that defensive programming targets exit codes, but exit-code success is satisfied by the silent-fallback path. Defenses must guard at the **result-invariant level** (what was actually written / posted / received), not at the **exit-code level**.

---

## Eight known instances

### Instance 1 — gh-token attribution traps

**Surface:** `gh` operations + bot installation tokens
**Failure shape:** broken/missing `GH_TOKEN` → silent fallback to stored `gh auth login` user → ops succeed, content correct, but `actor` on the resource is the human-operator account, not the bot
**Recurrence:** 5+ confirmed instances across multiple agents
**Canonical defense:** `gh-token-attribution-traps.md` (sister canonical rule) — 6 specific failure modes + result-invariant defenses (`[[ "$GH_TOKEN" == ghs_* ]]` prefix check, `macf-whoami.sh` spot-check, PreToolUse hook intercepts `gh` and `git push` invocations)

### Instance 2 — GitHub auto-close negation-blindness

**Surface:** PR / issue body markdown parsing
**Failure shape:** `Closes #N` / `Fixes #N` / `Resolves #N` (and lowercase / past-tense variants — 9 forms total) trigger GitHub's auto-close on merge **regardless of surrounding context** — including inside negations ("will NOT close #N"), quotes, hypothetical examples, or AC checklists. Revert commits inherit the keyword via the default `Revert "..."` wrapping and fire auto-close a second time on the revert merge.
**Recurrence:** Multiple confirmed incidents; sub-failure-mode (revert-message-keyword-inheritance) confirmed 2026-04-29.
**Canonical defense:** `pr-discipline.md` + `coordination.md §Issue Lifecycle 1` — use `Refs #N` exclusively when issue was filed by someone else; never use any of the 9 auto-close keywords with `#N` regardless of intended context. When reverting, override the default revert message to strip the inherited keyword.

### Instance 3 — Remote Control IPC blocking tmux send-keys

**Surface:** Claude Code TUI sessions with "Remote Control active" status
**Failure shape:** `tmux send-keys` exits 0 + keystrokes are written to pane stdin, but Claude Code's input handler is bound to a different IPC channel (RC's SDK socket); routing-via-tmux silently bypasses the actual input path → recipient never sees the routed prompt.
**Recurrence:** Cross-agent triangulated; 2+ confirmed firings on real routes hours apart, same shape.
**Defense status:** Two-tier per fleet class:
- **Consumer fleet** (CV agents, tester agents, future macf-init'd consumers): structurally retired via Stage 3 channel-server primitive (HTTP POST bypasses tmux layer entirely). Operational as of DR-020 / macf-actions v3+.
- **Substrate fleet** (workspaces operated as the design surface, not registered MACF consumers): permanent operational reality — substrate workspaces don't run `macf init`. Defensive posture: rule-discipline + Pattern C fragility detector (`tmux display -p '#{session_activity}'` doesn't advance under RC-bound input).

The structural retirement applies to consumer fleet only; substrate fleet expects Instance 3 firings to recur on routes indefinitely; rule-discipline catches the failure at observation time, not pre-emptively.

### Instance 4 — Loki / ClickHouse-logs pipeline divergence (label-vs-structured-metadata)

**Surface:** OTLP logs pipeline routing through central Collector → Loki + ClickHouse-logs
**Failure shape:** Loki only indexes a small set of labels (`service_name`, `service_namespace`, `k8s_*`); other OTLP resource attrs land in structured metadata, NOT as indexed labels. Loki query selector `{gen_ai_agent_name=...}` returns 0 streams silently — same data is visible in ClickHouse via Map-key access. Snapshot scripts that query Loki by an unindexed key return zero results while the parallel ClickHouse query returns full rows. Silent split where the same pipeline produces inconsistent retrieval shape across consumers.
**Recurrence:** Surfaced during phase-1 verification on a multi-tester scenario.
**Structural defense:** observability-snapshot scripts use `service_name` indexed label for the common `gen_ai.agent.name` filter case + structured-metadata fallback (`{service_name=~".+"} | <key>="<value>"`) for other keys + manifest warnings array detecting Loki/CH divergence at >10× ratio with shape-aware diagnostic per failure mode.

### Instance 5 — Workflow secrets-misnamed (operator-renames vs workflow-expects)

**Surface:** GitHub Actions workflow consuming `secrets.X` / `vars.Y` references
**Failure shape:** When an expected secret is missing or renamed (e.g., workflow expects `TAILSCALE_OAUTH_CLIENT_ID` but the operator created `TS_OAUTH_CLIENT_ID`), `${{ secrets.TAILSCALE_OAUTH_CLIENT_ID }}` substitutes empty string at action invocation time. The downstream tool surfaces a misleading error (auth fail at the consumer step) rather than the actual root cause (missing secret).
**Recurrence:** Surfaced via 3 confirmed workflow runs of confusing errors before the precheck-step pattern was introduced.
**Structural defense:** Workflow precheck step (runs after `checkout`, before any tool that consumes the secrets) pulls all expected secrets + vars into env, empty-string-checks each, aggregates missing names into one `::error::` annotation per missing input + runbook reference, exits 1 on any missing. Aggregate-fail-loud over fail-on-first-miss so the operator sees ALL gaps in one workflow run.

### Instance 6 — Cross-agent notification loop (multi-agent coordination protocol layer)

**Surface:** `type: "mcp_tool"` Stop hook + `notify_peer` broadcast tool deployed end-to-end (DR-023 UC-1)
**Failure shape:** Each individual operation succeeds at the API boundary (HTTP 200 from `/notify`, MCP push completed, `tmux_wake_delivered` logged). But the protocol has no termination condition for "peer notification triggers fresh turn → fresh turn fires Stop hook → Stop hook notifies peer." The platform's same-agent recursion guard (`(server, tool, input)` deduplication) catches recursion inside a single agent's MCP context; cross-agent recursion bypasses dedup because each agent has its own dispatcher state. Empirical observation: 8 cycles in 50s before manual termination.
**Architectural origin:** design-assumption mismatch — peer notifications were intended as informational (no auto-action) but the receiver's `/notify` handler triggered tmux-wake-on-receipt, turning notifications into programmatic prompts.
**Structural defense:** Pattern E (type-discriminator at receiver) shipped in macf v0.2.4 — `server.ts` `onNotify` discriminates by payload type. `peer_notification` → MCP push only, tmux wake SKIPPED with explicit log entry. Other `NotifyType`s (`issue_routed`, `mention`, etc.) preserve current wake-on-receipt behavior. Verified via clean post-fix trace (single 3-span trace where the prior version had 8 alternating cross-agent spans).

### Instance 7 — OTel-counter cumulative-state assumption violated by short-lived process lifecycle

**Surface:** OTel cumulative-temporality counters in processes whose lifetime doesn't match the cumulative-counter contract (e.g., `macf-channel-server` runs as Claude Code's MCP subprocess; lifetime = Claude session lifetime; multiple sessions spawn fresh processes each starting counter at 0).
**Failure shape:** Counter increments emit fine via OTLP (HTTP 200 from Collector). Series identity (same labels: `macf_agent`, `macf_notify_type`, etc.) collides across short-lived process generations. Prometheus's cumulative-counter assumption sees the latest scrape value (often `1` per fresh process) rather than the true accumulated count (e.g., `5` events across a 5-iter sweep). `rate()` / `increase()` queries handle the resets correctly within scrape windows, but raw counter values become near-meaningless.
**Recurrence:** First observed instance, surfaced via T6 metrics runtime verification.
**Defense status:** Two-phase plan. **Phase 1** (immediate): document `sum(increase(metric[range])) by (labels)` as the canonical query pattern in operations runbook + add comment in `metrics.ts` explaining the per-session lifetime characteristic. **Phase 2** (in flight): configure OTel SDK delta temporality — `OTLPMetricExporter({ temporalityPreference: AggregationTemporality.DELTA })`. Each process exports its own deltas; OTel/Collector aggregates by series identity → cumulative count correct regardless of process topology. Verified robust to both "1-process-per-session-restart" and "N-parallel-processes-per-tester" topologies.

### Instance 8 — Telemetry-endpoint silent-drop on retired/wrong-port OTLP target

**Surface:** OTel exporter pointed at a retired or otherwise non-listening endpoint (e.g., a stale `:4318` after compose-stack retirement when the current cluster is on a different port).
**Failure shape:** `claude.sh` exports cleanly (no error). Claude Code's OTel exporter dispatches traces/metrics/logs to the configured endpoint → TCP connect refused → exporter silently retries-then-drops (no surfaced error in stderr; no log entry in operator-visible logs). Agents continue to function normally — coordination events fire, channel-server delivers notifications, GitHub artifacts get created. **The observability surface is empty** (no traces in Tempo, no metrics in Prometheus) but no failure signal at any layer.
**Recurrence:** First observed instance, surfaced via end-to-end smoke test (consumer agents ran for 34 minutes producing real coordination events but Tempo + Prometheus had zero traces and zero metric series for the test window).
**Defense status:** Five architectural surfaces (Layer 1 + Tiers 1-4) — paper-grade artifact for the methodology section.
- **Layer 1 (CLI release-discipline):** `macf update --help` documents always-on template-sync semantics; downstream tooling (e.g., e2e tests) pin the macf binary version with `npx -y @groundnuty/macf@<pin>` to prevent stale-CLI-binary clobbering of canonical templates.
- **Tier 1 (substrate testers):** env-override pattern — `OTEL_EXPORTER_OTLP_ENDPOINT=<correct-endpoint>` set before `claude.sh` runs.
- **Tier 2 (consumer canonical):** canonical `claude-sh.ts` produces a **two-layer override** form: template-time bake via `MACF_OTEL_ENDPOINT` + run-time override via `OTEL_EXPORTER_OTLP_ENDPOINT` + canonical default pointing to the current cluster.
- **Tier 3 (cluster-side compatibility port-map):** k3d serverlb persists host-port mappings for legacy ports, so any stale `claude.sh` predating the canonical-template fix routes correctly without re-bootstrap.
- **Tier 4 (agent-process exporter-state):** long-lived agent processes started during a connect-refused window have their bundled OTel SDK retry budget exhausted and don't auto-recover. Operator remediation: graceful relaunch (fresh OTel exporter state via fresh process). Detection: `doctor-otel.sh` queries each running claude process's `OTEL_SERVICE_NAME` from `/proc/<pid>/environ` against Tempo and reports stuck processes.

**Pattern A defense template:** result-invariant check at the observability boundary — assert "trace count > 0 in Tempo for the test window" before considering the run telemetered. Mirrors the gh-token-attribution Pattern B (pre-flight state validation) shape applied to the OTLP boundary instead. Two concrete script implementations form the complete result-invariant assertion surface for the OTLP-pipeline silent-fallback class:
- **Cluster-side:** `check-tempo-ingestion.sh` — compares `tempo_distributor_spans_received_total` delta to TraceQL search count over the same window; exits non-zero on ingestion-without-search-results signature. Detects Tiers 1/2/3 (config / endpoint / cluster-side) failures.
- **Agent-side:** `doctor-otel.sh` — for each running claude process with `OTEL_TRACES_EXPORTER=otlp` set, reads `OTEL_SERVICE_NAME` from `/proc/<pid>/environ` and queries Tempo for that service's recent traces. Reports stuck processes (Tier 4 firing condition).

Together the script-pair detects the entire OTLP-pipeline silent-fallback class regardless of which architectural surface broke. **Strongest empirical evidence yet that Pattern A is the load-bearing structural-defense template for the entire observability-pipeline-class.**

**TraceQL query-syntax note (Pattern A's adjacent gotcha):** when querying Tempo for traces by dotted resource attributes, **the dotted key must be quoted**. The unquoted form returns 0 silently (matches no traces; is NOT a parse error):

```bash
# WRONG (returns 0 silently — looks like "no telemetry" when traces actually exist)
curl -G "$TEMPO/api/search" --data-urlencode 'q={resource.gen_ai.agent.name=~"cv-.*"}'

# RIGHT (matches; canonical form for dotted resource attrs)
curl -G "$TEMPO/api/search" --data-urlencode 'q={resource."gen_ai.agent.name"=~"cv-.*"}'
```

This is a **secondary Pattern A failure mode** — the assertion script CAN return zero-traces and look like a Tier-1/2/3/4 firing when actually it's a query-syntax issue. Defense: when investigating "Pattern A reports zero traces," cross-check with the alternative query `{resource.service.name=~"macf-agent.*"}` (uses the OTel-canonical service-name attribute which TraceQL handles natively, no dotted-key quoting needed). If that returns non-zero, the issue is query-syntax not silent-fallback.

---

## How to recognize the class on first encounter

When investigating a "the operation completed but the outcome is wrong" incident, suspect silent-fallback if ANY of:

1. **Exit code 0 / HTTP 200 with semantic mismatch** — operation reported success, downstream behavior shows it didn't actually work.
2. **Multiple paths share the same exit-code outcome** — the "good path" and the "fallback path" both produce success, but only the good path produces correct semantics.
3. **Detection requires invariant-checking, not error-checking** — to find the failure, you have to query the result and check it against expected shape (token prefix, actor login, recipient activity, downstream telemetry presence).

If you recognize the class on first encounter, file the new instance as a research-doc or insight in your workspace, then propose canonicalization via PR per the threshold in *"When to add a new instance to this rule"* below.

---

## Defensive patterns

Apply the matching pattern when implementing tools that interact with these surfaces.

### Pattern A — Result-invariant assertion

After the operation, assert an invariant on the RESULT, not on the exit code:

```bash
# Don't:
gh issue comment N --body "..." || exit 1   # exit 0 doesn't prove correct attribution

# Do:
gh issue comment N --body "..."
COMMENT_AUTHOR=$(gh issue view N --json comments --jq '.comments[-1].author.login')
[ "$COMMENT_AUTHOR" = "$EXPECTED_BOT" ] || { echo "FATAL: wrong author"; exit 1; }
```

### Pattern B — Pre-flight state validation

Before the operation, validate that the precondition for the good path holds:

```bash
# Token prefix check before gh ops
[[ "$GH_TOKEN" == ghs_* ]] || { echo "FATAL: bad token"; exit 1; }
gh ...
```

### Pattern C — Heartbeat / activity invariant

For routing-style operations, check that recipient state advanced post-delivery:

```bash
# tmux send-keys + check session_activity advanced (Remote Control IPC detector)
PRE=$(tmux display -p -t $SESSION '#{session_activity}')
tmux send-keys -t $SESSION "..." Enter
sleep 2
POST=$(tmux display -p -t $SESSION '#{session_activity}')
[ "$POST" -gt "$PRE" ] || { echo "WARNING: tmux activity didn't advance — RC-bound?"; }
```

### Pattern D — Precheck step at workflow / process entrypoint

For long-running workflows where a missing/misnamed configuration input renders as empty-string and causes a downstream tool to surface a misleading error: add a fail-fast precheck early in the execution that asserts the configuration shape is correct, aggregating ALL missing items into one error message rather than failing on the first miss.

```bash
# GitHub Actions workflow precheck (runs after checkout, before any tool that consumes the secrets)
# Aggregate-fail-loud over fail-on-first-miss — operator sees ALL gaps in one fire.
set -euo pipefail
missing=()
[ -z "${TAILSCALE_OAUTH_CLIENT_ID:-}" ] && missing+=("TAILSCALE_OAUTH_CLIENT_ID (secret)")
[ -z "${TAILSCALE_OAUTH_SECRET:-}" ]    && missing+=("TAILSCALE_OAUTH_SECRET (secret)")
# ... etc per expected secret/var
if [ ${#missing[@]} -gt 0 ]; then
  echo "::error::Missing required workflow inputs:"
  for m in "${missing[@]}"; do echo "::error::  - $m"; done
  echo "::error::See docs/<runbook>.md for the runbook."
  exit 1
fi
echo "✓ All expected secrets + variables present"
```

Key elements:
- `${VAR:-}` defaulting required (without it, `set -u` fails BEFORE the precheck can collect the missing names). Note: `${VAR:-}` returns empty string when unset, AND empty string is the actual signal — GitHub Actions substitutes empty for missing secrets/vars (not "undefined"). The precheck detects "missing OR explicitly-empty" uniformly, which is correct: an operator setting a secret to empty string IS a misconfiguration worth blocking.
- Distinguish "(secret)" vs "(variable)" annotation — saves the operator a settings-page click
- Aggregate via `missing=()` array + `${#missing[@]}` length check
- One `::error::` annotation per missing item (GitHub UI renders red error annotations)
- Runbook cross-reference embedded in the error message

Generalizes beyond GitHub Actions: any process that consumes configuration from external sources benefits from a precheck-at-entrypoint pattern. The hazard is that empty-config typically causes a misleading downstream error rather than failing at the configuration boundary; the defense is asserting at the boundary itself.

### Pattern E — Type-discriminator at the receiver

For multi-agent protocols where notifications can drive recipient behavior: discriminate by message type at the receiver and restrict action-triggering paths to types that intentionally drive action. Informational types (peer notifications, status updates, FYI) flow through MCP push or equivalent observability surfaces but do NOT auto-trigger fresh turns / Stop hooks / response side-effects.

```typescript
// Receiver's notification handler
async function onNotify(payload: NotifyPayload, ...) {
  // Always: deposit into observable state (MCP push, log, metrics)
  await pushToMcpChannel(payload);

  // Conditional: discriminate by type for action-triggering side effects
  if (payload.type === 'peer_notification') {
    // Observational only — no fresh turn fires; recipient's LLM SEES the
    // notification via MCP channel state but doesn't auto-respond.
    // Cross-agent loop class structurally retired.
    logger.info('action_path_skipped', {
      reason: 'type_discriminator',
      type: payload.type,
    });
    return;
  }

  // Action-triggering types preserve current behavior
  if (config.tmuxWakeAvailable) {
    await wakeViaTmux(formatNotifyContent(payload));
  }
}
```

Key elements:
- **Always** deposit into observable state (preserves visibility / paper-trail)
- **Conditional** action-triggering (preserves termination by restricting which messages drive emergent behavior)
- **Explicit log** when the action path is skipped (surfaces the discrimination decision in operational logs; debuggable)

Pattern E specifically addresses the **multi-agent coordination protocol** layer where Patterns A-D don't apply — the issue isn't single-step semantic mismatch (Patterns A/B/C catch those) or config-substitution failure (Pattern D), but emergent multi-step behavior driven by misaligned action-triggering semantics. Pattern E restores the design assumption ("informational notifications don't drive turn-taking") at the implementation layer.

Generalizes to any multi-agent protocol with mixed informational + actionable notifications: the discriminator IS the contract, encoded at the receiver where it can't drift away from the implementation.

---

## Why this class matters at the architectural level

Silent-fallback hazards are **architectural**, not implementation bugs. They emerge from:

- Layered abstractions where a lower layer's "success" doesn't guarantee the upper layer's semantic correctness (tool API vs intent)
- Default-fallback paths designed for resilience that produce wrong-but-successful outcomes when the primary path fails
- Detection-via-invariant rather than detection-via-error-code

For coordination-system safety analysis: this is a class of hazards multi-agent systems must explicitly defend against. Each new instance teaches the same lesson; the class-name is what makes the lesson transferable across agents.

### Defense-pattern emergence (6-of-8 known instances have structural defense applied or shipped)

| Instance | Surface | Structural defense | Pattern |
|---|---|---|---|
| 1 — gh-token attribution traps | `gh` ops + bot tokens | PreToolUse hook + helper-with-fail-loud-prefix-check | Pattern B |
| 2 — GitHub auto-close negation-blindness | PR/issue body markdown | Pattern B candidate; structural defense via PreToolUse hook on body content per #275 precedent — not yet shipped | Pattern B (latent) |
| 3 — Remote Control IPC blocking tmux send-keys | Claude Code TUI input | Two-tier: consumer fleet structurally retired via channel-server primitive (DR-020 mTLS HTTPS POST); substrate fleet permanent operational reality — defense = rule-discipline + Pattern C fragility detector | Pattern C deployable as fragility detector |
| 4 — Loki/CH-logs pipeline divergence | OTLP logs routing | manifest warnings + shape-aware diagnostic | Pattern A |
| 5 — Workflow secrets-misnamed | GitHub Actions workflow inputs | Workflow precheck step | Pattern D |
| 6 — Cross-agent notification loop | Multi-agent coordination protocol | macf v0.2.4: type-discriminator in receiver's `/notify` handler — `peer_notification` skips tmux wake (observational-only); other `NotifyType`s preserve wake-on-receipt | Pattern E |
| 7 — OTel-counter cumulative-state vs short-lived-process lifecycle | Metric-instrumentation lifecycle | Two-phase: doc workaround `sum(increase(...))` + OTel SDK delta temporality | Pattern A |
| 8 — OTLP endpoint silent-drop | Observability-endpoint routing | Five-surface defense: CLI release-discipline + substrate testers env-override + canonical template `:14318` default + cluster-side compat port-map + agent-process `doctor-otel.sh` Pattern A | Pattern A (composite — first multi-architectural-layer case in this rule; instances 1-7 have single-pattern defenses) |

Six of eight instances have structural defense applied or shipped. Defense patterns (A, B, C, D, E) generalize across instances — they're reusable defense templates, not case-specific fixes. **Pattern A (result-invariant assertion at the boundary) bears the most weight** — it's the structural defense for instances 4, 7, AND 8 (3 of 8), each at a different architectural boundary (logs pipeline, metric counter, observability endpoint). Instance 8's five-surface defense topology (consumer canonical + cluster-side compat port-map + concrete Pattern A impl) demonstrates that structural defense at the observability-pipeline-class can compose across architectural layers — the canonical-distribution layer + the cluster-infrastructure layer + the assertion-script layer all reinforce each other rather than substituting for each other.

The breadth of layers spanned by 5 different defense patterns (identity, parsing, TUI binding, observability routing, config substitution, multi-agent coordination protocol, metric-instrumentation lifecycle, observability-endpoint routing) is independent evidence that the hazard CLASS is real. If silent-fallback was a single-instance accident, no defense pattern would emerge. **Pattern A's recurrence across 3 different observability boundaries (logs / metrics / endpoint) is the strongest signal that result-invariant assertion is the load-bearing structural-defense template for the entire observability-pipeline-class** of silent fallback.

---

## When to add a new instance to this rule

Add when ALL of the following hold:

- A new failure mode of the same shape is observed (success at API boundary, semantic failure invisible)
- The instance has been verified (not just suspected) — minimum 1 incident with a concrete trace
- The defense pattern is identified (otherwise the instance is a TODO, not a documented hazard)

The class-name is what makes the lesson transferable, not multi-agent witness. A single-agent-confirmed instance with a concrete trace + identified defense pattern is sufficient for canonicalization (instances 4, 5, 7, 8 are all single-agent-confirmed). Cross-agent triangulation strengthens the framing but isn't a precondition.

Add as a new numbered section under "Eight known instances" (will become "Nine known instances" etc.) with the same fields: Surface / Failure shape / Recurrence / Defense status.

---

## When to read vs modify this rule

- **Read:** every session start. This rule is broadly applicable across coordination, observability, and tool-integration work.
- **Modify:** never directly in workspace copies. Edit the canonical file at `groundnuty/macf:packages/macf/plugin/rules/silent-fallback-hazards.md` and re-run `macf update`.
- **Disagree with a rule?** Open an issue on `groundnuty/macf` proposing the change, with rationale + the incident that showed the rule was wrong. Peer review applies.

---

## Cross-references

- `gh-token-attribution-traps.md` (canonical) — Instance 1 detail
- `pr-discipline.md` + `coordination.md §Issue Lifecycle 1` (canonical) — Instance 2 detail
- DR-020 (Stage 3 mTLS routing) — Instance 3 consumer-fleet structural retirement
- DR-022 / DR-023 (channel-server + MCP-tool architecture) — Instance 6 Pattern E shipping vehicle
