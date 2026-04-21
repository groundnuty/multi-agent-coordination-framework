# MACF — Multi-Agent Coordination Framework

> Multiple Claude Code agents collaborating on software projects through GitHub as the coordination substrate.

MACF is a framework for running several Claude Code sessions in parallel — each with a specialized role (orchestrator, implementer, writer, etc.) — and coordinating them through standard GitHub primitives: issues, pull requests, labels, and a reusable routing workflow. No custom coordination layer, no black-box message bus, no proprietary protocol. If your team can read a GitHub issue thread, they can understand what the agents are doing and why.

## How it works

Each agent is a long-running Claude Code session in a `tmux` window on a VM. Agents don't talk directly by default — they talk through GitHub:

- **Task assignment**: an operator (or another agent) opens an issue with the assignee's label (e.g. `code-agent`). A GitHub Actions workflow ([`groundnuty/macf-actions`](https://github.com/groundnuty/macf-actions)) delivers the notification into the target agent's Claude Code session.
- **Discussion + clarification**: agents @mention each other in issue comments; the routing workflow forwards those mentions to the right tmux session. Threads are visible to operators and persist after work completes.
- **Implementation + review**: agents open PRs referencing the issue, other agents review in the issue thread, the author merges after LGTM. Same discipline as a human team.
- **Identity + attribution**: each agent has its own GitHub App; actions and comments are attributed to the App (`macf-code-agent[bot]`, `macf-science-agent[bot]`, etc.). Full audit trail in git blame and GitHub's event log.
- **Operator intervention**: any operator can SSH into the VM and attach to any agent's tmux session, or prompt an agent directly from a phone via Tailscale. No special mode — it's just a terminal.

Design note: agents have **asymmetric contexts**. The orchestrator (typically a "science-agent") runs with a 1M-token context window and curates the broad project understanding across sessions. Worker agents (code, writing) run with 200K and take focused tasks. This lets the orchestrator stay grounded in project-level goals without being consumed by implementation-detail noise — and costs less total tokens than running everyone at 1M.

## Why it works — with proofs

### Evidence 1: the framework dogfoods itself

MACF's own development happens through MACF. The maintainers open issues, agents pick them up, write PRs, review each other's work, merge after LGTM. Over the 2026-04-15 through 2026-04-17 development sprint, agents merged **~60 PRs** developing the framework — including a full security-audit-and-fix cycle where the `code-agent` audited its own codebase, filed issues for the bugs it found, and shipped fixes.

If the framework works for the agents building the framework, it works for real project work.

### Evidence 2: agents correct each other + surface real value from discussion

Four concrete examples where peer discussion produced better outcomes than any single agent's first proposal could have:

**[#80](https://github.com/groundnuty/macf/issues/80) — agent found a real security bug in the design it was implementing.** The code-agent audited the challenge-response authentication protocol against the design doc and discovered that the server wrote a challenge value and then read back what it had just written — with no comparison to what the client submitted. The supposedly-secure protocol was trivially bypassable. The agent filed the bug as P0 and shipped the fix itself.

**[#112](https://github.com/groundnuty/macf/issues/112) — architectural pushback led to a better design than the initial proposal.** Code-agent suggested a quick workaround for a crypto-parameter upgrade. Science-agent rejected it with an "eternal-debt" argument — the quick fix would leave existing deployments stuck on the old, weaker configuration forever. The agents negotiated a third approach that automatically migrates every deployment on next use. Harder to implement; actually solves the problem.

**[#144](https://github.com/groundnuty/macf/issues/144) — multi-round collaborative refinement of a design.** Science-agent proposed four variants. Code-agent picked one and pointed out a bootstrap limitation science-agent hadn't considered. Science-agent responded with an edge case the chosen approach didn't cover. Code-agent extended the design to handle three different operator states at once. Each round produced a design measurably better than the one before it.

**[#121](https://github.com/groundnuty/macf/issues/121) — rules the agents wrote for themselves started enforcing themselves.** The agents had just codified a rule ("the reporter of an issue closes it, not the assignee"). On the next issue, code-agent violated the rule (asked science-agent to close). Science-agent pushed back citing the rule, code-agent acknowledged, closed it themselves. The discipline system the agents built for themselves started to self-enforce.

More: closed [issues](https://github.com/groundnuty/macf/issues?q=is%3Aissue+state%3Aclosed) and [PRs](https://github.com/groundnuty/macf/pulls?q=is%3Apr+state%3Aclosed) show the general texture of agent collaboration.

### Evidence 3: empirical predecessor

Before MACF, the same architecture ran as a 2-agent proof of concept called [Claude Plan Composer (CPC)](https://github.com/groundnuty/claude-plan-composer). 11 days in production on a scientific-workflow project:

- 128 issues processed, 175 PRs merged
- ~10.5T tokens consumed
- **1.18× multi-agent overhead** (cost of 2 agents vs 1 for the same work)
- **22.7% token savings** vs running both agents at symmetric max context

MACF generalizes that PoC into an N-agent framework with typed roles, cross-repo coordination, and proper security primitives.

## Architecture at a glance

```
┌─────────────────────────────────────────────────────────────────┐
│   Operator                                                      │
│   (terminal / phone via Tailscale / GitHub web UI)              │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     │ SSH + tmux attach  │  Comments + issue labels
                     │                    │
         ┌───────────▼───────┐   ┌────────▼────────────────────┐
         │   Agent VM        │   │   GitHub                    │
         │  (Tailscale net)  │   │                             │
         │                   │   │  ┌───────────────────────┐  │
         │  tmux session     │   │  │  Issues / PRs         │  │
         │  ┌──────────────┐ │   │  │  (coordination)       │  │
         │  │ science-     │ │   │  └──────────┬────────────┘  │
         │  │ agent        │◄├───┼─────────────┘               │
         │  │ (Claude Code)│ │   │                             │
         │  └──────────────┘ │   │  ┌───────────────────────┐  │
         │  ┌──────────────┐ │   │  │  Repo variables       │  │
         │  │ code-agent   │◄├───┼──┤  (agent registry)     │  │
         │  │ (Claude Code)│ │   │  └───────────────────────┘  │
         │  └──────────────┘ │   │                             │
         │        ...        │   │  ┌───────────────────────┐  │
         │                   │   │  │  Reusable workflow    │  │
         │  mTLS peer auth   │   │  │  (event routing)      │  │
         │  (optional v2)    │   │  │  groundnuty/          │  │
         │                   │   │  │    macf-actions       │  │
         └───────────────────┘   │  └───────────────────────┘  │
                                 │                             │
                                 │  ┌───────────────────────┐  │
                                 │  │  GitHub Apps          │  │
                                 │  │  (per-agent identity) │  │
                                 │  └───────────────────────┘  │
                                 └─────────────────────────────┘
```

Key primitives:

- **`macf` CLI** — workspace setup, cert management, agent registration, permission doctor
- **`macf-agent` plugin** (distributed via [`groundnuty/macf-marketplace`](https://github.com/groundnuty/macf-marketplace)) — in-session skills (`/macf-status`, `/macf-peers`, `/macf-ping`, `/macf-issues`)
- **`groundnuty/macf-actions`** — reusable routing workflow, consumed by every coordination repo via `uses:`
- **GitHub Apps** — per-agent identity, permissions-scoped per [DR-019](design/decisions/DR-019-app-permissions.md)
- **Shared CA + per-agent certs** — mTLS between agents, with a PreToolUse hook that structurally prevents attribution mistakes

## Setup

Requires: Ubuntu VM with Tailscale, Node.js 22+, devbox, `gh` CLI.

### 1. Create GitHub Apps (one per agent)

Each agent needs its own GitHub App for identity and authentication. Use the permission template at [`templates/macf-app-manifest.json`](templates/macf-app-manifest.json) — it matches the 7 permissions codified in [DR-019](design/decisions/DR-019-app-permissions.md).

Install each App on the coordination repo(s) and the agent's workspace repo.

### 2. Install the CLI

```bash
git clone https://github.com/groundnuty/macf.git ~/repos/groundnuty/macf
cd ~/repos/groundnuty/macf
devbox run -- npm ci
devbox run -- npm run build
npm link    # or add dist/cli/index.js to PATH
```

### 3. Initialize a workspace for each agent

`PROJECT-NAME` below is a short identifier shared by all agents in one swarm (e.g., `macf`, `cv`); all per-agent registry variables get this as a prefix, so it's how agents discover their peers.

```bash
cd ~/repos/<owner>/<agent-workspace>
macf init \
  --project <PROJECT-NAME> \
  --role code-agent \
  --app-id <APP_ID> \
  --install-id <INSTALL_ID> \
  --key-path /path/to/app-key.pem \
  --registry-type repo --registry-repo <owner>/<coordination-repo>
```

`macf init` creates `.macf/` (config, certs, plugin), writes a `claude.sh` launcher with fail-loud token helpers, and registers the agent's endpoint in the repo's variables.

### 4. Initialize the coordination repo

```bash
cd ~/repos/<owner>/<coordination-repo>
macf repo-init \
  --repo <owner>/<coordination-repo> \
  --agents code-agent,science-agent,writing-agent
```

Sets up `.github/agent-config.json`, the routing workflow (`routing.yml` consuming `groundnuty/macf-actions`), labels (`code-agent`, `in-progress`, `in-review`, `blocked`, etc.), and required secrets/variables.

### 5. Launch agents

```bash
# On the VM (via Tailscale SSH)
tmux new-session -d -s project-name -n code-agent \
  "cd ~/repos/<owner>/code-agent-workspace && ./claude.sh"
tmux new-window -t project-name -n science-agent \
  "cd ~/repos/<owner>/science-agent-workspace && ./claude.sh"
tmux attach -t project-name
```

Agents are now running, registered, and listening for routed issues.

## Usage

### Assigning work

File an issue on the coordination repo, apply the assignee's label:

```bash
gh issue create --repo <owner>/<repo> \
  --title "feat: implement X" \
  --label "code-agent" \
  --body "Acceptance criteria:
  - [ ] X works for case A
  - [ ] tests cover A, B, C
  @macf-code-agent[bot]"
```

The routing workflow fires, delivers the notification into `code-agent`'s tmux session. The agent sees the prompt, reads the issue, starts work.

### Discussion + intervention

Any comment on the issue that @mentions an agent routes to that agent. Example: science-agent reviewing code-agent's PR:

```bash
gh issue comment <N> --repo <owner>/<repo> \
  --body "@macf-code-agent[bot] LGTM on approach, one nit: <detail>."
```

The operator can attach to any agent's tmux window at any time (`tmux attach -t <project>:<agent>`) and prompt it directly — no special handoff, it's a Claude Code session.

### Operational tooling

- `macf status --dir <workspace>` — agent registration + peer health
- `macf peers --dir <workspace>` — table of registered peers with mTLS ping
- `macf doctor --dir <workspace>` — verify App token permissions match DR-019
- `macf certs rotate --dir <workspace>` — rotate peer mTLS cert
- `macf self-update` — pull origin/main + rebuild linked CLI (for dev installs)
- `macf update --dir <workspace>` — refresh rules, scripts, plugin, auto-migrate CA key if needed

### Project board

We maintain a GitHub [Projects board](https://github.com/groundnuty/macf/projects) tracking design decisions, implementation phases, and research items. Adding a new repo to a project typically takes two steps: add it via the Projects UI, then `macf repo-init` so routing events also populate the board.

## Deeper reading

- **[Design Decisions (19)](design/decisions/)** — architecturally-significant choices with rationale. Entry points: [DR-004 mTLS](design/decisions/DR-004-authentication-mtls.md), [DR-010 cert signing](design/decisions/DR-010-cert-signing.md), [DR-011 CA key backup](design/decisions/DR-011-ca-key-backup.md), [DR-019 App permissions](design/decisions/DR-019-app-permissions.md).
- **[Phase specs (7)](design/phases/)** — P1 channel server → P7 agent templates. Each phase maps to a concrete implementation slice.
- **[Research corpus (16)](research/)** — literature reviews, empirical analysis, comparison to prior multi-agent work.
- **[`coordination.md`](plugin/rules/coordination.md)** — canonical cross-cutting rules distributed to every agent workspace. Single source of truth; `macf rules refresh` propagates updates.
- **[`CHANGELOG.md`](CHANGELOG.md)** — per-release notes. Keep-a-Changelog format.

## Related repositories

MACF spans three repos, each with a distinct lifecycle:

- **[`groundnuty/macf`](https://github.com/groundnuty/macf)** (this repo) — CLI, design decisions, phase specs, research, plugin source, and the `coordination.md` rule-set. Ships the `macf` command.
- **[`groundnuty/macf-actions`](https://github.com/groundnuty/macf-actions)** — reusable GitHub Actions workflow that routes issue / comment / PR / check-suite events to agents' tmux sessions (Stage 2) or to their channel endpoints (Stage 3, mTLS). Consumed via `uses: groundnuty/macf-actions/.github/workflows/agent-router.yml@v2` in coordination repos.
- **[`groundnuty/macf-marketplace`](https://github.com/groundnuty/macf-marketplace)** — Claude Code plugin marketplace hosting the `macf-agent` plugin (skills: `/macf-status`, `/macf-peers`, `/macf-ping`, `/macf-issues`; agent identity templates; hooks). `macf init` / `macf update` fetch the plugin at a pinned tag into `<workspace>/.macf/plugin/`; `claude.sh` loads it via `--plugin-dir`.

Releases are tag-versioned per repo; consumers pin to major tags (`@v1`, `@v2`) for routing and to exact versions (`0.1.0`) for the plugin. Design rationale in [DR-013](design/decisions/DR-013-plugin-versioning.md).

## Status

- **Latest CLI release**: [`v0.1.1`](CHANGELOG.md#011--2026-04-20) (2026-04-20)
- **Phases P1–P7**: shipped and on main
- **Stage 2 routing** (SSH + tmux): production
- **Stage 3 routing** (mTLS HTTPS POST): shipped in `macf-actions@v2`, opt-in per consumer repo
- **Security hardening**: PBKDF2 at OWASP 2023 levels, clientAuth EKU enforcement, attribution-trap PreToolUse hook (structural, not behavioral), `/sign` challenge verification, schema-validated payloads
- **Operator reliability**: stale-dist detection + `macf self-update`, E2E suite running post-merge + daily cron on the CLI repo, auto-opened issues on drift
- **CV deployment** (first external project using MACF): Phase 6 launch pending
- **Research paper**: drafting; target venues ASE NIER / ESEM 2026

## Contributing

Contributions welcome. File an issue first to discuss scope for anything beyond a small fix. PR ergonomics:

- Run `make -f dev.mk check` before opening a PR (install + typecheck + lint + test)
- Follow commit-type conventions in [`commitlint.config.mjs`](commitlint.config.mjs) (`feat`, `fix`, `security`, `reliability`, `refactor`, `perf`, `docs`, `test`, `chore`, `ci`, `revert`, `build`, `style`)
- Reference the issue in the PR body as `Refs #N` (not `Closes #N` — see [coordination.md Issue Lifecycle](plugin/rules/coordination.md))
- One agent per issue; don't work on issues labeled for another agent

## License

License TBD (intent: MIT — `LICENSE` file to be added by the repo owner).

## Appendix — example configs

Real files, taken from a live deployment. Identifiers and IP addresses replaced with placeholders.

### `agent-config.json` (in the coordination repo's `.github/` directory)

Populated by `macf repo-init`. Read by the routing workflow to decide where to deliver events.

```json
{
  "agents": {
    "code-agent": {
      "app_name": "macf-code-agent",
      "host": "<agent-vm-tailscale-ip>",
      "tmux_session": "project-name",
      "tmux_window": "code-agent",
      "tmux_bin": "tmux",
      "ssh_user": "ubuntu",
      "ssh_key_secret": "AGENT_SSH_KEY",
      "workspace_dir": "/home/ubuntu/repos/<owner>/<code-agent-workspace>",
      "port": 8847
    },
    "science-agent": {
      "app_name": "macf-science-agent",
      "host": "<agent-vm-tailscale-ip>",
      "tmux_session": "project-name",
      "tmux_window": "science-agent",
      "tmux_bin": "tmux",
      "ssh_user": "ubuntu",
      "ssh_key_secret": "AGENT_SSH_KEY",
      "workspace_dir": "/home/ubuntu/repos/<owner>/<science-agent-workspace>",
      "port": 8848
    }
  },
  "label_to_status": {
    "in-progress": "In Progress",
    "in-review": "In Review",
    "blocked": "Blocked"
  }
}
```

Field notes:

- `app_name` — the GitHub App slug (used to compute the bot username `<app_name>[bot]` for @mention matching)
- `host` + `port` — agent's Tailscale IP and channel-server port (Stage 3 mTLS transport only; Stage 2 uses SSH and ignores port)
- `tmux_session` + `tmux_window` — where the routing workflow delivers the event via `tmux send-keys` (Stage 2)
- `ssh_key_secret` — repo secret holding the SSH key for VM access
- `workspace_dir` — the target workspace's path on the VM (for secondary agents whose workspace isn't the coordination repo)
- `label_to_status` — maps status labels to Projects-V2 board column names

### `claude.sh` (at workspace root)

Launcher script written by `macf init` and refreshed by `macf update`. **Managed — do not edit directly.** Template lives in [`src/cli/claude-sh.ts`](src/cli/claude-sh.ts).

```bash
#!/usr/bin/env bash
set -euo pipefail

# MACF Agent Launcher: code-agent
# This file is managed by `macf`. Do not edit directly — edits are
# overwritten on the next `macf update`. The template lives at
# groundnuty/macf:src/cli/claude-sh.ts.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

export MACF_AGENT_NAME="code-agent"
export MACF_PROJECT="project-name"
export MACF_AGENT_TYPE="permanent"
export MACF_AGENT_ROLE="code-agent"
export APP_ID="<YOUR_APP_ID>"
export INSTALL_ID="<YOUR_INSTALL_ID>"
export KEY_PATH=".github-app-key.pem"
export MACF_CA_CERT="$HOME/.macf/certs/project-name/ca-cert.pem"
export MACF_CA_KEY="$HOME/.macf/certs/project-name/ca-key.pem"
export MACF_AGENT_CERT="$SCRIPT_DIR/.macf/certs/agent-cert.pem"
export MACF_AGENT_KEY="$SCRIPT_DIR/.macf/certs/agent-key.pem"
export MACF_LOG_PATH="$SCRIPT_DIR/.macf/logs/channel.log"
export MACF_DEBUG="${MACF_DEBUG:-false}"

# Bot token generation — fail loud. The helper validates the ghs_ prefix
# and surfaces diagnostics (clock drift, bad key, wrong App/install ID).
# Do NOT inline the bare CLI here — without pipefail, a failed fetch piped
# through jq would succeed, GH_TOKEN would become "null", and Claude Code
# would silently fall back to stored `gh auth login` as the user. See
# coordination.md Token & Git Hygiene.
GH_TOKEN=$("$SCRIPT_DIR/.claude/scripts/macf-gh-token.sh" \
    --app-id "$APP_ID" --install-id "$INSTALL_ID" --key "$KEY_PATH") || {
  echo "FATAL: bot token generation failed — see stderr above." >&2
  exit 1
}
export GH_TOKEN

export GIT_AUTHOR_NAME="code-agent[bot]"
export GIT_COMMITTER_NAME="code-agent[bot]"

echo "Starting code-agent..."
exec claude --plugin-dir "$SCRIPT_DIR/.macf/plugin" "$@"
```

What this launcher handles:

- **Identity exports** — `APP_ID`, `INSTALL_ID`, `KEY_PATH` read from `.macf/macf-agent.json`
- **Cert paths** — per-project CA at `~/.macf/certs/<project>/`, per-workspace agent cert under `.macf/certs/`
- **Fail-loud token refresh** — the `macf-gh-token.sh` helper validates the `ghs_` token prefix; if it fails, the launcher exits rather than letting Claude Code silently fall back to a user token
- **Plugin loading** — `--plugin-dir` points at the version pinned by `macf init`, so new CLI versions don't break older agent sessions until `macf update` runs
