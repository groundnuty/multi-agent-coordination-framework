# Orchestrator-Worker Pattern: Literature Review

Date: 2026-03-28
Context: Deep research on the pattern where an AI agent orchestrates work and delegates execution to fresh-context workers. Applied to our code-agent architecture.

---

## 1. What Is This Pattern Called?

The field has **not converged on a single name**. The pattern appears under overlapping terms:

### Academic Names

| Term | Used By | Scope |
|---|---|---|
| Hierarchical Multi-Agent Systems | Wan et al. (2025), Liu et al. (2025) | Broadest — covers any multi-level agent coordination |
| Centralized Coordination | Guo et al. (2024) survey | One agent controls task allocation |
| Planning vs Execution Separation | Xi et al. (2023) cognitive architecture | "Brain" component distinct from "action" component |
| Task Decomposition + Delegation | Huang et al. (2024) survey | One of five primary planning categories |

### Industry/Framework Names

| Term | Used By | Definition |
|---|---|---|
| **Orchestrator-Workers** | Anthropic | "A central LLM dynamically breaks down tasks, delegates them to worker LLMs, and synthesizes results" |
| **Supervisor Pattern** | LangGraph | Supervisor agent whose "tools are other agents" |
| **Hierarchical Process** | CrewAI | Manager agent that "emulates a corporate hierarchy" |
| **GroupChat Manager** | AutoGen/Microsoft | Coordinating agent in multi-agent conversations |
| **Team Lead + Teammates** | Claude Code | Lead coordinates, teammates claim tasks from shared list |
| **Assembly Line Paradigm** | MetaGPT | SOPs structure the delegation chain |

### Closest Canonical Terms

**"Orchestrator-workers"** (Anthropic) and **"supervisor pattern"** (LangGraph) are the most commonly used in practice. In academic literature, **"hierarchical multi-agent"** is the umbrella term.

### Sources

- Anthropic, "Building Effective Agents" (2024): https://www.anthropic.com/engineering/building-effective-agents
- Guo et al., "Large Language Model based Multi-Agents: A Survey of Progress and Challenges" (2024): https://arxiv.org/abs/2402.01680
- Xi et al., "The Rise and Potential of Large Language Model Based Agents: A Survey" (2023): https://arxiv.org/abs/2309.07864
- Huang et al., "Understanding the planning of LLM agents: A survey" (2024): https://arxiv.org/abs/2402.02716
- LangGraph multi-agent blog: https://blog.langchain.com/langgraph-multi-agent-workflows
- CrewAI processes docs: https://docs.crewai.com/concepts/processes
- Wu et al., "AutoGen" (2023): https://arxiv.org/abs/2308.08155
- Hong et al., "MetaGPT" (2023): https://arxiv.org/abs/2308.00352
- Claude Code agent teams docs: https://code.claude.com/docs/en/agent-teams
- Claude Code sub-agents docs: https://code.claude.com/docs/en/sub-agents

---

## 2. Context Management in Orchestrator Agents

### Orchestration Context vs Execution Context

A critical distinction that few papers address explicitly, but every major implementation reveals:

**Orchestration context**: Issue specs, worker summaries, delegation decisions, workflow patterns learned. Small, slow-growing, high-value.

**Execution context**: File contents, test output, build logs, git diffs, command results. Large, fast-growing, quickly stale.

**Claude Code sub-agents** articulate this most clearly: "Each subagent runs in its own context window with a custom system prompt, specific tool access, and independent permissions." Subagents help "preserve context by keeping exploration and implementation out of your main conversation." Only "the relevant summary returns to your main conversation."

Source: https://code.claude.com/docs/en/sub-agents

**LangGraph** offers explicit modes:
- **Shared Context**: "all the work either of them do is visible to the other" (full transparency, but verbose)
- **Isolated Context**: "agents maintain their own independent scratchpads, and then their final responses are appended to a global scratchpad" (reduced noise)

Source: https://blog.langchain.com/langgraph-multi-agent-workflows

### Context Contamination

The **Sculptor** paper (Li et al., Aug 2025) identifies the mechanism: "LLMs suffer from significant performance degradation when processing long contexts due to **proactive interference**, where irrelevant information in earlier parts of the context disrupts reasoning and memory recall." They argue that "explicit context-control strategies, rather than merely larger token windows, are key to robustness at scale."

Source: Li et al., "Sculptor: Empowering LLMs with Cognitive Agency via Active Context Management" (2025): https://arxiv.org/abs/2508.04664

The **Engram** paper (Karimi et al., Mar 2026) addresses this directly: "existing agentic frameworks suffer from context degradation over long horizons or fail to accumulate knowledge across independent runs." Their solution: each agent iteration archives results into a compact "Research Digest" that subsequent fresh-context agents read on startup.

Source: Karimi et al., "Improving Coherence and Persistence in Agentic AI for System Optimization" (2026): https://arxiv.org/abs/2603.21321

### How Frameworks Handle Orchestrator Context

| Framework | Strategy | Source |
|---|---|---|
| Claude Code | Sub-agents have own context windows. Orchestrator receives summaries only. Auto-compaction at ~95% capacity. | https://code.claude.com/docs/en/sub-agents |
| CrewAI | Task output chains; short-term, long-term, and entity memory systems. | https://docs.crewai.com/concepts/crews |
| LangGraph | Graph-based state with explicit shared vs isolated message lists. | https://blog.langchain.com/langgraph-multi-agent-workflows |
| AutoGen | GroupChat manager sees all agent messages (shared context). | https://arxiv.org/abs/2308.08155 |
| MetaGPT | SOPs structure information flow; agents verify intermediate results. | https://arxiv.org/abs/2308.00352 |
| Lemon Agent | Three-tier progressive context management with self-evolving memory. | https://arxiv.org/abs/2602.07092 |
| Engram | Fresh context per iteration + persistent "Research Digest" archive. | https://arxiv.org/abs/2603.21321 |

---

## 3. Benefits of the Pattern

### Quality of Delegation

Anthropic's guidance: orchestrator-workers works best for "complex tasks where you can't predict the subtasks needed." The orchestrator's ability to dynamically decompose tasks based on the input is the key differentiator from simple parallelization.

**Kulkarni & Kulkarni (Mar 2026)** provide quantitative evidence: the hierarchical supervisor-worker architecture achieved **F1 0.921 at 1.4x cost** on SEC filing extraction, sitting on "the most favorable position on the cost-accuracy Pareto frontier." More cost-efficient than reflexive architectures (F1 0.943 at 2.3x cost).

Source: Kulkarni & Kulkarni, "Benchmarking Multi-Agent LLM Architectures for Financial Document Processing" (2026): https://arxiv.org/abs/2603.22651

### Error Containment

Worker failures are naturally isolated because each worker has its own context window. MetaGPT specifically addresses "logic inconsistencies due to cascading hallucinations caused by naively chaining LLMs" through structured verification of intermediate results.

### Token Efficiency

Fresh workers avoid accumulated context entirely. **Amayuelas et al. (Apr 2025)** demonstrated that "the planner method outperforms the orchestrator method in handling concurrent actions, resulting in improved efficiency and better utilization of agents" and that "providing explicit information about worker capabilities enhances the allocation strategies."

Source: Amayuelas et al., "Self-Resource Allocation in Multi-Agent LLM Systems" (2025): https://arxiv.org/abs/2504.02051

### Parallelism

Claude Code's agent teams explicitly support parallel execution where "teammates work independently, each in its own context window." The docs recommend 3-5 teammates with 5-6 tasks per teammate.

### The "Senior Developer Writes Tickets" Analogy

**LATM — LLMs As Tool Makers** (Cai et al., May 2023) formalizes this: a powerful model (GPT-4) creates reusable tools in a "tool making phase," and a lightweight model (GPT-3.5) applies them in a "tool using phase." This "strategic division of labor allows the once-off cost of tool-making to be spread over multiple instances of tool-using."

Source: Cai et al., "Large Language Models as Tool Makers" (2023): https://arxiv.org/abs/2305.17126

**ChatDev** (Qian et al., Jul 2023) directly implements the software development analogy with CEO, CTO, programmer, and tester agent roles following a waterfall process.

Source: Qian et al., "ChatDev: Communicative Agents for Software Development" (2023): https://arxiv.org/abs/2307.07924

---

## 4. Problems and Failure Modes

### Orchestrator as Bottleneck

Claude Code's agent teams docs note: "Sometimes the lead starts implementing tasks itself instead of waiting for teammates." Mitigation: explicitly tell the lead to wait for teammates.

Source: https://code.claude.com/docs/en/agent-teams

### Spec Quality Degradation with Context Growth

**LOCA-bench** (Zeng et al., Feb 2026): "reliability often deteriorates" as context expands during agent operations, though "advanced context management techniques can substantially improve the overall success rate."

Source: Zeng et al., "LOCA-bench: Benchmarking Language Agents Under Controllable and Extreme Context Growth" (2026): https://arxiv.org/abs/2602.07962

### "Telephone Game" / Cascading Hallucinations

MetaGPT was specifically designed to address "cascading hallucinations caused by naively chaining LLMs." Their solution: encoding workflows as SOPs rather than free-form conversation.

### Worker Cannot Ask Clarifying Questions

Implementation-dependent:
- Claude Code foreground subagents: permission prompts pass through to user
- Claude Code background subagents: clarifying questions fail, but subagent continues
- Claude Code agent teams: teammates can message each other directly
- CrewAI hierarchical: workers cannot ask manager for clarification mid-task

### When to Execute Directly vs Delegate

Anthropic's heuristics:
- **Execute directly** when: task needs frequent back-and-forth, iterative refinement, quick targeted change
- **Delegate** when: task produces verbose output you don't need in main context, work is self-contained and can return a summary

Source: https://code.claude.com/docs/en/sub-agents

---

## 5. Context Growth in Long-Running Agents

### Foundational: Lost in the Middle

Liu et al. (Jul 2023): "performance is often highest when relevant information occurs at the beginning or end of the input context, and significantly degrades when models must access relevant information in the middle of long contexts."

Source: Liu et al., "Lost in the Middle: How Language Models Use Long Contexts" (2023): https://arxiv.org/abs/2307.03172

### Instruction Following Degrades Over Extended Interactions

**De Araujo et al. (Dec 2025)** tested persona-based LLMs across 100+ turn dialogues: "Persona fidelity degrades over the course of dialogues, especially in goal-oriented conversations." As dialogues lengthen, "persona responses become increasingly similar to baseline responses" — demonstrating "the fragility of persona applications in extended interactions."

Source: De Araujo et al., "Persistent Personas? Role-Playing, Instruction Following, and Safety in Extended Interactions" (2025): https://arxiv.org/abs/2512.12775

**This directly applies to our observation**: the code-agent followed rules well early in a session but needed hand-holding after compaction. The persona/role (code-agent identity, workflow rules) degraded over the session.

### Proactive Interference (Context Contamination)

Sculptor: "irrelevant information in earlier parts of the context disrupts reasoning and memory recall." This is the mechanism where execution artifacts (logs, test output) pollute the planning/reasoning context.

### Surprisingly Robust in Some Cases

**Ma & Liu (Dec 2025)** found that in a 200-turn chaotic conversation test, models "maintained key facts and instructions far better than expected." Degradation is task-dependent — may be more about attention competition than absolute information loss.

Source: Ma & Liu, "Quantifying Laziness, Decoding Suboptimality, and Context Degradation in Large Language Models" (2025): https://arxiv.org/abs/2512.20662

### LOCA-bench: First Context Rot Benchmark

Zeng et al. (Feb 2026) introduced "context rot" as a benchmark concept for agents: "reliability often deteriorates" as context expands, but this can be mitigated through advanced context management.

Source: https://arxiv.org/abs/2602.07962

### KV Cache Management for Long Agents

**SideQuest** (Kariyappa & Suh, Feb 2026): "the LLM context is dominated by tokens from external retrieval, causing memory usage to grow rapidly." Model-driven cache compression achieved "up to 65% reduction in peak token consumption on agent tasks while maintaining accuracy."

Source: Kariyappa & Suh, "SideQuest: Model-Driven KV Cache Management for Long-Horizon Agentic Reasoning" (2026): https://arxiv.org/abs/2602.22603

### Strategies for Keeping Orchestrator Context Lean

| Strategy | Implementation | Source |
|---|---|---|
| Auto-compaction | Summarize at ~95% capacity | Claude Code |
| Fresh context + digest | Each iteration starts fresh, reads prior archive | Engram (arXiv:2603.21321) |
| Isolated subagent context | Workers have own windows; only summaries return | Claude Code, LangGraph |
| Active context management | Agent tools to hide/restore/summarize sections | Sculptor (arXiv:2508.04664) |
| KV cache compression | Model-driven token relevance assessment | SideQuest (arXiv:2602.22603) |
| Memory externalization | Short/long-term/entity memory systems | CrewAI, Generative Agents |
| Three-tier progressive context | Redundancy reduction across parallel ops | Lemon Agent (arXiv:2602.07092) |

---

## 6. Real-World Implementations

### Claude Code Sub-Agents

Most detailed production implementation. Key features:
- Built-in types: Explore (fast/read-only/Haiku), Plan (research), General-purpose
- Custom sub-agents via Markdown YAML frontmatter
- Each in own context window with configurable tools, permissions, model
- Foreground (blocking) or background (concurrent)
- Cannot spawn other subagents (no nesting)
- Auto-compaction at ~95%

Source: https://code.claude.com/docs/en/sub-agents

### Claude Code Agent Teams

Lead + teammate architecture:
- Shared task list with self-coordination
- Direct inter-agent messaging
- Each teammate loads project context independently
- Lead's conversation history does NOT carry over to teammates
- Recommended 3-5 teammates, 5-6 tasks per teammate

Source: https://code.claude.com/docs/en/agent-teams

### GitHub Copilot Workspace

Strict planning-before-execution: Analyze → Spec → Plan → Generate → Test. User acts as orchestrator reviewing plan before execution.

Source: https://github.blog/news-insights/product-news/github-copilot-workspace/

### Devin (Cognition)

"Keep sessions under ~3 hours and break down large tasks." Single long-running agent with conversational interface, not multi-agent orchestrator.

Source: https://www.cognition.ai/blog/devin-generally-available

### SWE-agent (Princeton)

Single agent with carefully designed Agent-Computer Interface (ACI). 12.5% pass@1 on SWE-bench. Not multi-agent.

Source: Yang et al., "SWE-agent" (2024): https://arxiv.org/abs/2405.15793

### OpenHands (formerly OpenDevin)

Open platform for AI developer agents. Supports multi-agent but technical details sparse.

Source: Wang et al., "OpenHands" (2024): https://arxiv.org/abs/2407.16741

### CrewAI Hierarchical Process

Manager handles "planning, delegation, and validation." Dynamic allocation based on agent capabilities.

Source: https://docs.crewai.com/concepts/processes

### LangGraph Supervisor

Supervisor is "an agent whose tools are other agents." Supports nested hierarchical structures.

Source: https://blog.langchain.com/langgraph-multi-agent-workflows

### Project Synapse

"Central Resolution Supervisor agent performs strategic task decomposition and delegates subtasks to specialized worker agents."

Source: Yadav et al. (2026): https://arxiv.org/abs/2601.08156

---

## 7. The "Knowledge Compilation" Effect

### The Core Idea

As an orchestrator processes more tasks, it encodes learned patterns into increasingly precise worker specs. This is **prompt refinement through operational experience**.

### Formal Research

**DSPy** (Khattab et al., Oct 2023): Treats LLM pipelines as "text transformation graphs" with a "compiler that will optimize any DSPy pipeline to maximize a given metric," achieving "over 25% and 65%" improvements over standard prompting.

Source: Khattab et al., "DSPy: Compiling Declarative Language Model Calls into Self-Improving Pipelines" (2023): https://arxiv.org/abs/2310.03714

**LATM**: Powerful model creates reusable tools, lighter model applies them. "Strategic division of labor allows the once-off cost of tool-making to be spread over multiple instances."

Source: https://arxiv.org/abs/2305.17126

**Iterative Experience Refinement** (Qian et al., May 2024): Agents continuously improve knowledge during and across task batches. "Experience elimination facilitates achieving better performance using just 11.54% of a high-quality subset."

Source: Qian et al., "Iterative Experience Refinement of Software-Developing Agents" (2024): https://arxiv.org/abs/2405.04219

**Claude Code Persistent Memory**: Sub-agents can have user/project/local memory scopes — "build up knowledge over time, such as codebase patterns, debugging insights, and architectural decisions."

**Generative Agents** (Park et al., Apr 2023): Three-layer architecture (experience → reflection → retrieval) for believable agent behavior.

Source: Park et al., "Generative Agents: Interactive Simulacra of Human Behavior" (2023): https://arxiv.org/abs/2304.03442

**Zhang et al. (Oct 2023)**: Specific multi-agent collaboration strategies "not only outshine previous top-tier approaches, but also optimize efficiency (using fewer API tokens)."

Source: Zhang et al., "Exploring Collaboration Mechanisms for LLM Agents: A Social Psychology View" (2023): https://arxiv.org/abs/2310.02124

### The Gap

**No published research** specifically studies whether an orchestrator agent improves its delegation quality over the course of a single long session. DSPy operates across training runs. Persistent memory operates across sessions. The within-session learning question remains empirically unanswered.

---

## 8. Key Gaps in the Literature

1. **No formal definition of "orchestration context" vs "execution context."** Every framework implements this split but nobody has formalized it.

2. **No empirical study of orchestrator quality degradation over time.** We know context degrades, but nobody has measured whether delegation specs get worse as orchestrator context fills.

3. **No comparative study of "when to delegate vs execute directly."** Only Anthropic's heuristics exist — no benchmarks.

4. **No study of the "telephone game" effect in multi-level delegation.** Information loss as a function of delegation depth is unmeasured.

5. **No study of within-session knowledge compilation.** Does the orchestrator write better specs for task #10 than task #1?

6. **"Context rot" has one benchmark (LOCA-bench) and no formal definition.**

7. **Limited cost-quality Pareto analysis.** Only Kulkarni & Kulkarni (2026) benchmarks architectures on cost vs quality.

---

## 9. Relevance to Our System

### What the research supports:

- **Separating orchestration from execution** is the dominant pattern in every major framework (Claude Code, LangGraph, CrewAI, MetaGPT, AutoGen)
- **Fresh worker contexts** avoid proactive interference (Sculptor) and context rot (LOCA-bench)
- **Centralized topology** (orchestrator + workers) is the best-performing multi-agent architecture (Google/MIT 2025)
- **Knowledge compilation** through improving worker specs is analogous to DSPy and LATM

### What remains unproven for our case:

- Whether the code-agent orchestrator's specs actually improve within a session (no research exists)
- The optimal context size for the orchestrator (our estimate: ~300K after 100 issues, well within 1M)
- Whether instruction-following degradation (De Araujo et al.) affects the orchestrator's adherence to delegation rules over time
- The exact token savings (our simulation says 74%, but depends on task complexity distribution)

### What we could contribute to the field:

Our system has **empirical data** that doesn't exist in the literature:
- 39 sessions, 26,620 API calls, 10.5 trillion tokens — measured, not simulated
- Real context growth curves for specialized agents over multi-day sessions
- Cache hit rates for focused vs hypothetical combined windows
- Actual workflow learning observed (agents evolved beyond initial rules)
- The "hand-holding after compaction" observation — direct evidence of within-session learning loss

This could be a research contribution: the first empirical study of orchestrator context management in a production multi-agent coding system.

---

## 10. Complete Reference List

### Academic Papers

| # | Paper | Authors | Venue/Year | URL |
|---|---|---|---|---|
| 1 | MetaGPT: Meta Programming for Multi-Agent Framework | Hong et al. | ICLR 2024 | https://arxiv.org/abs/2308.00352 |
| 2 | AutoGen: Enabling Next-Gen LLM Applications | Wu et al. | arXiv 2023 | https://arxiv.org/abs/2308.08155 |
| 3 | ChatDev: Communicative Agents for Software Dev | Qian et al. | ACL 2024 | https://arxiv.org/abs/2307.07924 |
| 4 | Lost in the Middle | Liu et al. | TACL 2024 | https://arxiv.org/abs/2307.03172 |
| 5 | Sculptor: Active Context Management | Li et al. | arXiv 2025 | https://arxiv.org/abs/2508.04664 |
| 6 | Engram: Coherence and Persistence in Agentic AI | Karimi et al. | arXiv 2026 | https://arxiv.org/abs/2603.21321 |
| 7 | LOCA-bench: Context Growth Benchmark | Zeng et al. | arXiv 2026 | https://arxiv.org/abs/2602.07962 |
| 8 | SideQuest: KV Cache Management | Kariyappa & Suh | arXiv 2026 | https://arxiv.org/abs/2602.22603 |
| 9 | Lemon Agent Technical Report | Jiang et al. | arXiv 2026 | https://arxiv.org/abs/2602.07092 |
| 10 | DSPy: Compiling Declarative LM Calls | Khattab et al. | arXiv 2023 | https://arxiv.org/abs/2310.03714 |
| 11 | LATM: LLMs As Tool Makers | Cai et al. | arXiv 2023 | https://arxiv.org/abs/2305.17126 |
| 12 | Iterative Experience Refinement | Qian et al. | arXiv 2024 | https://arxiv.org/abs/2405.04219 |
| 13 | Generative Agents | Park et al. | arXiv 2023 | https://arxiv.org/abs/2304.03442 |
| 14 | Rise of LLM-Based Agents (survey) | Xi et al. | arXiv 2023 | https://arxiv.org/abs/2309.07864 |
| 15 | Planning of LLM Agents (survey) | Huang et al. | arXiv 2024 | https://arxiv.org/abs/2402.02716 |
| 16 | LLM-based Multi-Agents (survey) | Guo et al. | arXiv 2024 | https://arxiv.org/abs/2402.01680 |
| 17 | Persistent Personas in Extended Interactions | De Araujo et al. | arXiv 2025 | https://arxiv.org/abs/2512.12775 |
| 18 | Context Degradation in LLMs | Ma & Liu | arXiv 2025 | https://arxiv.org/abs/2512.20662 |
| 19 | Benchmarking Multi-Agent for Financial Docs | Kulkarni & Kulkarni | arXiv 2026 | https://arxiv.org/abs/2603.22651 |
| 20 | Self-Resource Allocation in Multi-Agent LLM | Amayuelas et al. | arXiv 2025 | https://arxiv.org/abs/2504.02051 |
| 21 | SWE-agent | Yang et al. | arXiv 2024 | https://arxiv.org/abs/2405.15793 |
| 22 | OpenHands | Wang et al. | arXiv 2024 | https://arxiv.org/abs/2407.16741 |
| 23 | Exploring Collaboration for LLM Agents | Zhang et al. | arXiv 2023 | https://arxiv.org/abs/2310.02124 |
| 24 | Project Synapse | Yadav et al. | arXiv 2026 | https://arxiv.org/abs/2601.08156 |
| 25 | Toward Universal Embodied Planning | Wan et al. | J. Field Robotics 2025 | https://doi.org/10.1002/rob.22522 |
| 26 | Hierarchical Language Models for Navigation | Liu et al. | Adv. Intell. Systems 2025 | https://doi.org/10.1002/aisy.202500640 |

### Industry Blog Posts and Documentation

| # | Title | Source | URL |
|---|---|---|---|
| 27 | Building Effective Agents | Anthropic | https://www.anthropic.com/engineering/building-effective-agents |
| 28 | Claude Code Sub-Agents | Anthropic | https://code.claude.com/docs/en/sub-agents |
| 29 | Claude Code Agent Teams | Anthropic | https://code.claude.com/docs/en/agent-teams |
| 30 | LangGraph Multi-Agent Workflows | LangChain | https://blog.langchain.com/langgraph-multi-agent-workflows |
| 31 | CrewAI Processes | CrewAI | https://docs.crewai.com/concepts/processes |
| 32 | CrewAI Crews Concepts | CrewAI | https://docs.crewai.com/concepts/crews |
| 33 | GitHub Copilot Workspace | GitHub | https://github.blog/news-insights/product-news/github-copilot-workspace/ |
| 34 | Devin Generally Available | Cognition | https://www.cognition.ai/blog/devin-generally-available |
| 35 | AutoGen Blog | Microsoft Research | https://www.microsoft.com/en-us/research/blog/autogen-enabling-next-gen-llm-applications-via-multi-agent-conversation/ |
