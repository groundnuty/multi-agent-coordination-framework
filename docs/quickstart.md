# Quickstart — first MACF agent in 30 minutes

This is a hands-on tutorial. Walk through the actual path to bootstrap your first MACF agent, file your first cross-agent issue, observe routing fire, and complete a first PR review cycle. Empirical claim: a first-time operator with one VM + Tailscale + a GitHub account typically finishes this in **20-40 minutes** (most variation is in GitHub App provisioning UI, not in MACF itself).

If anything feels stuck, [troubleshooting.md](troubleshooting.md) has the gotchas catalogued.

## What you'll build

By the end of this tutorial:

- One agent (`code-agent`) bootstrapped on your VM, with its own GitHub App and channel server
- One coordination repo wired up with the routing workflow
- One end-to-end routing test: file an issue tagged `code-agent`, observe routing fire, see the prompt arrive in the agent's tmux session

This is the minimum viable MACF deployment. Adding more agents follows the same pattern (repeat steps 4-6 for each).

## Pre-requisites

You need:

- An Ubuntu VM (or any Linux box) with `ssh` access. **Tailscale** is recommended for network reachability across operator devices; not strictly required if everything stays on one host.
- **Node.js 22+** on the VM (`node --version` to verify)
- **devbox** installed (`curl -fsSL https://get.jetify.com/devbox | bash`; for managed Node + tooling)
- **`gh` CLI** authenticated as your GitHub user (`gh auth login`; this is for one-time setup, not for agent operations)
- **Two GitHub repos** under your account or org:
  - One **coordination repo** (where issues + PRs live). Can be an existing project repo or a fresh one.
  - One **agent workspace repo** (where the agent's runtime config lives). Often the same as coordination repo for single-agent setups.
- A **GitHub App** for the agent (see step 1 below)

## Step 1 — Create the agent's GitHub App (5-10 min)

Each agent needs its own GitHub App. The App provides identity (`<app-name>[bot]` username), authentication (1-hour installation tokens), and permission scope.

Use the manifest template at [`templates/macf-app-manifest.json`](../templates/macf-app-manifest.json) — it codifies the 7 required permissions per [DR-019](../design/decisions/DR-019-app-permissions.md): `metadata`, `contents`, `issues`, `pull_requests`, `actions_variables`, `workflows`, `actions`.

**Create the App:**

1. Go to <https://github.com/settings/apps/new> (or for an org: `https://github.com/organizations/<org>/settings/apps/new`)
2. Set the App name to something descriptive: `<your-prefix>-code-agent` (e.g., `acme-code-agent`)
3. Set the Homepage URL to anything (e.g., your project URL)
4. Uncheck "Active" under Webhook (we don't need GitHub-side webhooks for the App's internal use; routing-Action handles events)
5. Under Repository permissions, set:
   - **Metadata**: Read
   - **Contents**: Read & write
   - **Issues**: Read & write
   - **Pull requests**: Read & write
   - **Variables**: Read & write *(GitHub UI label; canonical API name `actions_variables`)*
   - **Workflows**: Read & write
   - **Actions**: Read
6. Click "Create GitHub App"

**Provision the App's credentials:**

1. After creation, scroll to "Private keys" and click "Generate a private key" — downloads `<app-slug>.YYYY-MM-DD.private-key.pem`. Save this; you'll need its path.
2. Note the **App ID** (top of the App settings page) — a number like `1234567`.
3. Click "Install App" in the left sidebar. Install on your coordination repo + your agent workspace repo (or "All repositories" if simpler). Note the **Installation ID** from the URL after install (e.g., `https://github.com/settings/installations/12345678` → ID `12345678`).

You now have: `APP_ID`, `INSTALL_ID`, and the path to the private key.

## Step 2 — Install MACF (1-2 min)

On your VM:

```bash
npm install -g @groundnuty/macf
macf --version
# Expected: 0.2.9 (or later)
```

That's it; the CLI is now on `PATH`.

## Step 3 — Create the project CA (one-time per project; 1-2 min)

The project CA signs each agent's mTLS cert. One CA per project, regardless of how many agents.

```bash
mkdir -p ~/your-coordination-repo
cd ~/your-coordination-repo
git clone git@github.com:<owner>/<coordination-repo>.git .

macf certs init
# Interactive: enter a passphrase for the CA private key. Save it somewhere safe.
# Effects:
#   ~/.macf/certs/<project>/ca-cert.pem   (public; uploaded to GitHub Variables)
#   ~/.macf/certs/<project>/ca-key.pem    (private; encrypted with passphrase)
```

**Save the passphrase.** Without it, you can't sign new agent certs and would need to recover from backup (`macf certs recover`).

## Step 4 — Bootstrap the coordination repo (2-3 min)

```bash
cd ~/your-coordination-repo
macf repo-init \
  --repo <owner>/<coordination-repo> \
  --agents code-agent
```

This creates:

- `.github/agent-config.json` — registry pointer + per-agent metadata (App slug, tmux session, workspace path)
- `.github/workflows/agent-router.yml` — references `groundnuty/macf-actions/.github/workflows/agent-router.yml@v3`
- Labels: `code-agent`, `in-progress`, `in-review`, `blocked`, `agent-offline` (and similar for any other agents listed)
- Required secrets/variables (you may need to provision these manually; the script tells you which)

Commit + push:

```bash
git add .github/
git commit -m "chore: macf repo-init"
git push origin main
```

Verify the routing workflow registered: `gh workflow list --repo <owner>/<coordination-repo>` should show `Agent Router`.

## Step 5 — Bootstrap the agent workspace (3-5 min)

In the agent's workspace directory (often the same as the coordination repo for single-agent setups):

```bash
cd ~/your-agent-workspace
# Move the App private key into the workspace
cp /path/to/<app-slug>.YYYY-MM-DD.private-key.pem .github-app-key.pem
chmod 600 .github-app-key.pem

# Run macf init
macf init \
  --project <project-name> \
  --role code-agent \
  --app-id <APP_ID> \
  --install-id <INSTALL_ID> \
  --key-path .github-app-key.pem \
  --registry-type repo \
  --registry-repo <owner>/<coordination-repo> \
  --advertise-host 127.0.0.1 \
  --tmux-session <project-name>
```

Where:

- `<project-name>` is a short identifier shared by all agents in this swarm (e.g., `acme`); becomes the prefix for registry variables
- `--advertise-host 127.0.0.1` works if all agents on one host. For cross-host, use the agent's Tailscale IP
- `--tmux-session <project-name>` is where `claude.sh` will run (you'll create the session next)

Effects of `macf init`:

- `.macf/{certs,logs,plugin}/` directories
- Agent cert (signed by project CA)
- `.macf/macf-agent.json` (agent identity + registry pointer)
- Plugin fetched from `groundnuty/macf-marketplace@v<plugin-version>`
- Canonical `claude.sh` written
- PreToolUse hooks (`check-gh-token.sh`, `check-mention-routing.sh`) registered in `.claude/settings.json`
- 13 canonical rules distributed to `.claude/rules/`
- 4 plugin skills pre-approved in `.claude/settings.json` `permissions.allow`

## Step 6 — Run `macf doctor` (1 min)

```bash
macf doctor
```

Expected output (3 sections):

```
MACF doctor report
──────────────────────────────────────────────────────────────
  ✓ metadata        required=read   actual=read
  ✓ contents        required=write  actual=write
  ✓ issues          required=write  actual=write
  ✓ pull_requests   required=write  actual=write
  ✓ actions_variables required=write actual=write
  ✓ workflows       required=write  actual=write
  ✓ actions         required=read   actual=read
  ✓ all required permissions present (7/7 satisfied)

Sandbox filesystem (macf#200)
──────────────────────────────────────────────────────────────
  ✓ sandbox.filesystem.allowRead contains /proc/self/fd  [PASS]

Workspace permissions (macf#296)
──────────────────────────────────────────────────────────────
  ✓ permissions.allow grants Write + Edit (autonomous coordination unblocked)  [PASS]
```

If any section shows `✗` (hard fail) or `⚠` (warn), fix per the diagnostic message before proceeding. Most common issues: the App permissions don't match (re-check step 1's permission settings + accept the install), or `permissions.allow` lacks Write/Edit (add to `.claude/settings.local.json`; see [troubleshooting.md](troubleshooting.md)).

## Step 7 — Launch the agent (1 min)

```bash
# Start the tmux session (detached) in the workspace dir
tmux new-session -d -s <project-name> -n code-agent \
  -e MACF_AGENT_NAME=code-agent \
  -e MACF_PROJECT=<project-name> \
  "cd ~/your-agent-workspace && ./claude.sh"

# Attach to verify
tmux attach -t <project-name>
```

You should see Claude Code start up, the plugin load (`mcpServers.macf-agent` initializing), and the channel server self-register. Within 5-10 seconds the registration is complete.

**Detach with `Ctrl+b d`** (don't `exit` — that kills the agent).

**Verify channel-server registration:**

```bash
gh api repos/<owner>/<coordination-repo>/actions/variables/MACF_<PROJECT_UPPER>_AGENT_CODE_AGENT --jq '.value'
# Expected: JSON like {"host":"127.0.0.1","port":8847,"type":"permanent","instance_id":"...","started":"2026-04-30T..."}
```

**Verify channel-server log:**

```bash
cat ~/your-agent-workspace/.macf/logs/channel.log | tail -10
# Expected: collision_check, registered, server_started events at recent timestamps
```

If both are present + recent, the agent is operational.

## Step 8 — File your first issue (1-2 min)

From a different terminal (with your normal `gh auth login` user identity, NOT the bot):

```bash
gh issue create --repo <owner>/<coordination-repo> \
  --title "test: first MACF routing test" \
  --label "code-agent" \
  --body "@<your-app-prefix>-code-agent[bot] please respond with the current time. This is a routing-validation test."
```

Note the issue number returned (e.g., `#1`).

## Step 9 — Observe routing fire (1-2 min)

Within 10-30 seconds (GitHub webhook delay + workflow cold-start dominates), the routing-Action workflow runs. Verify:

```bash
# Watch the workflow run
gh run list --repo <owner>/<coordination-repo> --workflow agent-router.yml --limit 1
# Expected: a recent run with status "completed" + conclusion "success"

# Re-attach to the agent tmux session
tmux attach -t <project-name>
```

In the agent's tmux session, you should see Claude Code receive a prompt about your test issue + start to respond. The agent reads the issue, recognizes it as a routing test, and replies with the current time + a status comment.

**Verify the reply landed:**

```bash
gh issue view <N> --repo <owner>/<coordination-repo> --comments
# Expected: a new comment from <app-prefix>-code-agent[bot] with the time + acknowledgment
```

You've now completed an end-to-end MACF cycle: human → GitHub → routing-Action → channel server → agent → response → GitHub.

## Step 10 — Complete a first PR review cycle (5-10 min)

Now exercise the full coordination loop. File an issue asking the agent to make a small change:

```bash
gh issue create --repo <owner>/<coordination-repo> \
  --title "feat: add a hello-world function" \
  --label "code-agent" \
  --body "@<your-app-prefix>-code-agent[bot] please:
1. Create a file \`src/hello.ts\` with a single function \`hello(name: string): string\` returning \`\"Hello, \${name}!\"\`
2. Add a test in \`test/hello.test.ts\` covering the canonical case
3. Open a PR referencing this issue with \`Refs #N\` (NOT \`Closes #N\`)"
```

The agent will:

1. Read the issue + apply the `in-progress` label
2. Branch from `main`
3. Write the implementation + test
4. Run `make -f dev.mk check` (or `npm test` in your project; varies by stack)
5. Open a PR with `Refs #<N>` in the body
6. Apply the `in-review` label
7. Post `@<your-handle> PR ready for review` on the issue thread

You review the PR, post `@<your-app-prefix>-code-agent[bot] LGTM` (or use `gh pr review --approve --body-file <review.md>` for the canonical formal-review form per [pr-discipline.md](../packages/macf/plugin/rules/pr-discipline.md)), and the agent merges + posts the closure handoff.

You then close the issue per the reporter-owns-closure rule:

```bash
gh issue close <N> --repo <owner>/<coordination-repo> --reason completed --comment "Verified on main after PR #M merged. Closing as reporter."
```

You've now exercised the full PR review cycle. The agent is operational.

## What just happened (recap)

In ~30 minutes you set up:

- One GitHub App (per-agent identity)
- One project CA (mTLS authority for inter-agent traffic)
- One coordination repo with the routing workflow + labels
- One agent workspace with the canonical `claude.sh`, plugin, hooks, rules
- One channel server running mTLS HTTPS on a registered port
- One end-to-end routing test
- One full PR review cycle

The pieces map to the architecture in [concepts.md](concepts.md):

| What you did | Which primitive |
|---|---|
| Created the GitHub App | Per-agent identity ([DR-008](../design/decisions/DR-008-agent-identity.md), [DR-019](../design/decisions/DR-019-app-permissions.md)) |
| Created the project CA | mTLS root of trust ([DR-004](../design/decisions/DR-004-authentication-mtls.md), [DR-010](../design/decisions/DR-010-cert-signing.md)) |
| `macf repo-init` | Routing workflow + labels ([P6](../design/phases/P6-action-update.md), [DR-017](../design/decisions/DR-017-ssh-elimination.md)) |
| `macf init` | Workspace bootstrap + cert + plugin ([P4](../design/phases/P4-cli.md), [P5](../design/phases/P5-plugin.md)) |
| `macf doctor` | Path-3 health check ([macf#296](https://github.com/groundnuty/macf/issues/296), [#305](https://github.com/groundnuty/macf/issues/305)) |
| Launching the agent | Channel server bootstrap + registry self-publish ([P1](../design/phases/P1-channel-server.md), [DR-002](../design/decisions/DR-002-channel-per-agent.md)) |
| Filed issue → routing fire | Routing-Action `route-by-config` job ([P6](../design/phases/P6-action-update.md)) |
| PR review cycle | `pr-discipline.md` formal review submission engaging `route-by-pr-review-state` (Path-2 promotion per [#39](https://github.com/groundnuty/macf-actions/issues/39)) |

## Adding more agents

Repeat steps 1, 5, 6, 7 for each additional agent. The CA (step 3) and the coordination repo (step 4) are one-time per project; new agents just need their own GitHub App + workspace.

For multi-agent coordination patterns (when to use orchestrator-worker vs peer-to-peer; how to set up cross-repo coordination; CV-fleet style configurations), see:

- [concepts.md](concepts.md) — orchestrator-worker design + asymmetric contexts
- [use-cases.md](use-cases.md) — when to use multi-agent at all
- [`design/macf-consumer-onboarding.md`](../design/macf-consumer-onboarding.md) — full reference for new-consumer-project bootstrap

## Where to go next

- **Browse the [features](features.md)** — concrete inventory of what v0.2.9 ships
- **Read [concepts](concepts.md)** — why MACF is shaped the way it is, with DR citations
- **Skim [use-cases](use-cases.md)** — when MACF is the right tool, when it isn't
- **Bookmark [troubleshooting](troubleshooting.md)** — when something goes wrong (and it will)
- **Open the [FAQ](faq.md)** — common questions answered honestly

## What if something doesn't work

Most common failure modes:

| Symptom | First check |
|---|---|
| `macf init` fails on cert | Project CA exists at `~/.macf/certs/<project>/`? Did you remember the passphrase? |
| `macf doctor` fails on App permissions | App installed on the right repo(s)? Permissions match step 1? |
| Channel server fails to register | `actions_variables: write` permission on the App? `gh api .../actions/variables` works manually? |
| Routing fires but agent doesn't wake | Tmux session exists with the right name? `tmux list-sessions` shows it? `MACF_AGENT_NAME` env set in the session? |
| Tmux session exists but agent is silent | Send keys via `.claude/scripts/tmux-send-to-claude.sh` (NOT `tmux send-keys`); the canonical helper handles the multi-line-input quirk |

Each row maps to a section in [troubleshooting.md](troubleshooting.md) with the full fix.

## Honest limitations of this quickstart

- **One agent only.** Real MACF deployments have 2-7+ agents; this gets you to one. Multi-agent doubles the GitHub App provisioning work + introduces cross-agent routing tests.
- **Single VM.** Multi-VM with Tailscale works but adds network setup; not covered here.
- **Test issue, not real work.** The hello-world example exercises the path; production work requires more discipline (commit hygiene, CI integration, label-based queue management). See [`coordination.md`](../packages/macf/plugin/rules/coordination.md) for the full discipline set.
- **Cost not measured.** A typical agent session consumes 200K-1M tokens depending on context window + work depth. CPC predecessor measured 1.18× total cost vs single-agent for the same work; expect similar overhead in MACF until your workload benefits from asymmetric-context savings.

For when MACF is and isn't worth the overhead: [use-cases.md](use-cases.md).
