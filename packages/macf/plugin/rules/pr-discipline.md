# PR Discipline (canonical, shared)

**This file is the single source of truth for how MACF agents use pull
requests as the default merge checkpoint.** It is copied into each agent
workspace's `.claude/rules/` by `macf init` and refreshed by `macf update`
/ `macf rules refresh`. Do not edit workspace copies directly — edit the
canonical file at
`groundnuty/macf:packages/macf/plugin/rules/pr-discipline.md` and re-run
the distribution.

---

## The default: PR for every artifact

**Every agent-authored change that produces a persistent artifact goes
through a pull request, not a direct commit to the default branch.**

This applies uniformly to:

- Source code (`.ts`, `.py`, `.sh`, etc.)
- Tests
- Rules + docs (`.md`)
- Config (`package.json`, `tsconfig.json`, workflow files)
- Research + findings documents
- Generated artifacts (when committed to the repo)

The PR is the merge checkpoint. Without it:

- No peer review — the reviewer who's supposed to validate can't
- No CI — tests / linters / build checks don't run on the change in
  isolation
- No audit trail — "who approved what" becomes a git-blame archaeology
  problem instead of a PR-comment lookup
- No rollback point — reverting one PR is one command; reverting a string
  of direct commits requires cherry-pick-reversing each

The cost of a PR is ~30 seconds of typing. The cost of skipping it is
paid once something goes wrong.

---

## The narrow exceptions

**Direct commit to default branch is acceptable only when ALL of these
hold:**

- The change is operator-authored at the terminal, not agent-generated
- It's a trivial recovery (typo in a config file, emergency secret rotation,
  obvious one-line unbreak)
- The operator takes responsibility verbally in a follow-up channel (team
  chat, issue comment, etc.)

**Examples that are NOT exceptions** — use a PR:

- "It's just a research doc" — still a PR
- "It's just comments" — still a PR
- "It's a small fix" — still a PR
- "CI doesn't apply to this file type" — still a PR (the review discipline
  does)
- "I'm the only one working on this repo" — still a PR (audit trail
  matters)
- "It's a content-only change, no logic" — still a PR

If you find yourself reaching for `git commit && git push origin main`
as an agent, you're probably violating this rule. Stop, branch, push, PR.

---

## PR anatomy

### Branch name

Reflects the change type + scope. Common patterns:

- `feat/<issue-number>-<slug>` — new feature
- `fix/<issue-number>-<slug>` — bug fix
- `chore/<slug>` — version bumps, dep updates, renames
- `docs/<slug>` — docs-only
- `research/<date>-<slug>` — research findings
- `refactor/<slug>` — structural changes without behaviour change

### PR title

Follows conventional commits format:

```
<type>(<scope>): <description starting lowercase>
```

Examples:

- `fix(cli): reject empty MACF_AGENT_NAME with actionable error`
- `docs(design): add dr-022 amendment j — first-publish-path gotchas`
- `research: 2026-04-22 observability stack landscape`

### PR body

Structure (scale each section to the change size):

```markdown
Refs #<issue-number>
<or: Closes #<issue-number> only if the PR author and the issue reporter are the same agent>

## Summary

<What changed and why, 1–3 sentences.>

## Approach

<How, briefly. Why this approach and not alternatives.>

## Test plan

- [x] Specific verification step
- [x] Specific verification step
- [ ] Operator-verification (if applicable)

## Notes

<Gotchas, related issues, follow-ups.>
```

---

## `Refs #N` vs `Closes #N`

Governed by **reporter-owns-closure** (see `coordination.md`):

- **`Closes #N`**: PR author == issue reporter. Auto-close on merge is
  fine because the same agent is approving the closure.
- **`Refs #N`**: PR author != issue reporter. The issue reporter verifies
  the fix before closing — auto-close bypasses that verification.

When in doubt, use `Refs`. It's the safer default.

Same applies to the close-keyword siblings: `Fixes`, `Resolves`, `Fix`,
`Close`, `Resolve`, and their tense variants. If the issue is
foreign-reporter, use `Refs` for all of them.

---

## The review loop

1. **Implementer opens the PR**, @mentions the reviewer on the issue
   thread with a pointer to the PR.
2. **Reviewer checks out the branch**, reads the diff in context, LGTMs
   or lists concerns. See `peer-dynamic.md` for what substantive review
   looks like.
3. **If concerns**: implementer pushes fix commits (don't force-push the
   review history), @mentions the reviewer again.
4. **Once LGTM**: implementer merges. See below.
5. **After merge**: implementer posts the closure handoff on the
   originating issue, per `coordination.md` rule 1.

---

## How to submit LGTM — formal review, not comment

**LGTM and "request changes" decisions MUST be submitted as formal GitHub
reviews via `gh pr review --approve` or `gh pr review --request-changes`,
not as plain `gh pr comment` text.**

```bash
# CORRECT — formal review submission
gh pr review <PR-number> --repo <owner>/<repo> --approve --body-file <review.md>

# CORRECT — formal request-changes submission
gh pr review <PR-number> --repo <owner>/<repo> --request-changes --body-file <review.md>

# WRONG — review communicated only via issue/PR comment
gh pr comment <PR-number> --repo <owner>/<repo> --body "LGTM, you can merge"
gh issue comment <issue-N> --repo <owner>/<repo> --body "@<author> LGTM on PR #M"
```

**Why this matters structurally:**

Formal review submission fires GitHub's `pull_request_review` webhook
event with `state in {approved, changes_requested}`. The MACF routing
Action's `route-by-pr-review-state` job (macf-actions v3.3.0+, per
macf-actions#39) listens for this exact event and notifies the PR author's
channel-server directly — independent of whether the reviewer @mentioned
the author in the body. **This is the structural defense for the
LGTM→merge handoff: the state-change IS the wake signal.**

If the LGTM is communicated only as a plain `gh pr comment`,
`pull_request_review` never fires; routing falls back to `route-by-mention`
which depends on body parsing (and `mention-routing-hygiene.md §5`
backtick-suppression discipline can suppress what looks like an addressing
mention). Empirically observed: cv-e2e-test rehearsals #9, #10, #11b
(2026-04-29 and 2026-04-30) — agents merged PRs without firing
`pull_request_review` at all, leaving `route-by-pr-review-state` an
untested code path despite being shipped via macf-actions v3.3.0.

**Same shape as the silent-fallback hazard class (`silent-fallback-hazards.md`):
the comment-form succeeds at the API boundary (`gh pr comment` returns 0)
but the semantic outcome (wake recipient via routing-Action's structural
defense) silently doesn't happen. Pattern A defense at the discipline
layer: assert the LGTM uses a state-change-firing mechanism, not just
text-on-the-thread.**

**The body content of the formal review** is the same kind of content you'd
otherwise put in a comment — substantive review notes, what's strong, what
needs changes, dispositions on prior feedback. The `--body-file` path is
the canonical way to pass that body without shell-quoting issues (per the
backticks-in-comments hazard noted in `mention-routing-hygiene.md`).

**This rule complements `coordination.md §Communication 2`** ("discussion
in issue comments, not PR comments"). The two surfaces serve different
purposes:

- **State-change events** (LGTM, request-changes) fire on the PR via
  formal review submission — engages the routing-Action structural
  defense (`route-by-pr-review-state`).
- **Substantive discussion ABOUT the work** persists on the issue thread
  — visible on the Projects board, persists after the PR is merged or
  closed.

Both surfaces are load-bearing. Don't skip the formal review thinking
"the issue thread is the canonical place"; don't skip the issue-thread
discussion thinking "the formal review covers everything."

**Verifying your review actually landed as a state-change** (per
`verify-before-claim.md §2`):

```bash
# After gh pr review, confirm a state-change review exists.
# Filter for APPROVED or CHANGES_REQUESTED specifically — `[-1]` alone
# can mistake a follow-up COMMENTED review for the missing state-change.
gh pr view <PR-number> --repo <owner>/<repo> --json reviews \
  --jq '[.reviews[] | select(.state == "APPROVED" or .state == "CHANGES_REQUESTED")]
        | last // "no state-change review"'
```

If the most recent state-change review is missing (output: `"no state-change
review"`) OR the most recent review overall has `state == "COMMENTED"` and
no prior state-change exists, the review was submitted as a comment-style
review and won't fire the `pull_request_review.submitted` event with an
actionable state — the routing won't engage. Re-submit with `--approve` or
`--request-changes`.

**When `--comment` (no state change) IS appropriate:**

- **Mid-review clarifying questions** — partial-review feedback before completing the read-through, asking the implementer to disambiguate before you decide
- **Partial-review notes** — observations on parts of the diff while the rest is in flight (e.g., "skimmed the `src/server.ts` changes; will read tests next pass")
- **Out-of-band observations** — comments on a PR that's not blocking your LGTM/changes decision (style nits, future-work suggestions, links to adjacent context)
- **Review-pickup acknowledgment** — comment like *"picking this up; will review tonight"* or *"queued behind X; ETA Y"* so the PR author knows when to expect feedback. Coordination-discipline (saves the implementer from polling) but isn't a state-change.

These don't fire structural routing; agents on both sides should treat them as informational, not as merge-gating signals.

---

## Merge-by-implementer

**The implementer who wrote the PR merges it, not the reviewer.**

Reasons:

- The implementer owns the change — they know whether the latest commit is
  actually the right state to land.
- The implementer has context on CI status, whether any flaky tests are
  noise, whether the branch needs a rebase.
- Reviewer-merge ambiguates responsibility — if the merge is broken, who
  owned it? The coordination model assumes a clear owner per action.

**The reviewer's role ends at the LGTM.** After that, the implementer
decides the merge timing (wait for CI green, rebase on main if needed,
retry on flaky CI, etc.) and executes.

If the PR author is blocked (e.g., offline), the reviewer may merge after
an explicit hand-off comment — but that's exception, not default.

### When the reviewer is absent or unreachable

**Without an explicit LGTM from the reviewer, the implementer does NOT merge — even if waiting indefinitely.**

When a PR has been open for an extended period without reviewer signal:

1. **@mention the reviewer again** on the originating issue — they may have missed routing (silent-fallback hazards class; see `silent-fallback-hazards.md` Instance 3 for a concrete failure mode where routing succeeds at the API layer but the recipient never sees the prompt)
2. **If still no response after a reasonable interval** (judgment call based on session pacing — minutes for fast-cycle work, an hour or more for deeper review): **escalate to the issue reporter** with `@<reporter>`
3. **The reporter decides**:
   - Re-route the review to a different reviewer
   - Accept self-merge as exception (with explicit comment on the PR documenting why the LGTM gate was bypassed)
   - Close the PR if the work is no longer needed

**Self-merging without LGTM is a protocol violation**, except via the explicit reporter-sanctioned exception above. The only other sanctioned merge-without-explicit-LGTM path is the "PR author offline → reviewer merges with hand-off comment" exception described in the previous paragraph.

**Why this rule exists.** The LGTM gate is structural — it ensures that someone other than the implementer has read the diff in context. Self-merge without LGTM bypasses that quality gate even if the work is correct. The escalation path preserves the gate's intent (someone else makes the merge decision) while providing a clear path forward when the registered reviewer is unreachable.

This rule was surfaced 2026-04-26 during the macf-testbed#229 Phase C iter 4 sweep — a tester self-merged when its harness driver (acting as the de-facto reviewer) was killed mid-poll. The work was correct and the scenario AC was met, but the LGTM precondition wasn't. Codified here so the protocol covers reviewer-absence symmetrically with the existing implementer-absence case.

### Before merging

Check `mergeStateStatus` via `gh pr view <N> --json mergeStateStatus`:

- `CLEAN` → merge
- `UNSTABLE` → a required check failed or is in-flight. Wait if
  in-flight, fix if failed
- `BEHIND` → rebase on main, force-push, re-check
- `DIRTY` → conflicts, resolve, push, re-check
- `BLOCKED` → branch protection rules not met — check reviews, required
  checks, status checks
- `UNKNOWN` → GitHub is still computing, wait ~30–60s and re-query

See `coordination.md` "When You're Stuck" for the full routing table.

Don't merge on `UNSTABLE` assuming the failing check is unrelated. If the
check is required, investigate it before merging.

### Squash vs merge vs rebase

Prefer **squash**. One PR = one commit on main. Keeps the history linear
and the commit log scannable.

Use merge-commit style only when the PR legitimately captures multiple
independent changes that should be preserved as separate commits.
Don't use rebase-merge unless the project has a specific reason.

---

## After the merge

1. **Delete the remote branch.** (GitHub prompts; take the prompt.)
2. **Post the closure handoff on the originating issue** (`coordination.md`
   rule 1):

    > `@<reporter>` PR #N merged as `<commit-sha>`. Ready for you to close
    > when verified.

3. **Do NOT close the issue yourself if you weren't the reporter.** Let
   the reporter verify + close. See `coordination.md` failure-mode-B for
   when you ARE the reporter (then close yourself).

---

## CI-aware merge timing

If the repository uses CI on PRs:

- Wait for at least the `check` job to complete before merging (or whatever
  the required-status-checks list demands).
- `UNSTABLE` + `in-flight` → wait
- `UNSTABLE` + `failed` → investigate + fix, then re-push
- Don't merge-and-then-hope-the-CI-was-flaky. If required checks failed,
  fix them before merging.

For fire-and-forget trivial changes (e.g., typo fix), waiting for CI is
still right — it's a minute, and it protects against "the typo fix broke
the build" because someone's CI job depends on the exact string you
changed.

---

## When to modify this rule

- **Read:** every session start.
- **Modify:** never directly in workspace copies. Edit the canonical file
  and re-distribute via `macf update`.
- **Disagree with a rule?** Open an issue on `groundnuty/macf` proposing
  the change, with rationale + the incident that surfaced the need.
