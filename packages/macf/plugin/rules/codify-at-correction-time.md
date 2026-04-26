# Codify at Correction Time

**When peer correction reveals a substrate-discipline gap — write the workbench rule (or in-thread codification) immediately, not later.** Codify-at-correction-time is the substrate's natural Stage-3 mechanism for absorbing peer correction; making it canonical promotes it from emergent property to expected discipline.

This rule is the cross-agent canonical version of the `codify-at-decision-time` workbench discipline. They're complementary:

- **Decision time** — codify when introducing a new path / file / env var / workaround the canonical rules don't yet acknowledge. Pre-emptive.
- **Correction time** — codify when peer correction surfaces a gap in your existing application of canonical rules. Post-hoc.

Both are species of "make the lesson explicit and durable rather than implicit and fragile."

---

## When to fire

Within ~2 turns of any of the following:

- **Peer surfaces a class-of-slip** in your behavior (not just a single instance — they identify a recurring shape: *"this is the third time you've...")
- **You concede after pushback** + the concession represents new framing worth preserving past this thread
- **Your application of a canonical rule misfired** in a way that's not directly addressed by the rule's existing text — you've found the gap before the canonical rule has
- **A peer's correction lands a useful generalization** of the canonical rule (e.g., "verify-before-claim cuts at every hop, not just the original claim")

The trigger is *peer correction surfaces a substrate-discipline pattern*, not just *peer correction happens*. Routine "you got X wrong, fix it" doesn't require codification — only patterns that generalize past this incident.

---

## How to codify

Two surfaces, both useful:

### Workbench memory (private, durable across sessions)

Write a one-page feedback memory at `~/.claude/projects/.../memory/feedback_<slug>.md` (or your agent's equivalent memory location). Format:

    ---
    name: <one-line rule statement>
    description: <when to apply, why it exists>
    type: feedback
    ---

    <body: rule + when-to-apply + when-NOT + cross-references>

The memory loads on session start; future sessions inherit the discipline.

### In-thread paper-trail (durable on GitHub, audit-able)

If your agent class doesn't have durable workbench memory (e.g., ephemeral testers whose workspace regenerates on bootstrap), or if the lesson belongs in the paper-trail, post the codification as a comment on the thread where it surfaced:

    Pattern worth noting on my side: [class-of-slip articulated explicitly]. Hit N times in [window]; corrective shape is [what to do differently].

The thread becomes the durable substrate-of-codification. Future readers (peers, paper authors, future-you) can audit the codification chain via GitHub's issue history.

For research-grade findings: BOTH surfaces. Memory captures the lesson; the paper-trail comment makes it citable.

---

## Multi-agent codification cascades are the goal, not redundant work

When peer correction surfaces a substrate-discipline gap, expect multiple agents to independently codify the same lesson, often within minutes of each other. This is feature, not redundancy:

- **Cross-agent attestation** of the same meta-rule provides stronger evidence that the lesson generalizes than a single-agent codification
- **Memory-naming convergence** across agents (similar slugs, similar structure) is a signal that the rule is genuinely general
- **Codification-mechanism diversity** (memory file, in-thread comment, workbench rule promotion, retroactive-application announcement) is appropriate per agent — each agent's persistence model differs

Observed 2026-04-25 / 2026-04-26: 11 codification events across 4 agents (3 substrate + 1 measurement) in ~36 hours, on 3 distinct canonical-rule refinements + the meta-rule itself. Multi-agent codification cascades produced this pattern as a substrate-level emergent property; making the codification habit canonical promotes it from emergent to expected.

See `groundnuty/macf-science-agent:insights/2026-04-26-verify-at-every-hop-emitter-receiver-cross-cell.md` for the case study + meta-tally of the events that motivated this rule's promotion.

---

## When NOT to codify

- The correction was for a single instance with no recurring shape (one-off bug ≠ pattern)
- The lesson is already captured by an existing canonical rule (don't duplicate; reference)
- The agent's correction was substantively wrong and you're conceding to maintain harmony rather than because the framing is right (push back per `peer-dynamic.md`)
- Mid-flow on something more important + can defer by ≤1 turn safely

---

## Apply in real time

The discipline isn't aspirational — it's operational on the next decision after codification. If you save the rule at turn N, you're expected to apply it at turn N+1 (or have an explicit reason not to).

Observed 2026-04-25: code-agent saved `feedback_verify_at_every_hop_when_citing_peer_evidence.md` at ~18:38Z and applied it the same minute by deferring a fix that would have re-framed peer evidence without re-verification. Codify-at-correction-time + immediate application is the full pattern.

---

## Cross-references

- `verify-before-claim.md` §5 — the verify-at-every-hop discipline this rule operationalizes the codification habit for
- `peer-dynamic.md` — the broader peer-correction protocol this rule extends (correct each other through dialogue → codify the dialogue's lessons)
- `coordination.md` — the substrate-level coordination protocol that makes peer correction reliable enough for codification cascades to emerge
