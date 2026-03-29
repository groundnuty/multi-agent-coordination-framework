# MACF Workspace and Repository Design

Date: 2026-03-28
Context: Complete layout of repos, agents, workspaces, and org structure for the MACF project.

---

## Organization Structure

```
groundnuty/ (personal)
  multi-agent-coordination-framework   ← the framework tool (macf CLI)

macf-experiment/ (org)
  macf-paper                           ← conference paper (LaTeX)
  macf-experiments                     ← experiment data, analysis, findings
  macf-daytrader-T1                    ← DayTrader fork for task 1
  macf-daytrader-T2                    ← DayTrader fork for task 2
  macf-daytrader-T3                    ← DayTrader fork for task 3
  macf-daytrader-T4                    ← DayTrader fork for task 4
  macf-daytrader-T5                    ← DayTrader fork for task 5
```

---

## Permanent Agents (Long-Lived)

| Agent | Working Dir | Role | Sees |
|---|---|---|---|
| **code-agent** | `multi-agent-coordination-framework` | Implements framework features | Framework code only |
| **science-agent** | `macf-experiments` | Designs experiments, analyzes results, files issues on all repos | All experiment data + findings |
| **writing-agent** | `macf-paper` | Writes LaTeX, formats tables/figures | Paper content only |

Cross-repo interactions:
- Science-agent files issues on `multi-agent-coordination-framework` with `--repo` flag
- Science-agent files issues on `macf-paper` with `--repo` flag
- Science-agent files issues on `macf-daytrader-T*` with `--repo` flag
- Writing-agent may read findings from `macf-experiments` via subagent exploration

---

## Experiment Agents (Disposable, Per-Run)

| Agent | Role | GitHub Identity |
|---|---|---|
| **exp-science-agent** | Files issues, reviews PRs (Condition B) | `macf-exp-science[bot]` |
| **exp-code-agent** | Implements tasks (Condition B) | `macf-exp-code[bot]` |
| **exp-single-agent** | Does everything (Condition A) | `macf-exp-single[bot]` |

Fresh context per run. No memory, no accumulated learning. Controlled conditions.

---

## GitHub Apps (6 total)

| App | Type | Installed On |
|---|---|---|
| `macf-science-agent` | Permanent | All repos (framework, paper, experiments, daytrader forks) |
| `macf-code-agent` | Permanent | `multi-agent-coordination-framework` |
| `macf-writing-agent` | Permanent | `macf-paper` |
| `macf-exp-science` | Experiment | All `macf-daytrader-T*` forks |
| `macf-exp-code` | Experiment | All `macf-daytrader-T*` forks |
| `macf-exp-single` | Experiment | All `macf-daytrader-T*` forks |

---

## Agent Registry

Per-org variables (macf-experiment):
```
MACF_AGENT_science_agent   = {"host":"vm1.tailnet","port":8788}
MACF_AGENT_writing_agent   = {"host":"vm1.tailnet","port":8790}
MACF_AGENT_code_agent      = {"host":"vm1.tailnet","port":8789}  (mirrored from groundnuty)
MACF_AGENT_exp_science     = {"host":"...","port":...}           (ephemeral)
MACF_AGENT_exp_code        = {"host":"...","port":...}           (ephemeral)
MACF_AGENT_exp_single      = {"host":"...","port":...}           (ephemeral)
```

Repo-level variable (groundnuty/multi-agent-coordination-framework):
```
MACF_AGENT_code_agent      = {"host":"vm1.tailnet","port":8789}
```

Code-agent registers in both places (repo-level for its own Action, org-level for cross-repo discovery).

---

## Experiment Workspace Layout

Each experiment run gets an isolated workspace on disk. Two clones for multi-agent (science RO, code RW). Full isolation between agents.

### Condition A: Single Agent

```
/tmp/macf-runs/T1-rep1-A/
  single/                             exp-single-agent's clone
    .claude/
      rules/agent-identity.md         (single-agent variant)
      rules/gh-token-refresh.md
      settings.local.json
    .github-app-key.pem
    (DayTrader code — full clone, READ-WRITE)
```

### Condition B1: Multi-Agent, Code-Aware Science

```
/tmp/macf-runs/T1-rep1-B1/
  science/                            exp-science-agent's clone (READ-ONLY)
    .claude/
      rules/agent-identity.md         (science variant, code-aware)
      rules/gh-token-refresh.md
      settings.local.json
    .github-app-key.pem
    (DayTrader code — full clone, can pull, READ-ONLY)

  code/                               exp-code-agent's clone (READ-WRITE)
    .claude/
      rules/agent-identity.md         (code-agent variant)
      rules/gh-token-refresh.md
      settings.local.json
    .github-app-key.pem
    (DayTrader code — full clone, creates branches, PRs)
```

### Condition B2: Multi-Agent, Domain-Only Science

```
/tmp/macf-runs/T1-rep1-B2/
  science/                            exp-science-agent workspace (NO CODE)
    .claude/
      rules/agent-identity.md         (science variant, domain-only)
      rules/gh-token-refresh.md
      settings.local.json
    .github-app-key.pem
    task.md                           task description only, no DayTrader code

  code/                               exp-code-agent's clone (READ-WRITE)
    .claude/
      rules/agent-identity.md         (code-agent variant)
      rules/gh-token-refresh.md
      settings.local.json
    .github-app-key.pem
    (DayTrader code — full clone, creates branches, PRs)
```

---

## Experiment Run Matrix

| Task | A (single) | B1 (multi, code-aware) | B2 (multi, domain-only) | Total |
|---|---|---|---|---|
| T1: Health check | 3 | 3 | 3 | 9 |
| T2: EJB to CDI | 3 | 3 | 3 | 9 |
| T3: Extract service | 3 | 3 | 3 | 9 |
| T4: OTel tracing | 3 | 3 | 3 | 9 |
| T5: Docker compose | 3 | 3 | 3 | 9 |
| **Total** | **15** | **15** | **15** | **45** |

---

## Harness Script Workflow

```
For each task T1-T5:
  For each rep 1-3:

    Condition A:
      1. Clone macf-daytrader-{task} to /tmp/macf-runs/{task}-rep{rep}-A/single/
      2. Copy single-agent config to .claude/
      3. Start exp-single-agent in that directory
      4. Agent receives task, implements, self-reviews, creates PR
      5. Collect session logs + metrics

    Condition B1:
      1. Clone to /tmp/.../B1/science/ (RO) and /tmp/.../B1/code/ (RW)
      2. Copy science-agent (code-aware) config and code-agent config
      3. Start both agents
      4. Send task to science-agent (via channel)
      5. Science reads code, files issue on macf-daytrader-{task}
      6. Action routes to code-agent
      7. Code implements, creates PR, asks for review
      8. Action routes to science-agent
      9. Science reviews, LGTM or requests changes
      10. Code merges after LGTM
      11. Collect session logs + metrics + communication data

    Condition B2:
      1. Create /tmp/.../B2/science/ with task.md only (NO clone)
      2. Clone to /tmp/.../B2/code/ (RW)
      3. Copy science-agent (domain-only) config and code-agent config
      4. Same flow as B1 but science can only write domain-level specs
      5. Collect session logs + metrics + communication data
```

---

## Results Storage

```
macf-experiments/
  tasks/
    T1-health-check.md
    T2-ejb-cdi.md
    T3-extract-quotes.md
    T4-otel-tracing.md
    T5-docker-compose.md

  runs/
    T1-rep1-A/
      session-logs/single-agent.jsonl
      metrics.json
      quality.json
      github.json

    T1-rep1-B1/
      session-logs/science-agent.jsonl
      session-logs/code-agent.jsonl
      metrics.json
      quality.json
      github.json
      communication.json

    T1-rep1-B2/
      session-logs/science-agent.jsonl
      session-logs/code-agent.jsonl
      metrics.json
      quality.json
      github.json
      communication.json

    (45 run directories total)

  analysis/
    extract-metrics.py
    compare-conditions.py
    generate-tables.py
    plots/

  findings/
    (paper science-agent writes here)
```

---

## Framework Repo Structure

```
groundnuty/multi-agent-coordination-framework/
  channel/
    server.ts               MCP channel server (HTTP + mTLS)
    register.ts             org variable registration
    health.ts               /health endpoint
    types.ts
    package.json

  certs/
    setup-ca.sh             generates CA + agent certs
    ca-cert.pem             committed (public)
    .gitignore              ignores key files

  templates/
    agent-router.yml        GitHub Action (HTTP POST, reads org vars)
    agent-identity/
      code-agent.md
      science-agent.md
      writing-agent.md
      exp-single.md
      exp-science-code-aware.md
      exp-science-domain-only.md
      exp-code.md
    gh-token-refresh.md
    settings.local.template.json
    claude.sh.template
    mcp.json.template

  setup/
    setup.ts                Chrome + CLI automation
    setup-repo.ts           per-repo setup (labels, Action, board)
    setup-agent.ts          per-agent setup (GitHub App, certs, config)

  cli/
    macf.ts                 CLI entry point
    commands/
      setup.ts              macf setup
      run.ts                macf run (experiment harness)
      status.ts             macf status (query agent registry)
      health.ts             macf health (ping all agents)

  CLAUDE.md
  README.md
  package.json
```

---

## CLI Commands

```bash
macf setup --org macf-experiment          # set up org (variables, secrets)
macf setup --repo macf-paper              # set up repo (labels, Action, board)
macf setup --agent science-agent          # set up agent (GitHub App via Chrome, certs, config)

macf status                               # list all registered agents
macf health                               # ping all agents
macf health code-agent                    # ping specific agent

macf run --task T1 --condition A --reps 3  # run experiment condition
macf run --task all --condition all        # run full experiment (45 runs)

macf collect --run T1-rep1-B1             # collect results from a run
macf analyze                              # generate tables and plots
```
