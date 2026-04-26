# Model-era compatibility

**Agent rule sets are version-dependent.** Claude model releases shift behavioral defaults in ways that affect autonomous operation, and rule sets calibrated for one model version may produce friction on the next. This rule documents version-specific behavior + adjustments + a maintenance template for future releases.

---

## Why this exists

Each major Claude release has subtly different defaults around:

- **Instruction generalization** — does the model silently broaden a request from one item to many similar items?
- **Subagent dispatch** — does the model proactively delegate to specialized subagents (Explore, Task) or prefer direct reasoning?
- **Tool-call propensity** — does the model run many small tool calls or favor doing more reasoning per call?
- **Response-length calibration** — does the model match prose length to prompt length, or default to verbose / terse?
- **Safeguard triggers** — does the model refuse legitimate domain work (security testing, content analysis) on cybersecurity / abuse classifiers?

Old rule sets that assume one set of defaults break on different defaults. The fix is **not** prompting the model to behave like the old version; it's calibrating rule sets to the current model's defaults.

---

## Notes for Opus 4.7+ (current as of 2026-04-26)

Claude Opus 4.7 differs from earlier models in ways that matter for autonomous work:

### Literal instruction following

The model does not silently generalize an instruction from one item to another, or infer requests you didn't make.

- **Be explicit about scope.** If you want a change applied across multiple files, list them or say "all files matching X."
- "Update the docs" applied to one file when 15 are relevant is a feature not a bug — narrow the scope explicitly.

### Fewer subagents by default

The model prefers direct reasoning over delegation. If you want subagent dispatch (e.g., `feature-dev:code-reviewer`, `Explore`), request it explicitly in the rule or prompt.

- Workflows that previously relied on automatic subagent dispatch may now run as single-context.
- If a task benefits from parallel exploration or context isolation, name the subagent in the directive.

### Fewer tool calls by default

If a task seems underdone or reasoning seems shallow, don't prompt around it — check the `effortLevel` in `settings.json`. The MACF template defaults to `xhigh` for agentic work. Lower values (`low`, `medium`) scope narrower.

### Response length calibrated to complexity

Short prompts get short answers; open-ended analysis gets long ones. If you need a specific verbosity, say so explicitly ("brief" / "detailed" / "comprehensive" qualifiers).

### Cybersecurity safeguards may refuse legitimate work

Penetration testing, red-teaming, security research, and similar legitimate domain work may trigger refusals. For those use cases, apply to Anthropic's Cyber Verification Program; safeguards are intentionally conservative.

---

## Bash deny-rule coverage (Claude Code v2.1.113+)

The `Bash(...)` deny patterns (sudo, `git push --force*`, `docker push *`, `rm -rf /`, `git commit --no-verify`) match commands wrapped in common exec wrappers as of Claude Code v2.1.113: `env`, `sudo`, `watch`, `ionice`, `setsid`, and similar. So `env sudo rm -rf /` or `watch sudo docker push ...` are caught by existing denies without needing to enumerate every wrapped variant.

This is a Claude Code-level behavior change, not a template-level rule change — but worth knowing the surface area is wider than the literal patterns suggest.

---

## How rule sets stay current across model releases

When a new Claude version lands:

1. **Audit the high-impact behavioral surfaces** above (instruction generalization, subagent dispatch, tool propensity, response length, safeguards) against the new version's defaults.
2. **Capture observed differences:**
   - **If the new version's defaults match the existing latest section** (no behavioral shift on the catalogued surfaces), extend the existing section header to cover the new version (e.g., `## Notes for Opus 4.7+, 5.0+`). Document any newly-discovered surfaces inline.
   - **If the new version's defaults differ** on any catalogued surface, add a NEW section dated `## Notes for <Model> <Version>+` AND mark the previous section with an end-of-applicability range (e.g., `## Notes for Opus 4.7+ (4.7 only — superseded by 5.0)`).
   - This convention preserves the version-stack history without ambiguity about which sections apply to which model versions.
3. **Update rule sets that depended on the old defaults.** Common targets:
   - Rules assuming "the model will figure out the broader scope" → make scope explicit
   - Rules depending on automatic subagent dispatch → name the subagent
   - Effort-level expectations → calibrate against new defaults
4. **Distribute via canonical PR + `macf update`** to consumer workspaces.

This is part of the **substrate-evolution maintenance loop**: model behavior shifts → substrate agents observe friction → friction codified in workbench → promoted to canonical → distributed.

---

## Why this rule exists

The model-era-compatibility surface was discovered empirically during 2026-04 Opus 4.7 rollout. Devops-agent observed multiple friction points where workflows that worked in earlier sessions stopped working — not because the rules were wrong, but because the underlying model's defaults had shifted. Codifying the differences + maintenance pattern prevents future agents from re-discovering the same tuning problems.

The behavioral-divergence catalog is **load-bearing for autonomous agent operation**: agents that don't account for the current model's defaults produce work that's underdone (fewer tool calls than the task warrants) or overdone (verbose where terse was wanted) or scope-limited (instructions interpreted literally where broader generalization was expected).

This is also a **paper-grade observation**: agent rule sets in production multi-agent systems require explicit version-dependent maintenance. Each Claude release is a substrate-evolution event that triggers a small wave of rule recalibration.

---

## Cross-references

- `peer-dynamic.md` § "Response form" — verbosity expectations interact with model-era response-length calibration
- `coordination.md` § "Communication" — concise-comments rule depends on model not adding gratuitous prose
- `groundnuty/macf-devops-toolkit:.claude/rules/autonomous-work.md` — original source of the Opus 4.7 notes (substrate-evolution origin)
