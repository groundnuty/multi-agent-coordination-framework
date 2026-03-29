# MACF Channel Architecture Design

Date: 2026-03-28
Context: Designing the channel-based communication layer to replace SSH+tmux routing in the multi-agent coordination framework.

---

## Problem Statement

The current agent routing uses: GitHub Action → Tailscale VPN → SSH → tmux send-keys → Claude Code session. This is fragile (stale sessions, PATH issues, C-c workaround) and complex (SSH keys, authorized_keys, tmux_bin config).

Claude Code Channels (MCP-based, research preview since v2.1.80) offer a cleaner alternative: an HTTP endpoint that pushes events directly into a running Claude Code session via the MCP protocol.

---

## Design Requirements

1. **Replace SSH+tmux** with HTTP POST to channel endpoint
2. **Per-agent identity** — each agent has its own channel
3. **Cross-VM support** — agents on multiple machines (Tailscale for networking)
4. **Ephemeral workers** — short-lived agents that spawn fast, get first-class GitHub identity
5. **P2P capability** — agents can health-ping each other
6. **Authentication** — mTLS with per-agent certificates
7. **Dynamic registration** — agents pick their own port, announce to a shared registry
8. **No single point of failure** — no dedicated orchestrator process
9. **Race-free** — concurrent agent startups don't conflict
10. **Audit trail preserved** — GitHub Issues/PRs remain the work artifacts

---

## Design Decisions: How We Got Here

### Decision 1: One Channel Per Agent

**Constraint**: Claude Code's MCP channel is a subprocess of the Claude Code process. Each Claude Code session spawns its own MCP servers. Two agents can't share a channel.

**Decision**: Each agent gets its own channel server, its own HTTP port.

**Implication**: N agents on same VM = N ports needed.

### Decision 2: Two Communication Planes

**GitHub** (work artifacts): Issues, PRs, reviews, comments. Persistent, auditable, board-visible. The source of truth for WHAT work is done.

**Channels** (operational signals): Routing notifications from the Action, P2P health pings. Ephemeral, not on GitHub. The mechanism for HOW agents get notified.

These planes don't compete. GitHub is content, channels are plumbing. Like HTTP serves content but TCP keepalives check the connection.

### Decision 3: GitHub Action Stays, SSH Replaced

The agent-router Action still handles:
- Label routing (issue labeled → find agent → POST to channel)
- @mention routing (comment/PR → find mentioned agent → POST to channel)
- Board sync (label → Projects V2 column)
- Offline detection (POST fails → add `agent-offline` label)

The ONLY change: replace `ssh ... tmux send-keys` with `curl -X POST`.

### Decision 4: mTLS for Authentication

**Evaluated:**

| Method | Security | Complexity | Per-agent identity |
|---|---|---|---|
| Shared secret header | Medium | Low | No |
| Per-agent secret | Good | Low | Yes |
| mTLS with certificates | Best | Medium (~20 lines of openssl) | Yes — CN in cert |
| Tailscale-only (no app auth) | Good | Zero | No |
| GitHub webhook HMAC-SHA256 | Good | Medium | No |

**Decision**: mTLS. Per-agent identity via certificate CN. CA managed by the org. Removes dependency on Tailscale for authentication (Tailscale provides network access, mTLS provides identity).

**Setup**:
```bash
# One-time: create CA
openssl genrsa -out ca-key.pem 4096
openssl req -x509 -new -key ca-key.pem -out ca-cert.pem -days 365 -subj "/CN=MACF-CA"

# Per agent: create cert signed by CA
openssl genrsa -out code-agent-key.pem 2048
openssl req -new -key code-agent-key.pem -out code-agent.csr -subj "/CN=code-agent"
openssl x509 -req -in code-agent.csr -CA ca-cert.pem -CAkey ca-key.pem -out code-agent-cert.pem -days 365

# Per Action: create router cert
openssl genrsa -out router-key.pem 2048
openssl req -new -key router-key.pem -out router.csr -subj "/CN=agent-router"
openssl x509 -req -in router.csr -CA ca-cert.pem -CAkey ca-key.pem -out router-cert.pem -days 365
```

### Decision 5: Dynamic Ports with Per-Agent Org Variables

**Seven designs evaluated:**

| # | Design | Verdict |
|---|---|---|
| 1 | Static `agent-config.json` in repo | Can't handle ephemeral workers |
| 2 | Dedicated orchestrator process | Overengineered, single point of failure |
| 3 | Leader election (etcd/bully) | Distributed systems complexity for port assignment |
| 4 | File-based registry (`/tmp/`) | Breaks cross-VM |
| 5 | GitHub Contents API with SHA CAS | Commits for ephemeral state, clutters git history |
| 6 | Single org variable (one JSON) | Race condition on concurrent writes, no CAS |
| **7** | **Per-agent org variables** | **Race-free, cross-VM, no extra process** |

**Decision**: Per-agent GitHub org variables. Each agent writes ONLY its own variable. No shared state, no race conditions.

```
vars.MACF_AGENT_code_agent      = {"host":"vm1.tailnet","port":8788}
vars.MACF_AGENT_science_agent   = {"host":"vm1.tailnet","port":8789}
vars.MACF_AGENT_worker_1        = {"host":"vm2.tailnet","port":8832}
```

**Discovery**: Action lists all `MACF_AGENT_*` variables to find agents.

**No heartbeats needed**: The Action checks liveness at routing time (POST succeeds = alive, POST fails = offline). No periodic API calls, no rate limit concerns.

**Port selection**: Agent picks a random port, tries to listen. If `EADDRINUSE`, picks another. The OS prevents same-VM conflicts. Cross-VM conflicts can't happen (different port spaces).

### Decision 6: Channel Handles Both Routing and Startup Issue Check

The channel replaces:
1. tmux send-keys injection from the Action (routing)
2. SessionStart hook that injects pending issues via tmux (startup pickup)

Both become HTTP POSTs to the channel endpoint.

### Decision 7: SSH Completely Eliminated

With channels on Tailscale IPs, SSH is no longer needed:
- No SSH keys to generate
- No `authorized_keys` to manage
- No SSH key secrets in GitHub
- No `tmux_bin` path workarounds
- No `C-c` before send-keys hack
- No stale tmux session errors

Tailscale provides network access. mTLS provides authentication. Channels provide message delivery.

### Decision 8: Worker Pool Identity

**Constraint**: GitHub Apps require manual UI creation. Can't create 50 apps for 50 workers.

**Decision**: One GitHub App per worker pool (`macf-worker[bot]`). All workers share the same bot identity on GitHub. They differentiate via tags in comments:

```
[worker-3] Starting work on this.
[worker-3] @macf-science-agent[bot] PR #42 is ready for review.
```

Permanent agents (science, code, writing) each get their own GitHub App with unique identity.

### Decision 9: Per-Org Registry, Not Cross-Org

**Evaluated**: User-level registry (spans orgs) vs org-level registry.

**Decision**: Per-org. Agents don't cross org boundaries. Each org has its own set of org variables. Simpler, no cross-org permissions needed.

### Decision 10: P2P Health Pings via Channel Endpoints

Each channel exposes `GET /health`:

```
GET /health → {"agent": "code-agent", "status": "working", "issue": 42}
```

Any agent can ping any other agent by reading the org variable for the target's host:port, then GETting `/health`. This is direct P2P, not through GitHub.

**Use cases**:
- "Is code-agent alive?" before filing an issue
- "What issue is code-agent working on?" to check progress
- "How long has science-agent been idle?" for monitoring

---

## Final Architecture

```
                    GitHub (macf-experiment org)
                    ┌─────────────────────────┐
                    │ Org Variables:           │
                    │   MACF_AGENT_*           │
                    │   MACF_CA_CERT           │
                    │ Org Secrets:             │
                    │   TS_OAUTH_*             │
                    │   PROJECT_TOKEN          │
                    │                          │
                    │ Per-repo:                │
                    │   agent-router.yml       │
                    │   Labels                 │
                    │   Projects V2 board      │
                    └──────────┬───────────────┘
                               │
                    GitHub Action (agent-router)
                    ┌──────────┴───────────────┐
                    │ 1. Read MACF_AGENT_* vars │
                    │ 2. Find target agent      │
                    │ 3. POST via Tailscale     │
                    │    (mTLS authenticated)   │
                    └──────────┬───────────────┘
                               │ HTTPS + mTLS
              ┌────────────────┼────────────────┐
         VM1 (Tailscale)                   VM2 (Tailscale)
    ┌─────────────────────┐         ┌─────────────────────┐
    │ science :8788       │         │ worker-1 :8832      │
    │ code    :8789       │         │ worker-2 :8847      │
    │ writing :8790       │         │ worker-3 :8851      │
    │                     │◄──P2P──►│                     │
    └─────────────────────┘         └─────────────────────┘

Each agent's channel:
  POST /notify      ← receive work from Action or other agents
  GET  /health      ← P2P health check
  (mTLS required for all endpoints)
```

### Agent Startup Flow

```
1. Agent starts Claude Code with channel server
2. Channel server picks random port, tries to listen
   - If EADDRINUSE: try another port
3. Channel registers with GitHub:
   gh api orgs/macf-experiment/actions/variables/MACF_AGENT_{name} \
     --method POST -f value='{"host":"vm1.tailnet","port":8788}'
4. Claude Code session is ready
5. Channel checks for pending issues (replaces SessionStart hook):
   gh issue list --label {agent-label} --state open
   → if any: pushes notification to Claude Code via MCP
```

### Action Routing Flow

```
1. Issue created with label "code-agent"
2. agent-router.yml triggers
3. Action reads MACF_AGENT_code_agent org variable
4. Gets host:port
5. Connects via Tailscale (ephemeral node, same as before)
6. POSTs to https://host:port/notify (mTLS with router cert)
   Body: {"type":"issue","number":42,"title":"..."}
7. Channel server receives → pushes MCP notification to Claude Code
8. Claude Code receives <channel> event → acts on it
   If POST fails:
9. Action adds "agent-offline" label + comment
```

### P2P Ping Flow

```
1. Science-agent wants to check on code-agent
2. Reads MACF_AGENT_code_agent org variable (or from local cache)
3. GET https://code-agent-host:port/health (mTLS with science-agent cert)
4. Response: {"agent":"code-agent","status":"working","issue":42}
```

---

## What Changes from Current CPC System

| Component | CPC (current) | MACF (new) |
|---|---|---|
| Message delivery | SSH + tmux send-keys | Channel HTTP POST |
| Authentication | SSH keys | mTLS certificates |
| Agent discovery | Static agent-config.json | Per-agent org variables |
| Network | Tailscale + SSH | Tailscale only (SSH eliminated) |
| Startup issue check | SessionStart hook + tmux | Channel self-check on startup |
| P2P communication | Not possible | GET /health on peer's channel |
| Ephemeral workers | Not supported | First-class via worker pool identity + dynamic registration |
| Port assignment | Hardcoded in config | Dynamic (random + retry) |
| Agent-router Action | SSH commands | HTTP POST commands |
| Offline detection | SSH failure → label | HTTP POST failure → label |

---

## Open Questions for Implementation

1. **Channel server runtime**: Node.js (available on machine) vs Bun (not installed). Bun is faster but Node works.
2. **How does `claude.sh` change?** Needs `--dangerously-load-development-channels server:macf-channel` flag. The channel is in `.mcp.json`.
3. **mTLS cert distribution**: CA cert in org variable, agent certs generated by setup tool and stored on disk. Router cert stored as org secret for the Action.
4. **Cleanup of dead worker variables**: Cron job? Manual? Action checks `last_seen` before routing?
5. **The `--dangerously-load-development-channels` flag**: Required during research preview. Ugly in production. Will Anthropic add an allowlist mechanism?
6. **Channel instructions**: What system prompt does the channel inject? Needs to tell Claude how to interpret `<channel>` events (issue routing vs health ping vs P2P message).

---

## Design Alternatives Considered (Full Record)

### Design 1: Static agent-config.json

The CPC approach. All agent addresses hardcoded in a JSON file committed to the repo. Action reads the file via sparse checkout.

**Why rejected**: Can't handle ephemeral workers. Every new worker requires a commit, push, and Action re-read. Race conditions on concurrent worker registration.

**When it's right**: Small, stable team of 2-3 permanent agents. Our CPC setup.

### Design 2: Dedicated Orchestrator Process

A standalone Node process that maintains the registry, assigns ports, health-checks agents, issues certs. All agents register with it on startup.

**Why rejected**: Extra process to manage. Single point of failure. If orchestrator dies, new agents can't register (though existing agents keep working). Overengineered for our scale.

**When it's right**: Large-scale deployments (50+ agents), auto-scaling, enterprise. When you need centralized control and monitoring.

### Design 3: Leader Election

Every agent can be the orchestrator. If the current leader dies, another takes over via Bully algorithm or Raft consensus.

**Why rejected**: Distributed consensus for port assignment is absurd. The complexity of leader election, state replication, and re-registration far exceeds the value of dynamic port discovery. We're not building a database.

**When it's right**: Mission-critical systems where no single point of failure is acceptable and agents must self-organize without infrastructure.

### Design 4: File-Based Registry (/tmp/)

Each agent writes `{port, pid}` to a local file. Other agents read the directory.

**Why rejected**: Only works on a single VM. `/tmp/macf-registry/` on VM1 is invisible to VM2.

**When it's right**: All agents on one machine, simple development setup, throwaway environments.

### Design 5: GitHub Contents API with SHA CAS

Agent-config.json in a repo, updated atomically via the Contents API's SHA-based compare-and-swap.

**Why rejected**: Creates git commits for ephemeral runtime state. "register worker-3" commits clutter the history. And the CAS retry loop adds latency.

**When it's right**: When you need auditable registration history (compliance) and can tolerate commit noise.

### Design 6: Single Org Variable (one JSON)

All agents in one org variable as a JSON object. Read-modify-write on registration.

**Why rejected**: GitHub org variable API has no CAS. Concurrent writes = last writer wins, potentially overwriting another agent's registration.

**When it's right**: Very low registration frequency (agents start rarely, never concurrently). Quick and simple for 2-3 agents.

### Design 7: Per-Agent Org Variables (CHOSEN)

Each agent owns its own org variable. No shared state, no races.

**Why chosen**: Race-free by construction. Cross-VM. No extra processes. GitHub-native. 1000 variable limit is sufficient. Discovery via prefix scan. Liveness checked at routing time (no heartbeats needed).

**Limitations**: Requires org admin permission. Dead variables need cleanup. Tied to GitHub (not portable). No event notification on new agent registration.

---

## Comparison with Industry

| System | Discovery | Communication | Authentication |
|---|---|---|---|
| **MACF (ours)** | GitHub org variables | Channels (HTTP/mTLS) | mTLS certs |
| **Kubernetes** | etcd + DNS | HTTP/gRPC | Service accounts + mTLS (Istio) |
| **Consul** | Consul agents + DNS | HTTP | ACL tokens + mTLS |
| **Claude Code agent-teams** | In-process | SendMessage (in-process) | None (same process) |
| **MetaGPT** | Hardcoded roles | In-memory message passing | None (same process) |
| **AutoGen** | GroupChat config | Python function calls | None (same process) |

Our approach is closest to Kubernetes service mesh (per-service identity via mTLS, service discovery via registry), but uses GitHub as the registry instead of etcd. This is appropriate for our scale (10-50 agents) and GitHub-native workflow.

---

## References

- Claude Code Channels reference: https://code.claude.com/docs/en/channels-reference
- Claude Code Channels user guide: https://code.claude.com/docs/en/channels
- GitHub org variables API: https://docs.github.com/en/rest/actions/variables#list-organization-variables
- Tailscale MagicDNS: https://tailscale.com/kb/1081/magicdns
- mTLS in Node.js: https://nodejs.org/api/tls.html#tlscreateserveroptions-secureconnectionlistener
- GitHub Contents API (CAS alternative): https://docs.github.com/en/rest/repos/contents#create-or-update-file-contents
