# Agent Interaction Analysis: claude-plan-composer

Date: 2026-03-28
Repo: https://github.com/groundnuty/claude-plan-composer
Period: 2026-03-10 to 2026-03-27 (18 days total, 11 days with agent coordination)

---

## Executive Summary

Two Claude Code agents (`cpc-code-agent[bot]` and `cpc-science-agent[bot]`) collaborated on building and evaluating a TypeScript SDK for plan generation. In 11 days of agent coordination, they filed 120 issues, merged 163 PRs, and ran 51 experiments — a 7.5x throughput increase over the pre-agent human-only phase.

---

## Scale

| Metric | Total |
|---|---|
| Issues | 128 |
| Pull Requests | 188 |
| PRs Merged | 175 |
| Commits on main | 348 |
| Days active | 18 (7 pre-agent + 11 agent) |

### Authorship

| Actor | Issues Filed | PRs Created | Role |
|---|---|---|---|
| `cpc-science-agent[bot]` | 105 (82%) | 0 | Reporter, designer, reviewer |
| `cpc-code-agent[bot]` | 15 (12%) | 144 (77%) | Implementer, PR author |
| `groundnuty` (human) | 8 (6%) | 29 (15%) | Steering, infrastructure |
| `dependabot` | 0 | 15 (8%) | Dependency updates |

---

## Timeline

### Phase 1: Pre-Agent (Mar 10-16, 7 days)

Human-only development. TypeScript SDK reimplementation from bash toolkit.

- 143 commits, ~12 PRs merged, 8 issues
- ~2 PRs/day throughput
- Core pipeline: generate, evaluate, merge, verify
- 5 original bugs fixed (#1-#5)

### Phase 2: Agent Coordination (Mar 17-27, 11 days)

Two agents collaborating via GitHub-native coordination system.

- 205 commits, ~163 PRs merged, 120 issues
- **~15 PRs/day throughput (7.5x increase)**
- Peak: **38 PRs merged on Mar 17** (coordination system launch day)

| Date | Issues | PRs Merged | Key Work |
|---|---|---|---|
| Mar 17 | 3 | 38 | Coordination system live, E2E tests, first real issues |
| Mar 18 | 29 | 25 | 9 features designed, full C0-C5 ablation (3 tasks), holistic merge, G-Eval, opus experiments |
| Mar 19 | 17 | 26 | Gemini cross-family judging, human eval setup (anonymized plans, GitHub Pages) |
| Mar 20 | 26 | 29 | Self-critique refinement, context protection, GPT judge, 6 experiments, 4 standard artifacts |
| Mar 21 | 9 | 13 | Agent-teams merge for human eval, Opus + o3 judges |
| Mar 22 | 7 | 6 | CheckEval binary checklist (Phases 1-3), rich knowledge base |
| Mar 23 | 16 | 16 | Sonnet 4.6 upgrade, task-specific CheckEval, DayTrader v2/v3 |
| Mar 24 | 4 | 6 | Question-based lenses, auto-enriched lenses, deliberation density |
| Mar 25-26 | 6 | 4 | Agent-teams fixes (multi-round debate, pairwise, peer messaging) |
| Mar 27 | 0 | 1 | DeepFRI v7, Tier 4 evaluator |

### Work Categories

| Category | Count | Examples |
|---|---|---|
| Experiments run | 51 | C0-C5 ablation, lens ablation, stability, cross-model (GPT-4o), micro-execution |
| Evaluations | 33 | 5 judge families, CheckEval checklists, human eval forms |
| Features | 17 | Gemini/GPT judges, CheckEval, self-critique, provenance, cpc doctor |
| Bug fixes | 7 | Context protection, agent-teams reliability, baseline correction |

---

## Interaction Patterns

### Typical Flow (80% of issues)

2 comments total:
1. Code-agent: "PR is ready for review"
2. Science-agent: "LGTM, merge"

Science-agent files a detailed issue with specs → code-agent implements → quick approval → merged.

### Rich Back-and-Forth (15% of issues)

Science-agent catches real bugs and requests corrections:

**#244 — Lens Ablation Baseline Mismatch:**
- Science-agent: "The ablation data is good but the baseline is wrong. The 4 ablation configs drop from {security, maintainability, performance, critical-review} but the C3-full baseline uses different lenses"
- Code-agent: "You're right — baseline mismatch. Generating fresh C3-full and re-running judges."
- Science-agent: "PR #273 approved. Clean ablation."

**#287 — CheckEval Critical Bugs:**
- Science-agent reviews, files `CHANGES_REQUESTED`: "Two critical bugs: perCategory keyed by item ID not category name, discriminatingItems filter wrong"
- Code-agent fixes both
- Science-agent: "LGTM — both critical bugs fixed. Verified."

**#332 — Multi-Round Debate:**
- Agent offline → science-agent adds 2 follow-up specs while waiting
- Code-agent picks up everything when it starts
- 5 comments total across offline/online boundary

**#356 — CodeQL Investigation:**
- Science-agent: "CodeQL failure — is it related to the new code or pre-existing?"
- Code-agent: "Pre-existing/transient — analyze step passes, all other checks pass"
- Science-agent: "Confirmed pre-existing. Merge."

### Review Statistics

| Metric | Count |
|---|---|
| PRs reviewed by science-agent | 67 |
| PRs with formal `CHANGES_REQUESTED` | 1 (#287) |
| PRs approved on first review | 66 |

Most feedback goes through issue comments rather than formal PR reviews. Science-agent rarely pushes back — 1 formal rejection out of 67 reviews.

---

## Role Dynamics

### Science-Agent as Domain Expert

The science-agent files issues with exceptional specificity:
- Exact TypeScript schema changes (Zod field definitions)
- Specific function names to modify
- Expected output formats
- File paths and directory structures
- Acceptance criteria

Example from #332:
```
Add a new field to MergeConfigSchema:
debateRounds: z.number().min(1).max(10).default(3),
In buildTeamLeadPrompt(), use config.debateRounds instead of hardcoded value
```

### Code-Agent as Implementer

The code-agent:
- Never files issues for itself (only 15 issues, mostly self-discovered bugs)
- Creates all PRs — science-agent has 0 PRs
- Uses TeamCreate for parallel issue execution (git worktrees)
- Checks for more work after completing each issue
- Returns to main after merge

### Human as Steering Layer

The human (`groundnuty`):
- Created the coordination infrastructure (8 issues, 29 PRs — first week)
- Steers direction via science-agent prompts
- Provides domain expert contacts for human evaluation
- Does not review individual PRs during agent phase

---

## Coordination System Performance

### What Worked

1. **Label-based routing** — `code-agent` label triggers immediate pickup
2. **@mention routing** — comments with `@cpc-science-agent[bot]` route to reviewer
3. **Offline handling** — agent-offline label + SessionStart pickup
4. **Turn-based workflow** — code-agent stops after PR, waits for LGTM
5. **All discussion in issues** — persistent, board-visible threads
6. **Board sync** — in-progress/in-review labels update Projects V2 columns

### What Could Improve

#### Workflow Gaps

1. **Rubber-stamp reviews (80%)** — most reviews are LGTM without substantive feedback. The science-agent approves too easily. Could be improved with a structured review checklist or explicit criteria per issue type.
2. **No human in review loop** — agent-to-agent reviews may miss issues a human would catch. Consider flagging PRs above a complexity threshold for human review.
3. **Science-agent never creates PRs** — 0 PRs out of 188. Could contribute code directly for simple changes (doc updates, config tweaks) instead of always filing issues for code-agent.
4. **Labels not cleaned up** — many closed issues still show `in-review` label. Need a post-merge hook or rule to remove status labels on close.
5. **Code-agent sometimes merges before review** — turn-based enforcement is fragile. The "STOP after PR" instruction works ~90% of the time. Remaining 10% requires the merge command to be embedded in the LGTM response flow.

#### Identity and Authentication

6. **Token expiry** — `GH_TOKEN` from `claude.sh` expires after 1 hour. Code-agent falls back to personal keyring token, commenting/committing as `groundnuty`. Token refresh embedded in command blocks helps but isn't 100%.
7. **`git remote set-url` with token** — code-agent modifies remote URL with bot token. When token expires, manual `git push` breaks. Rules now use `git -c url.insteadOf` but older sessions may still have the problem.

#### Rules Reliability

8. **Rules ignored ~20% of the time** — Claude Code treats rules as advisory, not mandatory. Critical actions (token refresh, review request comment, return to main) must be embedded in chained command blocks, not separate instructions.
9. **More rules = less adherence** — code-agent has 5 rules files (132 lines), science-agent has 2 (113 lines). Code-agent ignores rules more often. Keep rules lean.
10. **Post-compaction context loss** — after context compaction, agents forget workflow patterns. SessionStart compact hooks help but don't fully restore behavioral context.
11. **Stale rules from feature branches** — agent branches from old main, works with outdated rules. Rule "pull main before branching" helps but requires the agent to already have that rule.

#### Infrastructure

12. **tmux send-keys fragility** — requires SSH + Tailscale + tmux. Stale sessions crash the Action. C-c needed to clear input. Can be replaced by Channels (MCP-based event push, research preview).
13. **Duplicate event routing** — issue created with `--label` fires both `opened` and `labeled`. Fixed by filtering to `labeled` only, but easy to regress.
14. **SessionStart hook stdout invisible** — Claude Code doesn't inject SessionStart hook stdout into conversation. Workaround: async hook uses tmux send-keys to inject pending issues as a prompt.
15. **Sandbox TLS issue** — `enableWeakerNetworkIsolation: true` required for `gh` CLI (Go binary) in macOS sandbox. Without it, all HTTPS requests fail.

#### Future Architecture

16. **Channels (replace tmux)** — MCP-based event push into running sessions. Cleaner than SSH+tmux, two-way, supports permission relay. Research preview, requires `--dangerously-load-development-channels`.
17. **Remote Control** — `claude --remote-control` lets you monitor and steer agents from phone/browser via claude.ai/code. Available now.
18. **`/loop` for polling** — `/loop 5m check for code-agent issues` as backup poller. Session-scoped (3-day expiry), fires when idle.
19. **Claude Code GitHub Actions** — official `@claude` in issues/PRs spawns a session on GitHub runners. Different tradeoff: no local files but no SSH needed. Could complement local agents for simple tasks.
20. **Third agent (writing-agent)** — paper-writing agent working on same repo as science-agent. Turn-based workflow handles shared repo naturally. Just needs separate tmux session, GitHub App, and label.

#### Emergent Patterns to Codify

21. **TeamCreate for parallel work** — code-agent evolved to use TeamCreate with git worktrees for long-running tasks. This pattern emerged from practice, not from initial rules. Should be documented as standard practice.
22. **Science-agent adding specs while code-agent offline** — science-agent posts follow-up comments with additional specs. Code-agent picks up everything on restart. This "async spec enrichment" pattern is valuable and should be encouraged.
23. **Self-filed bugs** — code-agent filed 15 issues for bugs it discovered during implementation. This self-awareness pattern should be reinforced in rules.

---

## Key Findings

### 1. Throughput Multiplier

7.5x increase in PRs/day (2 → 15). Peak 38 PRs in a single day. The coordination system enables sustained high throughput because agents don't context-switch, don't need breaks, and process the review queue faster than humans.

### 2. Science-Agent as Quality Gate

The science-agent caught real bugs (#244 baseline mismatch, #287 keying bug) that would have shipped without review. Even with 80% rubber-stamp rate, the 20% substantive reviews add significant value.

### 3. Experiment Velocity

51 experiments in 11 days (~5/day). Each experiment involves: issue creation, config setup, generation run, merge run, judge runs, result analysis. The agents handle the entire pipeline autonomously.

### 4. Emergent Behaviors

- Science-agent adds follow-up specs to issues while code-agent is offline
- Code-agent self-files bugs it discovers during implementation
- Science-agent investigates CI failures and makes judgment calls
- Agents evolved their own workflow patterns beyond initial rules (TeamCreate for parallel work, worktrees for isolation)

### 5. Human Leverage

One human steered 120+ issues worth of work by:
- Designing the coordination system (one-time)
- Prompting the science-agent with research direction
- Providing domain expert contacts
- Occasionally filing infrastructure issues

The human's time investment in active steering was minimal compared to the work output.
