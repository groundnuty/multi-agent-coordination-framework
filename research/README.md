# MACF Research

Research conducted during the design of the Multi-Agent Coordination Framework, based on production experience with the CPC (claude-plan-composer) project where two agents collaborated for 11 days (128 issues, 175 merged PRs).

## Empirical Analysis

| File | Topic | Key Finding |
|---|---|---|
| [token-usage-empirical-analysis](2026-03-28-token-usage-empirical-analysis.md) | Token consumption analysis of 39 sessions, 10.5T tokens | Multi-agent overhead is 1.18x not 4-15x. Communication via GitHub is only 2.9% of output. Cache dominates (1,511:1 read:output ratio). Asymmetric context saves 22.7%. |
| [cpc-agent-interaction-analysis](2026-03-28-cpc-agent-interaction-analysis.md) | Analysis of agent interactions on the CPC repo | 7.5x throughput increase (2→15 PRs/day). 51 experiments in 11 days. Science-agent caught real bugs (#244, #287). 80% rubber-stamp reviews. |

## Architecture & Design

| File | Topic | Key Finding |
|---|---|---|
| [channel-architecture-design](2026-03-28-channel-architecture-design.md) | Complete channel architecture with 7 design alternatives evaluated | Per-agent org variables, mTLS, challenge-response signing, no orchestrator. GitHub is the registry. |
| [macf-workspace-design](2026-03-28-macf-workspace-design.md) | Repository structure, agent assignments, experiment workspace layout | 8 repos, 6 GitHub Apps, 6 agent roles, 3 experiment conditions, 45 runs. |
| [chrome-automation-validation](2026-03-28-chrome-automation-validation.md) | Validation that Claude Code + Chrome can automate GitHub UI tasks | `claude --chrome -p` works for multi-page navigation, form filling, and data extraction. Enables automated GitHub App creation. |

## Literature Reviews

| File | Topic | Key Finding |
|---|---|---|
| [multi-agent-vs-single-agent-analysis](2026-03-28-multi-agent-vs-single-agent-analysis.md) | Is multi-agent worth it? 32 sources analyzed. | Context separation avoids context rot. DoT (Degeneration-of-Thought) means cross-agent review is genuinely better than self-review. Audit trail valuable for research. Token overhead offset by cache efficiency. |
| [orchestrator-worker-literature-review](2026-03-28-orchestrator-worker-literature-review.md) | The orchestrator-worker pattern across 35 sources. | Pattern is well-established (Anthropic, LangGraph, CrewAI, MetaGPT). No one has studied within-session knowledge compilation. Centralized topology performs best (Google/MIT 2025). |

## Novel Patterns

| File | Topic | Key Finding |
|---|---|---|
| [orchestrator-worker-pattern](2026-03-28-orchestrator-worker-pattern.md) | Code-agent as middle manager — orchestrates workers, keeps context for learning. | 74% input token savings. Orchestrator's context grows from orchestration (slow) not execution (fast). Workers are disposable with fresh contexts. |
| [findings-as-externalized-memory](2026-03-28-findings-as-externalized-memory.md) | Structured finding files (F1-F123) as externalized episodic memory. | Three-layer knowledge architecture: volatile context → persistent findings → mutable memory. 123 findings drove 17 features and a research paper. |
| [science-agent-access-patterns](2026-03-28-science-agent-access-patterns.md) | Five access patterns for the orchestrating agent. | Hybrid approach (digest + subagent exploration + code findings) gives ~95% of direct access quality at ~12% of context cost. |

## Research Questions

| File | Topic | Key Finding |
|---|---|---|
| [code-access-research-question](2026-03-28-code-access-research-question.md) | Does the science-agent need code access to file good issues? | Four hypotheses (code-aware helps, domain-only sufficient, depends on complexity, diminishing returns). CPC evidence: 70% of issues had code references, 99% first-attempt success. Not yet experimentally isolated. |

## Paper & Publication

| File | Topic | Key Finding |
|---|---|---|
| [paper-novelty-assessment](2026-03-28-paper-novelty-assessment.md) | What's publishable? 8 contributions assessed. | Top contributions: GitHub-native coordination (C1), 1.18x token overhead (C3), cross-network channels (C8). Strongest paper framing: architecture + empirical. |
| [conference-venue-analysis](2026-03-28-conference-venue-analysis.md) | Which conferences to target? 20+ venues evaluated. | Best fits: ASE NIER (~Jul), ESEM Technical (May 18), ICSE SEIP (Oct 23). All publish in indexed proceedings. |
| [controlled-experiment-design](2026-03-28-controlled-experiment-design.md) | DayTrader experiment: single-agent vs multi-agent. | 45 runs (5 tasks × 3 conditions × 3 reps) on WASdev/sample.daytrader7. Measures tokens, time, quality, review findings. 8-day execution timeline. |

## Observability & Tooling

| File | Topic | Key Finding |
|---|---|---|
| [agent-observability-telemetry-stack](2026-04-22-agent-observability-telemetry-stack.md) | OSS observability stack for multi-agent MACF (2026-04 refresh) — debugging + paper-grade data collection. | Pure-OSS path: **OpenLLMetry (Apache 2.0) + Langfuse (MIT) + OTEL GenAI agent semconv**. Phoenix is Elastic License 2.0 — source-available, NOT OSI-OSS. Honeycomb/Datadog/LangSmith are proprietary SaaS. Tier-1 (stdlib + `tools/trace-round-trip.py`) available today; Tier-2 (OTEL + Langfuse self-hosted) recommended before paper data collection. |

## Summary Statistics

- **15 research documents**
- **~253K words** of analysis
- **32+ academic papers** cited
- **35+ industry sources** referenced
- **7 design alternatives** evaluated for registration alone
- **5 access patterns** for science-agent analyzed
- **3 experiment conditions** designed (single, multi-code-aware, multi-domain-only)
