# Multi-Agent vs Single-Agent: Is Our 2-Agent Architecture Worth It?

Date: 2026-03-28
Context: Analysis of whether the science-agent/code-agent split on claude-plan-composer creates more value than a single generalist agent.

---

## TL;DR

The evidence **moderately favors** our 2-agent architecture. The strongest arguments are:
1. **Context window separation** — avoids context rot (every frontier model degrades with context length)
2. **Cross-agent review** — overcomes the Degeneration-of-Thought problem (single agents can't self-correct)
3. **Audit trail** — GitHub issue/PR record is valuable for research and compliance

The main cost is **4-15x token overhead** from communication serialization. As models get more capable, the single-agent gap narrows.

---

## 1. Is Role Separation Beneficial?

**Yes, conditionally.**

- **MetaGPT** (Hong et al., ICLR 2024): Structured role separation with SOPs reduces cascading hallucinations in multi-agent SE.
- **ChatDev** (Qian et al., ACL 2024): Specialized agents (CEO, CTO, Programmer, Reviewer) outperformed both MetaGPT and GPT-Engineer (single-agent) at ~$0.30/project.
- **HyperAgent** (2024): Four specialized agents achieved 26% on SWE-Bench-Lite.
- **Persona effects are real**: LLMs assigned specific roles produce more focused output within that domain.

**But**: "Rethinking the Bounds of LLM Reasoning" (ACL 2024) found a well-prompted single agent can match multi-agent discussion on most reasoning tasks. The Google DeepMind/MIT study (2025) found mean multi-agent performance was **-3.5%** vs single-agent, with massive variance.

**For our system**: The science/code split maps to a natural cognitive division — domain expert/reviewer vs implementer. This is the MetaGPT Architect+Engineer pattern, which has demonstrated benefits.

---

## 2. Token Efficiency

**Multi-agent is more expensive.**

- Anthropic's multi-agent research system: **~15x more tokens** than standard chat
- ICLR 2025 Workshop: **4-220x more prefill tokens**, 2-12x response tokens
- ChatDev/MetaGPT: communication costs often exceed $10/task due to serial message billing

**But optimization is possible:**
- **OPTIMA** (Chen et al., ACL 2025 Findings): **90% token reduction + 2.8x accuracy gain** through optimized communication
- **SupervisorAgent** (ICLR 2026): **29.68% token reduction** via lightweight supervision

**The "lossy compression as distillation" hypothesis has support**: Forcing agents to externalize knowledge through structured artifacts (our issues/PRs) acts as a quality filter. The science-agent must clarify intent, creating a compressed, relevant representation the code-agent starts with cleanly.

---

## 3. Context Window Benefits

**This is our strongest argument.**

- **"Lost in the Middle"** (Liu et al., TACL 2024): Performance degrades significantly when relevant info is in the middle of long contexts. U-shaped attention pattern.
- **Context Rot** (Chroma Research, 2025-2026): **Every single one of 18 frontier models** gets worse as input length increases. Even one distractor document reduces performance. Models perform better on shuffled haystacks than coherent ones.
- **JetBrains Research** (2025): Coding agents accumulate noise during exploration that directly degrades output.
- **Anthropic** (2025): Their 90% multi-agent improvement was "strongly linked to the ability to spread reasoning across multiple independent context windows."

**For our system**: A single agent holding paper content + experimental design + statistical methodology + code structure + test results + Git history operates in exactly the regime where context rot causes the most damage. Two focused windows win.

---

## 4. Cross-Agent Review Quality

**Cross-agent review is genuinely better than self-review.**

- **Degeneration-of-Thought (DoT)** (Liang et al., EMNLP 2024): "Once an LLM has established confidence in its solutions, it is unable to generate novel thoughts through reflection even if its initial stance is incorrect." This is the fundamental limit of self-review.
- **Multi-agent debate** (Du et al., ICML 2024): Significantly enhances reasoning and reduces hallucinations.
- **Mixture-of-Agents** (Together AI, 2024): LLMs are "collaborative" — they produce better output when seeing other models' outputs. MoA with OSS models beat GPT-4o.
- **"More Agents Is All You Need"** (Li et al., TMLR 2024): Simple sampling-and-voting scales with agent count.
- **Self-Refine** (Madaan et al., NeurIPS 2023): Competitive single-agent baseline (~20% improvement), but limited by DoT.

**For our system**: Science-agent catching baseline mismatch (#244) and keying bug (#287) is exactly the DoT problem in action — code-agent would not have caught its own mistakes through self-review.

---

## 5. Audit Trail Value

**Strong and growing importance.**

- **OpenAI** (2024): Recommends "ledger of actions taken by the agent" for all agentic systems
- **EU AI Act** (2026): May require traceability of AI-generated decisions
- **Research reproducibility**: Issue chain from scientific question → spec → implementation → evaluation is invaluable

**Our GitHub trail provides**: Immutable decision history, rationale capture, review evidence, reproducibility, human oversight hooks.

---

## 6. Downsides

| Downside | Severity for us | Mitigation |
|---|---|---|
| 4-15x token overhead | Medium | Tight issue templates, focused communication |
| Context loss in handoffs | Low | Structured issues act as distillation |
| Coordination failures | Low | Centralized topology (science reviews all) |
| Latency (routing, SSH) | Medium | Channels will reduce; async is fine for our workflow |
| Diminishing returns with better models | Growing | Re-evaluate periodically |
| 80% rubber-stamp reviews | Medium | Structured review checklists |

---

## 7. Verdict

| Factor | Single Agent | Our 2-Agent System | Winner |
|---|---|---|---|
| Context window cleanliness | One polluted window | Two focused windows | **Multi-agent** |
| Review quality (DoT) | Self-review limited | Fresh-eyes review | **Multi-agent** |
| Audit trail | Internal logs | Full GitHub paper trail | **Multi-agent** |
| Scientific rigor | Code-biased context | Domain-focused context | **Multi-agent** |
| Parallelizability | Sequential | Design ∥ Implement | **Multi-agent** |
| Token efficiency | 1x | ~4-15x overhead | **Single agent** |
| Latency | Direct execution | Routing overhead | **Single agent** |
| Context preservation | Full | Lossy handoff | **Single agent** |
| Simplicity | One agent | Coordination complexity | **Single agent** |

**Our architecture maps to the Centralized MAS topology** (science-agent as reviewer/orchestrator, code-agent as worker), which Google's study found to be the best-performing multi-agent architecture with error amplification of only 4.4x vs 17.2x for independent agents.

**Recommendation**: Keep the 2-agent architecture. The context window and DoT arguments are strong and well-supported. Optimize communication density. Measure the review quality gap empirically.

---

## References

### Academic Papers

| # | Paper | Authors | Venue | URL | Key Finding |
|---|---|---|---|---|---|
| 1 | Lost in the Middle: How Language Models Use Long Contexts | Liu et al. | TACL 2024 | https://arxiv.org/abs/2307.03172 | U-shaped attention — performance degrades when relevant info is in the middle of long contexts |
| 2 | Encouraging Divergent Thinking in Large Language Models through Multi-Agent Debate | Liang et al. | EMNLP 2024 | https://arxiv.org/abs/2305.19118 | Identifies Degeneration-of-Thought (DoT): single agents can't self-correct once confident. MAD framework overcomes this. |
| 3 | Improving Factuality and Reasoning in Language Models through Multiagent Debate | Du et al. | ICML 2024 | https://arxiv.org/abs/2305.14325 | Multi-agent debate significantly enhances reasoning and reduces hallucinations |
| 4 | Mixture-of-Agents Enhances Large Language Model Capabilities | Wang et al. | arXiv 2024 | https://arxiv.org/abs/2406.04692 | LLMs are "collaborative" — better output when seeing other models' outputs. MoA with OSS beats GPT-4o. |
| 5 | MetaGPT: Meta Programming for A Multi-Agent Collaborative Framework | Hong et al. | ICLR 2024 | https://arxiv.org/abs/2308.00352 | Structured SOPs + role separation reduce cascading hallucinations in multi-agent SE |
| 6 | Communicative Agents for Software Development | Qian et al. (ChatDev) | ACL 2024 | https://arxiv.org/abs/2307.07924 | Multi-agent virtual company outperforms single-agent at ~$0.30/project, ~48K tokens |
| 7 | Self-Refine: Iterative Refinement with Self-Feedback | Madaan et al. | NeurIPS 2023 | https://arxiv.org/abs/2303.17651 | Single-agent generate-feedback-refine improves ~20% over one-shot. Competitive but limited by DoT. |
| 8 | Towards a Science of Scaling Agent Systems | Li et al. | arXiv 2025 (Google DeepMind/MIT) | https://arxiv.org/abs/2512.08296 | Mean multi-agent = -3.5% vs single; massive variance. Centralized topology best. 87% architecture selection accuracy from task properties. |
| 9 | More Agents Is All You Need | Li et al. | TMLR 2024 | https://arxiv.org/abs/2402.05120 | Simple sampling-and-voting scales with agent count. Smaller models + more agents beat larger models. |
| 10 | OPTIMA: Optimizing Effectiveness and Efficiency for LLM-Based Multi-Agent System | Chen et al. | ACL 2025 Findings | https://arxiv.org/abs/2410.08115 | 90% token reduction + 2.8x accuracy gain through optimized multi-agent communication |
| 11 | Stop Wasting Your Tokens: Efficient LLM Multi-Agent Systems via SupervisorAgent | — | ICLR 2026 | https://arxiv.org/abs/2510.26585 | 29.68% token reduction via lightweight supervision without architecture changes |
| 12 | Scaling Large-Language-Model-based Multi-Agent Collaboration | Qian et al. | ICLR 2025 | https://arxiv.org/abs/2406.07155 | Collaborative scaling follows logistic growth; supports 1000+ agents; irregular topologies beat regular |
| 13 | Rethinking the Bounds of LLM Reasoning: Are Multi-Agent Discussions the Key? | — | ACL 2024 | https://aclanthology.org/2024.acl-long.331/ | Well-prompted single agent can match multi-agent discussion on most reasoning tasks |
| 14 | AutoGen: Enabling Next-Gen LLM Applications via Multi-Agent Conversation | Wu et al. | arXiv 2023 (Microsoft) | https://arxiv.org/abs/2308.08155 | Flexible multi-agent conversation framework; math agents beat GPT-4 + Wolfram Alpha |
| 15 | HyperAgent: Generalist Software Engineering Agents to Solve Coding Tasks at Scale | — | OpenReview 2024 | https://openreview.net/forum?id=PZf4RsPMBG | 4 specialized agents achieve 26% on SWE-Bench-Lite |
| 16 | LLM-Based Multi-Agent Systems for Software Engineering: Literature Review | — | arXiv 2024 | https://arxiv.org/abs/2404.04834 | Survey of multi-agent SE approaches |
| 17 | Multi-Agent Collaboration Mechanisms: A Survey | — | arXiv 2025 | https://arxiv.org/abs/2501.06322 | Taxonomy of collaboration patterns |
| 18 | Single-Agent or Multi-Agent? Why Not Both | — | arXiv 2025 | https://arxiv.org/abs/2505.18286 | Hybrid approaches combining single and multi-agent |
| 19 | Tipping the Balance: Using LLM-Based Multi-Agent Debate to Explore AI Argumentative Dynamics | Triem & Ding | ASIS&T 2024 | https://doi.org/10.1002/pra2.1034 | Real multi-agent debate produces more varied arguments than single-LLM simulated debate |
| 20 | Practices for Governing Agentic AI Systems | OpenAI | Whitepaper 2024 | https://openai.com/index/practices-for-governing-agentic-ai-systems/ | Audit trails and accountability ledgers recommended for all agentic systems |

### Industry Blog Posts and Technical Reports

| # | Title | Author/Org | Date | URL | Key Finding |
|---|---|---|---|---|---|
| 21 | Building Effective Agents | Anthropic | 2024 | https://www.anthropic.com/research/building-effective-agents | Start simple; add multi-agent only when needed; 5 composable patterns |
| 22 | Building a Multi-Agent Research System | Anthropic Engineering | 2025 | https://www.anthropic.com/engineering/multi-agent-research-system | 90.2% outperformance vs single-agent; 15x token cost; success linked to context window parallelization |
| 23 | Effective Context Engineering for AI Agents | Anthropic Engineering | 2025 | https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents | Context management is the key skill for agent builders |
| 24 | Context Rot: How Long-Context LLMs Lose Their Edge | Chroma Research | 2025-2026 | https://www.trychroma.com/research/context-rot | All 18 tested frontier models (Claude 4, GPT-4.1, Gemini 2.5) degrade with context length. Even one distractor hurts. Coherent distractors worse than shuffled. |
| 25 | Together MoA — Mixture of Agents | Together AI | 2024 | https://www.together.ai/blog/together-moa | Open-source MoA achieves 65.1% on AlpacaEval 2.0 vs GPT-4o's 57.5% |
| 26 | Towards a Science of Scaling Agent Systems (blog) | Google Research | 2025 | https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/ | Accessible summary of the paper's findings on when multi-agent helps vs hurts |
| 27 | Why Your Multi-Agent System Is Failing: Escaping the 17x Error Trap | Towards Data Science | 2025 | https://towardsdatascience.com/why-your-multi-agent-system-is-failing-escaping-the-17x-error-trap-of-the-bag-of-agents/ | Independent MAS amplifies errors 17.2x; centralized architecture reduces to 4.4x |
| 28 | Multi-Agent LLMs: A Comprehensive Guide for 2025 | SuperAnnotate | 2025 | https://www.superannotate.com/blog/multi-agent-llms | Industry overview of multi-agent patterns and use cases |
| 29 | Efficient Context Management for Coding Agents | JetBrains Research | 2025 | https://blog.jetbrains.com/research/2025/12/efficient-context-management/ | Coding agents accumulate noise during exploration that degrades output |
| 30 | The Growing Challenge of Auditing Agentic AI | ISACA | 2025 | https://www.isaca.org/resources/news-and-trends/industry-news/2025/the-growing-challenge-of-auditing-agentic-ai | Agent decision-making lacks traceability; audit trails critical |
| 31 | Code in Harmony: Evaluating Multi-Agent Frameworks for SE | — | OpenReview 2024 | https://openreview.net/pdf?id=URUMBfrHFy | Comparison of ChatDev, MetaGPT, and others on SE quality metrics |
| 32 | MAS Historically Outperforms SAS, But Loses Edge as LLMs Grow | ICLR 2025 Workshop | 2025 | https://openreview.net/pdf?id=0iLbiYYIpC | 4-220x more prefill tokens; MAS advantage diminishes with model capability |

### Cited in Sections

**Section 1 (Role Separation):** [5] MetaGPT, [6] ChatDev, [15] HyperAgent, [13] Rethinking Bounds, [8] Scaling Agent Systems, [2] DoT/MAD

**Section 2 (Token Efficiency):** [22] Anthropic Multi-Agent, [32] ICLR Workshop, [6] ChatDev costs, [10] OPTIMA, [11] SupervisorAgent

**Section 3 (Context Windows):** [1] Lost in the Middle, [24] Context Rot, [29] JetBrains, [22] Anthropic

**Section 4 (Cross-Agent Review):** [2] DoT/MAD, [3] Du et al. Debate, [4] Mixture-of-Agents, [9] More Agents, [7] Self-Refine, [19] Triem & Ding

**Section 5 (Audit Trail):** [20] OpenAI Governing, [30] ISACA

**Section 6 (Downsides):** [8] Scaling Agent Systems, [32] ICLR Workshop, [13] Rethinking Bounds
