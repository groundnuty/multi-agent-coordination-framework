# DR-015: HTTP Endpoints

**Status:** Accepted
**Date:** 2026-03-28

## Context

The channel server exposes HTTP endpoints for receiving work, health checks, and certificate signing. What should they be named?

## Decision

Three endpoints, all requiring mTLS:

| Endpoint | Method | Purpose |
|---|---|---|
| `/notify` | POST | Receive work notifications from Action or other agents |
| `/health` | GET | P2P health check, returns agent status |
| `/sign` | POST | Sign a CSR for a new agent (challenge-response auth) |

## Industry Validation

Researched endpoint naming conventions across Kubernetes, Slack, Discord, AWS, Google, Spring Boot, Consul, and other infrastructure systems.

### `/notify`

Tier 1 convention for service-to-service event push. Short, imperative, unambiguous. Used in internal service APIs. Alternative `/webhook` is for external systems (CI, SaaS) — `/notify` is more natural for peer agents.

### `/health`

The single most dominant health check endpoint name in the industry. Used by Docker, Kubernetes, Spring Boot, Express.js, AWS ALB, Consul, and virtually every microservice tutorial.

Returns rich response (status, current issue, uptime) — similar to Spring Boot Actuator's `/health` which also returns detailed dependency states. If we later need minimal liveness separate from status, we can split into `/health` + `/status`.

### `/sign`

Not an industry standard name (cert signing is usually a dedicated service like Vault or CFSSL). But for our self-contained system, `/sign` is clear: "sign this CSR."

## Response Formats

```
GET /health → 200
{
  "agent": "code-agent",
  "status": "online",
  "type": "permanent",
  "uptime_seconds": 3600,
  "current_issue": 42,
  "version": "0.1.0",
  "last_notification": "2026-03-28T18:01:00Z"
}

POST /notify → 200 {"status":"received"}
Body: { "type": "issue_routed", "issue_number": 42, "title": "..." }

POST /sign → 200
Body (request): { "csr": "...", "agent_name": "new-agent", "project": "macf" }
Body (challenge): { "challenge_id": "abc123", "instruction": "..." }
Body (cert): { "cert": "-----BEGIN CERTIFICATE-----..." }
```

## Two surface types: HTTP endpoints + MCP tools (added 2026-04-26)

The original DR (2026-03-28) specified the channel server's only architectural surface as HTTP-mediated calls (`/notify`, `/health`, `/sign`). With Claude Code 2.1.118's `type: "mcp_tool"` hook surface (per DR-023), the channel server gains a **second surface type**: MCP tools invokable directly from in-process hooks.

| Surface | Protocol | Caller context | Use cases |
|---|---|---|---|
| HTTP endpoints (this DR) | HTTPS + mTLS | Cross-process, cross-network | Routing Action → agent /notify; peer-agent /sign challenge-response; health-check polling |
| MCP tools (DR-023) | MCP stdio | In-process (same Claude Code session) | Hook-driven invocation: notify_peer, check_lgtm, etc. |

The two surfaces are **complementary, not redundant**:

- Some operations have a thin MCP-tool wrapper around an HTTP /notify call (UC-1 `notify_peer` resolves the peer's channel-server URL, POSTs to its `/notify` endpoint)
- Others are MCP-tool-only, since they only fire from in-process hooks (UC-2 `check_lgtm` reads PR state via `gh api` + returns decision JSON; no cross-network channel call needed)
- The HTTP endpoints stay minimal + stable (3 endpoints); the MCP tool surface evolves with hook use cases (per DR-023)

Both surfaces ship from the same npm package (`@groundnuty/macf-channel-server` per DR-022); the same process exposes both. No separate package, no separate process.

Cross-ref DR-023 for MCP tool surface details + UC-1 through UC-4 design.
