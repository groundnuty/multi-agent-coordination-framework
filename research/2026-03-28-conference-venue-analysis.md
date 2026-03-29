# Conference Venue Analysis: Multi-Agent GitHub Coordination Paper

Date: 2026-03-28
Purpose: Identify the best publication venue for our multi-agent coordination work, considering what we have (architecture + empirical data) and what different venues require.

---

## What We Have

### Architecture (no data needed)
- GitHub-native multi-agent coordination: Apps, Actions, Issues/PRs, Projects V2
- Turn-based workflow enforced by external routing (GitHub Actions → SSH/tmux)
- Agent rules files with coordination protocol
- Asymmetric context strategy proposal (transactional vs cumulative)
- Orchestrator-worker pattern design
- `claude.sh` launcher with token generation
- All publicly visible at https://github.com/groundnuty/claude-plan-composer

### Empirical Data (makes the paper strong)
- 39 sessions, 26,620 API calls, 10.5 trillion effective input tokens
- "1.18x not 4-15x" overhead finding with component decomposition
- Context growth curves: code-agent 1.48x, science-agent 4.25x
- Cache hit rates: 67.4% (code), 89.3% (science)
- 200K cap simulation: 73.5% savings for code-agent
- Communication content: only 2.9% of output tokens
- Token refresh: 79.7% of gh commands (pure overhead)
- GitHub interaction data: 128 issues, 376 comments, authorship patterns
- Agent memory evolution: 33 memory files from feedback
- Rules reliability: ~80% adherence, embedded command blocks needed
- Reproduction scripts documented

### What We Don't Have
- Controlled single-agent baseline (we estimate, don't measure)
- Multiple projects (only one TypeScript SDK)
- Multiple agent teams (only science + code)
- Long-term data (11 days)
- Industry deployment (academic researcher, not a company)

---

## Venue Analysis

### Tier 1: Excellent Fit

#### ASE 2026 NIER — New Ideas and Emerging Results
- **Deadline**: ~June-July 2026 (TBA, based on ASE 2025 pattern: July 12)
- **Conference**: October 12-16, 2026, Munich, Germany
- **Pages**: ~4 pages (based on prior years)
- **Published**: YES — ACM/IEEE proceedings, indexed on DBLP
- **Review**: Double-blind (historically for ASE NIER)
- **Acceptance rate**: ~25-30%

**Scope match**: NIER wants "new ideas that may change the way we think about SE." The "1.18x not 4-15x" finding directly challenges a widely cited assumption in multi-agent literature.

**With data**: Strong — counterintuitive finding backed by 10.5T tokens of evidence. Frame as "structured-artifact communication as a new paradigm for multi-agent SE overhead."

**Without data**: Still viable — "GitHub as coordination layer" is a new paradigm proposal. But weaker — reviewers will ask "does it actually work?"

**Risk**: Must frame as a VISION, not just a measurement. "Interesting number but what's the generalizable insight?" is the killer review.

**Best framing**: "We propose that multi-agent overhead is a function of the communication medium, not the number of agents. Preliminary evidence from a production system (10.5T tokens) shows 1.18x overhead with GitHub-mediated communication vs 4-15x reported for chat-based systems."

#### ESEM 2026 Technical Track
- **Deadline**: Abstract May 11 (mandatory) / Paper May 18, 2026
- **Conference**: October 4-9, 2026, Munich, Germany
- **Pages**: Up to 17 + 3 (refs, data availability, acknowledgements). Dagstuhl LIPIcs format.
- **Published**: YES — ACM proceedings, indexed on DBLP
- **Review**: Double-blind
- **Acceptance rate**: ~25-30%
- **Special**: Requires structured abstract (Background/Aims/Method/Results/Conclusions) and Data Availability section

**Scope match**: ESEM is THE venue for empirical software engineering measurement. Our work IS empirical measurement — token analysis, overhead decomposition, context growth curves.

**With data**: **Best venue.** 17 pages gives room for full methodology + analysis + reproduction scripts. ESEM reviewers appreciate measurement rigor.

**Without data**: NOT viable. ESEM requires empirical data. Architecture alone would be rejected.

**Risk**: No controlled single-agent baseline. Reviewers will ask "how do you know single-agent would cost X?" Our simulation-based estimate may not satisfy. Could frame as "exploratory empirical study" with honest threats to validity.

**Best framing**: "An Empirical Study of Token Consumption in GitHub-Mediated Multi-Agent Software Development" — structured abstract, detailed methodology, reproduction package.

#### ICSE 2027 SEIP — SE in Practice
- **Deadline**: October 23, 2026
- **Conference**: April 25 - May 1, 2027, Dublin, Ireland
- **Pages**: 10 + 2 refs. IEEE format.
- **Published**: YES — ACM proceedings (separate SEIP volume), indexed on DBLP
- **Review**: Single-blind
- **Acceptance rate**: ~30-35%

**Scope match**: SEIP values "practical insights over academic novelty." Our work is a practitioner's experience building and deploying a multi-agent system.

**With data**: Excellent. Real system, real data, honest lessons learned.

**Without data**: Medium. SEIP accepts experience reports without heavy empirical analysis, but "we built it and it works" without numbers is thin.

**Risk**: Long timeline (Oct 23 deadline). Could submit to ASE first, then SEIP if rejected.

**Best framing**: "GitHub-Native Multi-Agent Coordination: Architecture, Deployment, and Lessons from 175 Merged Pull Requests"

#### ICSE 2027 NIER
- **Deadline**: October 23, 2026
- **Conference**: April 25 - May 1, 2027, Dublin, Ireland
- **Pages**: ~4 pages
- **Published**: YES — ACM proceedings (separate NIER volume), indexed on DBLP
- **Review**: Double-blind
- **Acceptance rate**: ~20-25% (very selective)

**Scope match**: Same as ASE NIER but higher prestige. ICSE NIER is the most competitive short paper venue in SE.

**With data**: Very strong — same framing as ASE NIER.

**Without data**: Possible if framed as pure vision/paradigm proposal. But ICSE NIER is very competitive.

**Risk**: Highest bar in SE. Need the finding to be truly surprising and generalizable.

### Tier 2: Good Fit

#### ASE 2026 Industry Showcase
- **Deadline**: April 23, 2026
- **Conference**: October 12-16, 2026, Munich, Germany
- **Pages**: 10 + 2 refs (long) or 5 + 1 ref (short)
- **Published**: YES — ACM/IEEE proceedings, indexed on DBLP
- **Review**: Single-blind
- **Acceptance rate**: ~40-50%

**Scope match**: Industry track expects "industrial context" — companies deploying automated SE at scale. ASE 2024 industry papers come from Ericsson, Meta, etc. Our work is a solo researcher with two AI agents on a research project. NOT industrial context.

**With data**: The data is impressive (10.5T tokens, 175 PRs) but from an academic project, not industry deployment. Reviewers may question whether this counts as "industry."

**Without data**: Very weak. Industry track without deployment data is just a proposal.

**Risk**: Scope mismatch. "Marketing or public relations material is not solicited" — our celebration test file entries might look like marketing. The "7.5x throughput" claim is for a single researcher, not an engineering team.

**Best angle (if submitting)**: Short paper (5 pages) as "experience report" focusing on practical challenges and lessons, not as a full industry solution. Emphasize: "we present challenges and design patterns for practitioners setting up multi-agent GitHub coordination."

#### ASE 2026 Tools and Data Sets
- **Deadline**: May 11, 2026
- **Conference**: October 12-16, 2026, Munich, Germany
- **Pages**: 4 pages (including everything) + screencast required
- **Published**: YES — ACM/IEEE proceedings, indexed on DBLP

**Scope match**: Working tools with demo. Our "tool" is configuration files + a GitHub Action + rules files — not a traditional software artifact.

**With data**: Helps but the tool demo format focuses on the tool itself, not the data.

**Without data**: Viable if we can produce a compelling 3-5 minute screencast showing the agents coordinating in real-time.

**Risk**: 4 pages is very tight. Screencast must be compelling. Reviewers expect a downloadable, reusable tool.

#### SEAA 2026 — DAIDE Track
- **Deadline**: April 15, 2026
- **Conference**: September 2-4, 2026, Krakow, Poland
- **Pages**: 16 pages (full) or 8 pages (short). Springer LNCS format.
- **Published**: YES — Springer LNCS, indexed on DBLP
- **Review**: Unknown (likely single-blind)
- **Acceptance rate**: ~40-50% (lower tier)

**Scope match**: DAIDE (Data and AI Driven Engineering) track accepts applied AI in SE research. Broader scope, less rigid requirements.

**With data**: Good. 16 pages gives room for architecture + data.

**Without data**: Acceptable. SEAA accepts design papers and early-stage work.

**Risk**: Lower prestige (CORE B ranking). Springer LNCS less visible than ACM/IEEE. But: Krakow is local, proceedings are indexed, guaranteed DOI.

**Best angle**: Full 16-page paper combining architecture + preliminary data. Lower bar means higher acceptance chance.

#### ICSME 2026 Industry Track
- **Deadline**: Abstract May 8 / Paper May 15, 2026
- **Conference**: September 14-18, 2026, Benevento, Italy
- **Pages**: 10 + 2 refs (long) or 5 + 1 ref (short)
- **Published**: YES — IEEE proceedings, indexed on DBLP

**Scope match**: Software maintenance and evolution in practice. Our agents maintain a codebase, but our paper is about the coordination system, not about maintenance.

**With data**: Medium. Data supports the paper but scope is stretched.

**Without data**: Weak. Same industry context issue as ASE Industry.

**Risk**: Scope mismatch — ICSME focuses on evolution of existing systems. Our agents built a NEW system.

#### ICSME 2026 Tool Demo
- **Deadline**: Abstract May 24 / Paper May 28, 2026
- **Conference**: September 14-18, 2026, Benevento, Italy
- **Pages**: 5 pages including references
- **Published**: YES — IEEE proceedings, indexed on DBLP

**Scope match**: Same as ASE Tools but for maintenance/evolution tools.

**Without data**: Viable with good screencast.

### Tier 3: Reach / Mismatch

#### NeurIPS 2026 Main
- **Deadline**: Abstract May 4 / Paper May 6, 2026
- **Pages**: 9 pages main text
- **Published**: YES — Curran Associates, DBLP

**Scope match**: ML theory and applications. Our work is SE/systems, not ML. No new model, algorithm, or theoretical contribution.

**Risk**: 20-25% acceptance rate. Reviewers expect ML contributions. "We measured token usage of a deployed system" is not an ML paper.

**Verdict**: Skip unless we can extract a pure ML contribution (e.g., "context window efficiency as a function of specialization" with theoretical analysis).

#### EMNLP 2026 Main
- **Deadline**: May 25 (ARR submission)
- **Pages**: 8 pages (long) or 4 pages (short)
- **Published**: YES — ACL Anthology, DBLP

**Scope match**: NLP/LLM applications. Same mismatch as NeurIPS — our work uses LLMs but doesn't contribute to NLP.

**Verdict**: Skip. The LLM is a black box in our architecture.

#### ISSRE 2026 Research
- **Deadline**: Apr 10-17
- **Pages**: 12 pages
- **Published**: YES — IEEE, DBLP

**Scope match**: Software reliability. We have failure modes but our paper isn't about reliability engineering.

**Verdict**: Skip. Scope mismatch too large.

---

## "With Data" vs "Without Data" Summary

| Venue | With Data | Without Data |
|---|---|---|
| **ASE NIER** | Strong (counterintuitive finding) | Medium (paradigm vision) |
| **ESEM Technical** | **Best fit** (empirical measurement) | Not viable |
| **ICSE SEIP** | Strong (practice report) | Medium (experience only) |
| **ICSE NIER** | Very strong (highest prestige) | Possible (pure vision) |
| ASE Industry | Medium (not industrial context) | Weak |
| ASE Tool Demo | Helps | Viable (needs screencast) |
| SEAA DAIDE | Good | Acceptable |
| ICSME Industry | Medium | Weak |
| ICSME Tool Demo | Helps | Viable |
| NeurIPS | Skip | Skip |
| EMNLP | Skip | Skip |
| ISSRE | Skip | Skip |

**The data is the difference between a 4-page tool demo and a 17-page ESEM paper.** Without data, we're limited to short-format venues (NIER, tool demo, SEAA). With data, ESEM and ICSE SEIP open up.

---

## Recommended Submission Strategy

### Path A: Empirical Paper (needs data)

```
May 18:   ESEM 2026 Technical (17 pages, empirical measurement)
          → If rejected:
Oct 23:   ICSE 2027 SEIP (10 pages, with controlled baseline added)
```

**Pros**: Best venues for our strength (data). High impact.
**Cons**: Needs careful methodology framing. No controlled baseline is a risk.

### Path B: New Idea Paper (works with or without data)

```
~Jul:     ASE 2026 NIER (4 pages, "1.18x" finding as new paradigm)
          → If rejected:
Oct 23:   ICSE 2027 NIER (4 pages, refined version)
```

**Pros**: Short paper is faster to write. The finding is inherently interesting. Data strengthens but isn't required.
**Cons**: NIER is competitive. Must frame as vision, not just measurement.

### Path C: Dual Submission (both angles)

```
May 18:   ESEM 2026 Technical (17 pages — full empirical paper)
~Jul:     ASE 2026 NIER (4 pages — different paper, "1.18x" finding only)
```

**This is allowed** — ESEM and ASE are different conferences, and the papers would have different focus (empirical methodology vs new idea). Check both CFPs for dual-submission policies.

**Pros**: Two shots at publication. Different audiences. Different framings.
**Cons**: Writing two papers. The 4-page NIER extracts from the 17-page ESEM which may create overlap concerns if both are accepted.

### Path D: Safe Publication + Stretch

```
Apr 15:   SEAA 2026 DAIDE (16 pages, Krakow, lower bar)
~Jul:     ASE 2026 NIER (4 pages, different paper)
```

**Pros**: SEAA is almost guaranteed publication. ASE NIER is the stretch goal.
**Cons**: SEAA is lower prestige.

---

## Timeline

| Date | Deadline | Action |
|---|---|---|
| **Apr 15** | SEAA 2026 | If going Path D: submit 16-page paper |
| **Apr 23** | ASE Industry | Only if we can frame as industry experience (risky scope) |
| **May 4-6** | NeurIPS | Skip (scope mismatch) |
| **May 11** | ASE Tool Demo | Only if making a screencast |
| **May 11** | ESEM abstract | If going Path A or C: submit structured abstract |
| **May 18** | ESEM paper | Submit 17-page empirical paper |
| **~Jul** | ASE NIER | If going Path B or C: submit 4-page "1.18x" paper |
| **Oct 23** | ICSE SEIP/NIER | Backup if ASE/ESEM rejected |

---

## Conference Proceedings Verification

All venues listed above publish in indexed proceedings. Verified against DBLP entries for 2024/2025 editions:

| Venue | Publisher | Indexed |
|---|---|---|
| ASE (all tracks) | ACM/IEEE | DBLP, ACM DL |
| ESEM Technical | ACM | DBLP, ACM DL |
| ICSE (all tracks) | ACM/IEEE | DBLP, ACM DL |
| SEAA | Springer LNCS (from 2025) | DBLP, SpringerLink |
| ICSME (all tracks) | IEEE | DBLP, IEEE Xplore |
| NeurIPS Main | Curran Associates | DBLP |
| EMNLP Main | ACL | DBLP, ACL Anthology |
| ISSRE Research | IEEE | DBLP, IEEE Xplore |

**NeurIPS/ICML workshops are NOT published in formal proceedings** (non-archival, OpenReview only).

---

## Sources

- ASE 2026: https://conf.researchr.org/home/ase-2026
- ASE 2026 Industry CFP: https://conf.researchr.org/track/ase-2026/ase-2026-industry-showcase
- ASE 2026 Tools CFP: https://conf.researchr.org/track/ase-2026/ase-2026-tools-and-data-sets
- ASE 2024 DBLP: https://dblp.org/db/conf/kbse/ase2024.html
- ESEM 2026: https://conf.researchr.org/track/eseiw-2026/eseiw-2026-esem---technical-track
- ESEM 2024 ACM: https://dl.acm.org/doi/proceedings/10.1145/3674805
- ICSE 2027: https://conf.researchr.org/home/icse-2027
- ICSE 2027 Research: https://conf.researchr.org/track/icse-2027/icse-2027-research-track
- ICSE 2027 SEIP: https://conf.researchr.org/track/icse-2027/icse-2027-seip
- ICSE-SEIP 2024 ACM: https://dl.acm.org/doi/proceedings/10.1145/3639477
- ICSME 2026: https://conf.researchr.org/home/icsme-2026
- ICSME 2024 DBLP: https://dblp.org/db/conf/icsm/icsme2024.html
- SEAA 2026: https://dsd-seaa.com/seaa2026/
- SEAA 2025 Springer: https://link.springer.com/book/9783032041890
- NeurIPS 2026: https://neurips.cc/Conferences/2026/CallForPapers
- EMNLP 2026: https://2026.emnlp.org/calls/main_conference_papers/
- ISSRE 2026: https://cyprusconferences.org/issre2026/
- SE Deadlines Tracker: https://se-deadlines.github.io/
