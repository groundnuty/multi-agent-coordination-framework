# Mention-Routing Hygiene

**GitHub `@handle[bot]` mentions fire the Agent Router workflow regardless of surrounding context. When you are writing *about* an agent — quoting its output, analyzing its behavior, describing it in documentation — code-format the handle to suppress routing. Raw handles are reserved for intentional routing targets.**

GitHub's @mention semantics treat any bare `@handle` in a comment or PR body as a routable signal. The macf-actions router picks these up and forwards the reference to the named agent's tmux session, regardless of whether the reference was in an addressing context ("please take a look") or a describing context ("tester-2's response was…"). When described-not-addressed mentions fire routing, the referenced agent receives an ambient ping asking for an action that was never actually requested. For rules-loaded agents, this typically triggers scope-discipline reasoning (read context, recognize content-reference, cite `agent-identity.md §Not-for-testers`, stand down) and a response comment explaining why. Multiply this across scenario PRs that analyze tester behavior, insight documents that reference agents as research subjects, or cross-agent research commentary — testers and other agents get pinged for every describing use of their handle.

The fix is one character per handle: wrap the `@` and bracketed `[bot]` in backticks. The convention is cheap to apply; the cost of skipping it is proportional to how much the fleet writes about other agents.

---

## 1. The two modes

**Addressing** — you want the agent to see this and respond / act:

    @macf-code-agent[bot] please review PR #12 when convenient.

**Describing** — you are writing about the agent; no routing needed:

    The `@macf-tester-2-agent[bot]` response quoted `coordination.md` rule 1 verbatim.

The difference is a single pair of backticks. Both forms still render recognizably in GitHub's UI; only the raw form fires routing.

**Decision rule when unsure:** ask whether the agent receiving this comment should treat it as an action ask. If yes → raw. If no → backticked.

---

## 2. Contexts where describing happens

These are the common places the describing form applies. Not exhaustive; the principle generalizes:

- **PR bodies** quoting another agent's output verbatim (scenario transcripts, review excerpts, observation snippets)
- **Issue bodies and comments** analyzing agent behavior for research or post-mortem purposes
- **Observation logs** and **insight documents** referencing agents as research subjects
- **Canonical rule files and documentation** citing agent handles as examples
- **Paper drafts** and **research notes** in which agents are data, not interlocutors
- **Cross-agent commentary** where you are synthesizing what multiple agents did

In each of these, raw `@handle` will fire routing. Backtick-wrap.

Handles inside fenced code blocks (triple-backtick) or 4-space-indented blocks are already safe — GitHub's mention parser skips code contexts. Backtick-wrapping is for inline prose where a bare `@handle` would otherwise be parsed as a routing target.

---

## 3. Contexts where addressing happens

These are the legitimate routing targets — keep the raw form:

- The closing line of a PR body that asks a reviewer to look: `@macf-science-agent[bot] ready for review.`
- Direct replies on a thread where you expect the agent to act: `@macf-code-agent[bot] pushback: see file:line ref below.`
- Handoff comments: `@<reporter> ready for you to close when verified.`
- Escalation pings when blocked.

If a comment contains both describing and addressing references to the same agent, the describing form gets backticks and the addressing form stays raw.

---

## 4. Verification check before posting

For any comment or PR body that contains agent handles, grep the draft:

    grep -nE '@macf-[a-z-]+-agent\[bot\]' <draft-file>

For each line returned: is this line an action ask (raw stays) or a content reference (backticks wrap)?

If you don't want to verify per-line, the safe default is: **backtick by default, un-backtick only the addressing lines**.

Drafts you run through this check regularly: scenario PR bodies that include preserved artifacts, observation-log entries, insight files, review comments that quote the agent being reviewed.

---

## 5. Alternative forms (same effect, lower readability)

All three of these suppress routing; the choice is stylistic:

- **Backticks** (preferred): `` `@macf-tester-2-agent[bot]` ``
- **Escape sequences**: `\@macf-tester-2-agent\[bot\]`
- **Label form**: "tester-2" or "the tester-2 agent" (for prose where a full handle isn't needed)

Backticks are preferred because they render as inline code in GitHub's Markdown, which is semantically meaningful ("this is a handle identifier being referenced") and visually distinct from raw routing targets.

---

## 6. Symmetry — this rule applies to every agent

The convention is **bidirectional** across the fleet. Every agent that writes commentary referencing other agents applies the same rule:

- Science-agent writing about testers → backticks
- Code-agent writing about testers → backticks
- Testers writing about each other → backticks
- Operator-thread comments quoting agent output → backticks (operator is human but the convention applies for consistency)
- Devops, CV, future-fleet agents → backticks

Asymmetric adoption breaks the protocol: if only some agents escape handles, the others continue leaking routing from the contexts they miss. Symmetric adoption is what makes the convention enforceable.

---

## Why this rule exists

Routing is a global side-effect. Unlike most GitHub semantics, `@mention`-based routing in MACF does not differentiate the grammatical role of the handle — whether the sentence is about the agent, directed at the agent, or merely mentions the agent in passing. The router sees the handle and fires.

Without the backtick convention, every describing use of a handle produces a false-positive ping. For rules-loaded agents that correctly apply scope-discipline when incorrectly routed, this means they must spend attention reading the context, identifying that they were referenced-not-addressed, citing the applicable rule, and posting a stand-down comment. Each firing is a few seconds of noise per agent — but the describing form of a handle is far more common than the addressing form, so the noise accumulates quickly.

The failure-mode was observed on `macf-testbed#9` and `#18` (2026-04-24): a single rules-loaded tester received three ambient routing pings across two scenario PRs, correctly disciplined each response with scope-preserving rationale, and escalated the third firing into a cross-session-commitment-tracking critique of the author. That sequence of responses was appropriate — but it was also three response turns that could have been prevented by one keystroke of backticks per handle reference in the PR bodies.

The rule is cheap to apply, symmetric across the fleet, and eliminates a class of false-positive routing that otherwise compounds with every describing use of an agent handle.
