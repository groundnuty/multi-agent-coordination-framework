# Findings as Externalized Memory: A Knowledge Production Pattern for Multi-Agent Systems

Date: 2026-03-28
Context: Observed in the CPC multi-agent system. The science-agent wrote individual finding files (F1-F123) that became the raw material for both code improvements and paper writing. This pattern is potentially a distinct contribution.

---

## The Observed Pattern

In the CPC project, the science-agent developed a practice of writing individual "finding" files — one per discovery:

```
paper-repo/
  ase-2026-rt/
    new-findings/
      session-2026-03-20-v2-no-papers.md      ← F1-F5
      session-2026-03-20-operational.md        ← F6-F8
      session-2026-03-20-filip-eval.md         ← F9-F14
      session-2026-03-20-post-merge-critique.md ← F15, F15b
      session-2026-03-20-deepfri-v3.md         ← F16-F20
      session-2026-03-20-tool-evolution.md     ← F21-F24
      ...continued across sessions...          ← F25-F123
```

Each finding has a structured format:
```markdown
### F27: Default ISO lenses outperform task-specific without papers

**Task**: STAR pipeline
**Condition**: v2-no-papers (task-specific lenses) vs v1 (default ISO lenses)
**Result**: Default lenses +8.5/50 over task-specific when no domain papers available
**Implication**: Lens selection is context-dependent. The "auto_lenses" feature
  should consider available knowledge base, not just task description.
**Evidence**: eval/experiments/star-pipeline-opus-v2-no-papers/judges/
```

Over 11 days, the science-agent accumulated **123 findings** across 50+ files.

---

## How Findings Flowed Through the System

### Step 1: Science-agent discovers a finding

During experiment analysis or paper reading, the science-agent notices something interesting. It writes a finding file immediately — capturing the insight while context is fresh.

```
Science-agent context: [experiment results + prior findings + domain knowledge]
  → Insight emerges
  → Writes F27 to disk
  → Context may compact later, but F27 survives on disk
```

### Step 2: Findings drive code issues

The science-agent reads accumulated findings and identifies tool improvements:

```
F12 ("LLMs excel at engineering, struggle at science")
  + F17 ("Context protection fails for adversarial lenses")
  → Issue #239: "Fix context protection for adversarial lenses"
```

Multiple findings synthesize into a single actionable issue. The code-agent implements the fix without needing to understand the research reasoning behind it.

### Step 3: Findings drive paper content

The science-agent (or future writing-agent) reads findings to write paper sections:

```
F27 ("Default lenses outperform task-specific")
  + F120 ("Context 43%, diversity 57%")
  + F118 ("IDP specificity reversal — lens coverage gap")
  → Paper Section 4.2: RQ2 results on lens selection
```

The writing-agent doesn't need the full experiment context — it reads the finding files, which are pre-digested, structured summaries.

### Step 4: Findings survive context compaction

This is the critical benefit. When the science-agent's context compacts:
- Experiment details are lost from context
- Reasoning chains are truncated
- But all findings are ON DISK as markdown files
- The agent can re-read F1-F123 to reconstruct its understanding
- Re-reading is cheaper than re-reasoning

```
Before compaction: [full experiment context + reasoning + finding]
After compaction:  [compressed summary]
Recovery:          [read F27.md from disk → finding is back in context]
```

### Step 5: Findings index enables navigation

The science-agent maintained a `project_new_findings_index.md` memory file indexing all findings:

```markdown
### F115-F123 (session 2026-03-26):
- F115: Policy B > Policy A (rationale-only beats solution code)
- F116: V8 cross-task — Likert stable, specificity inversely correlates
- F117: Piotrek v8 = 100%. Value decomposition confounded by config changes.
...
```

This index is loaded at session start (via auto-memory), giving the agent a map of all discoveries without re-reading every finding file.

---

## What This Pattern Is

### Externalized Episodic Memory

In cognitive science, episodic memory stores specific experiences and events. The science-agent's finding files are externalized episodic memories — specific observations from specific experiments, timestamped, contextualized, and indexed.

Unlike the agent's working memory (context window), externalized findings:
- **Persist** across sessions and compaction events
- **Are structured** with consistent format (finding, task, condition, result, implication, evidence)
- **Are composable** — multiple findings can be synthesized into a new insight
- **Are shareable** — other agents can read them without the original context

### Knowledge Distillation from Context to Artifact

Each finding distills a large amount of context (experiment config + raw results + comparison tables + reasoning) into a compact artifact (~100-200 words). This is a form of lossy compression that preserves the INSIGHT while discarding the EVIDENCE PATH.

```
Raw context: ~50K tokens (experiment config + results + reasoning)
  ↓ distillation
Finding file: ~500 tokens (structured summary with key numbers)

Compression ratio: ~100:1
```

The compression is intentional — the finding captures what matters for future decisions, not the full derivation.

### Incremental Knowledge Base

The 123 findings form a searchable, indexed knowledge base that grows monotonically — findings are added but never deleted or modified. This is different from:
- **Memory files** (which are updated/overwritten based on feedback)
- **Context window** (which compacts and loses information)
- **Git history** (which tracks code changes, not insights)

The findings knowledge base is the science-agent's equivalent of a lab notebook.

---

## Connection to Literature

### Engram: Research Digest Pattern

**Karimi et al. (Mar 2026)**: "Improving Coherence and Persistence in Agentic AI for System Optimization"
- Each agent iteration archives results into a compact "Research Digest"
- Subsequent fresh-context agents read the digest on startup
- Purpose: maintain coherence across iterations despite fresh contexts

**Our findings pattern is similar but different**:
- Engram: automated archival of optimization metrics (structured, numerical)
- Our findings: agent-authored narrative insights (semi-structured, qualitative)
- Engram: one digest file, updated each iteration
- Our findings: one file per discovery, monotonically growing collection
- Engram: designed for optimization loops
- Our findings: designed for research discovery and paper writing

Source: https://arxiv.org/abs/2603.21321

### Generative Agents: Memory Architecture

**Park et al. (Apr 2023)**: "Generative Agents: Interactive Simulacra of Human Behavior"
- Three-layer memory: experience → reflection → retrieval
- Reflections are higher-order insights synthesized from experiences
- Our findings are analogous to reflections — synthesized from experiment experiences

**Key difference**: Park's agents reflect automatically on a schedule. Our science-agent writes findings deliberately when it notices something significant. The human scientist's judgment drives the timing.

Source: https://arxiv.org/abs/2304.03442

### Claude Code Persistent Memory

**Claude Code auto-memory**:
- Agents can save memories to `~/.claude/projects/.../memory/`
- Memories persist across sessions
- Types: user, feedback, project, reference

**Our findings extend this**:
- Memories are about the AGENT's behavior (feedback, project status)
- Findings are about the DOMAIN's content (experiment results, scientific insights)
- Memories help the agent work better; findings help the agent KNOW more

Source: https://code.claude.com/docs/en/memory

### DSPy: Compiled Knowledge

**Khattab et al. (Oct 2023)**: "DSPy: Compiling Declarative Language Model Calls into Self-Improving Pipelines"
- Treats LLM pipelines as optimizable programs
- Automatically compiles demonstrations and instructions

**Connection**: Our findings are manually compiled knowledge — the science-agent's demonstrations of "what good analysis looks like." They could potentially be used as few-shot examples for future agents. But currently they're consumed as context, not as training data.

Source: https://arxiv.org/abs/2310.03714

### LATM: Knowledge as Reusable Artifacts

**Cai et al. (May 2023)**: "Large Language Models as Tool Makers"
- Powerful model creates reusable tools; lighter model uses them
- "Strategic division of labor allows the once-off cost of tool-making to be spread over multiple instances of tool-using"

**Connection**: Findings are reusable knowledge artifacts. The science-agent's "once-off cost" of analyzing an experiment produces a finding that can be used multiple times — by the code-agent (to fix a bug), by the writing-agent (to write a paper section), by the human (to steer research direction).

Source: https://arxiv.org/abs/2305.17126

### Sculptor: Active Context Management

**Li et al. (Aug 2025)**: "Sculptor: Empowering LLMs with Cognitive Agency via Active Context Management"
- Agents can actively hide, restore, and summarize context sections
- "Explicit context-control strategies are key to robustness at scale"

**Connection**: Writing findings to disk is a form of active context management — the agent deliberately externalizes knowledge that would otherwise be lost to compaction. It's a manual version of what Sculptor proposes to automate.

Source: https://arxiv.org/abs/2508.04664

---

## Why This Might Be Novel

### What exists:
- Automated memory systems (Generative Agents, Claude Code memory)
- Research digests for optimization (Engram)
- Prompt compilation (DSPy)
- Active context management tools (Sculptor)

### What doesn't exist (to our knowledge):
1. **Agent-authored structured findings as the primary knowledge transfer mechanism** between agents in a multi-agent system
2. **Findings as the interface between research and writing** — the science-agent produces findings, the writing-agent consumes them
3. **Monotonically growing, indexed finding collections** as externalized episodic memory for long-running research projects
4. **Empirical measurement of the findings pattern** — 123 findings across 50+ files, used to drive both 17 features and a research paper

### The novel contribution (if we claim it):
"We observe that in a multi-agent research-oriented software development system, one agent (the science-agent) naturally develops a practice of writing structured finding files as externalized memory. These findings serve three functions: (1) surviving context compaction, (2) driving code improvement issues, and (3) providing pre-digested content for paper writing. The findings act as a knowledge transfer medium between agents with different roles and contexts."

---

## Data from CPC

### Scale
- 123 findings across 11 days
- ~50 files in `new-findings/` directory
- ~11 findings per day average
- Findings referenced in 17 feature issues, 51 experiments, and all paper sections

### Finding Categories (from the index)

| Category | Findings | Example |
|---|---|---|
| Pipeline behavior | F1-F5, F15, F23, F24 | "Default lenses beat task-specific without papers" |
| Evaluation methodology | F9-F14, F121 | "LLM judges can't replicate expert evaluation" |
| Tool fixes needed | F17, F22, F236-F239 | "Context protection fails for adversarial lenses" |
| Cross-experiment patterns | F116, F120 | "Context 43%, diversity 57%" |
| Human eval insights | F12, F117, F122 | "Better but less creative" (Filip's quote) |
| Conceptual contributions | F15b, F23 | "Pipeline creates its own verification oracle" |

### How Findings Were Used

| Consumer | How they use findings | Example |
|---|---|---|
| Code-agent | Implements fixes for findings that identify bugs/limitations | F17 → Issue #239 (context protection fix) |
| Science-agent | Synthesizes findings into experiment designs | F27 + F120 → Issue #358 (ablation experiment) |
| Science-agent | Uses findings to frame paper narrative | F122 + F123 → Paper Discussion section |
| Writing-agent (future) | Converts findings into LaTeX paragraphs | F115-F123 → Section 4 results |
| Human | Reads findings to steer research direction | F121 → decision to add Tier 4 evaluator |

### Finding Quality

Not all findings were equally useful:
- **High impact** (~30): Directly changed the paper framing or drove features (F27, F120, F122, F123)
- **Medium impact** (~50): Supported existing claims with new data points
- **Low impact / noise** (~43): Operational observations that didn't generalize

The science-agent didn't curate — it wrote everything. The human curated by deciding which findings to act on.

---

## The Three-Layer Knowledge Architecture

```
Layer 1: Context Window (volatile)
  ├── Full reasoning chains
  ├── Raw experiment output
  ├── File contents, tool results
  └── LOST on compaction

Layer 2: Finding Files (persistent, append-only)
  ├── Structured insights (F1-F123)
  ├── Written by science-agent during analysis
  ├── Survives compaction
  ├── Readable by any agent
  └── Indexed in memory file

Layer 3: Memory Files (persistent, mutable)
  ├── Agent behavioral feedback
  ├── Project status snapshots
  ├── Workflow patterns
  └── Updated based on feedback
```

The findings layer sits between volatile context and long-term memory. It's **append-only** (findings are never updated, only new ones added), **domain-specific** (about the research, not about the agent), and **structured** (consistent format for machine and human readability).

---

## For the Paper

### If presenting as a contribution:
"We identify a naturally emerging pattern in multi-agent research systems: structured finding files as externalized episodic memory. In our system, the science-agent authored 123 findings over 11 days. These findings served as: (1) compaction-resistant memory, (2) cross-agent knowledge transfer medium, and (3) paper writing source material. We propose this as a reusable pattern for long-running multi-agent research projects."

### If presenting as future work:
"An unexpected observation was the science-agent's practice of writing structured finding files (123 over 11 days) that survived context compaction and served as knowledge transfer between agents. Formalizing this pattern and measuring its impact on cross-agent communication quality is future work."

### If presenting as related work connection:
"Our science-agent's finding files function similarly to Engram's Research Digest (Karimi et al., 2026) and Generative Agents' reflection memories (Park et al., 2023), but are agent-authored, domain-specific, and serve as the primary interface between research analysis and paper writing."

---

## Open Questions

1. **Should finding writing be enforced or emergent?** In CPC it emerged naturally. Should the agent-identity rules explicitly say "write a finding file for every significant observation"?

2. **What's the optimal finding granularity?** Some CPC findings were too granular (operational details), others too broad. Is there a sweet spot?

3. **Can findings be automatically generated?** After each experiment run, could a PostToolUse hook automatically extract key metrics into a finding template?

4. **Do findings improve agent performance?** If we compared a science-agent with finding files vs one without, would the one with findings make better decisions and write better issues?

5. **Is the pattern specific to research projects?** Would findings be useful in a pure software engineering context (bug investigation findings, architecture decision findings)?

---

## References

| Paper | Relevance | URL |
|---|---|---|
| Engram (Karimi et al., 2026) | Research Digest pattern — closest to our findings | https://arxiv.org/abs/2603.21321 |
| Generative Agents (Park et al., 2023) | Three-layer memory with reflections | https://arxiv.org/abs/2304.03442 |
| DSPy (Khattab et al., 2023) | Compiled knowledge from demonstrations | https://arxiv.org/abs/2310.03714 |
| LATM (Cai et al., 2023) | Knowledge as reusable artifacts | https://arxiv.org/abs/2305.17126 |
| Sculptor (Li et al., 2025) | Active context management | https://arxiv.org/abs/2508.04664 |
| Claude Code memory docs | Auto-memory for persistent agent knowledge | https://code.claude.com/docs/en/memory |
