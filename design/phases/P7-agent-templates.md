# P7: Agent Templates

**Goal:** Complete agent identity definitions for all roles, encoding the tribal knowledge from the CPC project.

**Depends on:** P5 (plugin packaging, where agents are bundled)
**Design decisions:** DR-008, DR-009

---

## Deliverables

Seven agent definition files for the plugin's `agents/` directory. Each defines:
- Agent identity (who am I)
- Workflow (how I work)
- Issue lifecycle (turn-based protocol)
- Communication rules (@mentions, discussion in issues)
- Token refresh (embedded in command blocks)
- Label convention
- Role-specific behavior

## Agent Definitions

### Permanent Agents

#### `code-agent.md`
- Identity: implements features, fixes bugs
- Workflow: pull main → branch → implement → PR → ask for review → STOP → merge on LGTM → return to main
- Finishing Work: single chained command (token refresh + PR create + label update + review request comment)
- Merge: separate section, only on LGTM
- Key rules: @mention in every comment, never remove agent label, read full issue before starting

#### `science-agent.md`
- Identity: designs experiments, analyzes results, files issues, reviews PRs
- "Now or backlog?" prompt before filing issues
- Cross-repo `--repo` flags for all `gh` commands
- Findings pattern: write structured finding files (F1, F2...)
- Code access: use Explore subagent, not direct file reads
- Review: honest review — LGTM if good, request changes if not

#### `writing-agent.md`
- Identity: writes LaTeX, formats tables/figures, edits prose
- Works in paper repo
- Receives issues from science-agent with structural instructions
- Reviews focus on writing quality, not scientific accuracy
- Commits after every paper change

### Experiment Agents

#### `exp-code-agent.md`
- Same as code-agent but: no memory, no accumulated learning, fresh per run
- No self-chaining (doesn't check for more work after task)
- Experiment-specific: "Your only task is the issue that was routed to you"

#### `exp-science-code-aware.md`
- Science-agent variant with full code access
- Files issues with exact file paths and function names
- For Condition B1 of the experiment

#### `exp-science-domain-only.md`
- Science-agent variant with NO code access
- Files issues with domain-level descriptions only
- Cannot reference file paths, function names, or code structure
- For Condition B2 of the experiment
- Explicit rule: "You do not have access to the codebase. Describe what needs to be done, not how."

#### `exp-single-agent.md`
- Combined code + science role
- Does everything: reads task, implements, self-reviews, creates PR
- For Condition A (single-agent baseline)
- No coordination, no GitHub Issues for routing

### Worker Pool

Worker agents use the permanent agent templates but with `agent_type: worker` in config. The template is the same — the difference is lifecycle (disposable) and identity (shared `macf-worker[bot]` App, tagged comments).

## Key Patterns from CPC (Tribal Knowledge)

The cross-cutting patterns listed here apply to every agent. They are **not** duplicated into each agent template. The authoritative source is:

**`plugin/rules/coordination.md`** — shipped with the CLI package and distributed to each workspace's `.claude/rules/coordination.md` by `macf init` / `macf update` (see issue #52).

Patterns covered there:

1. Token refresh in command blocks (not a separate instruction — agents ignore those ~20% of the time)
2. Turn-based workflow — agent's turn ends after PR creation, merge only on routed LGTM
3. Discussion in issues, not PRs
4. @mention in every comment — routing depends on it
5. Pull latest main before branching
6. Return to main after merge
7. No "Starting work" comment — the `in-progress` label signals this
8. Concise comments (1-3 sentences unless detail is needed)
9. Reporter owns the issue — implementer never closes, posts handoff comment after merge
10. Work through the queue without prompting
11. Definitive GitHub states are action signals, not wait signals (mergeStateStatus interpretation)
12. Escalate to the issue reporter (universal: whoever tasked you)

Agent-specific content (code-agent's TDD+`make check`, science-agent's "now-or-backlog?" prompt, writing-agent's commit-per-change, exp-*'s experimental constraints) stays in each agent's template file.

### Experimental variant note

The `exp-*` agent templates intentionally **override** some of these universal patterns (e.g. `exp-code-agent` does NOT work through the queue — it stops after one task; `exp-single-agent` does not use @mentions because there is no peer). They keep their own inline rules to make the experimental constraints prominent and to prevent coordination.md from silently changing their behavior. This is deliberate drift for experimental control.

## Tests

- Each agent template is valid markdown with correct frontmatter
- Agent loads in Claude Code: `claude --agent macf-agent:code-agent`
- Experiment variants: verify domain-only agent CAN'T reference code paths (test with mock issue)
- Worker template: verify tagged comments include instance ID
