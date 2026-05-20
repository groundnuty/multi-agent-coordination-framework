# Phase: A2A v1.0 Phase 5 — CV Consumer-Fleet Migration to Inbound A2A Surface

**Issue:** [groundnuty/macf#406](https://github.com/groundnuty/macf/issues/406)
**Status:** in-progress (this PR ships the migration doc; actual execution is operator-driven)
**Date:** 2026-05-20
**Authored by:** code-agent; filed by science-agent per the layered-cadence dependency chain

## Overview

Phase 5 closes the A2A v1.0 integration arc on the **consumer-fleet
adoption** surface — migrating the existing CV agent fleet
(`cv-architect`, `cv-project-archaeologist`) from legacy `notify_peer`
envelope path to the A2A v1.0 inbound surface.

Per refined scope (operator-validated insight pre-recovery):
CV agents consume `macf-channel-server` via npm dependency, NOT direct
`notify_peer` source code. This phase is **version-bump coordination +
real-fleet verification**, NOT protocol refactoring of CV agents.

Phase 4 (#405) documented the external-publication surface + sunset
options; Phase 5 exercises the canonical inbound surface
internally with real CV traffic to satisfy whichever sunset criterion
operator selects.

## Doc-vs-execution split

This phase has an unusual split between **doc work** (this PR) and
**execution work** (operator-driven, post-PR):

- **Doc work (in this PR)**: migration procedure, verification commands,
  observability assertions, completion checklist
- **Execution work (operator-driven, post-merge)**: actual
  `macf update` on CV workspaces, cv-e2e-test rehearsal,
  Tempo / Grafana verification

Rationale: CV workspaces are at substrate-level paths
(`/home/ubuntu/cv-architect-home/` etc.) that code-agent doesn't have
direct access to. Code-agent's role is **designing the migration path
+ acceptance criteria**; operator's role is **executing + observing
production traffic**.

This mirrors how Phase 4's Foundry / Bedrock registration was scoped:
code-agent documented the procedure; operator action triggers when an
Azure / AWS tenant materializes.

## Acceptance criteria + migration procedure

### AC 1 — CV workspaces upgraded to v0.2.32+

**Status**: operator action; procedure documented below

**Per-workspace upgrade procedure** (operator runs in each CV workspace):

```bash
# In /home/ubuntu/cv-architect-home/ (and cv-project-archaeologist-home/):
cd <workspace>

# 1. Refresh canonical rules + scripts + macf-channel-server pin
macf update --all --yes

# 2. Verify the upgrade took effect — assert against the actual
#    deployed channel-server version, NOT just "macf update ran"
#    (per feedback_verify_at_every_hop_when_citing_peer_evidence.md
#    + feedback_silent_default_fallback_class.md)
cd <workspace>
node -e "const p = require('@groundnuty/macf-channel-server/package.json'); console.log(p.version)"
# Expect: 0.2.32 (or later)

# 3. Verify v0.2.32 is the npm registry's view, not local cache stale
npm view @groundnuty/macf-channel-server@0.2.32 version
# Expect: 0.2.32

# 4. Verify AgentCard endpoint responds with v0.2.32 capabilities
GH_TOKEN=$(...) curl -s --cert-type PEM \
  --cert <workspace>/.claude/.macf/certs/agent.crt \
  --key <workspace>/.claude/.macf/certs/agent.key \
  --cacert <workspace>/.claude/.macf/certs/ca.crt \
  "https://127.0.0.1:<port>/.well-known/agent-card.json" \
  | jq -r '.version'
# Expect: 0.2.32

# 5. Verify /a2a/v1 endpoint is reachable
curl -s -X POST --cert-type PEM \
  --cert <workspace>/.claude/.macf/certs/agent.crt \
  --key <workspace>/.claude/.macf/certs/agent.key \
  --cacert <workspace>/.claude/.macf/certs/ca.crt \
  -H "Content-Type: application/json" \
  "https://127.0.0.1:<port>/a2a/v1" \
  -d '{"jsonrpc":"2.0","id":"smoke-1","method":"message/send","params":{"message":{"messageId":"smoke","role":"ROLE_USER","parts":[{"text":"ping"}]}}}' \
  | jq '.result.status.state'
# Expect: "TASK_STATE_COMPLETED"
```

**Why v0.2.32, not v0.2.31**: v0.2.31 publish attempt FAILED (EOTP). Per
sigstore TLOG semantics, v0.2.31 will never publish. v0.2.32 supersedes
with identical content via OIDC trusted publishers. Operator MUST upgrade
to v0.2.32 (or later) — not v0.2.31. AC #405 originally referenced
v0.2.31+; that was filed pre-recovery; v0.2.32+ is the correct target
post-arc.

### AC 2 — cv-e2e-test rehearsal with A2A exercise

**Status**: operator action; rehearsal harness pre-exists

Use the existing `tools/cv-e2e-test.sh` rehearsal harness (in
`macf-science-agent` repo per #406 pointer) with one new assertion:
the `/a2a/v1` endpoint MUST be exercised at least once during the
rehearsal flow.

**Operator extension to the rehearsal**: post-rehearsal, grep Tempo for
the `macf.a2a.message_send` SERVER span name:

```
{name="macf.a2a.message_send", resource."gen_ai.agent.name"=~"cv-.*"}
```

At least one matching span per rehearsal proves CV's channel-server is
serving real A2A traffic. Zero matches = AC failure; investigate.

### AC 3 — Cross-workspace coordination flow via A2A

**Status**: operator action; observed in production CV traffic

Per Phase 3 (#407) protocol-selection logic in `notify-peer.ts`, CV
agents now use A2A path AUTOMATICALLY when target peer publishes
AgentCard with JSONRPC binding. AC 1 (above) ensures both CV agents
expose this AgentCard. AC 3 observes the natural cross-workspace
coordination flow that follows from AC 1 + AC 2.

**Observability assertion** (operator runs against Tempo):

```
# Look for cv-architect → cv-project-archaeologist via A2A:
{name="invoke_agent cv-project-archaeologist",
 resource."gen_ai.agent.name"="cv-architect",
 macf.outbound.protocol="a2a"}
```

A non-zero result count proves the cross-workspace flow uses A2A. The
sister query with `macf.outbound.protocol="legacy"` should trend to zero
over the observation window (relevant to AC 5 sunset).

### AC 4 — Observability verification (Tempo + Grafana)

**Status**: operator action; release-hygiene dashboard pre-exists

Use the release-hygiene Grafana dashboard (`macf-release-hygiene` UID;
`groundnuty/macf-devops-toolkit#74` / `#77` shipped 2026-05-20). Add a
new panel OR use an existing per-version count panel filtered to CV
agents:

```promql
count by (gh_actor, gh_repo) (
  macf_app_gh_actions_write_total{
    gh_actor=~"cv-.*"
  }
)
```

This surfaces the live consumer-version inventory. Once both CV agents
appear on v0.2.32+, AC 4 is satisfied.

Alternative direct check via npm registry user view:

```bash
npm view @groundnuty/macf-channel-server@0.2.32 dist.attestations.url
```

This is package-published-state, not consumer-deployment-state, so use
the Tempo / Grafana surface for actual consumer verification.

### AC 5 — Sunset coordination

**Status**: depends on operator's Phase 4 sunset-criterion decision

Phase 4 (#405) documented three sunset options for the legacy
`/notify` envelope path:

- **Option A**: counter-based; sunset when zero
  `macf.outbound.protocol: 'legacy'` spans for 60 consecutive days
- **Option B**: calendar-based; sunset 2026-09-30
- **Option C**: phase-completion-based; post-Phase-5 + 30-day
  observation

**If operator picks Option A or C**: Phase 5's AC 3 directly triggers
the criterion when both CV agents migrate to A2A path. The 60-day (A) or
30-day (C) observation window starts when the last legacy `/notify`
invocation count goes to zero.

**If operator picks Option B**: Phase 5 still satisfies the criterion
(CV agents migrate before 2026-09-30 deadline) but the time pressure is
operator-imposed, not phase-completion-driven.

Phase 5 completion criterion (this AC) = both CV agents on v0.2.32+
running A2A path AND a legacy-invocation-count baseline established for
the operator's chosen sunset criterion.

### AC 6 — CV memory + rules refresh

**Status**: surveyed; no active rule refresh needed pre-sunset

`grep -rln "notify_peer" packages/macf/plugin/rules/` returns 2 files:

- `silent-fallback-hazards.md` — historical incident witness (Instance
  6 cross-agent loop hazard); accurately documents the legacy path; NO
  refresh needed
- `gh-token-attribution-traps.md` — historical context describing
  notify_peer's registry lookups in the token-expiry incident; NO refresh
  needed

Both references are HISTORICAL CONTEXT, not active code references.
Post-sunset (when operator's Phase 4 criterion fires + a future PR
removes the legacy path), update these rules to mark them as
historical-witness-only with the sunset date. NOT in scope for Phase 5.

**CV-specific routing rules**: CV agents inherit canonical rules via
`macf rules refresh` (per `macf init` / `macf update` distribution).
The AC 1 upgrade procedure already covers this — `macf update --all
--yes` refreshes rules in lockstep with the channel-server bump.

## Completion checklist for operator

Phase 5 closes when ALL of these are true:

- [ ] `cv-architect` workspace on `@groundnuty/macf-channel-server@0.2.32+`
  (verified via direct package.json + npm registry, not inferred)
- [ ] `cv-project-archaeologist` workspace on `@groundnuty/macf-channel-server@0.2.32+`
- [ ] Both AgentCard endpoints publishing v0.2.32+ with JSONRPC interface
- [ ] At least one cv-e2e-test rehearsal post-upgrade with `macf.a2a.message_send`
  SERVER span observed in Tempo for both CV agents
- [ ] Cross-workspace A2A flow observed (`invoke_agent cv-*` CLIENT spans
  with `macf.outbound.protocol="a2a"`)
- [ ] Operator's Phase 4 sunset criterion (A/B/C) chosen + recorded in
  DR-022 Amendment O
- [ ] If criterion is observation-based (A or C): baseline starts;
  legacy-invocation count expected to trend to zero
- [ ] CV memory + rules refresh confirmed (canonical rules current
  on both workspaces post-`macf update`)

When all 8 boxes are checked, science-agent (issue reporter) closes #406.

## Out of scope (deferred)

- **Actual legacy `/notify` code removal**: triggered by sunset criterion
  firing + a separate PR (post-Phase-5; not part of this phase). The
  removal PR will land DR-022 Amendment O (or extend it) to record the
  removal SHA + sunset date.
- **CV consumer fleet beyond cv-architect + cv-project-archaeologist**:
  if future CV agents join the fleet (e.g., a `cv-publisher` or
  `cv-reviewer`), they inherit the migration path documented here without
  Phase 5.5 scope expansion. The pattern generalizes.
- **Substrate workspaces (science-agent, code-agent, devops-agent)**:
  NOT in Phase 5 scope per
  `feedback_substrate_workspaces_dont_use_macf.md`. Substrate agents
  consume macf differently (direct source-tree access, not npm
  dependency); their migration would be a separate concern if ever
  needed (which it isn't, since they're at the framework layer).
- **Substrate-sync round 3**: if a future canonical hook script change
  ships, fold the sync into CV's next `macf update` per the natural
  cadence. Not blocking Phase 5.

## Backwards compatibility

Phase 5 is **operator-action-driven**; the doc itself ships no code
changes; no breaking changes to any consumer or substrate surface.

The post-Phase-5 sunset removal PR (out of scope here) WILL break any
legacy `/notify` callers still active at sunset time — but the criterion's
observation period catches stragglers before removal. The 60-day (A) or
30-day (C) windows are explicit dead-code-removal discipline.

## Cross-references

- Master tracking: [#368](https://github.com/groundnuty/macf/issues/368)
- Phase 1 (AgentCard discovery): [#370](https://github.com/groundnuty/macf/issues/370)
- Phase 2a-d (inbound A2A complete): [#391](https://github.com/groundnuty/macf/pull/391), [#395](https://github.com/groundnuty/macf/pull/395), [#397](https://github.com/groundnuty/macf/pull/397), [#402](https://github.com/groundnuty/macf/pull/402)
- Phase 3 (outbound A2A + protocol selection): [#407](https://github.com/groundnuty/macf/pull/407)
- Phase 4 (external publication + sunset options): [#409](https://github.com/groundnuty/macf/pull/409); `design/phases/P-A2A-phase-4.md`
- Release v0.2.32 (full A2A v1.0 bidirectional, LIVE on npm 2026-05-20T03:04Z)
- DR-022 + Amendment N (OIDC trusted publishers); future Amendment O codifies sunset criterion
- DR-023 (mcp_tool hook; UC-1 notify_peer envelope shape this phase sunsets-prepares)
- Memory: `feedback_substrate_workspaces_dont_use_macf.md`,
  `feedback_canonical_distribution_excludes_substrate.md`,
  `feedback_verify_at_every_hop_when_citing_peer_evidence.md`,
  `feedback_silent_default_fallback_class.md`
- Observability dashboard: `groundnuty/macf-devops-toolkit:macf-release-hygiene`
  (Grafana UID; #74 + #77 shipped 2026-05-20)
- cv-e2e-test rehearsal harness: `tools/cv-e2e-test.sh` in macf-science-agent;
  latest rehearsal evidence in `insights/2026-04-30-rehearsal-13b-empirical-witnesses.md`
  (PR `groundnuty/macf-science-agent#13`)
