# Orchestrator-Worker Pattern for Code-Agent

Date: 2026-03-28
Context: Design analysis for improving the code-agent's context efficiency while preserving accumulated workflow knowledge.

---

## The Problem

Two competing needs for the code-agent:

1. **Long-term learning**: Over a session, the code-agent learns how the codebase works, how experiments run, what edge cases exist. This knowledge makes it more effective over time. After compaction, this degrades — the human had to hand-hold the agent to re-learn patterns.

2. **Context efficiency**: The code-agent's context grows to 966K tokens mainly from stale tool output (old test results, build logs, file reads). 73.5% of input tokens could be saved by keeping context smaller.

These are in tension: fresh context is cheap but loses learning. Large context preserves learning but is expensive.

## The Proposed Pattern

Split the code-agent into two roles running in the same session:

```
Code-Agent (orchestrator, 1M window, long-lived):
  ├── Reads issues from science-agent
  ├── Learns workflow patterns over time
  ├── Translates research specs into implementation specs
  ├── Delegates work to fresh workers via TeamCreate
  ├── Reviews worker output
  ├── Handles PR creation, communication, merge
  └── Accumulates orchestration knowledge (not execution artifacts)

Worker Subagent (fresh context, disposable):
  ├── Receives detailed spec from orchestrator
  ├── Gets dedicated git worktree
  ├── Executes the implementation
  ├── Reports results back to orchestrator
  └── Dies after task completion
```

The code-agent becomes a **middle manager** between the science-agent (domain expert) and disposable workers (executors).

## Why This Is Better Than Alternatives

### vs. Fresh Context Per Issue

| Aspect | Fresh per issue | Orchestrator + Workers |
|---|---|---|
| Workflow learning | Lost on every restart | Preserved in orchestrator's 1M window |
| Per-task context cost | Low (42K-80K) | Low (worker gets fresh context) |
| Spec quality | Depends entirely on rules/hooks | Orchestrator writes specs from experience |
| Edge case handling | Re-learns every time | Orchestrator remembers from past tasks |
| Complex multi-step tasks | Needs continuity hack | Orchestrator coordinates across steps |
| Session startup cost | 42K tokens + hook overhead per issue | Once for orchestrator, minimal per worker |

### vs. Current (Both at 1M, No Delegation)

| Aspect | Current 1M | Orchestrator + Workers |
|---|---|---|
| Context growth | 1.48x → up to 966K from stale artifacts | Orchestrator grows slowly (no execution artifacts); workers stay fresh |
| Token efficiency | Baseline (3.2B input tokens) | ~70-80% reduction on execution input |
| Compaction impact | Loses workflow knowledge + stale artifacts together | Orchestrator rarely compacts (small context); workers never compact (too short) |
| Parallelism | Can use TeamCreate but main agent accumulates artifacts | Main agent stays clean; all execution is delegated |

### vs. 200K Context Cap

| Aspect | 200K cap | Orchestrator + Workers |
|---|---|---|
| Workflow learning | Compacts frequently, loses learning | Orchestrator at 1M, rarely compacts |
| Context efficiency | Good (73.5% savings) | Better (workers are fresh, orchestrator stays lean) |
| Compaction quality | Must preserve both learning AND current task | Orchestrator only holds orchestration context (easier to compact well) |

## What the Orchestrator Holds in Context

The orchestrator's context accumulates **orchestration knowledge**, not execution artifacts:

### Valuable context (worth preserving):

- **Workflow patterns learned over time**: "when running experiments, always check that `eval/configs/` has the right model ID first"
- **Edge cases discovered**: "agent-teams strategy fails silently if maxTurns < 120"
- **Science-agent communication patterns**: "when science-agent says 'run v8', it means use the standardized config template"
- **Build system quirks**: "devbox sometimes needs `make -f dev.mk install` before `check`"
- **Git workflow lessons**: "always pull main before branching, always use `git -c url.insteadOf` for push"
- **Issue resolution history**: "issues like #244 need baseline verification before running ablation"

### What the orchestrator does NOT accumulate:

- Test output (delegated to worker)
- Build logs (delegated to worker)
- File contents being edited (delegated to worker)
- `cpc generate/merge/verify` output (delegated to worker)
- Large `gh` command responses (delegated to worker)

This means the orchestrator's context grows from **issue specs + worker summaries + communication**, not from execution artifacts. Estimated growth rate: much slower than current 1.48x, possibly staying under 200K for entire sessions.

## What the Worker Receives

The orchestrator writes a detailed, self-contained spec for each worker. This is the critical interface — the spec must be good enough for a "stupid" agent with zero context to execute perfectly.

### Spec Template (what the orchestrator would produce):

```markdown
## Task: [Issue title]

### Setup
1. You are in a git worktree at `.worktrees/<branch>/`
2. Run: `make -f dev.mk install` (installs dependencies)
3. Verify: `node --version` should show v22+

### Implementation
[Exact steps, file paths, code changes]

### Verification
1. Run: `make -f dev.mk check` — must pass (build + lint + 891 tests)
2. Run: [task-specific verification]
3. Expected output: [exact expected result]

### Artifacts to Save
- [List of files/directories that must be committed]

### Git
1. Stage: `git add [specific files]`
2. Commit: `git commit -m "Fix #<N>: <description>"`
3. Push: `git -c url."https://x-access-token:${GH_TOKEN}@github.com/".insteadOf="https://github.com/" push -u origin <branch>`

### Report Back
Tell me: pass/fail, any unexpected issues, paths to artifacts.
```

### Why "Assume the Worker Is Stupid" Works

The orchestrator has accumulated knowledge about:
- Which `make` targets to use (learned from feedback: "always use Makefile")
- What verification looks like for different task types
- What artifacts experiments produce and where they go
- Common failure modes and how to handle them

A fresh worker doesn't know any of this. But the orchestrator's spec encodes it all into explicit, step-by-step instructions. The learning is preserved in the orchestrator and transmitted to workers via detailed specs.

This is analogous to how a senior developer writes detailed tickets for junior developers — the senior's experience is encoded in the ticket quality, not in the junior's head.

## Context Growth Comparison

### Current Code-Agent (single role, 1M)

```
Session start:          42K tokens (rules + AGENTS.md)
After 1st issue:       ~80K (read issue + files + test output)
After 5th issue:      ~200K (accumulated stale artifacts)
After 20th issue:     ~500K (growing, compaction events start)
After 50th issue:     ~800K (near 1M, frequent compaction, learning degraded)
End of long session:  ~966K (maxed out, heavy compaction, hand-holding needed)
```

### Proposed Orchestrator (orchestration only, 1M)

```
Session start:          42K tokens (rules + AGENTS.md)
After 1st issue:       ~50K (read issue + wrote worker spec + reviewed summary)
After 5th issue:       ~70K (5 issue specs + 5 summaries, all small)
After 20th issue:     ~120K (learning accumulating, still compact)
After 50th issue:     ~180K (lots of learned patterns, still under 200K)
After 100th issue:    ~250K (may compact once, preserving recent learning)
End of long session:  ~300K (well within 1M, rarely compacts, learning intact)
```

### Workers (fresh per task)

```
Startup:               ~30K (minimal — rules + spec from orchestrator)
Peak during task:      ~60-100K (reads files, runs tests, edits code)
End of task:           dies (context freed)
```

### Estimated Token Savings

```
Current orchestrator+execution in one agent:
  100 issues × 100 calls/issue × 320K avg context = 3.2B tokens

Proposed orchestrator + fresh workers:
  Orchestrator: 100 issues × 20 calls/issue × 150K avg = 300M tokens
  Workers: 100 issues × 80 calls/issue × 65K avg = 520M tokens
  Total: 820M tokens

SAVINGS: 3.2B - 820M = 2.38B tokens (74.4%)
```

## The Compaction Asymmetry

### Science-agent compaction (painful, lossy):

Science-agent holds cumulative research reasoning in context:
- "F27 says default lenses beat task-specific, which connects to F85's finding about rationale amplification, which means our paper framing should emphasize the knowledge dimension..."

This chain of reasoning is IN THE CONTEXT, not in any file. Compaction loses intermediate reasoning steps. The agent can re-read files but can't reconstruct the synthesis.

### Orchestrator compaction (manageable, targeted):

The orchestrator holds workflow patterns:
- "For experiment issues, always verify config with `cpc doctor` first"
- "Science-agent's 'v8' notation means standardized config template"

These patterns are more declarative and less dependent on reasoning chains. They could potentially be saved to memory files via PreCompact hooks, making compaction even safer.

### Worker compaction (never happens):

Workers live for one task (typically 30-60 minutes, 80-100 API calls). They never reach compaction threshold. This is the key efficiency — the heavy execution work (the part that fills context with stale artifacts) happens in disposable contexts.

## The Evolution Argument

The user observed that agents evolved beyond initial rules:
- Code-agent adopted TeamCreate for parallel work
- Code-agent learned git worktree patterns
- Science-agent learned to add follow-up specs while code-agent is offline
- Both agents developed memory files from user feedback

With the orchestrator pattern, this evolution is preserved in the orchestrator's 1M window AND transmitted to workers via improving specs. Over time:

1. **Orchestrator learns** what makes good worker specs (from failures and feedback)
2. **Specs get better** with each iteration (orchestrator encodes learning)
3. **Workers execute more reliably** (better specs = fewer failures)
4. **Human intervention decreases** (orchestrator handles edge cases it's seen before)

With fresh-per-issue, this evolution would be lost on every restart. The agent would start from scratch, relying entirely on static rules — which we've shown are followed only ~80% of the time.

## Comparison with Industry Patterns

### MetaGPT (Hong et al., ICLR 2024)

MetaGPT uses a similar pattern: Product Manager → Architect → Engineer, where each role has a specialized context. The Architect writes detailed specs for the Engineer, similar to our orchestrator writing specs for workers. MetaGPT found this reduced "cascading hallucinations" because each agent operates within its competence.

Source: https://arxiv.org/abs/2308.00352

### Anthropic Multi-Agent Research System (2025)

Anthropic's system achieved 90% improvement by "spreading reasoning across multiple independent context windows, with subagents enabling the kind of scaling that a single agent cannot achieve." The subagents (analogous to our workers) have fresh contexts focused on specific sub-tasks.

Source: https://www.anthropic.com/engineering/multi-agent-research-system

### Google DeepMind "Centralized" Topology (2025)

The Google/MIT study found the Centralized topology (one orchestrator, multiple workers) to be the best-performing multi-agent architecture, with error amplification of only 4.4x vs 17.2x for independent agents. The orchestrator catches and corrects worker errors.

Source: https://arxiv.org/abs/2512.08296

### Claude Code's Own TeamCreate

Claude Code already implements this pattern natively with TeamCreate:
- Main agent spawns workers with `TeamCreate`
- Workers get dedicated git worktrees
- Workers report back via `SendMessage`
- Main agent reviews and merges

We're proposing to make this the default execution model, not an exception.

## Risks and Mitigations

### Risk 1: Spec Quality

If the orchestrator writes a bad spec, the worker fails. Wasted tokens.

**Mitigation**: The orchestrator learns from failures. After a worker reports a problem, the orchestrator adjusts future specs. Over time, specs improve. Additionally, the orchestrator can include verification steps in the spec ("if `make check` fails, report the first 20 lines of error output and stop").

### Risk 2: Orchestrator Context Still Grows

Even with only orchestration context, the orchestrator may eventually approach 1M.

**Mitigation**: Orchestration context grows much slower (~2K per issue vs ~30K per issue with execution). At 100+ issues, it might reach 250-300K — well within 1M. For extremely long sessions, PreCompact hooks can save learned patterns to memory files.

### Risk 3: Worker Startup Overhead

Each worker needs TeamCreate setup + worktree creation + dependency install.

**Mitigation**: Worktree creation is fast (~2 seconds). Dependencies can be symlinked from the main worktree (Claude Code's `symlinkDirectories` setting supports this — symlink `node_modules`). The overhead per worker is estimated at ~30 seconds and ~30K tokens — negligible compared to the 2.4B tokens saved.

### Risk 4: Communication Overhead Between Orchestrator and Worker

The orchestrator writes specs and reads summaries. This is additional output/input.

**Mitigation**: Spec is ~500-1000 tokens. Summary is ~200-500 tokens. Per issue: ~1.5K tokens of communication. Over 100 issues: 150K tokens. This is 0.005% of the 3.2B tokens saved — negligible.

### Risk 5: Loss of Direct File Context in Orchestrator

The orchestrator doesn't read source files directly (workers do). It might make wrong decisions about implementation approach.

**Mitigation**: The orchestrator can read files if needed — it's not forbidden from execution, just defaults to delegation. For complex architectural decisions, the orchestrator reads the relevant files, makes the decision, then delegates implementation. This is the senior developer pattern: "I'll review the code to decide the approach, but I'll have the junior implement it."

## Summary

| Layer | Context | Lifetime | Grows With | Cache Efficiency |
|---|---|---|---|---|
| Science-agent | 1M | Long session | Research reasoning (cumulative) | 89.3% (consistent) |
| Code-agent orchestrator | 1M | Long session | Workflow patterns (slow) | High (small, consistent) |
| Worker subagent | Fresh (~30K start) | One task | Execution artifacts (fast but disposable) | N/A (too short to matter) |

**Projected savings**: ~74% reduction in code-agent input tokens (~2.4B tokens) while preserving workflow learning. No quality loss — workers get better specs over time because the orchestrator accumulates experience.

**Implementation complexity**: Low — the code-agent already uses TeamCreate. The change is making delegation the default, not the exception, and writing better worker specs.
