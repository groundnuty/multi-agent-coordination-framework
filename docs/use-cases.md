# Use cases

When MACF is worth the multi-agent overhead, when it isn't, and how it compares to academic peers and open-source alternatives. Honest assessment with citations to empirical evidence — not a marketing pitch.

## Cost framing

Multi-agent coordination is more expensive than single-agent for the same work. The CPC predecessor (2-agent proof of concept) measured **1.18× total token cost** vs single-agent for an 11-day production run on a scientific-workflow project (128 issues, 175 PRs, 6.8M output tokens generated, 10.26B cache-read tokens — see `groundnuty/macf:research/2026-03-28-token-usage-empirical-analysis.md` for the full breakdown). MACF inherits this overhead; it's not a productivity multiplier in the headcount sense.

The value MACF delivers is **qualitative** (cross-agent peer review surfaces issues a single agent misses) and **asymmetric** (orchestrator-worker token allocation saves cost on broad-context curation), not raw throughput.

If the task at hand doesn't benefit from peer review or asymmetric context, MACF will be a more expensive way to do the same work. **Use it when the qualitative benefits outweigh the 18%+ overhead, not before.**

## When to use MACF

### 1. Multi-step research with cross-agent peer review

The signature use case. Research-grade work where the value of catching mistakes early exceeds the coordination cost.

**Empirical witness — cv-e2e-test rehearsal #13b** (2026-04-30 14:01-14:35Z): 10/11 PASS in a 34-minute end-to-end coordination cycle, with **21 `notify_received` events**, **11 tmux_wake_delivered** + **10 tmux_wake_skipped** (Pattern E firing on `peer_notification` types — the routing-active vs observational-only distinction working as designed). The single FAIL was a known cv-architect timing issue under investigation; the protocol surface itself was clean. See `groundnuty/macf-science-agent:insights/2026-04-30-rehearsal-13b-empirical-witnesses.md`.

What it shows: a CV research workflow involving research handoffs between `cv-architect` and `cv-project-archaeologist`, formal-review submissions, structural defenses (`route-by-pr-review-state`) firing correctly, and observability instruments producing paper-grade evidence. The 34-minute cycle would be possible single-agent but the cross-agent peer review at every PR boundary surfaced multiple issues that would have shipped silently with a single reviewer.

**Concrete examples of cross-agent peer review producing better outcomes than any single agent's first proposal:**

- **[macf#80](https://github.com/groundnuty/macf/issues/80)** — code-agent audited its own challenge-response cert-signing implementation against the design doc; discovered the server wrote a challenge value and read back what it had just written, with no comparison to what the client submitted. The supposedly-secure protocol was trivially bypassable. Filed as P0; shipped the fix.
- **[macf#112](https://github.com/groundnuty/macf/issues/112)** — code-agent suggested a quick workaround for a crypto-parameter upgrade. Science-agent rejected it with an "eternal-debt" argument: the quick fix would leave existing deployments stuck on the weaker configuration forever. Negotiated approach automatically migrates every deployment on next use. Harder to implement; actually solves the problem.
- **[macf#144](https://github.com/groundnuty/macf/issues/144)** — multi-round refinement of a design. Science-agent proposed four variants. Code-agent picked one and pointed out a bootstrap limitation. Science-agent responded with an edge case the chosen approach didn't cover. Code-agent extended the design to handle three different operator states at once. Each round produced a measurably better design.
- **[macf#121](https://github.com/groundnuty/macf/issues/121)** — rules the agents wrote for themselves started enforcing themselves. After codifying "the reporter of an issue closes it, not the assignee," code-agent violated the rule on the next issue (asked science-agent to close). Science-agent pushed back citing the rule. The discipline system the agents built started self-enforcing.

### 2. Long-running framework / system development

Work spanning days to weeks where session continuity + audit trail matter more than turn-around speed.

**Empirical witness — MACF dogfooding itself.** Over the 2026-04-15 → 2026-04-30 development sprint, agents merged **~80 PRs** developing the framework. This includes a full security-audit-and-fix cycle (code-agent audited its own codebase, filed issues for bugs, shipped fixes itself) and the v0.2.1 → v0.2.9 release cadence (8 npm releases over ~76 hours per `groundnuty/macf-science-agent:insights/2026-04-30-rehearsal-13b-empirical-witnesses.md`).

What it shows: framework-level work is well-suited because (a) cross-agent design discussion produces better architectural decisions, (b) PR-as-merge-checkpoint discipline catches regressions before they reach `main`, and (c) the audit trail in issue threads + PRs becomes the project's permanent record — six months later, "why was this done this way" is recoverable from `gh issue view N`.

If the framework works for the agents building the framework, it works for project work with similar structure: research, multi-component systems, design-heavy work.

### 3. Research-grade observability and audit trail

Work where you want every coordination event traced + queryable + auditable.

MACF's channel server produces OpenTelemetry traces (every `/notify`, `/sign`, peer ping) + counters (`macf_notify_received_total`, `macf_notify_peer_total`) per [DR-021](../design/decisions/DR-021-otel-instrumentation.md). All events land in the operator's OTel collector. Combined with GitHub's per-issue thread persistence, you get:

- Every cross-agent communication archived in issue threads
- Every routing-Action workflow run logged with status + timing
- Every channel-server event traced with operation name + duration
- Every commit + PR attributed to a specific agent's GitHub App
- Every release reproducible from the npm tarball + the v-tag SHA

What it shows: this isn't typical of multi-agent coordination tools (which usually optimize for headless-task throughput). For research contexts where post-hoc analysis of "what happened" matters — auditing a paper's methodology, debugging a coordination failure, reproducing a result — MACF's audit grain is paper-grade.

### 4. Asymmetric-context workloads

Tasks where one agent needs broad project context but most workers can run focused.

MACF's default configuration runs the orchestrator at 1M-token context (curates project-wide understanding) and workers at 200K (focused tasks). CPC predecessor measured **22.7% token savings** on this asymmetric configuration vs running everyone at symmetric max context across the same workload.

If your work has natural asymmetry — one agent reading the literature / the spec / the prior incidents while others implement focused changes — MACF saves tokens vs symmetric configurations.

## When NOT to use MACF

### Single-shot tasks

If the task fits in one Claude Code session, use one Claude Code session. MACF's coordination overhead (issue creation, label dispatch, PR review cycle, channel-server roundtrips) costs more than the value when there's nothing to coordinate.

Heuristic: if the work decomposes into ≤3 independent steps with no peer review needed, single-agent is correct.

### Real-time interactive coding

MACF routing latency is **2-5 seconds per hop** (GitHub webhook delivery dominates; routing-Action workflow cold-start adds variability). A task requiring fast turn-around — pair-programming on a tight bug, debugging a live incident — is bottlenecked by the routing transport, not the agent capability.

For interactive work, attach directly to a single agent's tmux session (`tmux attach -t <session>:<window>`) and prompt it as you would any Claude Code session. The framework's routing layer adds latency without value in this mode.

### Tasks with hard real-time deadlines

Sister to "real-time interactive": MACF's GitHub-as-substrate design assumes tolerance for human-thread-paced communication (minutes, not seconds). If a task must complete within sub-second budgets, the architecture isn't appropriate.

### When you don't have operator infrastructure

MACF's full GitHub-coupled mode requires:

- A VM or persistent host (laptops sleep; tmux sessions die on lid-close)
- Tailscale or equivalent for cross-host network reachability (if multi-host)
- GitHub Apps with permissions to grant
- Token budget for ongoing agent sessions

If any of these are blockers, the framework's full coordination value is gated. **For single-host scenarios where the GitHub coupling is the obstacle**, the local-registry mode (see next subsection) supports a subset of MACF without GitHub Apps. For cross-host or GitHub-driven-routing-required cases, the constraints above remain hard.

## When MACF without GitHub makes sense (local-registry mode)

[DR-024](../design/decisions/DR-024-local-registry-mode.md) ships a fourth registry variant — `local` — that runs the channel-server transport (mTLS HTTPS `POST /notify`, MCP push, tmux-send wake) end-to-end without GitHub Apps. Agents discover each other through `~/.macf/registry/<project>.json` instead of GitHub Actions Variables; certs are signed against a project-local CA written next to the registry file. This is **not a replacement** for GitHub mode; it serves a distinct set of cases where GitHub mode's bootstrap or substrate cost is the obstacle.

The five use cases [DR-024](../design/decisions/DR-024-local-registry-mode.md) §"Five use cases unlocked" identifies:

### 1. Solo small projects

Single-operator workflow on one laptop where setting up a coordination repo + GitHub App + routing workflow is more bootstrap than the project warrants. The 2026-05-01 surfacing case — operator running a paper-writing session and a code-writing session on a laptop, wants them to coordinate via channel-server primitives without filing GitHub issues at each handoff. Empirical anchor: the PPAM 2026 paper-and-code use case driving this prioritization.

### 2. Education / demos

Workshops, talks, or tutorial sessions where attendees can't reasonably create GitHub Apps in the demo window. `macf init --local` works without an internet round-trip to GitHub; peers register themselves in the local registry file; mTLS-routed notifications work end-to-end without external dependencies.

### 3. Framework development

MACF maintainers spinning up a clean test workspace on every meaningful protocol change. Today this requires a real GitHub App + a coordination repo. Local-registry mode lets the framework be tested end-to-end without that bootstrap (separate from the unit/integration tests under `packages/*/test/`, which mock the GitHub layer).

### 4. Air-gapped / offline environments

Hosts where GitHub is not reachable. The transport layer (channel-server, mTLS, `/notify`) doesn't need GitHub at runtime; only the discovery + identity layer does, and local mode replaces both with filesystem state.

### 5. CI sanity-check fixtures

Integration tests that need 2+ channel-servers actually talking to each other (not mocked) currently require either a real GitHub fixture or a complex stub. Local mode gives a pure-localhost path with no external dependencies.

### Honest limitations of local mode

These constraints are load-bearing; misreading them produces a system that looks like it works but lacks load-bearing properties. From [DR-024](../design/decisions/DR-024-local-registry-mode.md) §Limitations:

- **Single-host only.** No cross-host coordination. A laptop and a server are different hosts; agents on each cannot find each other through `local` mode. (Network-filesystem-shared registries are explicitly out of scope.)
- **No multi-operator visibility.** No GitHub thread for a third party to read what's happening. Solo / education / demo / framework-dev / air-gapped / CI-fixture all have one operator (or one demo-presenter) by definition.
- **No GitHub-driven routing.** The `macf-actions` workflow doesn't apply. Routing is direct peer-to-peer (`notify_peer` MCP tool per [DR-023](../design/decisions/DR-023-stage3-hook-mcp-tool-architecture.md)) or operator-driven (operator types into one tmux pane, agent calls `notify_peer`, peer wakes via `/notify`).
- **No canonical audit trail outside the local file.** Issue threads, PR review history, label timestamps — none of these exist. The registry file mtime + the operator's tmux scrollback are the audit surface. Fine for solo/demo/CI-fixture; insufficient for compliance-grade settings.
- **Identity attribution via local username.** Commits and tool calls don't have a bot-login backing them. Operators wanting commits to land as `app/<bot>[bot]` need GitHub mode.
- **No `/sign` challenge-response.** The endpoint returns 404 with a diagnostic body in local mode. The CA private key sits on disk at `<registry-dir>/<project>.ca.key` with filesystem permissions as the only access control; anyone who can read that file can mint a cert and join the project.

The trust boundary statement from DR-024 §"Trust boundary statement":

> **Local registry mode assumes same-host or trusted-LAN cooperating processes under a single operator's control. It is not a defense against external attackers, multi-tenant adversaries, or compliance-grade audit requirements. Filesystem permissions on `~/.macf/registry/` are the project's trust boundary.**

### Migration path — local → GitHub mode

When an operator outgrows local mode (cross-machine collaboration emerges, audit trail becomes load-bearing, multi-operator visibility becomes necessary, GitHub-driven routing is wanted), [DR-024](../design/decisions/DR-024-local-registry-mode.md) §"Migration path" defines a one-shot, one-direction migration:

```
macf init --registry-type repo --owner X --repo Y --migrate-from ~/.macf/registry/<project>.json
```

Reads the local registry, writes each agent's record as a `<PROJECT>_AGENT_<NAME>` GitHub Actions variable. Mints fresh agent certs via the existing `/sign` challenge-response. The local CA carries forward as the project CA in GitHub mode.

Bi-directional sync is explicitly out of scope. The migration tool is one-shot: read local, write GitHub, declare done.

### Choosing between local mode and GitHub mode

| Criterion | Local mode | GitHub mode |
|---|---|---|
| Cross-host coordination | Not supported | Supported |
| Multi-operator visibility | Not supported | Supported |
| GitHub-driven routing (issues / PRs / @mentions) | Not supported | Supported |
| Bootstrap cost | Single command, no external deps | GitHub App + install + repo wiring (~30 min per [quickstart.md](quickstart.md)) |
| Audit trail | Registry file mtime + tmux scrollback | Issue threads + PR history + workflow runs + OTel traces |
| Identity attribution | Local username | `<app-prefix>-<role>[bot]` |
| Internet dependency at runtime | None | GitHub webhook + Actions runtime |

Decision: if any single criterion in column 1 reads "Not supported" and your use case requires it, you need GitHub mode. Otherwise local mode is appropriate and [`docs/quickstart.md`](quickstart.md#quickstart-local-registry-mode-no-github-apps-required) walks the bootstrap.

For the full design rationale, threat model, and trade-off analysis, see [DR-024](../design/decisions/DR-024-local-registry-mode.md).

## Comparison to academic peers

### Anderson 2026 — ACMM (The AI Codebase Maturity Model)

**Citation:** Anderson, IBM Research, 2026-04-10, arXiv:2604.09388. See `groundnuty/macf-science-agent:papers/index.md` for canonical citation + status.

**Comparison:** ACMM operates on an orthogonal axis to MACF.

- **ACMM defines codebase maturity** by *feedback-loop topology* — a 6-level CMMI-inspired framework where each level is unlocked by adding a specific feedback mechanism (rules-as-text → metrics + tests → automated response → multi-loop self-improving → multi-loop with external orchestration). Each level subsumes the previous; you cannot skip levels; the intelligence is in the infrastructure, not the model. Validated via 100-day single-maintainer experience report on KubeStellar Console (CNCF k8s dashboard built from scratch with Claude Code + GitHub Copilot; aggregate: 5,435 commits, 4,499 PRs merged, 86.3% acceptance, 5,273 issues closed in 100 days) + 1-week deployment of **Hive** (open-source multi-agent orchestration realizing Level 6).
- **MACF identifies a hazard class** — *silent-fallback failures* where API-boundary success masks semantic failure — and develops 5 reusable structural-defense patterns (A through E) that span infrastructure layers (identity / parsing / TUI binding / observability routing / config substitution / coordination protocol / metric-instrumentation lifecycle / observability-endpoint routing). MACF's contribution is the 8-instance taxonomy + the structural-defense templates that generalize across instances. Evaluation is dogfooding + production deployments (CPC predecessor + active CV-fleet).

The orthogonality means: ACMM's feedback-loop discipline is independent of MACF's hazard-class identification. A MACF deployment can sit at any ACMM level; an ACMM-level-6 codebase can have any silent-fallback profile. The 8 instances MACF documented span ACMM Levels 1 through 6 — the hazards are NOT maturity-stage-bounded. The two papers can co-exist with sharp differentiation: ACMM identifies the maturity-progression staircase; MACF identifies the safety-hazard surface that extends across all levels.

For details, see `groundnuty/macf-science-agent:insights/2026-04-29-acmm-first-published-peer-establishes-orthogonal-axis.md`.

### Other academic peers

The broader multi-agent literature (planning systems, constraint solvers, robot teaming) is largely orthogonal to MACF's substrate scope. MACF's contribution is on the engineering-discipline + observability axis: how do you operate N LLM-backed agents in production with auditability? Most academic work hasn't addressed that question explicitly because most academic work runs in dedicated experimental environments rather than production-engineering contexts.

`research/` (16 notes in `groundnuty/macf`) and `groundnuty/macf-science-agent:research/` survey the relevant literature; `groundnuty/macf-science-agent:papers/` indexes peer papers. Refer there for the deeper comparison.

## Comparison to open-source alternatives

The multi-agent ecosystem has several open-source alternatives. Each has a different scope; the comparison is along several axes.

### Aider

[Aider](https://aider.chat/) is a Git-aware AI coding assistant — single-agent, focused on autonomous code editing within one repo. Different scope: Aider is a *better single-agent CLI*, not a multi-agent coordinator.

When Aider is correct: single-developer working with one Claude / GPT model on focused code edits in one repo. When MACF is correct: multi-agent work with cross-agent peer review, audit trail, multi-repo coordination.

Both can coexist — an MACF agent could in principle invoke Aider as a tool for focused edits.

### CrewAI

[CrewAI](https://crewai.com/) is a Python framework for orchestrating role-based agent crews. Closer to MACF's scope.

Differences:
- **Substrate**: CrewAI uses an in-process Python message queue. MACF uses GitHub. Trade-off: CrewAI is faster (no GitHub webhook latency) but lacks audit trail outside the Python process. MACF is slower but has persistent operator-readable threads + per-agent attribution.
- **Identity**: CrewAI has roles + tools. MACF has GitHub Apps + per-agent identity + per-agent permission scope (each agent can only do what its App's permissions allow).
- **Auditability**: CrewAI's coordination is in-process; debugging a coordination failure requires Python introspection. MACF's coordination is in GitHub; debugging requires `gh issue view N` + `gh run list`.
- **Production posture**: CrewAI is research/prototyping-oriented. MACF is production-oriented (mTLS between agents, structural defenses against attribution traps, OpenTelemetry observability).

When CrewAI is correct: rapid prototyping of multi-agent flows where the coordination primitives need to be in-process and tightly coupled. When MACF is correct: production multi-agent work where audit trail + per-agent identity + structural defenses matter more than coordination latency.

### AutoGen

[Microsoft AutoGen](https://github.com/microsoft/autogen) is a research framework for "conversational" multi-agent systems. Similar tradeoffs to CrewAI: in-process coordination, optimized for research experiments rather than production deployment. When AutoGen is correct: research experiments + benchmarks. When MACF is correct: production deployments.

### LangGraph

[LangGraph](https://langchain-ai.github.io/langgraph/) is LangChain's graph-execution framework for agent workflows. Different scope: LangGraph is a workflow orchestrator (DAG of agent steps), not a peer-to-peer coordinator. Closer to single-process multi-step pipelines than to MACF's multi-agent peer model.

When LangGraph is correct: structured workflows with deterministic graph topology. When MACF is correct: emergent multi-agent peer coordination through GitHub primitives.

## Decision tree

If you're choosing between MACF and the alternatives:

```
Is the work multi-step + does it benefit from cross-agent peer review?
│
├─ NO → Use a single Claude Code session (or Aider for focused code edits).
│       MACF overhead doesn't pay off here.
│
└─ YES → Is real-time interactive turn-around critical?
         │
         ├─ YES → Single Claude Code session (don't pay routing latency cost)
         │
         └─ NO → Is audit trail + per-agent identity + production discipline important?
                  │
                  ├─ NO → CrewAI/AutoGen for rapid in-process prototyping
                  │
                  └─ YES → MACF (you've found the sweet spot)
```

## Empirical anchors (numbers you can verify)

Citations for the claims above; check them yourself:

| Claim | Source | Verify |
|---|---|---|
| 1.18× multi-agent overhead | CPC 11-day production run | `groundnuty/claude-plan-composer` repo |
| 22.7% asymmetric-context savings | Same | Same |
| ~80 PRs in 2026-04-15→04-30 sprint | MACF dogfooding | `gh pr list --repo groundnuty/macf --state merged --search "merged:2026-04-15..2026-04-30" \| wc -l` |
| 8 npm releases over ~76 hours | v0.2.1 → v0.2.9 | `npm view @groundnuty/macf versions` (or `gh release list --repo groundnuty/macf`) |
| 10/11 PASS rehearsal #13b | cv-e2e-test 2026-04-30 | `groundnuty/macf-science-agent:insights/2026-04-30-rehearsal-13b-empirical-witnesses.md` |
| 21 notify_received events / 11+10 wake events | Same | Same insight document |
| 23 DRs / 7 phase specs / 13 canonical rules | Current state | `ls design/decisions/ \| wc -l` etc. |

## Honest limitations (what MACF does NOT solve)

- **Cost optimization**: token spend on multi-agent coordination is real and ongoing. If your budget is tight, this is a hard constraint.
- **Operator effort**: bootstrap is 30 minutes for the first agent + 15 minutes per additional agent + ongoing operator time managing the swarm. Not a fire-and-forget framework.
- **Failure modes**: agent sessions can hang, channel servers can crash, tokens can expire mid-task. The Path-2 hooks + Path-3 doctor mitigate the common cases; uncaught failure modes still exist (see [troubleshooting.md](troubleshooting.md)).
- **Network dependencies**: GitHub outages stop coordination. Tailscale outages stop cross-host routing. Plan for both.
- **No managed offering**: you self-host. There's no SaaS option (and the GitHub-as-substrate design makes one structurally awkward — you'd be paying for a wrapper around services you already have).

## Cross-references

- [concepts.md](concepts.md) — architecture grounding the design choices above
- [features.md](features.md) — what's in v0.2.9 today
- [troubleshooting.md](troubleshooting.md) — failure modes catalogued
- [faq.md](faq.md) — common questions with concrete answers
- `groundnuty/macf-science-agent:insights/` — paper-grade observations referenced above
- `groundnuty/macf-science-agent:papers/` — academic-peer baseline (ACMM and others)
- `groundnuty/claude-plan-composer` — predecessor empirical baseline
