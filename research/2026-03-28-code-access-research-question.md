# Research Question: Does the Science-Agent Need Code Access?

Date: 2026-03-28
Status: Open question — not yet tested experimentally
Context: Observed in CPC multi-agent system. Science-agent had access to the code repo and filed issues with exact function names, file paths, and schema definitions. But was this necessary?

---

## The Observation

In the CPC project, the science-agent worked from the paper repo (`claude-plan-composer-paper`) but filed issues on the code repo (`claude-plan-composer`). Its issues contained precise code references:

**Example — Issue #332 (Multi-Round Debate):**
```
Add a new field to MergeConfigSchema:
debateRounds: z.number().min(1).max(10).default(3),
In buildTeamLeadPrompt(), use config.debateRounds instead of hardcoded value
```

**Example — Issue #244 (Lens Ablation):**
```
Save ALL artifacts to:
eval/experiments/star-pipeline-opus-ablation/
```

**Example — Issue #145 (Context Protection):**
```
Add blocklist field to GenerateConfigSchema
Validate in generateVariants() before starting sessions
```

The science-agent referenced specific Zod schemas (`MergeConfigSchema`, `GenerateConfigSchema`), specific functions (`buildTeamLeadPrompt()`, `generateVariants()`), specific file paths, and specific data structures. These are implementation-level details, not domain-level requirements.

## The Question

**Did the science-agent's code access make it a better issue reporter, or would domain-level descriptions have been sufficient?**

This matters because:
1. Code access costs context tokens — every `gh api` call or file read to understand the codebase consumes the science-agent's 1M window
2. If domain-level specs are sufficient, the science-agent can stay purely in the research/domain context without code pollution
3. For the paper-writing case: does the writing-agent need to read `main.tex` before getting issues, or can the science-agent describe changes at a structural level?

## Hypotheses

### H1: Code Access Produces Better Issues (Code-Aware Advantage)

**Claim**: When the science-agent reads the code before filing an issue, the resulting issue is more precise, leading to:
- Faster implementation by code-agent (less exploration needed)
- Fewer misunderstandings (exact function/file names eliminate ambiguity)
- Fewer back-and-forth clarification rounds
- Higher first-attempt success rate

**Supporting evidence from CPC**:
- 80% of issues were implemented on first attempt with no clarification questions
- Code-agent rarely asked "which file?" or "which function?" — the issue already specified
- Issue #332 had exact schema field definitions — code-agent could copy-paste
- The 2-comment pattern (PR ready → LGTM) suggests issues were unambiguous

**Mechanism**: The science-agent acts as a "bilingual translator" — it understands both the domain (research methodology, experimental design) AND the implementation (TypeScript, Zod, Claude Agent SDK). This dual knowledge produces issues that are precise at both levels.

**Cost**: The science-agent reads source files, accumulating code artifacts in its context window. This displaces research reasoning context. In CPC, the science-agent had 4.25x context growth, partly from reading code.

### H2: Domain-Level Specs Are Sufficient (Code-Aware Unnecessary)

**Claim**: A well-written domain-level spec is sufficient for a capable code-agent. The code-agent's job is to find the right files and make the right changes — it doesn't need the science-agent to do that exploration for it.

**Example — what the issue could have been without code access:**

Issue #332 as domain-only:
```
The agent-teams merge strategy should support configurable multi-round debate.
Currently debate rounds are hardcoded. Make them configurable with a sensible default.
Pass the merge constitution to teammates so they can reference quality dimensions.
```

vs what the science-agent actually wrote (with code access):
```
Add a new field to MergeConfigSchema:
debateRounds: z.number().min(1).max(10).default(3),
In buildTeamLeadPrompt(), use config.debateRounds instead of hardcoded value
```

**The domain-only version** describes WHAT to do. The code-aware version describes HOW to do it. The question is: does the code-agent need the HOW, or can it figure it out?

**Supporting argument**: The code-agent already has full code access. It can `grep` for "debate" or "rounds" and find the right places. A domain-level spec might actually be better because it doesn't over-specify implementation details that the code-agent might handle differently (and perhaps better).

**Counter-argument**: In CPC, when issues were less precise (early issues before science-agent learned the codebase), the code-agent sometimes implemented the wrong thing or needed clarification. The precise issues later in the project correlated with fewer errors.

### H3: It Depends on Task Complexity

**Claim**: Simple tasks don't benefit from code-aware specs. Complex tasks do.

| Task Type | Code access value | Why |
|---|---|---|
| Simple (add a config field) | Low — code-agent finds the right file in seconds | Over-specification wastes science-agent's context |
| Medium (refactor a module) | Medium — knowing which files to touch saves exploration | But code-agent can use `grep` and `find` |
| Complex (extract a microservice) | High — architecture decisions need cross-file understanding | Wrong decomposition is expensive to fix |

**For DayTrader T3 (extract quotes microservice)**: The science-agent knowing that `QuoteDataBean` is in `daytrader-ee7-ejb/src/.../impl/` and is called from `TradeAction.java` would produce a much better issue than "extract the quotes functionality."

**For DayTrader T1 (add health check)**: Specifying "add `HealthCheckResource.java` to the web module" vs "add a health check endpoint" — the code-agent can figure out the second just as well.

### H4: Code Access Has Diminishing Returns Over Time

**Claim**: Early in a project, code-aware specs are very valuable (the code-agent doesn't know the codebase). Later, the code-agent has learned the codebase from previous tasks and domain-level specs are sufficient.

**Supporting evidence from CPC**:
- Early issues (Mar 17-18) had more clarification rounds
- Later issues (Mar 23-27) were almost always LGTM on first attempt
- But this could also be because the science-agent got better at writing specs, not because the code-agent learned the codebase

**Confound**: Both agents improved over time. Hard to separate "science-agent writes better specs" from "code-agent knows the codebase better" without controlled experiment.

---

## Parallel Question: Paper Writing

The same question applies to the paper-writing flow:

### Does the science-agent need to read `main.tex` to file good writing issues?

**Code-aware equivalent** (science-agent reads the LaTeX):
```
In Section 4.2 (lines 340-355), the RQ1 results paragraph
claims 15x overhead. Replace with our measured 1.18x.
The table on line 362 needs a "Variance" column.
Reframe the paragraph to lead with the counterintuitive finding.
```

**Domain-only equivalent** (science-agent doesn't read LaTeX):
```
The RQ1 results section should present our 1.18x overhead finding
as the headline. Include variance data. Frame it as challenging
the 4-15x assumption from literature.
```

The domain-only version is arguably better for a writing-agent — it describes the INTENT, letting the writing-agent decide HOW to implement it in LaTeX. But the code-aware version prevents the writing-agent from editing the wrong section or missing the table.

---

## Experimental Design (Future Work)

### Experiment: Code Access Ablation

Add a third condition to the DayTrader experiment:

| Condition | Science-agent access | Issue style |
|---|---|---|
| A: Single-agent | N/A (no science-agent) | Task description only |
| B1: Multi-agent, code-aware | Reads DayTrader source | Exact file paths, function names |
| B2: Multi-agent, domain-only | NO code access | Domain-level requirements only |

**Measurements**:
- Issue precision: count specific file/function references per issue
- Implementation time: wall-clock from issue creation to PR
- Clarification rounds: number of back-and-forth comments
- First-attempt success rate: PR accepted on first review?
- Error rate: bugs caught in review
- Science-agent context cost: tokens spent reading code (B1 only)

**Runs**: 5 tasks × 3 conditions × 3 reps = 45 runs (15 more than the base experiment)

### Experiment: Paper Writing Access Ablation

| Condition | Science-agent reads paper? | Issue style |
|---|---|---|
| W1: Paper-aware | Reads `main.tex` before filing | Line-specific instructions |
| W2: Domain-only | Only has research context | Structural/intent-based instructions |

**Measurements**:
- Writing-agent implementation time
- Science-agent review findings (did it catch location errors?)
- Edit precision (did writing-agent change the right section?)
- Science-agent context growth (how much did paper reading cost?)

---

## CPC Evidence Summary

From the CPC interaction data:

| Metric | Value | Interpretation |
|---|---|---|
| Issues with exact code references | ~70% (estimated from samples) | Science-agent frequently included implementation details |
| Clarification rounds | ~5% of issues had any | Very few — suggests specs were clear |
| First-attempt success | ~80% (66/67 PRs approved first review) | High — but was this from code access or from simple tasks? |
| Science-agent context growth | 4.25x per session | Partly from reading code files |
| Science-agent cache hit rate | 89.3% | High — suggests code reads were consistent/cached |

**The honest answer**: We don't know if the code access caused the high success rate. It could be that:
1. The tasks were simple enough that domain-level specs would have worked
2. The code-agent is capable enough to find things without guidance
3. The code access only mattered for the complex tasks (and we had few of those)

This is why it needs a controlled experiment.

---

## Implications for System Design

### If H1 is true (code access helps):
- Science-agent should have read access to the code repo
- The context cost is justified by fewer errors and faster implementation
- Design: cross-repo read access, like CPC had

### If H2 is true (domain-only is sufficient):
- Science-agent can stay purely in its domain context (paper, research)
- Code access is wasted context that displaces research reasoning
- Design: strict separation, no cross-repo access

### If H3 is true (depends on complexity):
- Simple tasks: domain-only specs
- Complex tasks: science-agent reads code before filing
- Design: science-agent decides per-task whether to read code (adaptive)

### If H4 is true (diminishing returns):
- Early in project: code-aware specs
- Later: domain-only as code-agent has learned the codebase
- Design: science-agent starts code-aware, transitions to domain-only

---

## For the Current Paper

This is **future work**, not a contribution of the current paper. In the paper, we should:

1. **Acknowledge** that the science-agent had code access and this may have contributed to issue quality
2. **Report** the evidence: 80% first-attempt success, ~5% clarification rate, code references in ~70% of issues
3. **Frame as open question**: "Whether code access is necessary for effective cross-agent issue quality remains untested. Our science-agent filed issues with exact function names (e.g., #332 referencing `MergeConfigSchema`), but we did not isolate this variable."
4. **Propose** the ablation experiment (B1 vs B2) as future work

---

## Connection to Other Research Questions

This question connects to several themes in the literature:

### Task Decomposition Quality
Huang et al. (2024) survey identifies "task decomposition" as a primary planning category. The quality of decomposition (how detailed, how implementation-specific) is known to affect execution. But nobody has studied whether the PLANNER needs implementation access to decompose well.

Source: https://arxiv.org/abs/2402.02716

### The "Telephone Game" Effect
MetaGPT (Hong et al., 2023) found "cascading hallucinations caused by naively chaining LLMs." More detailed specs should reduce hallucination cascading — but at what context cost?

Source: https://arxiv.org/abs/2308.00352

### LATM (LLMs as Tool Makers)
Cai et al. (2023) showed that a powerful model can create tools for a lighter model. The "tool" in our case is the issue spec. Does the powerful model (science-agent) need to understand the execution environment (code) to create good "tools" (specs)?

Source: https://arxiv.org/abs/2305.17126

### Degeneration-of-Thought in Specification
Liang et al. (2023) showed single agents can't self-correct. But does a SEPARATE agent need to understand the implementation to provide effective correction? Or can it correct purely from domain knowledge?

Source: https://arxiv.org/abs/2305.19118

### Context Engineering
Anthropic's "Effective Context Engineering" (2025) argues that context management is the key skill for agent builders. The code-access question is fundamentally about context engineering: what belongs in the science-agent's context and what doesn't?

Source: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
