# DR-019: MACF GitHub App Permissions

**Status:** Accepted (amended 2026-05-18 — see "Amendment A" below)
**Date:** 2026-04-16

## Context

Every MACF agent runs as a GitHub App with an installation token (`ghs_*`).
The App's permission set defines what the agent can do — and getting it wrong
triggers the silent-fallback attribution trap (see #61): a missing permission
returns 401, `gh` falls through to the stored user login, and subsequent ops
get mis-attributed to the operator instead of the bot.

We've re-discovered permission gaps four times during implementation:

- `variables: write` (PR #46) — needed for the agent registry
- `workflows: write` — needed to push `.github/workflows/` changes (macf-actions setup)
- `actions: read` (#72) — needed by coordinator agents to debug team workflow runs
  via `gh run list` / `gh run view --log-failed`
- `actions: write` (#371 + Amendment A 2026-05-18) — needed for release-hygiene
  workflow dispatch (`npm-deprecate.yml` after orphan-publish recovery) +
  `gh run rerun` after transient CI failures. Surfaced via the v0.2.25 sigstore-
  TLOG split-publish recovery — App lacked the perm; orphan deprecation required
  operator-side workflow_dispatch despite the bot otherwise being able to
  publish releases autonomously.

Rather than re-discover on the next App, we codify the minimum set here.

## Decision

The minimum permission set for a MACF agent's GitHub App. Names in the
first column are **GitHub's canonical API names** as returned by
`GET /app/installations/:id` — some differ from the App settings UI labels
(noted in the last column).

| Permission (API name) | Level  | Why                                                             | UI label        |
|-----------------------|--------|------------------------------------------------------------------|-----------------|
| `metadata`            | read   | Mandatory by GitHub — cannot be omitted                         | Metadata        |
| `contents`            | write  | Push commits, PRs to feature branches                           | Contents        |
| `issues`              | write  | Comment, label, edit issues — the primary coordination surface  | Issues          |
| `pull_requests`       | write  | Create/merge PRs, submit reviews                                | Pull requests   |
| `actions_variables`   | write  | Agent registry lives in repo/org/user variables (DR-005/DR-006) | **Variables**   |
| `workflows`           | write  | `macf repo-init` writes `.github/workflows/agent-router.yml`    | Workflows       |
| `actions`             | **write** | `gh run list` / `gh run view --log-failed` for self-debug; plus `workflow_dispatch` / `gh run rerun` for release-hygiene workflows on the dispatch allowlist (see Amendment A) | Actions         |

Every MACF App should have all seven. Coordinator/review agents (science-agent,
writing-agent) especially need `actions: write` to debug their team's CI AND
dispatch the release-hygiene workflows on the allowlist (notably
`npm-deprecate.yml`) — a coordinator that can't read workflow logs or
dispatch release-cleanup automation can't do its job.

## Creating a new App (manifest flow)

GitHub Apps can be created from a manifest. Use the template at
`templates/macf-app-manifest.json` (shipped with this PR) as the baseline — it
encodes the permission table above and the event subscriptions MACF needs.

For a one-off App created via the web UI, set every permission in the table
above at its listed level before installing.

## Verifying an existing App

Use `macf doctor` (#74) — it queries `GET /app/installations/:id` with an
App JWT and compares the returned `.permissions` map against this table.

**Why the JWT query, not the install-token response:** the installation
token response's `.permissions` field does NOT surface all granted
permissions — some (notably `actions_variables`) are visible only via
the JWT-authenticated installation endpoint. Observed empirically on
multiple Apps; using the install-token response gives false negatives.

Manual equivalent:

    JWT=$(gh token generate --app-id $APP_ID --key $KEY_PATH --jwt --token-only)
    curl -s -H "Authorization: Bearer $JWT" \
      -H "Accept: application/vnd.github+json" \
      https://api.github.com/app/installations/$INSTALL_ID | jq .permissions

Compare the keys returned against the table above.

## Options Considered

| Option                                    | Trade-off                                              |
|-------------------------------------------|---------------------------------------------------------|
| Minimum set (just `contents: write`)      | Under-permissioned — re-discovery on every new feature |
| **Conservative (seven above)**            | **Covers current + near-future needs, one update here** |
| Maximum (every repo-scoped permission)    | Over-broad; violates least-privilege                   |

## Rationale

- Silent failures from missing permissions are expensive to debug (see #72)
- The seven-permission set covers every MACF feature built so far (P1–P7) +
  release-hygiene workflow dispatch (Amendment A 2026-05-18)
- All seven permissions are write-level. `actions` was originally `read`
  (coordinator self-debug only) and was upgraded to `write` per Amendment A
  to enable release-hygiene workflow dispatch — see Amendment A for the
  blast-radius re-evaluation that justified the upgrade.
- Keeping this as a DR (not just inline in each phase doc) means App creators
  have a single canonical reference

---

## Amendment A — `actions: write` for release-hygiene workflow dispatch (2026-05-18)

**Status:** Accepted
**Decided by:** operator (per groundnuty/macf#371 thread 2026-05-18)
**Authored by:** code-agent; reviewed by science-agent (design owner) +
devops-agent (audit-log implementation hook)
**Driver issue:** groundnuty/macf#371 (`/sign` → `/macf/sign` Path 2; v0.2.25
sigstore-TLOG split-publish recovery surfaced the gap)

### What changed

`actions` permission upgraded from `read` to `write` in the canonical
permission table above. The original framing (DR-019 base): "the only
non-write permission, included specifically for coordinator self-debug —
minor surface area." The revised framing: write-level grants
`workflow_dispatch` + `gh run rerun` + `gh run cancel` capabilities,
which the App needs for release-hygiene automation on a dispatch-allowlist
basis (see below). Blast-radius re-evaluation found the broader scope
acceptable given the mitigation framework below.

### Recurring-friction evidence

Per `reference_macf_app_permissions.md` memory: "MACF agent Apps need
variables + workflows permissions beyond the 4 default; we keep
rediscovering this." `actions: write` is the next entry in that
rediscovery pattern. Witness:

- **2026-05-18 #362 D2 (testbed `workflow_dispatch`)** — substrate
  failure-injection harness needed `workflow_dispatch` on a test workflow
  in `groundnuty/macf-testbed`. App lacked the perm; harness pivoted
  to a `push`-trigger workaround (zero-trial branches matching a glob).
  Workaround succeeded but added complexity unrelated to the experiment.
- **2026-05-18 #371 + #377 (npm-deprecate orphan cleanup)** — v0.2.25
  release sigstore-TLOG-race created two orphan npm versions
  (`@groundnuty/macf-core@0.2.25` + `@groundnuty/macf@0.2.25`). Cleanup
  via `npm-deprecate.yml` workflow requires `workflow_dispatch`; App
  lacks the perm; routed to operator queue.
- Prior occurrences flagged in the memory entry without specific
  incident links — pattern is broader than this session.

The structural cost of "operator-side workflow_dispatch for the
recurring class" exceeds the structural cost of "App has the perm +
mitigation framework constrains misuse."

### Blast-radius re-evaluation

`actions: write` grants the App:

- `workflow_dispatch` — fire a workflow_run for any workflow in the repo
- `gh run cancel` — cancel an in-flight workflow run
- `gh run rerun` — rerun a previously-completed workflow

What it does NOT grant (each remains scoped via other permissions):

- ❌ Modify `.github/workflows/*` source files (that's `workflows: write`,
  already granted)
- ❌ Modify branch protection / merge rules (that's `administration`,
  not in the set)
- ❌ Push commits / open PRs / merge PRs (those are `contents` + `pull_requests`,
  already in the set with their own constraints)
- ❌ Delete data, modify secrets, modify the App itself

Worst-case misuse scenario: a malformed agent cancels an in-flight
production workflow run (e.g., a deploy). Recovery: operator notices via
existing alarms / consumer downtime signals + reruns the workflow.
Cancellation is annoying but recoverable; no data loss, no irreversible
state change. The original DR-019 framing weighted "minor surface area"
for `actions: read`; the corrected weighting for `actions: write` is
"bounded recoverable surface area" — still acceptable under the
recurring-friction calculus.

### Dispatch allowlist + addition criteria

Not every workflow in `.github/workflows/` is appropriate to dispatch
from the App. The allowlist below names the workflows the App is
expected to dispatch; anything else is an anomaly (see audit-log hook
below) and should be flagged for review.

**Current allowlist (Amendment A, 2026-05-18):**

| Workflow | Purpose | Risk class |
|---|---|---|
| `.github/workflows/npm-deprecate.yml` | Mark orphaned/broken npm versions deprecated | Low (metadata-only; non-destructive) |

**Criteria for adding a workflow to the allowlist (any future amendment):**

1. **Release-hygiene scope** — the workflow performs metadata cleanup
   or recovery operations on already-published artifacts. NOT used for
   primary release flow (those run on tag-push, not workflow_dispatch).
2. **Bounded recoverable side effects** — worst-case misuse is annoying
   but not data-destructive. Production deploys + secret rotations are
   NOT eligible (those route through operator approval).
3. **Documented in the audit-log spec** — devops-agent's release-hygiene
   Grafana dashboard surfaces invocations to this workflow for review.

Add to this table via a new DR-019 Amendment when the criteria are met
for a new workflow; the audit-log dashboard's "unexpected workflow"
alert (see hook below) fires on any workflow_dispatch to a name not in
this table.

### Audit-log implementation hook (item 5 of the amendment spec)

Per devops-agent's spec on the #371 thread 2026-05-18: every
`actions:write`-scoped GitHub API invocation by a MACF agent App emits
two complementary signals through the existing OpenTelemetry pipeline.

**Signal 1 — OTel span (per-invocation, full context):**

```
name:       macf.app.gh_api_call           (MACF-specific; Q1 decided)
kind:       SPAN_KIND_CLIENT
attributes:
  # OTel HTTP semconv canonical keys (gives standard query/auto-
  # aggregation surface — Datadog / Grafana Cloud / etc. recognize
  # these out of the box even with our custom span name)
  http.request.method:       "POST"
  http.response.status_code: 204
  url.full:                  "https://api.github.com/repos/groundnuty/macf/actions/workflows/npm-deprecate.yml/dispatches"
  url.path:                  "/repos/groundnuty/macf/actions/workflows/npm-deprecate.yml/dispatches"

  # MACF privileged-API governance attrs (the use case the span IS for —
  # no duplication with OTel HTTP semconv; orthogonal dimensions)
  gh.api.scope:              "actions:write"
  gh.repo:                   "groundnuty/macf"
  gh.workflow:               "npm-deprecate.yml"   (null for non-workflow API calls)
  gh.action:                 "dispatch" | "cancel" | "rerun"
  gh.actor:                  "app/macf-code-agent"
```

**Span-name convention rationale (Q1 decision)**: MACF-specific name
rather than auto-generated `HTTP POST` from OTel HTTP semconv, because
the use case IS MACF-specific (privileged App-action governance) — a
named MACF span gives cleaner TraceQL queries
(`{ name = "macf.app.gh_api_call" }`) than filtering generic HTTP spans
by attribute. **HTTP attrs use OTel semconv canonical keys** (`http.request.method`,
`url.full`, etc.) rather than parallel `gh.api.endpoint`/`gh.api.method`
duplicates — same query power, less duplication, standard tools
auto-recognize the HTTP fields. The `gh.*` attrs cover the governance
dimensions OTel HTTP semconv doesn't (privileged-scope classification,
workflow / action discriminators).

Resource attrs already stamped by every agent's `claude.sh` OTLP block
(`service.name`, `gen_ai.agent.name`, `gen_ai.agent.role`) flow through
the existing pipeline; no new infrastructure required.

Lands in Tempo. TraceQL surface:

```
{ name = "macf.app.gh_api_call" && span.gh.api.scope = "actions:write" }
{ resource.gen_ai.agent.name = "code-agent" && span.gh.action = "dispatch" }
```

**Signal 2 — OTel counter (aggregable, alertable):**

```
name:       macf.app.gh_actions_write_total
type:       Counter (sum)
attributes:
  repo:     <gh.repo>
  action:   <gh.action>
  workflow: <gh.workflow>     (Q2 decision; null for non-dispatch ops)
```

Lands in Prometheus. Suitable for rate-anomaly alerts (e.g.
> 10/hour from any single agent triggers a review).

**Workflow label rationale (Q2 decision)**: cardinality is bounded by
the dispatch allowlist above (table is the cardinality cap; any new
entry requires a DR amendment). Per-workflow alerts are
higher-precision than per-action — they catch "App dispatched a
workflow NOT on the allowlist" (anomaly: unexpected workflow name)
distinctly from "App dispatched `npm-deprecate.yml` 50× in an hour"
(anomaly: expected workflow at unexpected rate). The label cost is
negligible for bounded cardinality.

**Why two signals**: span gives per-invocation context for forensic
analysis ("what exactly did the App dispatch and when"); counter gives
efficient aggregation for alert rules. Both at ~5-10 lines of emission
code in the App's GitHub-API client layer.

**Instrumentation point (Q3 decision; science-agent + devops-agent
both acked 2026-05-18)**: every `actions:write`-scoped `gh` CLI
invocation by a MACF agent App is captured at the canonical
PreToolUse hook (`.claude/scripts/check-gh-token.sh`; distributed via
`macf init` / `macf update` / `macf rules refresh`). The hook pattern-
matches the gh subcommand class and emits both signals (span + counter)
through the existing OpenTelemetry pipeline.

**Why PreToolUse-hook instrumentation rather than octokit middleware**
(reframe from devops-agent's initial spec): MACF has zero octokit
dependency. Grep across `packages/macf*/{package.json,src/}` returns
no `@octokit/*` hits. Agents call GitHub via `gh` CLI subprocess
(dominant path; every `gh issue comment` / `gh pr view` / `gh workflow
run` flows through the `Bash` tool) + `node:https` direct
(channel-server's `notify_peer` only; not GitHub API). Adopting octokit
just for the audit-log hook is large scope creep (conflates three
arcs: widen permission + introduce octokit + factory/middleware).

The existing `check-gh-token.sh` PreToolUse hook (#140) is the
analogous artifact: ONE script, ONE shared distribution channel
(`macf init`/`update`), ONE instrumentation point, **structural
enforcement built-in** (LLM-issued Bash commands cannot bypass
PreToolUse hooks — same property that catches the attribution traps
per Instance 1 in `silent-fallback-hazards.md`).

**Pattern-match comprehensiveness (per science-agent impl note 1)**:
the hook must match the FULL `actions:write` subcommand set, not just
`gh workflow run`. Canonical list:

- **Workflow lifecycle**: `gh workflow run` / `gh workflow disable` / `gh workflow enable`
- **Run lifecycle**: `gh run cancel` / `gh run rerun` / `gh run rerun --failed`
- **API-direct**: `gh api .../actions/workflows/.../dispatches` (POST) / `gh api .../actions/runs/{id}/cancel` (POST) / `gh api .../actions/runs/{id}/rerun` (POST) + `/rerun-failed-jobs`

The dispatch-allowlist (Section "Dispatch allowlist") names workflows
for the `dispatch` action specifically. `cancel` / `rerun` operate on
RUNS not WORKFLOWS — different semantic — and are in scope of the
audit-log emission even when not in the workflow allowlist regex.

**OTel emission from bash (per science-agent impl note 2)**: bash
script emits span + counter via, in lean order:

1. **`otel-cli`** — lightweight, well-documented; preferred when available
2. **`curl` to OTLP HTTP** — works in any env; ~3 lines for span, ~3 for counter; the fallback
3. **Fork/exec a small Node.js helper** using `@opentelemetry/api` — heaviest, only if (i)+(ii) prove insufficient

Resource attrs come from `claude.sh`'s exported OTel env vars
(`gen_ai.agent.name`, `service.name`, `OTEL_EXPORTER_OTLP_ENDPOINT`,
etc.) — no new wiring. Implementation chooses (i) → (ii) at
script-write time; the DR doesn't lock this in.

**Known instrumentation gaps (per science-agent forward-looking note)**:
the PreToolUse hook catches every LLM-issued Bash call to `gh`. It
does NOT catch:

- Non-Bash-tool subprocess paths from compiled JS/TS that call `gh`
  (e.g., a hypothetical `child_process.spawn('gh', ['...'])` from a
  Node.js channel-server module)
- Direct `curl` to GitHub's REST API from the same paths

Current MACF architecture has no such paths — `notify_peer` is the
only non-Bash subprocess call from compiled code, and it talks to peer
agents' `/notify` endpoints (not GitHub). If a non-Bash-`gh`-subprocess
path emerges later, address with the appropriate instrumentation
point THEN (octokit middleware if octokit gets adopted; or a
node-level subprocess-spawn hook). YAGNI for current scope; flagged
here as a known limitation for future re-evaluation.

**Multi-environment observability gap (deployment topology, added
2026-05-19 per macf#368 first-audited-dispatch empirical observation):**
the PreToolUse hook's emission requires (i) `OTEL_EXPORTER_OTLP_ENDPOINT`
set in the agent's session env AND (ii) the configured OTLP endpoint to
be network-reachable from the agent's session. In practice, audit-log
spans land only from operator-local agent sessions where the claude.sh
OTel block is exported AND the cluster Tempo (`http://127.0.0.1:14318`
per `groundnuty/macf-devops-toolkit` canonical) is reachable. Remote
agent sessions (e.g., code-agent's CI VM, devops-agent's VM if separate
from the cluster host) silently skip emission per the hook's opt-in
observability design (`OTEL_EXPORTER_OTLP_ENDPOINT` unset → no curl
fired). This is a deployment-topology gap, not a hook-correctness
gap — the structural defense pattern is intact (the gh CLI invocation
itself proceeds correctly + the hook fires + the audit-emission branch
runs); the audit-log REACH is what's bounded. Sister-shape to
`silent-fallback-hazards.md` Instance 8's "OTLP-endpoint silent-drop"
Tier 4 (long-lived agent processes started during connect-refused
window have OTel SDK retry budget exhausted) — same architectural
family ("the OTLP boundary fails silently in a way the agent doesn't
surface"). Witness: macf#368 first audited `gh workflow run
npm-deprecate.yml` 2026-05-19; dispatch SUCCEEDED end-to-end but hook
silent-skipped emission because code-agent's remote session lacked
both pre-conditions. The audit-log's VALUE depends on its REACH, not
just its CORRECTNESS — future deployment patterns that put `actions:write`
on remote agents should explicitly verify (i) + (ii) OR accept that
those agents' privileged-API calls won't emit audit-log signals.

**Shared-instrumentation architectural consideration**: science-agent
flagged "if MACF agents don't all share an octokit factory, consider
adding one — keeps the audit-log surface canonical instead of N
parallel implementations drifting." For MACF's gh-CLI reality, the
analogous artifact is the canonical PreToolUse hook itself:

- **There is no shared octokit factory** because there is no octokit
  usage. The analogous artifact is `check-gh-token.sh` — already a
  shared PreToolUse hook distributed to every workspace by
  `macf init`/`macf update`/`macf rules refresh`. ONE script, ONE
  emission point, instrumented once.
- Net: shared-instrumentation is structurally satisfied by the
  existing `check-gh-token.sh` distribution mechanism — same
  distribution-and-versioning surface as the rules canon. No new
  shared infrastructure required.

**Implementation tracking**: extension code (the `check-gh-token.sh`
`actions:write` pattern-match branch + the OTel emission helper +
canonical-rules + hook test coverage) lands in a follow-up issue
filed against `groundnuty/macf` after this DR amendment lands (not
in this DR amendment's scope; this DR codifies the requirement, the
issue tracks the code). Devops-agent's `groundnuty/macf-devops-toolkit#74`
(issue, closed 2026-05-20T00:06:56Z) + `#77` (impl PR, merged at
`85c966a8`) builds the release-hygiene Grafana dashboard derived from
these signals. Dashboard UID: `macf-release-hygiene`. Operator access:
`make pf-grafana` (from `environments/macf/`) → `http://127.0.0.1:3000/d/macf-release-hygiene`.
Source manifests at `groundnuty/macf-devops-toolkit:environments/macf/manifests/grafana-dashboards-release-hygiene/`.

**PromQL string-escape gotcha** (caught during devops-agent's dashboard implementation): the canonical dispatch-allowlist regex `npm-deprecate\.yml` (single backslash; matches the literal `.` in `.yml`) must be doubled to `npm-deprecate\\.yml` when embedded in a PromQL string literal. PromQL's string parser raises an explicit `parse error: unknown escape sequence U+002E '.'` on `\.` — caught pre-merge via `kubectl apply --dry-run=server` (which routes the manifest through the Prometheus operator's admission webhook where PromQL parsing actually runs). Without the dry-run validation, the rejection would surface at PrometheusRule reconcile in-cluster AFTER the manifest applies — but always with a loud parse error, never a silent mis-parse. The `make grafana-allowlist-sync` target in `groundnuty/macf-devops-toolkit` handles the doubling automatically when materializing the SSOT-derived ConfigMap into the dashboard alert expression. **Methodology takeaway**: cross-language-boundary semantic-preservation is detected at the target DSL's own parser, not via round-trip equivalence checks — end-to-end admission validation pre-merge is the catch. Devops-agent's `reference_multi_language_regex_escape_translation.md` memory captures the full methodology learning. (Distinct from silent-fallback class: that's API-success/semantic-failure; this is preserved-bytes/changed-semantic/loud-parser-at-target — different shape; both worth knowing.)

If science-agent + devops-agent push back on the gh-CLI Q3 reframe
and prefer to adopt octokit instead, the implementation issue scopes
the octokit migration as its own arc; this DR amendment is updated
to reflect the chosen instrumentation point before the impl PR
lands.

### Migration

For operators of existing MACF Apps:

1. Open the App settings on GitHub: Profile → Developer settings →
   GitHub Apps → `<app-name>` → Permissions & events
2. Under "Repository permissions" → "Actions": change from `Read-only`
   to `Read and write`
3. Save. Users of the App will receive a permission-update prompt on
   next install/reauth — accept to grant the new scope.
4. Verify post-update with `macf doctor` (queries `GET /app/installations/:id`
   and compares against the new permission table above).

No code changes required for the permission grant itself; the audit-log
hook (item 5) is a separate implementation tracked in its own follow-up
issue.

### Cross-references

- groundnuty/macf#371 — `/sign` namespace move; surfaced this amendment via the orphan-cleanup workflow_dispatch ask
- groundnuty/macf#377 — sigstore-TLOG hazard + test-flake stabilization (sibling concern from same session)
- `reference_macf_app_permissions.md` (science-agent memory) — recurring-friction history
- `groundnuty/macf-devops-toolkit#74` (issue) + `groundnuty/macf-devops-toolkit#77` (impl PR, merged at `85c966a8`) — release-hygiene Grafana dashboard + alerts (dashboard UID `macf-release-hygiene`)
