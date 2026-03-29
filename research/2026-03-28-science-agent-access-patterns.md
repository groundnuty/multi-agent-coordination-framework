# Research Question: Optimal Access Patterns for the Science-Agent

Date: 2026-03-28
Context: The science-agent needs to make informed decisions (file good issues, review PRs accurately) without drowning its context in code/paper artifacts. What access pattern balances information quality with context efficiency?

---

## The Fundamental Tension

```
More access → More informed → Bigger context → Worse reasoning
Less access → Cleaner context → Better reasoning → Less informed
```

This is not a binary choice. There's a spectrum of access patterns, each with different context costs and information quality.

### The Science-Agent's Core Value

The science-agent's value comes from its REASONING — connecting experiment results to research questions, identifying patterns across tasks, designing methodology, catching scientific errors in implementation. This reasoning lives in its context window.

Every token of code or LaTeX that enters the context DISPLACES research reasoning tokens. If the context fills with `src/merge/strategy.ts` contents, there's less room for "F27 implies that default lenses work better because ISO dimensions are more orthogonal than task-specific ones."

### The Evidence from CPC

| Metric | Value | Interpretation |
|---|---|---|
| Context growth | 4.25x per session | Science-agent's context grew significantly |
| Cache hit rate | 89.3% | Context was consistent — mostly research, not code |
| Issues with code references | ~70% | Science-agent frequently included implementation details |
| Clarification rounds | ~5% of issues | Very few — specs were clear |
| First-attempt PR success | ~99% (66/67) | Almost all PRs approved on first review |
| Post-compaction performance | Degraded | Needed hand-holding to re-learn patterns |

The high cache hit rate (89.3%) suggests the science-agent's context was MOSTLY research-focused. The code reads were targeted and temporary — they entered context, contributed to the issue, then got pushed out by subsequent research work. This is consistent with **Approach A (read-on-demand)** happening organically.

---

## Five Access Patterns

### Approach A: Read-on-Demand (Direct File Access)

**How it works**: Science-agent has full RO access to the code repo. It reads specific files only when needed for a particular task — filing an issue, reviewing a PR, or verifying an implementation claim.

```
Context timeline:
  [research... research... research...]
    ↓ need to file issue about merge strategy
  [research... research... + strategy.ts (5K tokens)]
    ↓ files issue with exact function references
  [research... research... + strategy.ts + issue reasoning]
    ↓ continues research work
  [research... research... + new_research...]
    ↓ strategy.ts pushed to middle/end of context (lower attention)
```

**Context cost per code read**: 2-20K tokens depending on file size. Temporary — gets pushed to low-attention zones by subsequent work.

**Pros**:
- Maximum information when needed
- Exact file paths, function names, line numbers in issues
- Can verify implementation details during PR review
- No extra infrastructure needed

**Cons**:
- Each read grows context permanently (until compaction)
- Multiple reads accumulate — 10 file reads = 50-200K of code in context
- Risk of "context contamination" — code artifacts diluting research reasoning
- The science-agent may read MORE than necessary (exploration creep)

**CPC evidence**: This is what happened in CPC. The 4.25x growth and ~70% code-referenced issues suggest targeted reads that accumulated over time.

**Best for**: Projects where the science-agent files infrequent but precise issues.

### Approach B: Subagent Exploration (Summary-Only)

**How it works**: Science-agent spawns a read-only `Explore` subagent to investigate the code. The subagent reads files in its OWN context window and returns a summary. Only the summary enters the science-agent's context.

```
Science-agent context:
  [research... research... research...]
    ↓ spawns Explore subagent: "How is debate configured in merge?"

    Subagent context (separate, disposable):
      [reads strategy.ts, prompt-builder.ts, config.ts, types.ts]
      [reasons about how debate works]
      [returns summary: "MergeConfigSchema in types.ts has no debateRounds.
       buildTeamLeadPrompt() in prompt-builder.ts hardcodes 3 rounds.
       Constitution is passed via teamLeadSystemPrompt."]

  [research... research... + 200-token summary]
    ↓ files issue with exact references (from summary)
  [research... research... + summary + issue reasoning]
```

**Context cost per exploration**: ~200-500 tokens (summary only). The full code (~20-50K) stays in the disposable subagent context.

**Pros**:
- Minimal context growth (~100x less than direct read)
- Science-agent gets the information it needs
- Subagent can explore broadly (read many files) without polluting science-agent's context
- Claude Code already supports this natively (`Explore` subagent type uses Haiku — fast and cheap)
- Multiple explorations don't compound context growth significantly

**Cons**:
- Lossy — the summary may miss details the science-agent would have noticed
- Latency — spawning a subagent takes a few seconds
- The science-agent can't "browse" the code interactively (has to formulate a question upfront)
- Summary quality depends on the subagent's capability

**CPC evidence**: Not tested in CPC. The science-agent read files directly. But the code-agent already uses subagents extensively.

**Best for**: Projects where the science-agent needs frequent code understanding without context pollution.

**Implementation**:
```markdown
# In science-agent's agent-identity.md rules:

## Understanding Code Before Filing Issues

When you need to understand the codebase before filing an issue, use an
Explore subagent instead of reading files directly:

    /explore How is [feature] implemented? Which files and functions are involved?

This keeps your context focused on research reasoning. Only the summary
enters your context, not the full code.
```

### Approach C: Code-Agent Writes Findings (Inverse Flow)

**How it works**: Instead of the science-agent pulling code context, the code-agent pushes summarized code knowledge as finding files. The science-agent reads findings, not code.

```
Code-agent (after implementing a feature):
  writes: findings/code/F_code_42.md
    "MergeConfigSchema now has debateRounds field (z.number, default 3).
     buildTeamLeadPrompt() passes config.debateRounds to advocates.
     Constitution is available via config.constitution."

Science-agent (when designing next experiment):
  reads: findings/code/F_code_42.md
  files issue based on code-level finding
```

**Context cost**: Same as reading a finding file (~200-500 tokens). But the finding is PRE-DIGESTED by the code-agent — it captures the RELEVANT implementation details, not the full file content.

**Pros**:
- Zero code in science-agent's context
- Code-agent knows which details matter (it just implemented it)
- Findings persist across sessions (survive compaction)
- Creates a code knowledge base that grows over time
- Bridges the "code access" question without science-agent reading code at all

**Cons**:
- Requires code-agent to write findings (extra work, ~5% more output tokens)
- Code-agent may not capture what the science-agent needs to know
- Stale findings — code may change after the finding was written
- Science-agent can't ask follow-up questions about the code (has to file another issue or wait for new findings)

**CPC evidence**: Not tested. CPC findings were research-oriented (F1-F123), not code-oriented.

**Best for**: Long-running projects where the codebase evolves significantly. The code findings serve as a changelog + knowledge base.

**Implementation**:
```markdown
# In code-agent's agent-identity.md rules:

## Writing Code Findings

After implementing a feature or fixing a bug, write a code finding:

    File: findings/code/F_code_<issue-number>.md
    Format:
      ### F_code_<N>: <one-line summary>
      **Files changed**: <list>
      **Key APIs/schemas affected**: <list>
      **How it works**: <2-3 sentences>
      **Constraints/gotchas**: <any non-obvious behavior>
```

### Approach D: Automated Code Digest

**How it works**: A scheduled hook or script generates a periodic "code state digest" — a structured summary of the codebase. The science-agent reads this ~2-5K token digest instead of the full code.

```
Code digest (auto-generated weekly or after each merge to main):

  ## Codebase Summary (claude-plan-composer-ts, 2026-03-28)

  ### Module Structure
  - src/types/ — Zod schemas (MergeConfigSchema, GenerateConfigSchema, ...)
  - src/generate/ — prompt building, auto-lenses, parallel runner
  - src/merge/ — 3 strategies (simple, subagent-debate, agent-teams)
  - src/evaluate/ — pre-merge evaluation
  - src/verify/ — post-merge verification (3 gates)
  - src/pipeline/ — orchestrator, config resolution, NDJSON logger
  - src/cli/ — Commander CLI

  ### Recent Changes (last 5 merges)
  - #332: Added debateRounds to MergeConfigSchema (configurable)
  - #330: DeepFRI v7 experiment with rich knowledge + question lenses
  - #328: Full harness merge (pairwise + 3 passes + 200 turns)

  ### Key Config Fields
  model, max_turns, strategy, refinement, holistic, debateRounds, blocklist

  ### Open Issues (code-agent label)
  none
```

**Context cost**: ~2-5K tokens, read once at session start or periodically.

**Pros**:
- Very low context cost
- Always up to date (auto-generated)
- Science-agent has architectural understanding without reading code
- No manual effort from either agent

**Cons**:
- Lossy — the digest can't capture everything
- May miss subtle implementation details that matter for specific issues
- Generating a good digest requires a script that understands the codebase
- Stale between updates (if not regenerated often enough)

**CPC evidence**: The MEMORY.md file partially serves this role — it has key config fields, running instructions, tech stack. But it's manually maintained by the agent, not auto-generated.

**Best for**: Large codebases where the science-agent needs architectural awareness but rarely needs function-level details.

**Implementation**:
```bash
# PostMerge hook or scheduled task
# Generates a code digest after each merge to main

#!/bin/bash
echo "## Codebase Summary ($(date +%Y-%m-%d))" > .code-digest.md
echo "" >> .code-digest.md

# Module structure
echo "### Modules" >> .code-digest.md
find src -maxdepth 1 -type d | while read dir; do
  count=$(find "$dir" -name "*.ts" | wc -l | tr -d ' ')
  echo "- $dir/ ($count files)" >> .code-digest.md
done

# Recent changes
echo "" >> .code-digest.md
echo "### Recent Changes (last 5 merges)" >> .code-digest.md
git log --oneline -5 --first-parent main >> .code-digest.md

# Key exports
echo "" >> .code-digest.md
echo "### Key Exports" >> .code-digest.md
grep "^export" src/index.ts >> .code-digest.md 2>/dev/null
```

### Approach E: No Code Access (Domain-Only)

**How it works**: Science-agent has zero access to the code repo. It works purely from domain knowledge, experiment results, and findings. Issues are domain-level descriptions.

```
Science-agent context:
  [research... research... research... (pure domain)]
    ↓ files issue: "The merge strategy should support configurable
       debate rounds with a sensible default"
  [research... research... (no code artifacts ever)]
```

**Context cost**: Zero code-related tokens. Maximum space for research reasoning.

**Pros**:
- Cleanest possible context — 100% research/domain
- No context contamination from code artifacts
- Longest effective context window for reasoning
- Simplest setup — no cross-repo access needed

**Cons**:
- Issues lack implementation specificity
- Code-agent may misinterpret domain-level specs
- More clarification rounds expected
- Cannot review PRs for correctness (only for domain accuracy)
- May file impossible or redundant issues (doesn't know what already exists)

**CPC evidence**: Not tested. CPC science-agent always had code access.

**Best for**: Early-stage projects where the architecture isn't settled, or when the science-agent's domain expertise is the primary value and implementation is straightforward.

---

## Comparative Analysis

### Context Cost per Task

Assume the science-agent files one issue requiring code understanding:

| Approach | Tokens added to context | Persists? | Cumulative (100 issues) |
|---|---|---|---|
| A: Read-on-demand | ~10K per file read | Yes (until compaction) | ~200K+ (accumulates) |
| B: Subagent exploration | ~300 (summary only) | Yes | ~30K |
| C: Code findings | ~300 (finding file) | Yes | ~30K |
| D: Code digest | ~3K (read once) | Yes (but doesn't grow) | ~3K (static) |
| E: No code access | 0 | N/A | 0 |

### Information Quality per Task

| Approach | Specificity | Accuracy | Staleness risk |
|---|---|---|---|
| A: Read-on-demand | Exact (line numbers, function names) | High (reads actual code) | Low (reads current state) |
| B: Subagent exploration | Good (summarized) | Good (subagent reads actual code) | Low (explores on demand) |
| C: Code findings | Good (curated by code-agent) | Medium (code-agent's interpretation) | Medium (finding may be stale) |
| D: Code digest | Overview only | Medium (auto-generated summary) | Medium (stale between updates) |
| E: No code access | Domain-level only | N/A | N/A |

### Expected Issue Quality

| Approach | Issue precision | Clarification rounds | First-attempt success |
|---|---|---|---|
| A: Read-on-demand | High (exact references) | Low (~5%) | High (~99%) |
| B: Subagent exploration | Good (summary-based) | Low (~10%) | High (~95%) |
| C: Code findings | Good (pre-digested) | Medium (~15%) | Good (~90%) |
| D: Code digest | Architectural | Medium (~20%) | Good (~85%) |
| E: No code access | Domain-level | High (~30%) | Medium (~75%) |

*Note: These are estimates based on CPC patterns and reasoning. Actual values would need experimental measurement.*

---

## The Hybrid Approach

The approaches are NOT mutually exclusive. The optimal pattern may combine them:

```
Default: Approach D (code digest)
  Science-agent has architectural awareness from a 3K token digest.
  Good for: routine issue filing, experiment design.

When filing complex issues: Approach B (subagent exploration)
  Science-agent spawns Explore subagent for specific questions.
  Good for: issues requiring exact function/file knowledge.

Continuously: Approach C (code findings from code-agent)
  Code-agent writes findings after each implementation.
  Good for: keeping science-agent informed about changes.

Never: Approach A (direct file read)
  Science-agent should NOT read code files directly.
  All code access goes through subagent or findings.
```

This hybrid gives:
- Low baseline context cost (3K digest)
- On-demand precision (300 token summaries from subagent)
- Continuous knowledge updates (findings from code-agent)
- No direct code pollution of research context

### Context Cost of Hybrid (100 issues)

```
Digest: 3K (read once)
Subagent explorations: ~20 explorations × 300 tokens = 6K
Code findings read: ~50 findings × 300 tokens = 15K
Total: ~24K tokens of code-related context

vs Approach A: ~200K+ accumulated code reads
vs Approach E: 0 (but 25+ clarification rounds × 2K each = 50K anyway)
```

The hybrid is cheaper than both reading code directly AND not reading it at all (because the clarification rounds in Approach E also cost tokens).

---

## Research Question: RQ11

**RQ11: What access pattern for the orchestrating agent produces the best issue quality with the least context growth in a multi-agent software development system?**

### Sub-questions:
- RQ11a: Does direct code reading (Approach A) produce measurably better issues than subagent exploration (Approach B)?
- RQ11b: Do code-agent-authored findings (Approach C) reduce the science-agent's need to read code?
- RQ11c: Is there a task complexity threshold below which no code access (Approach E) is sufficient?
- RQ11d: Does the hybrid approach (D+B+C) achieve comparable issue quality to full access (A) at lower context cost?

### Experimental Design

Use the DayTrader experiment (5 tasks × 3 reps) with additional conditions:

| Condition | Access pattern | Runs |
|---|---|---|
| B-A: Multi-agent, full RO access | Approach A (read-on-demand) | 5 × 3 = 15 |
| B-B: Multi-agent, subagent only | Approach B (explore subagent) | 5 × 3 = 15 |
| B-E: Multi-agent, domain only | Approach E (no code access) | 5 × 3 = 15 |

**Total additional runs**: 45 (on top of the base 30)
**Total experiment**: 75 runs

**This may be too large for a single paper.** Consider:
- Base paper: A (single) vs B-A (multi, full access) — 30 runs
- Follow-up paper: B-A vs B-B vs B-E — 45 runs, focused on access patterns

### Metrics

| Metric | How to measure | What it tells us |
|---|---|---|
| Issue word count | Characters / 4 | Spec verbosity |
| Code references per issue | Count file paths, function names | Spec precision |
| Science-agent context at issue filing | Effective input tokens on the API call | Context cost of preparation |
| Science-agent context growth per session | End / start effective input | Cumulative cost |
| Code-agent implementation time | Wall-clock from issue receipt to PR | How quickly agent understands spec |
| Clarification comments | Count back-and-forth before implementation | Spec ambiguity |
| First-attempt PR success | PR accepted on first review? | Spec completeness |
| Bugs caught in review | Substantive review findings | Review quality |

---

## For the Paper

### In the DayTrader experiment paper (if single access pattern):
"Our science-agent had read-only access to the code repository and filed issues with exact function names and file paths (Approach A: read-on-demand). The impact of this access pattern on issue quality is an open question — we did not isolate code access as an independent variable. Alternative approaches (subagent exploration, code findings, domain-only) may achieve comparable quality at lower context cost."

### As a standalone research contribution:
"We identify five distinct access patterns for orchestrating agents in multi-agent SE systems, ranging from full code access to domain-only. Through [controlled experiment / case study], we find that [the hybrid approach / subagent exploration] achieves [X]% of full-access issue quality at [Y]% of the context cost. This suggests that [conclusion about optimal access pattern]."

### As a design guideline:
"For practitioners setting up multi-agent coding systems: avoid giving the orchestrating agent direct file read access. Instead, use subagent exploration for on-demand code queries and code-agent-authored findings for continuous knowledge updates. This preserves the orchestrator's context for high-value reasoning while maintaining implementation awareness."

---

## Connection to Other Research Questions

| Related RQ | Connection |
|---|---|
| RQ2 (code access for issue quality) | RQ11 generalizes RQ2 — it's not just "yes/no code access" but "which access PATTERN" |
| RQ3 (asymmetric context) | Access pattern directly affects context size per agent role |
| RQ4 (findings improve performance) | Approach C tests whether code findings help the science-agent |
| RQ6 (orchestrator learning) | Access pattern affects what the orchestrator learns — code patterns vs domain patterns |
| RQ7 (delegate vs execute) | The orchestrator's code understanding affects its delegation quality |

---

## References

| Paper | Relevance | URL |
|---|---|---|
| Sculptor (Li et al., 2025) | Active context management — agents controlling what's in their context | https://arxiv.org/abs/2508.04664 |
| Lost in the Middle (Liu et al., 2023) | Information in middle of context gets less attention | https://arxiv.org/abs/2307.03172 |
| Context Rot (Chroma, 2025) | All models degrade with context length | https://www.trychroma.com/research/context-rot |
| Engram (Karimi et al., 2026) | Research Digest as external knowledge | https://arxiv.org/abs/2603.21321 |
| Anthropic Context Engineering (2025) | Context management as key agent skill | https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents |
| Claude Code Sub-Agents docs | Explore subagent for read-only code exploration | https://code.claude.com/docs/en/sub-agents |
| LOCA-bench (Zeng et al., 2026) | Context growth benchmark for agents | https://arxiv.org/abs/2602.07962 |
| De Araujo et al. (2025) | Persona fidelity degrades over long dialogues | https://arxiv.org/abs/2512.12775 |
