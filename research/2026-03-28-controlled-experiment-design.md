# Controlled Experiment: Single-Agent vs Multi-Agent on DayTrader Migration

Date: 2026-03-28
Purpose: Design a controlled experiment comparing single-agent and multi-agent execution of real SE tasks, to provide the missing baseline for the "1.18x overhead" claim.

---

## Motivation

Our empirical analysis of the CPC multi-agent system measured 1.18x output token overhead vs an ESTIMATED single-agent baseline. Reviewers at ESEM, ICSE, or ASE will ask: "How do you know single-agent would cost X?"

This experiment provides a CONTROLLED comparison by running the SAME tasks under both conditions on the SAME codebase.

---

## The Codebase: DayTrader 7

**Repository**: https://github.com/WASdev/sample.daytrader7 (45 stars)

**What it is**: The DayTrader 7 benchmark — a Java EE 7 application built around an online stock trading system. Classic monolith used extensively in migration/modernization research.

**Size**:
- 913K bytes of Java
- 259K bytes of HTML
- ~8.2 MB total
- Modules: `daytrader-ee7-ejb` (business logic), `daytrader-ee7-web` (web tier), `daytrader-ee7` (parent)
- Build: Maven
- DB: Derby/DB2
- Container: Docker
- CI: Travis

**Why DayTrader**:
1. Real-world complexity — not a toy project
2. Classic modernization target — EJB→CDI, monolith→microservices, Java EE→Jakarta EE
3. Well-known in SE research community (used in migration studies)
4. Publicly available, forkable, reproducible
5. We already have migration plans for it from CPC experiments (5 tasks × multiple conditions)

---

## Experiment Design

### Independent Variable

| Condition | Description | Context |
|---|---|---|
| **A: Single-agent** | One Claude Code session, one context window. Receives task, implements, self-reviews, creates PR. | 1M context, Opus 4.6 |
| **B: Multi-agent** | Science-agent files issue with specs. Code-agent implements. Science-agent reviews. Turn-based via GitHub routing. | Same model, same context per agent |

### Task Set

Five migration/modernization tasks of increasing complexity, all realistic and commonly encountered in Java EE modernization projects:

#### T1: Add Health Check Endpoint (Simple)
**Description**: Add a `/health` REST endpoint to the web module that returns `{"status": "UP", "timestamp": "<ISO8601>"}`. Must be accessible without authentication.

**Expected changes**:
- Create 1 new Java file (`HealthCheckResource.java`)
- Possibly modify `web.xml` or add JAX-RS application config
- Add 1 test

**Why this task**: Tests basic file creation and understanding of the web module structure. Minimal code reading required.

**Estimated effort**: ~15 minutes for a human developer.

#### T2: Replace EJB with CDI in Trade Service (Medium)
**Description**: In the EJB module, replace `@Stateless` session bean annotations with CDI `@ApplicationScoped` for the `TradeSLSBBean` class. Update all injection points from `@EJB` to `@Inject`. Ensure existing functionality is preserved.

**Expected changes**:
- Modify `TradeSLSBBean.java` — change annotations
- Modify all classes that inject it — `@EJB` → `@Inject`
- May need to add `beans.xml` or modify existing CDI config
- Verify build still compiles

**Why this task**: Tests multi-file refactoring within a module. Requires understanding injection patterns and EJB/CDI differences.

**Estimated effort**: ~30-45 minutes for a human developer.

#### T3: Extract Quotes Microservice (Complex)
**Description**: Extract the stock quotes functionality (`QuoteDataBean`, `QuoteData`) into a standalone microservice with a REST API. The main application should call the new microservice via HTTP instead of direct method calls. Create a new Maven module `daytrader-quotes-service`.

**Expected changes**:
- Create new Maven module with `pom.xml`
- Move/copy quote-related classes
- Create REST API layer in the new service
- Modify the main application to use HTTP client instead of direct calls
- Add Docker compose entry for the new service
- Update parent `pom.xml`

**Why this task**: Tests architectural decomposition — the hardest migration task. Requires understanding of the entire codebase, data flow, and service boundaries.

**Estimated effort**: ~2-4 hours for a human developer.

#### T4: Add OpenTelemetry Tracing (Medium, Cross-Cutting)
**Description**: Add OpenTelemetry tracing to all EJB method calls in the trade service. Each method should create a span with the method name, and trace context should propagate across EJB calls. Add the OTel dependency to `pom.xml`.

**Expected changes**:
- Add OpenTelemetry dependency to `pom.xml`
- Create a CDI interceptor for tracing OR add manual span creation
- Apply interceptor to target EJBs
- Configure trace exporter (OTLP to stdout for testing)

**Why this task**: Tests adding a cross-cutting concern that touches many files. Requires understanding of interceptor patterns and EJB lifecycle.

**Estimated effort**: ~1-2 hours for a human developer.

#### T5: Multi-Stage Docker Build + Compose (Medium, Infrastructure)
**Description**: Replace the existing single-stage `Dockerfile` with a multi-stage build (build stage with Maven, runtime stage with Liberty). Create a `docker-compose.yml` that runs the app + a Derby database. The app should be accessible on port 9080.

**Expected changes**:
- Rewrite `Dockerfile` as multi-stage
- Create `docker-compose.yml`
- May need to adjust Liberty server config
- Add health check to compose

**Why this task**: Tests infrastructure modernization. Requires understanding of the build process and runtime configuration.

**Estimated effort**: ~30-60 minutes for a human developer.

### Task Presentation

Each task is presented as a structured description (same text for both conditions):

```markdown
## Task: [Title]

### Background
[1-2 sentences about DayTrader and what module this affects]

### Requirements
[Numbered list of what must be done]

### Acceptance Criteria
- [ ] Build passes: `mvn clean package`
- [ ] [Task-specific verification]
- [ ] Changes are committed with descriptive message
- [ ] PR created with description of changes
```

For Condition B (multi-agent), the science-agent receives this description and files it as an issue. The task description is NOT pre-optimized for either condition — it's a neutral SE task description.

### Repetitions

Each task is run 3 times per condition to measure variance:

| Task | Condition A (single) | Condition B (multi) | Total |
|---|---|---|---|
| T1: Health check | 3 runs | 3 runs | 6 |
| T2: EJB→CDI | 3 runs | 3 runs | 6 |
| T3: Extract service | 3 runs | 3 runs | 6 |
| T4: OTel tracing | 3 runs | 3 runs | 6 |
| T5: Docker compose | 3 runs | 3 runs | 6 |
| **Total** | **15 runs** | **15 runs** | **30 runs** |

Each run starts from a fresh fork/clone of DayTrader7 (same commit hash).

---

## Measurement Protocol

### Token Metrics (from session logs)

For each run, extract from `~/.claude/projects/<project>/*.jsonl`:

| Metric | How | Script |
|---|---|---|
| Output tokens | Sum `usage.output_tokens` across all API calls | `analyze_sessions()` from token-usage-empirical-analysis.md |
| Effective input tokens | Sum `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` | Same script |
| Cache hit rate | `cache_read / (input + cache_create + cache_read)` | Same script |
| Context growth | Effective input at first 10% vs last 10% of API calls | `analyze_context_growth()` |
| API calls | Count messages with `usage` field | Same script |
| Tool calls | Count `tool_use` blocks | Same script |
| `gh` commands | Count `tool_use` blocks with `gh ` in command | Same script |

### Quality Metrics

| Metric | How |
|---|---|
| Build passes | `mvn clean package` exit code (0 = pass) |
| Task-specific acceptance | Manual check of acceptance criteria |
| Code compiles | Part of build |
| Tests pass | `mvn test` exit code |
| Lint / static analysis | SpotBugs or PMD if configured |

### Process Metrics

| Metric | How |
|---|---|
| Wall-clock time | `timestamp` of first and last JSONL entry |
| Number of errors/retries | Count tool_use results with error indicators |
| Self-corrections | Count instances where agent noticed and fixed its own mistake |
| Review findings (Condition B only) | Count substantive review comments from science-agent |
| Compaction events | Detect context drops >50% between consecutive API calls |

### Communication Metrics (Condition B only)

| Metric | How |
|---|---|
| Issue body tokens | Characters / 4 |
| Comment tokens | Characters / 4 |
| Review comment tokens | Characters / 4 |
| Total communication overhead | Sum of above |
| Routing latency | Time from issue creation to code-agent receiving prompt |

---

## Execution Protocol

### Condition A: Single-Agent

```bash
# 1. Fresh fork of DayTrader7
gh repo fork WASdev/sample.daytrader7 --clone --remote
cd sample.daytrader7

# 2. Start Claude Code with same settings as code-agent
claude --permission-mode acceptEdits

# 3. Present the task
# (paste the task description as the first prompt)

# 4. Agent works autonomously
# - Reads code, implements, tests, creates PR
# - Self-reviews before creating PR
# - Session ends when agent says "done" or creates PR

# 5. Record session ID for log extraction
```

Repeat 3 times per task, fresh fork each time.

### Condition B: Multi-Agent

```bash
# 1. Fresh fork of DayTrader7 with agent coordination setup
gh repo fork WASdev/sample.daytrader7 --clone --remote
cd sample.daytrader7
# Copy: .github/agent-config.json, .github/workflows/agent-router.yml
# Copy: .claude/rules/agent-identity.md, .claude/rules/gh-token-refresh.md
# Create labels: code-agent, science-agent, in-progress, in-review

# 2. Start both agents
./claude.sh  # (from code-agent dir)
./claude.sh  # (from science-agent dir)

# 3. Science-agent receives the task description
# (paste to science-agent, which files an issue with code-agent label)

# 4. Agents coordinate autonomously
# - Science-agent files issue → routing → code-agent implements
# - Code-agent creates PR → routing → science-agent reviews
# - If changes requested: code-agent fixes → science-agent re-reviews
# - Code-agent merges after LGTM

# 5. Record session IDs for both agents
```

Repeat 3 times per task, fresh fork each time.

### Controls

| Control | Why | How |
|---|---|---|
| Same model | Eliminate model capability as variable | Both use `claude-opus-4-6` with 1M context |
| Same permission mode | Eliminate permission prompts as variable | Both use `acceptEdits` |
| Same codebase state | Eliminate code differences | Fresh fork from same commit hash |
| Same task description | Eliminate prompt quality as variable | Identical text for both conditions |
| Same machine | Eliminate hardware as variable | Run on same laptop |
| Fresh context per run | Eliminate context carryover | New Claude Code session, no `--resume` |
| Randomized order | Eliminate learning effects | Randomize which condition runs first per task |

### What We Don't Control (Threats to Validity)

| Threat | Impact | Mitigation |
|---|---|---|
| LLM non-determinism | Different outputs each run | 3 repetitions per condition, report mean + variance |
| Token cache warming | First run may have worse cache | Discard first run as warm-up? Or report all 3. |
| Time of day / API load | May affect latency | Record timestamps, report both tokens and wall-clock |
| Condition B setup overhead | agent-router, labels, config files | Don't count setup time, only task execution time |
| Science-agent issue quality | May vary between runs | Use same human-written task description; science-agent only reformats |

---

## Expected Outcomes

### Hypothesis 1: Multi-Agent Output Overhead is ~1.2x

Based on our CPC data (1.18x), we expect multi-agent to produce ~20% more output tokens due to:
- Issue creation + review comments
- `gh` command overhead
- Token refresh

### Hypothesis 2: Multi-Agent Input May Be CHEAPER

Based on our cache analysis, focused context windows should have better cache hit rates. Single-agent accumulates context from all tasks; multi-agent resets between agent turns.

### Hypothesis 3: Multi-Agent Catches More Errors

Based on DoT literature (Liang et al., 2023) and our CPC experience (#244 baseline mismatch, #287 keying bug), cross-agent review should catch errors that self-review misses.

### Hypothesis 4: Complex Tasks Benefit More from Multi-Agent

Simple tasks (T1) may show overhead without benefit — science-agent review is rubber-stamp for trivial changes. Complex tasks (T3) should show more value from cross-review.

### Possible Surprise: Single-Agent Wins on Simple Tasks

If multi-agent overhead dominates and review adds no value for simple tasks, single-agent may be cheaper AND faster for T1/T5. This would support the asymmetric context strategy — delegate simple tasks to fresh workers, use multi-agent only for complex tasks.

---

## Analysis Plan

### Primary Analysis: Token Overhead per Condition

For each task × condition, compute:
- Mean output tokens (across 3 runs)
- Mean effective input tokens
- Mean total tokens
- Overhead ratio = multi-agent / single-agent

Report as table:

| Task | Single-Agent (mean±sd) | Multi-Agent (mean±sd) | Ratio |
|---|---|---|---|
| T1: Health | ... | ... | ... |
| T2: EJB→CDI | ... | ... | ... |
| T3: Extract | ... | ... | ... |
| T4: OTel | ... | ... | ... |
| T5: Docker | ... | ... | ... |
| **Overall** | ... | ... | **...x** |

### Secondary Analysis: Context Growth

Plot effective input per API call over time for each run. Compare:
- Single-agent: one curve, growing throughout
- Multi-agent code-agent: curve resets between issues (if fresh-per-issue pattern)
- Multi-agent science-agent: two brief periods (file issue, review PR)

### Tertiary Analysis: Quality

| Task | Single-Agent Quality | Multi-Agent Quality | Review Findings |
|---|---|---|---|
| T1 | Build pass? Criteria met? | Same + review feedback | What did science-agent catch? |
| ... | ... | ... | ... |

### Statistical Tests

With 3 repetitions per condition per task:
- Mann-Whitney U test (non-parametric, small sample) for token differences per task
- Wilcoxon signed-rank test across tasks (paired by task)
- Report effect sizes (Cohen's d) even if not significant — small sample, exploratory study

---

## Estimated Cost

### Per Run
- Single-agent: ~100-500 API calls × ~100K avg context = ~10-50M effective input + ~50-200K output
- Multi-agent: similar per agent, but split across two agents + routing overhead

### Total
- 30 runs × ~30M average effective input per run = ~900M tokens
- On Claude Max: included in subscription
- On API: ~$15-50 at current pricing (mostly cache reads)
- Wall-clock: ~30 runs × ~20 min average = ~10 hours total

### Infrastructure
- DayTrader fork: free (GitHub)
- Agent coordination setup: ~30 min one-time (copy config files, create labels)
- Maven/Java: need JDK 8+ and Maven on the machine

---

## What This Proves (for the paper)

| Finding | What the experiment adds |
|---|---|
| "1.18x not 4-15x" | Controlled measurement, not just observational. If confirmed, this is a strong empirical result. |
| "Communication is cheap" | Direct measurement of GitHub artifact size vs total tokens per task. |
| "Focused windows cache better" | Compare cache hit rates between conditions. |
| "Cross-review catches errors" | Document what science-agent catches that single-agent misses. |
| "Overhead depends on task complexity" | Break down by task type — simple vs complex. |

### If the Experiment Shows Single-Agent is Cheaper

That's also publishable! "Multi-agent overhead is justified for complex tasks but not simple ones" is a nuanced finding. It supports the orchestrator-worker pattern: delegate simple tasks to fresh workers (single-agent pattern), use multi-agent review only for complex tasks.

---

## Relationship to Existing CPC Data

| Data Source | Role in Paper |
|---|---|
| **CPC production data** (10.5T tokens) | Motivating observation: "we measured 1.18x in production" |
| **DayTrader experiment** (this) | Controlled validation: "we confirmed with controlled experiment" |
| **Combined** | "Observational data from production (N=128 issues) + controlled experiment (N=30 runs)" |

The CPC data provides ecological validity (real project, real work). The DayTrader experiment provides internal validity (controlled conditions, same task, measurable differences).

---

## Timeline

| Day | Activity |
|---|---|
| 1 | Fork DayTrader, set up agent coordination, verify build works |
| 2 | Write 5 task descriptions, pilot 1 run per condition |
| 3-4 | Run T1-T3 (18 runs: 3 tasks × 2 conditions × 3 reps) |
| 5-6 | Run T4-T5 (12 runs: 2 tasks × 2 conditions × 3 reps) |
| 7 | Extract data, run analysis scripts, generate tables/plots |
| 8 | Write up results section |

**Total: ~8 days** from start to results.

---

## References

- DayTrader 7: https://github.com/WASdev/sample.daytrader7
- DayTrader in modernization research: widely cited in Java EE migration studies
- Liang et al. (2023), "Encouraging Divergent Thinking through Multi-Agent Debate" — DoT problem: https://arxiv.org/abs/2305.19118
- Our token analysis methodology: `research/2026-03-28-token-usage-empirical-analysis.md`
- Our multi-agent vs single-agent literature review: `research/2026-03-28-multi-agent-vs-single-agent-analysis.md`
