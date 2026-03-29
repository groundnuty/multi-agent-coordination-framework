# Paper Novelty Assessment: Multi-Agent GitHub Coordination

Date: 2026-03-28
Purpose: Assess what's publishable from our multi-agent coordination work on claude-plan-composer.

---

## What We Have

### Artifacts

- **Production system**: 2 Claude Code agents (science + code) collaborating via GitHub on a real TypeScript SDK + research paper project
- **11 days of data**: 128 issues, 188 PRs, 175 merged, 348 commits, 39 sessions
- **Token-level telemetry**: 26,620 API calls, 10.5 trillion effective input tokens, 6.8M output tokens, cache hit rates, context growth curves
- **Architecture**: GitHub Apps for identity, GitHub Actions for routing, Projects V2 for visibility, Tailscale for SSH, tmux for injection — all GitHub-native
- **Design iteration history**: From initial PoC through 20+ bugs found and fixed, rules evolved, patterns emerged
- **Agent memory evolution**: 33 memory files accumulated from user feedback across sessions
- **Wiki documentation**: 8 pages covering architecture, setup, rules, troubleshooting, design lessons

### Source Code / Configuration

- `.github/workflows/agent-router.yml` — the coordination Action (3 jobs)
- `.github/agent-config.json` — agent registry
- `.claude/rules/agent-identity.md` — coordination protocol per agent
- `.claude/settings.local.json` — agent credentials and hooks
- `claude.sh` — launcher with token generation
- All publicly visible at https://github.com/groundnuty/claude-plan-composer

---

## Novelty Analysis

### Contribution 1: GitHub-Native Multi-Agent Coordination Architecture

**What**: Two Claude Code agents with distinct GitHub App identities coordinate entirely through GitHub's existing infrastructure — Issues, Pull Requests, Projects V2, Actions, Labels, @mentions. No custom coordination framework needed.

**Why novel**: Every existing multi-agent coding system uses its own coordination layer:
- MetaGPT: custom SOP-based message passing (Hong et al., ICLR 2024, https://arxiv.org/abs/2308.00352)
- ChatDev: custom chat chain protocol (Qian et al., ACL 2024, https://arxiv.org/abs/2307.07924)
- AutoGen: custom GroupChat manager (Wu et al., 2023, https://arxiv.org/abs/2308.08155)
- Claude Code agent-teams: internal TeamCreate/SendMessage (https://code.claude.com/docs/en/agent-teams)
- LangGraph: custom graph-based state (https://blog.langchain.com/langgraph-multi-agent-workflows)
- CrewAI: custom task chain (https://docs.crewai.com/concepts/processes)

Nobody has used GitHub itself as the coordination medium. This matters because:
1. GitHub is where developers already work — no new tools to learn
2. Issues/PRs create an automatic audit trail
3. Projects V2 board gives human visibility without agent code changes
4. Labels enable routing without centralized orchestration
5. GitHub Actions provides event-driven triggering without polling
6. The coordination protocol is visible, auditable, and version-controlled (in `.claude/rules/`)

**Closest prior work**: MetaGPT uses Git for code storage but not GitHub's issue/PR/review infrastructure for coordination. GitHub Copilot Workspace uses GitHub but is single-agent, not multi-agent.

**Strength**: Strong. Practical contribution that others can reproduce. Architecture is fully open-source.

### Contribution 2: Empirical Token Analysis of Production Multi-Agent Coding

**What**: First published empirical analysis of token consumption in a production multi-agent coding system, based on 39 sessions and 10.5 trillion effective input tokens.

**Key findings**:
- Inter-agent communication via GitHub artifacts: only 2.9% of output tokens
- GitHub coordination overhead (all `gh` commands): 16.5% of output tokens
- Token refresh commands: 79.7% of all `gh` commands (pure overhead)
- Cache read:output ratio: 1,511:1 (context re-reading dominates everything)
- Science-agent 2.5x more expensive than code-agent (cumulative vs transactional context)
- Cache hit rates: 67.4% (code-agent), 89.3% (science-agent) — focused windows cache well

**Why novel**: No other paper has published real token usage data at this scale:
- Anthropic's multi-agent research blog (2025) reports "~15x more tokens" but no detailed breakdown (https://www.anthropic.com/engineering/multi-agent-research-system)
- ICLR 2025 Workshop reports 4-220x theoretical overhead but no production data (https://openreview.net/pdf?id=0iLbiYYIpC)
- Kulkarni & Kulkarni (2026) benchmark cost vs quality but on a single task, not a production system (https://arxiv.org/abs/2603.22651)
- ChatDev reports ~$0.30/project but no per-component breakdown (https://arxiv.org/abs/2307.07924)

**Strength**: Very strong. Real data fills a clear gap. Reproducible — we provide extraction scripts.

### Contribution 3: The "1.18x Not 4-15x" Finding

**What**: Our multi-agent system costs ~1.18x on output tokens vs estimated single-agent, not the 4-15x reported in literature. When accounting for context window efficiency (cache hit rates, focused windows), the total cost may be **lower** than single-agent.

**Detailed breakdown**:
- Communication content: ~120K tokens (1.8% overhead)
- Token refresh: ~322K tokens (4.8% — pure implementation overhead)
- gh reasoning: ~386K tokens (5.7%)
- Review cycle: ~200K tokens (2.9%)
- Total overhead: ~1.03M tokens = 15.2% of 6.8M output = **1.18x multiplier**

**Why it's lower than literature**:
1. GitHub artifacts are compressed (~500 tokens/issue vs thousands for chat dialogue)
2. No shared context growth (agents have independent windows)
3. Structured handoffs (issues have titles, labels, structured bodies)
4. Asynchronous (no waiting, no "thinking while other agent talks")
5. Cache efficiency from focused, consistent context windows

**Why novel**: Directly challenges the widely cited 4-15x assumption:
- Anthropic (2025): ~15x (https://www.anthropic.com/engineering/multi-agent-research-system)
- ICLR 2025 Workshop: 4-220x (https://openreview.net/pdf?id=0iLbiYYIpC)
- Google/MIT (2025): mean -3.5% performance with high overhead (https://arxiv.org/abs/2512.08296)

The key insight: **the overhead depends on the communication medium, not just the number of agents.** GitHub-mediated communication is 50-100x more compressed than chat-based multi-agent dialogue.

**Strength**: Very strong. Counterintuitive finding with clear explanation. Will get attention.

### Contribution 4: Asymmetric Context Strategy

**What**: Different context window sizes for different agent roles based on work patterns:
- Science-agent (cumulative work): 1M context, long sessions, 89.3% cache hits
- Code-agent (transactional work): could use 200K or fresh-per-issue, 67.4% cache hits
- Projected savings: 2.4B tokens (22.7% of system total) from one configuration change

**Measured context growth patterns**:
- Code-agent: 1.48x growth ratio (41K → 74K avg), max 966K due to stale artifacts
- Science-agent: 4.25x growth ratio (65K → 315K avg), legitimate cumulative context

**Why novel**: Nobody has proposed role-based context sizing for multi-agent systems:
- Sculptor (Li et al., 2025) proposes active context management but not role-based asymmetry (https://arxiv.org/abs/2508.04664)
- LOCA-bench (Zeng et al., 2026) benchmarks context growth but doesn't differentiate by agent role (https://arxiv.org/abs/2602.07962)
- Engram (Karimi et al., 2026) uses fresh context per iteration but uniformly (https://arxiv.org/abs/2603.21321)

**Strength**: Medium-strong. Novel concept with empirical support. Needs more tasks/projects to generalize.

### Contribution 5: Within-Session Knowledge Compilation

**What**: Direct observation that the code-agent performed better before compaction than after. This is evidence of within-session learning that can't be captured by rules, hooks, or memory files.

**Observed**: After compaction, the code-agent:
- Forgot workflow patterns it had learned (experiment run procedures)
- Required hand-holding to re-learn what it previously did autonomously
- Rule adherence degraded (token refresh, review request posting)

**Why novel**: Literature gap acknowledged by every survey:
- DSPy (Khattab et al., 2023) compiles across training runs, not within sessions (https://arxiv.org/abs/2310.03714)
- Engram (Karimi et al., 2026) compiles across iterations, not within one (https://arxiv.org/abs/2603.21321)
- De Araujo et al. (2025) show persona degradation over long dialogues but don't study learning → compaction → degradation (https://arxiv.org/abs/2512.12775)
- No paper studies: "does an orchestrator write better specs for task #10 than task #1?"

**Strength**: Medium. Observational evidence, not controlled experiment. But it's the first reported observation of this phenomenon in a production system.

### Contribution 6: Rules Reliability Quantification

**What**: Agent rules (`.claude/rules/`) are followed ~80% of the time. Critical actions (token refresh, review request, return to main) must be embedded in chained command blocks (`&&`) or hooks — separate instructions get skipped.

**Supporting evidence**:
- Code-agent ignored "refresh token before every task" ~50% of the time
- Code-agent skipped review request comment when it was a separate step
- Code-agent merged before review when STOP instruction was in rules but not in command flow
- Science-agent with fewer rules files (2 vs 5) followed rules more reliably

**Why novel**: Claude Code's own best practices say "move to hooks" but don't quantify:
- "If you have told Claude not to do something 3 times and it keeps doing it, move that rule from CLAUDE.md to a hook" (https://code.claude.com/docs/en/best-practices)
- GitHub issue #27032 documents that Claude Code appends "this context may or may not be relevant" after CLAUDE.md (https://github.com/anthropics/claude-code/issues/27032)
- No paper quantifies the actual adherence rate in a production setting

**Strength**: Medium. Useful practical finding but hard to generalize (model-specific, prompt-specific).

### Contribution 7: Turn-Based Workflow via External Routing

**What**: Code-agent's turn ends after creating PR + posting review request. It does NOT merge. Merge only happens when it receives a new prompt (the routed LGTM from science-agent). This turn boundary is enforced by the GitHub Actions routing system, not by rules.

**Why novel**: Existing multi-agent coding systems don't have external turn enforcement:
- ChatDev uses internal phase transitions (https://arxiv.org/abs/2307.07924)
- MetaGPT uses SOPs for phase gating (https://arxiv.org/abs/2308.00352)
- Claude Code agent-teams uses SendMessage but within the same process (https://code.claude.com/docs/en/agent-teams)

Our system uses GitHub's event → Action → SSH → tmux injection pipeline to enforce turns. The agent literally cannot proceed until the reviewer responds through the routing system. This is a stronger guarantee than rules-based turn control.

**Strength**: Medium. Novel mechanism, but the implementation (tmux send-keys) is fragile. Channels would make it more robust.

---

### Contribution 8: Cross-Network Channels for Persistent Agent Coordination

**What**: Extending Claude Code's MCP channel mechanism from localhost-only event push to cross-network agent notification via Tailscale + mTLS. This enables GitHub Actions to notify persistent local Claude Code agents of new work — a use case Anthropic's architecture does not address.

**The gap in Anthropic's architecture**:

Anthropic provides two models for CI/CD + agent interaction:

1. **`claude-code-action`** (GitHub Actions): Spawns a FRESH Claude Code instance on the GitHub runner for each event. The agent is ephemeral — no persistent context, no accumulated learning, no local files. It clones the repo, does the task, comments/commits, and dies.

2. **Channels** (Telegram/Discord/webhook): Pushes events into a RUNNING Claude Code session, but only from the SAME MACHINE. The docs explicitly use `hostname: '127.0.0.1'` and state "localhost-only: nothing outside this machine can POST."

Neither solves the problem: **"I have a persistent Claude Code agent on my laptop with accumulated context, local files, and learned workflow patterns. When a GitHub event occurs, how does the agent get notified?"**

```
Anthropic's model:           Our model:
GitHub event                 GitHub event
  ↓                            ↓
Fresh agent on runner        Persistent agent on your machine
  ↓                            ↓
No context, no learning      Full context, learned patterns
  ↓                            ↓
Clone, work, die             Continue working in rich context
```

**Our contribution**: We extend the channel pattern to work across the network:
- Channel listens on Tailscale IP (not localhost)
- mTLS for per-agent authentication (not needed on localhost)
- Dynamic port registration via GitHub org variables (not needed for single-machine)
- GitHub Action POSTs to the channel endpoint instead of running `claude-code-action`

**Why this matters**:
1. **Persistent context**: Our agents have accumulated 10.5T tokens of context across 39 sessions. An ephemeral runner-based agent starts from zero every time.
2. **Accumulated learning**: The code-agent learned workflow patterns, build quirks, and test procedures over 11 days. A fresh agent would need to re-learn from rules alone (which we showed are followed only ~80% of the time).
3. **Local environment**: Agents use `devbox`, local `gh-token` extension, project-specific MCP servers, and custom hooks. Runner-based agents can't access these.
4. **Token efficiency**: Re-reading the codebase on every event wastes tokens. A persistent agent already has it cached (89.3% cache hit rate for science-agent).

**Why novel**:
- Anthropic's channel docs don't address cross-network use (only localhost)
- Anthropic's GitHub Actions run ephemeral agents (no persistent state)
- No published system combines channels + VPN + mTLS for persistent agent notification
- The closest pattern is SSH + tmux send-keys (our CPC PoC), which we're replacing with a cleaner channel-based approach

**Closest prior work**:
- Anthropic "Building Effective Agents" (2024): describes orchestrator-worker but doesn't address cross-machine notification. Source: https://www.anthropic.com/engineering/building-effective-agents
- Claude Code Channels Reference: localhost webhook example only. Source: https://code.claude.com/docs/en/channels-reference
- Claude Code GitHub Actions: ephemeral runner-based agents. Source: https://code.claude.com/docs/en/github-actions
- `tmux send-keys` via SSH: the community workaround we're replacing. Source: https://github.com/anthropics/claude-code/issues/24947

**Strength**: Strong. Fills a clear architectural gap. Combines existing primitives (channels, Tailscale, mTLS) in a novel way. The "persistent vs ephemeral" agent tradeoff is well-understood in distributed systems but hasn't been formally addressed for LLM coding agents.

---

## What's NOT Novel (Don't Overclaim)

| Concept | Already Published By |
|---|---|
| Multi-agent coding systems | ChatDev, MetaGPT, SWE-agent, AutoGen (all 2023-2024) |
| Orchestrator-worker pattern | Anthropic "Building Effective Agents" (2024), LangGraph, CrewAI |
| Context window efficiency | Lost in the Middle (Liu et al., 2023), Context Rot (Chroma, 2025) |
| Agent identity via GitHub Apps | GitHub's own documentation |
| GitHub Actions for automation | GitHub's own documentation |
| Token caching benefits | Anthropic's prompt caching documentation |
| Role specialization in agents | MetaGPT, ChatDev, HyperAgent |
| Self-review limitations (DoT) | Liang et al. (2023), Du et al. (2023) |

---

## Strongest Paper Framings

### Framing A: "GitHub-Native Multi-Agent Coordination" (Architecture + Empirical)

**Title**: "GitHub-Native Multi-Agent Coordination for Autonomous Software Development: An Empirical Study"

**Contributions**:
1. Architecture: GitHub Apps + Actions + Issues/PRs as coordination layer (contribution 1)
2. Empirical: 10.5T tokens analyzed, 1.18x overhead finding (contributions 2, 3)
3. Design lessons: rules reliability, turn-based enforcement, asymmetric context (contributions 4, 6, 7)

**Narrative**: "We present a multi-agent coordination system that uses GitHub's existing infrastructure as the communication medium. Through 11 days of production use (128 issues, 175 merged PRs), we find that GitHub-mediated communication incurs only 1.18x token overhead — dramatically lower than the 4-15x reported for chat-based multi-agent systems."

**Venue fit**: ASE SEIP, ICSE SEIP, CHASE, LLM Agents Workshop

### Framing B: "Token Economics of Multi-Agent Coding" (Empirical Focus)

**Title**: "The Token Tax: Empirical Analysis of Communication Overhead in Multi-Agent Software Development"

**Contributions**:
1. First production token dataset for multi-agent coding (contribution 2)
2. The "1.18x not 4-15x" finding with decomposition (contribution 3)
3. Asymmetric context strategy saving 22.7% (contribution 4)
4. Within-session knowledge compilation evidence (contribution 5)

**Narrative**: "Multi-agent LLM systems are widely believed to cost 4-15x more tokens than single-agent. We present the first empirical analysis of a production multi-agent coding system (39 sessions, 10.5T tokens) and find that structured communication via GitHub artifacts reduces this to 1.18x. We further show that role-based context window sizing can save 22.7% of system tokens."

**Venue fit**: ICLR/NeurIPS Agents Workshop, EMNLP Industry, ASE NIER

### Framing C: "Context Management for Long-Running Code Agents" (Context Focus)

**Title**: "Transactional vs Cumulative: Context Management Strategies for Specialized Coding Agents"

**Contributions**:
1. Measured context growth patterns for different agent roles (contribution 4)
2. Cache hit rate analysis: 67.4% vs 89.3% for focused windows (contribution 2)
3. Orchestrator-worker pattern with asymmetric windows (contribution 4)
4. Within-session learning and compaction degradation (contribution 5)
5. Rules reliability and the "command block" pattern (contribution 6)

**Narrative**: "We study how context windows behave in long-running coding agents with different roles. Science-oriented agents exhibit 4.25x context growth (cumulative reasoning) while implementation agents show 1.48x (transactional work). We propose an asymmetric context strategy where orchestrator agents maintain large windows for learning while delegating execution to fresh-context workers, saving 74% of input tokens."

**Venue fit**: COLM, NeurIPS, ICLR (more ML-focused)

---

## Recommended Framing: A + B Hybrid

Combine the architecture contribution (it's practical and reproducible) with the empirical findings (they're novel and surprising). The "1.18x" number is the hook that gets the paper read.

**Working title**: "GitHub as Coordination Layer: Architecture and Token Economics of Multi-Agent Software Development"

**Structure**:
1. Introduction — multi-agent coding is growing, overhead is a concern, we present a GitHub-native approach
2. Architecture — GitHub Apps, Actions, Issues/PRs, turn-based workflow
3. Empirical methodology — session log analysis, token extraction, communication measurement
4. Results — 1.18x overhead, 2.9% communication, cache hit rates, context growth
5. Asymmetric context — transactional vs cumulative roles, 22.7% savings
6. Design lessons — rules reliability, command blocks, knowledge compilation
7. Threats to validity — single project, two agents, Claude-specific
8. Related work — MetaGPT, ChatDev, AutoGen, token overhead literature
9. Conclusion

---

## Threats to Validity

Must acknowledge honestly:

1. **Single project**: All data from one TypeScript SDK. Patterns may not generalize to other languages, project sizes, or domains.
2. **Two agents only**: We haven't tested with 3+ agents. Coordination overhead may scale differently.
3. **Claude-specific**: Rules reliability, cache behavior, and compaction patterns are specific to Claude Code / Claude models. Other models/frameworks may differ.
4. **No controlled baseline**: We estimate single-agent cost from measured data, not from actually running a single agent on the same tasks. A controlled experiment would strengthen the 1.18x claim.
5. **Human steering**: The human influenced task selection, reviewed critical decisions, and provided feedback. The system is not fully autonomous.
6. **Claude Max plan**: Token counts represent computational work, not monetary cost. On API billing with cache discounts, the cost picture changes.
7. **Short duration**: 11 days. Long-term effects (agent drift, memory bloat, coordination fatigue) are unknown.
8. **tmux fragility**: The current routing mechanism (SSH + tmux send-keys) is a known limitation that Channels will address.

---

## Data Availability

All data needed to reproduce:
- Session logs: `~/.claude/projects/<project>/*.jsonl` (private — would need anonymization)
- GitHub data: public at https://github.com/groundnuty/claude-plan-composer (issues, PRs, comments)
- Architecture: public (wiki, agent-router.yml, agent-config.json, rules files)
- Analysis scripts: documented in `research/2026-03-28-token-usage-empirical-analysis.md`

For publication, we would need to:
- Anonymize session logs (remove file contents, personal paths)
- Provide a reproduction package with extraction scripts
- Consider releasing a dataset of token usage patterns (aggregated, not raw)
