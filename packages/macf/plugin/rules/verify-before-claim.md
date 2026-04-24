# Verify Before Claim

**Tool output beats memory. Diff beats prose. Freshly-queried state beats last-known state.**

Before you make an assertion about system state — the status of an issue, whether a PR merged, what a config file contains, whether a service is running — verify it with a tool call, then claim it. The cost of a `gh`/`kubectl`/`helm`/`ls`/`grep` call is ~1 second. The cost of a confidently-wrong assertion that a peer acts on is much larger.

This rule compounds every behavior in this file — they're four faces of the same discipline.

---

## 1. Never fabricate "verified" output in close comments

When closing an issue (or writing any "this is done" artifact), paste **literal output** from the verifying tool call. Do not paraphrase it. Do not write what it "should" say.

**Bad:**
> Verified — `macf --version` returns `0.2.0` and `npm view @groundnuty/macf version` returns `0.2.0`. Closing.

(If you didn't actually run those commands in the current session, the text is a fabrication even if the values happen to be correct.)

**Good:**
>     $ npm view @groundnuty/macf version
>     0.2.0
>     $ macf --version
>     0.2.0
>
> Closing as reporter.

Literal quoted output with the `$` prompts is the signal that the assertion is grounded in a just-executed command. Future readers (auditors, peers, future-you) can tell by formatting whether the evidence is fresh or narrated.

**Applies to:** issue close comments, PR merge-handoff comments, runbook "I ran X, got Y" sections, status updates on long-running tasks.

---

## 2. After `gh issue comment` / `gh issue close`, verify it actually posted

Writing the review/LGTM/close-comment as prose in your response is NOT the same as posting it. Only executed tool calls reach the repo; chat output is invisible to other agents. Treat the verification step as a **mandatory tail**, not optional.

After any `gh issue comment` / `gh pr comment` / `gh issue close`:

    gh issue view <N> --repo <owner>/<repo> --json comments \
      --jq '.comments[-1].author.login'

Confirms:
- (a) the comment exists (non-empty output)
- (b) attribution is correct — your bot login, not the user's login (attribution-trap catch)

Signs you may have missed the tool call:

- Your last action was describing a review / decision / close in prose
- The recipient's status comment says "waiting for review" or "ready for you to close" with no reply from you visible on the thread
- Time has passed since you "reviewed" but no downstream activity has happened

When in doubt, run the `gh issue view` check. Cheap to verify; costly to have the peer wait on a review that never arrived.

---

## 3. Before ordering-claims, `gh pr view` the predecessor

Before asserting "PR A must merge before PR B" or "X is blocked on Y":

    gh pr view <predecessor-N> --repo <owner>/<repo> --json state,mergeStateStatus,mergedAt

Don't infer the predecessor's state from stale in-context memory. PR review conversations often span hours; a PR you saw as OPEN two hours ago may be MERGED now. Sequencing claims based on stale state lead to peers doing unnecessary rebases or waiting on already-satisfied dependencies.

Same principle for `gh issue view` / `helm status` / `kubectl get` — the live query beats the remembered value, always, for anything that could have moved.

---

## 4. Before committing "root cause: X" to memory, read the fix diff

When an incident closes with a post-mortem-style "root cause: X" from the reporter, that statement is the reporter's *hypothesis*. Before writing it into persistent memory, verify against the actual fix diff:

    git show <fix-commit-sha>
    # or
    gh pr diff <fix-PR-N> --repo <owner>/<repo>

The diff shows what was *actually* changed. Reporter prose is narrative — often right, sometimes simplified, occasionally wrong. A memory file claiming "mode-6 of the attribution trap is X" is load-bearing for future sessions; miscalling the root cause sends those future sessions chasing the wrong bug class.

Cluster to which this belongs: always prefer concrete artifact (diff, config, tool output) over narrative description of it. The narrative is lossy compression.

---

## 5. When mis-attribution is discovered mid-thread

If you post a comment and later realize it was attributed to the wrong identity (typically: chat-fallback to user because GH_TOKEN was the string "null"), **do not delete-and-repost**. Downstream references — @mentions to you, PR thread anchors, peer agents quoting the comment — break when the original is deleted.

Instead: post a follow-up clarification on the same thread:

> Follow-up: the previous comment on this thread was posted under the wrong identity due to a token-refresh failure. The intended author was `macf-devops-agent[bot]`. Content still stands.

Then fix the root-cause (refresh the token properly, inspect the helper for silent-failure modes — see `gh-token-refresh.md`). Silent delete-and-repost creates a worse audit trail than a clear acknowledgment of the slip.

---

## Why this rule exists

Verification discipline slips most often in the turn *right before a hand-off*: closing an issue, merging a PR, summarizing to a peer. The context buffer feels settled, the task feels done — so we narrate instead of verify. That's exactly when a wrong claim becomes load-bearing on someone else's next action.

Cheap to verify. Expensive to be confidently wrong. Always pay the cheap cost.
