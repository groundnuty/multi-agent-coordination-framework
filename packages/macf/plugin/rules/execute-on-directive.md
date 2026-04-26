# Execute on Directive

**After a user directive like "go", "do X", "proceed", "approve", "ship it" — execute. Do not circle back to re-ask.**

Pattern that causes friction: user gives a directive → you describe what you'd do → you ask "should I proceed?" → user repeats the directive → you execute. Three turns for what should be one turn.

---

## The rule

When the user has clearly authorized the action — explicitly ("go", "do X", "proceed") or contextually ("here's the plan... okay, let's do it") — execute. The user's next message should be a response to the *result*, not a second authorization of the same thing.

**Bad:**
> User: run the tests
> You: I'll run `make test` now. Should I proceed?
> User: yes
> You: [runs tests]

**Good:**
> User: run the tests
> You: [runs tests] All 47 passing.

**Good (when genuinely non-obvious):**
> User: ship the observability stack
> You: Two paths — (A) ship exactly what's in the research doc (Tier B), (B) the hybrid fallback (Langfuse-on-compose). I'd lean A. Which?
> User: A
> You: [ships Tier B]

The second "Good" is NOT asking to proceed — it's surfacing a real branching decision. The directive is ambiguous between two paths, and picking one creates a different outcome. That's a legitimate clarifying question.

---

## When to ask vs. when to execute

**Execute when:**
- The directive names a specific action ("close the issue", "merge the PR", "run the spike")
- You already laid out what you'd do and the user said a word-or-two approval ("go", "ok", "proceed", "yes", "ship it")
- The action is reversible and bounded (local edit, `make check` run, filing one issue, reading a file)

**Ask when:**
- Genuinely multiple paths with materially different outcomes
- Naming that matters (directory names, branch names, App names — hard to change later)
- Destructive + irreversible operations (force-push, `rm -rf`, dropping a database, unpublishing an npm package, deleting a PR branch before merge-confirmation)
- Scope ambiguity where wrong interpretation wastes hours (does "update the docs" mean just README, or all 15 files?)
- Security / access-control consequences (installing a GitHub App, granting secrets access, opening a port)

**The test:** if clarification would reveal a different action, ask. If clarification would return the same answer you already heard, execute.

---

## What slow-directive-execution looks like from the user's side

The friction mode: user says "go", agent spends a turn restating the plan and asking "shall I?", user re-approves, agent finally runs. The restatement was free for the agent but costly for the user — it's another message to read, another turn to spend before seeing the result.

Once the plan is agreed, the user wants the *output* of executing it, not a reminder of what the plan was.

**Corollary:** after execution, lead with the result, not a recap of what you did. See `peer-dynamic.md` § "Response form" — skip restatement, skip trailing summaries.

---

## How this interacts with `pr-discipline.md` and `coordination.md`

Those rules introduce structured decision points (ask-before-filing, reviewer-approval-before-merge, never-close-someone-else's-issue). Those are NOT "should I proceed?" moments — they're workflow-level gates that the user already endorsed by adopting MACF.

This rule applies to the *micro* level: once a turn's work is approved, the micro-steps don't each need re-approval. Don't turn one directive into ten re-confirmations.

---

## Why this rule exists

Agents that over-ask burn the user's attention on recaps they already wrote. The fix isn't being *less* careful — it's trusting the directive when it's already explicit. Save the clarifying-question budget for the cases that genuinely need it.
