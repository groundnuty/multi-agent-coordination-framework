# DR-024: Local-registry mode (`MACF_REGISTRY_TYPE=local`)

**Status:** Proposed
**Date:** 2026-05-01
**Trigger:** [macf#322](https://github.com/groundnuty/macf/issues/322) (laptop-local / education / demo / framework-development / air-gapped / CI-fixture use cases — operator surfacing 2026-05-01)

## Context

MACF's coordination primitives split cleanly into two layers:

1. **Transport primitives** — `POST /notify` over mTLS HTTPS, MCP push to a local Claude Code TUI, tmux send-keys wake. All three are pure-local IPC or pure-local-network operations. None of them require GitHub at runtime.
2. **Discovery + identity** — agents find each other via the registry (`MACF_<PROJECT>_AGENT_<NAME>` GitHub Actions variables per [DR-005](DR-005-agent-registration.md)); new agents prove identity via the `/sign` challenge-response flow that asserts GitHub-write access ([DR-010](DR-010-cert-signing.md)).

The GitHub coupling lives entirely in layer 2. An operator running 2 Claude sessions on a single laptop, communicating directly, technically does not need GitHub Apps for the transport layer — only for discovery + identity. The 2026-05-01 operator surfacing made this explicit:

> *"on my laptop I'm writing a paper and implementing code, too small project for full github events, but sufficient for 2 claude code sessions that could communicate directly. can macf enable this?"*
> *"can't we use our channel server without github apps?"*

`docs/use-cases.md` already frames the operator-infrastructure prerequisites honestly — under "When NOT to use MACF" the document lists "A VM or persistent host (laptops sleep…)", "Tailscale or equivalent for cross-host network reachability", "GitHub Apps with permissions to grant", and "Token budget for ongoing agent sessions". The same section concludes: *"The CV-laptop-friendly path is open work; not currently supported."*

This DR closes that open work for the **single-host** case. It defines a fourth registry-type variant — `local` — that runs end-to-end without GitHub Apps, and articulates the threat model and trade-offs that come with it.

### Five use cases unlocked

1. **Solo small projects.** The 2026-05-01 surfacing case — operator running a paper-writing session and a code-writing session on a laptop, wants them to coordinate via channel-server primitives. Too small for a dedicated GitHub repo + App; benefits from MACF's coordination protocol regardless.
2. **Education / demos.** Demonstrating MACF's coordination model in a workshop or talk where the audience can't reasonably create GitHub Apps in the demo window. Operator runs `macf init --registry local` on the demo laptop, peers register themselves in `~/.macf/registry/<project>.json`, mTLS-routed notifications work end-to-end without external dependencies.
3. **Framework development.** The MACF maintainers themselves spin up a clean test workspace on every meaningful protocol change. Today this requires a real GitHub App + a coordination repo. Local-registry mode lets the framework be tested end-to-end without that bootstrap (separate from the unit/integration test suites in `packages/*/test/`, which already mock the GitHub layer).
4. **Air-gapped / offline.** Environments where GitHub is not reachable. The transport layer doesn't need it; the discovery layer is the only blocker.
5. **CI sanity-check fixtures.** Integration tests that need 2+ channel-servers actually talking to each other (not mocked) currently require either a real GitHub fixture or a complex stub. Local-registry mode gives a pure-localhost path with no external dependencies — closer to a "real" run than mocking.

### Why this is a separate variant, not a flag

The `RegistryConfig` discriminated union (`packages/macf-core/src/registry/types.ts`) already encodes registry choice as part of the agent's typed config. Adding a `local` variant keeps the existing exhaustive-switch pattern intact (every consumer site that switches on `registry.type` gets a compile-time error if `local` is unhandled). A boolean flag like `MACF_USE_GITHUB=false` would erase that discipline and create a parallel implicit dimension over the existing variants.

## Decision

**Extend `RegistryConfig` with a fourth variant** — `local` — and ship a `LocalRegistryClient` that implements the existing `Registry` interface (`packages/macf-core/src/registry/types.ts`). Local-registry mode replaces three GitHub-coupled paths with same-host equivalents:

| Layer | GitHub mode (`repo` / `org` / `profile`) | `local` mode |
|---|---|---|
| Discovery | `MACF_<project>_AGENT_<name>` GitHub Actions variables | `~/.macf/registry/<project>.json` (operator-overridable path) |
| Identity / cert signing | `/sign` challenge-response per [DR-010](DR-010-cert-signing.md) — proof of GitHub-write access mints a cert | Pre-shared local-CA — `macf init --registry local` generates `~/.macf/registry/<project>.ca.{crt,key}`; subsequent agents in the same project sign against the same CA |
| Routing trigger | `macf-actions` workflow watches issues/PRs/comments → POST `/notify` to assignee's channel-server | None on the GitHub side. Routing is direct `POST /notify` peer-to-peer (operator-driven, or agent-initiated via `notify_peer` MCP tool per [DR-023](DR-023-stage3-hook-mcp-tool-architecture.md) UC-1) |

The transport layer (channel-server, mTLS, `/notify` endpoint, MCP push, tmux send-keys wake, `/health`) is unchanged across all four registry variants. mTLS is still required end-to-end — local mode does not weaken cryptographic transport, only the trust mechanism for cert provisioning.

The proposed shape of the discriminated-union extension:

```typescript
export const LocalRegistryConfigSchema = z.object({
  type: z.literal('local'),
  path: z.string().min(1),  // absolute path; operator-overridable
});

export const RegistryConfigSchema = z.union([
  OrgRegistryConfigSchema,
  ProfileRegistryConfigSchema,
  RepoRegistryConfigSchema,
  LocalRegistryConfigSchema,
]);
```

Default `path`: `~/.macf/registry/<project-name>.json`. Implementation expands the existing variant list at consumer sites via the discriminated-union exhaustive switch — every site that currently switches on three cases gets a fourth.

## Threat model — explicit

This is the most consequential section. Get the security boundaries wrong and operators will misuse `local` mode for cases that warrant `repo`/`org`/`profile` mode.

### What local mode protects against

- **Wire eavesdropping on localhost or trusted-LAN.** mTLS still required end-to-end. Two agents on the same machine are protected from another local user reading their `/notify` traffic via loopback. Two agents on a Tailscale-meshed LAN (out of scope per "Limitations" below; included here for the threat-model framing) would be protected from passive interception on the network.
- **Port-isolation between agents on the same host.** Each agent's channel-server requires the peer to present a cert minted by the project's CA, regardless of port. A rogue local process on a different port can't successfully complete an mTLS handshake.
- **Identity confusion between projects on the same host.** Two `local` projects on the same laptop generate independent CAs (`~/.macf/registry/projectA.ca.crt` vs `~/.macf/registry/projectB.ca.crt`); cross-project cert acceptance is structurally precluded by certificate validation against the project-specific CA.

### What local mode does NOT protect against

- **External network attackers.** This mode is not a substitute for GitHub-App-mediated identity proofs. Treating local mode as suitable for an internet-exposed deployment is a category error. The CA private key sits on disk at `~/.macf/registry/<project>.ca.key` with filesystem permissions as the only access control. Anyone who can read that file can mint a cert and join the project.
- **Adversarial cooperating agents on the same host.** All agents in the project share the CA-key trust by virtue of filesystem access. There is no per-agent identity proof — once an agent has read the CA key, it is indistinguishable from any other agent in the project.
- **Multi-tenant hosts.** A shared host where multiple operators have independent projects is supportable (independent CAs); a shared host where multiple operators share a project is not (one operator can mint certs as the other).
- **GitHub-equivalent audit trail.** No cross-machine, multi-operator-readable audit surface. The local `~/.macf/registry/<project>.json` mtime and the operator's shell history are the audit trail. Fine for solo / education / demo; insufficient for compliance-grade settings.

### Trust boundary statement

> **Local registry mode assumes same-host or trusted-LAN cooperating processes under a single operator's control. It is not a defense against external attackers, multi-tenant adversaries, or compliance-grade audit requirements. Filesystem permissions on `~/.macf/registry/` are the project's trust boundary.**

This sentence (or a paraphrase) appears verbatim in `docs/use-cases.md` and the operator-facing onboarding doc whenever the implementation lands. Operators should not have to read this DR to understand the trade-off.

### Filesystem-permission discipline

The `LocalRegistryClient` writes the registry JSON and the CA key with restrictive permissions:

- `~/.macf/registry/` — `0700` (operator-only; no group, no world)
- `~/.macf/registry/<project>.json` — `0600`
- `~/.macf/registry/<project>.ca.key` — `0600`
- `~/.macf/registry/<project>.ca.crt` — `0644` (read-only safe; cert is public)

`macf doctor` (or an extension thereof; current `doctor` checks `permissions.allow` per [#296 + #305](https://github.com/groundnuty/macf/issues/296)) is a reasonable place for a permission-spotcheck on local-registry mode in a follow-up PR.

## File format

`~/.macf/registry/<project>.json` shape:

```json
{
  "schema_version": 1,
  "project": "my-paper-project",
  "agents": {
    "paper-agent": {
      "host": "127.0.0.1",
      "port": 9001,
      "instance_id": "a1b2c3",
      "started": "2026-05-01T15:00:00Z",
      "type": "permanent"
    },
    "code-agent": {
      "host": "127.0.0.1",
      "port": 9002,
      "instance_id": "d4e5f6",
      "started": "2026-05-01T15:00:30Z",
      "type": "permanent"
    }
  }
}
```

Per-agent value contract mirrors `AgentInfoSchema` from `packages/macf-core/src/registry/types.ts` exactly — same `host` / `port` / `type` / `instance_id` / `started` shape stored in the GitHub-variable value today. This is deliberate: consumers reading agent records get the same Zod-validated shape regardless of which `Registry` implementation produced it.

### `schema_version` field

Top-level `schema_version` enables future migrations without ambiguity. Initial value `1`. If the file format ever needs to change (e.g., to add a `last_seen` timestamp, or to extend `type` to include observation-only agents), bumping `schema_version` and adding a one-shot migration on read keeps existing operator files intact.

This is a structural-defense pattern from the broader MACF doctrine ("never trust file shape; validate"; cf. coordination.md "Input Validation"). The GitHub-variable backend doesn't need a schema version because each variable is independently parsed against `AgentInfoSchema`; the file backend wraps multiple records under one envelope and benefits from explicit versioning of the envelope shape.

### Atomic writes + concurrent-write safety

Two channel-servers may launch concurrently and try to register at the same time. The `LocalRegistryClient` must:

1. **Atomic write via temp-file-then-rename.** Write `<project>.json.<random-suffix>.tmp`, fsync, rename onto `<project>.json`. POSIX rename atomicity guarantees readers never observe a partial file. The same pattern Linux package managers and editors use for any file that other processes might read concurrently.
2. **File-locking around read-modify-write.** Use `proper-lockfile` (or equivalent — choice deferred to implementation PR) to serialize the read → modify → write cycle. Lock acquisition retries with backoff; lock timeout fails the registration with an actionable error.
3. **Recovery on corrupt JSON.** If the file exists but is unparseable (interrupted previous write, manual edit gone wrong), `LocalRegistryClient.list()` returns an empty list with a warning logged, rather than throwing. Re-registration overwrites the corrupt file. This matches the existing `createRegistry`-from-`registry.ts` behavior on individual GitHub variables (corrupt JSON → `null`, not throw).

## Cert flow — local-CA pre-shared

`/sign` challenge-response is the GitHub mode's identity primitive: an agent proves it can write to the project's GitHub registry, and that proof grants it a cert. There is no equivalent identity proof in local mode because there is no shared external authority. The operator's filesystem ownership IS the identity proof.

### Flow

```
First agent (project bootstrap):
  macf init --registry local --path ~/.macf/registry/my-project.json
    ├─ creates ~/.macf/registry/ if absent (0700)
    ├─ generates ~/.macf/registry/my-project.ca.key + .ca.crt (0600 + 0644)
    ├─ generates this agent's cert signed against the CA
    ├─ generates this agent's key
    └─ writes registry entry on first claude.sh launch (atomic temp+rename)

Second agent (joining same project):
  macf init --registry local --path ~/.macf/registry/my-project.json
    ├─ reads existing CA from ~/.macf/registry/my-project.ca.{crt,key}
    ├─ generates this agent's cert signed against the same CA
    ├─ generates this agent's key
    └─ writes 2nd registry entry on first claude.sh launch
```

There is **no `/sign` round-trip** in local mode. The CA private key is read directly from the filesystem path the operator just wrote it to. This is the trade-off — local mode treats filesystem ownership as the trust proof; GitHub mode treats GitHub-write-access as the trust proof.

### `/sign` endpoint disabled in local mode

The channel-server's `/sign` endpoint is structurally inactive in local mode. Two viable disable strategies; preferred form deferred to implementation PR:

- **Return 404 with diagnostic body.** Discoverable failure: a peer that mistakenly tries to use challenge-response gets a clear error pointing at local-mode docs.
- **Skip endpoint registration entirely.** Lower attack surface; less discoverable for peer agents that didn't expect it to be missing.

Either works; the threat-model framing is the same — local mode does not offer the GitHub-mediated trust path, by construction.

### CA-key compromise recovery

In GitHub mode the recovery is `macf certs rotate`, which generates a new CA, re-signs every agent's cert against the new CA, and writes the new CA cert as a registry-wide artifact. In local mode the same `macf certs rotate` flow can run — generate new `~/.macf/registry/<project>.ca.{crt,key}`, re-sign all agent certs that the operator chooses to keep — but there is no GitHub variable for cross-machine key distribution to coordinate against. Single-host: trivial. Cross-host (out of scope per below): operator distributes the new CA cert manually.

## Routing trade-offs

The biggest functional gap between local mode and GitHub mode is **routing**.

GitHub mode has a workflow (`groundnuty/macf-actions@v3`) that watches issues, PRs, and comments. Label-based and `@mention`-based routing fires `POST /notify` to the appropriate agent's channel-server. Cross-agent coordination through GitHub-thread comments is the dominant routing pattern in production deployments.

**Local mode has none of this.** There is no `macf-actions` workflow. There is no GitHub thread to watch. There is no `@mention` substrate. Cross-agent routing in local mode is either:

1. **Direct `POST /notify` peer-to-peer.** Agent-initiated via the `notify_peer` MCP tool per [DR-023](DR-023-stage3-hook-mcp-tool-architecture.md) UC-1. Channel-server looks up peer's `host:port` in the local registry, opens an mTLS connection, posts the notification. Receiver wakes via the existing tmux-send-keys wake path.
2. **Operator-driven coordination.** Operator types into one Claude session, that agent calls the appropriate tool, peers get notified via `/notify`. Or operator drives both sessions independently and uses MACF's transport just for explicit handoffs.

What this means in practice:

- **Cross-agent peer review at PR boundaries does not work in local mode** — there are no PRs in this mode (no GitHub repo to PR against). The `pr-discipline.md` LGTM-gate hooks fire on `Bash(gh ... merge ...)` only; local mode operators don't run those commands.
- **Issue-thread-as-coordination does not work in local mode.** Discussion happens in tmux pane stdin/stdout, not in a persistent issue thread. This costs the auditability + replayability of GitHub mode.
- **Cross-machine routing does not work in local mode.** A `local` registry on host A is not visible to a process on host B. (See "Limitations" — single-host is a load-bearing assumption.)

The trade-off is explicit: **GitHub-driven routing requires `MACF_REGISTRY_TYPE=repo`/`org`/`profile`. Local mode loses that capability in exchange for the bootstrap simplicity.**

For operators outgrowing the local-mode use cases, the migration path (next section) makes the upgrade single-shot and lossless.

## Migration path — local → GitHub mode

When an operator outgrows local mode (cross-machine collaboration emerges, audit trail becomes load-bearing, multi-operator visibility becomes necessary, GitHub-driven routing is wanted), the proposed migration is **one-shot, one-direction**:

```
macf init --registry repo --owner X --repo Y --migrate-from ~/.macf/registry/<project>.json
```

Reads the local registry, writes each agent's record as a `<PROJECT>_AGENT_<NAME>` GitHub variable. Mints fresh agent certs via the existing `/sign` challenge-response (CA carries forward — the local CA becomes the project CA in GitHub mode, agents re-prove via the GitHub-write-access challenge to be assigned cert against the migrated CA). Operator deletes `~/.macf/registry/<project>.{json,ca.key}` once they're satisfied the new mode is working; `<project>.ca.crt` is retained as the project's CA cert (now also distributed via the registry).

### Bi-directional sync — explicitly out of scope

A continuous local↔GitHub sync (changes in either propagate to the other) is **not** in scope. Use cases:

- A team with both laptop-development and production-coordination modes: out of scope. They should run two independent projects.
- An operator who wants to switch back to local mode after going GitHub: not blocked, just no automation. Operator can manually re-init with `--registry local`.

The migration tool is intentionally one-shot: read local, write GitHub, declare done. The two-way sync surface is over-engineering for the use case.

## Limitations — clearly documented

These are the constraints local mode imposes; the implementation PR(s) must surface them prominently in `docs/use-cases.md` + onboarding docs.

1. **Single-host only.** No cross-host coordination. A laptop and a server are different hosts; agents on each cannot find each other through `local` mode. (Network-filesystem-shared registries across hosts are possible in principle but explicitly out of scope — they re-introduce most of the security pitfalls of GitHub mode without the audit benefits.)
2. **No multi-operator visibility.** No GitHub thread for a third party to read what's happening. The mode is for solo + education + demo + framework-dev + air-gapped + CI-fixture, all of which have one operator (or one demo-presenter) by definition.
3. **No GitHub-driven routing.** `macf-actions` workflow doesn't apply. Routing is direct peer-to-peer or operator-driven.
4. **No canonical audit trail outside the local file.** Issue threads, PR review history, label timestamps — none of these exist. The registry file mtime + the operator's tmux scrollback are the audit surface.
5. **Identity attribution via local username.** Commits and tool calls don't have a bot-login backing them. If an operator wants commits to land as `app/<bot>[bot]` they need GitHub mode.
6. **Migration is one-shot.** Bi-directional sync is not in scope. Outgrowing local mode means a single migration call, not an ongoing dual-mode setup.

These limitations should be repeated wherever local mode is documented — `docs/use-cases.md`, `docs/quickstart.md`, the implementation PR's CHANGELOG entry. The cost of misunderstanding which mode is appropriate is high (operator builds a system that needs GitHub mode but is structured as local mode); the cost of over-documenting is low.

## Out of scope

- **Cross-host coordination via local mode.** A network-filesystem-shared registry could in theory work but reintroduces multi-tenancy concerns and complicates the trust boundary. Operators with cross-host needs should use GitHub mode.
- **Multi-operator visibility.** Fundamental to GitHub-as-substrate; not portable to local mode.
- **Bi-directional local↔GitHub sync.** One-shot migration only.
- **Secrets management for the shared CA key.** Filesystem permissions are the entire mechanism. No keychain integration, no encrypted-at-rest, no OS-credential-store binding. Operators with high-assurance requirements should use GitHub mode (where the CA key still sits on disk on the bootstrap machine, but the cross-machine trust path goes through GitHub-mediated identity proofs).
- **Rich-CLI prompts during `macf init --registry local`.** Whether the init flow should interactively prompt for path / agent name / etc. is a UX question for the implementation PR. The DR commits to the existence of `--registry local` + `--path` flags; interactive variants and prompts are implementation-side decisions.
- **`/sign`-endpoint behavior in local mode beyond "disabled".** The exact disable mechanism (404 vs not-registered) is an implementation choice; this DR commits only to the endpoint not being part of the trust path in local mode.

## Consequences

### Positive

- **Lowers the floor for MACF adoption.** Solo operators, educators, demo presenters, framework developers, air-gapped users, and CI fixtures all gain a path that doesn't require operator-grade GitHub setup.
- **Sharpens the GitHub-mode value proposition.** When the only thing GitHub mode buys is GitHub-mode-specific features (routing, audit, multi-operator visibility), the choice becomes deliberate rather than the only option. `docs/use-cases.md`'s honest framing ("MACF is overkill when its core value doesn't apply") gets a constructive completion: there's a mode for the cases where the core value doesn't apply.
- **Closes a documented gap.** `docs/use-cases.md` already names "The CV-laptop-friendly path is open work; not currently supported." The implementation PR turns that into "supported via local-registry mode; see `docs/quickstart.md#local-registry`."
- **Test infrastructure improvement.** Integration tests that today either skip or rely on heavy GitHub mocking can use local mode for end-to-end channel-server-to-channel-server tests. Tighter test coverage of the transport layer.

### Negative / cost

- **Parallel implementation surface.** `LocalRegistryClient` is a second `Registry`-conformant implementation. Bug fixes and feature additions to the registry contract must propagate to both. Discriminated-union exhaustive switch + shared `Registry` interface bound this cost (compile-time fail-fast on missing variants), but it's not zero.
- **Security trade-off to communicate.** Operators must understand which mode they're in and why. A bad-fit choice (using local mode where GitHub mode's audit/routing is needed) produces a system that looks like it works but lacks load-bearing properties. Documentation discipline is the mitigation; misuse is the residual risk.
- **Divergent feature set.** Local mode lacks routing-Action-driven coordination, PR review hooks, GitHub-thread-as-audit-trail. Feature additions to MACF that depend on GitHub-substrate features (e.g., the LGTM-gate hooks per [#319](https://github.com/groundnuty/macf/pull/319), `route-by-pr-review-state` per `macf-actions@v3.3.0`) by definition do not apply to local mode. The two modes diverge in the long run; doctrine must keep that divergence explicit.
- **More test surface.** Concurrent-write-safety tests, atomic-write tests, malformed-JSON-recovery tests, schema-version-migration tests — all new. Standard cost of adding a new backend; surfaced here as a follow-up implementation cost.
- **Documentation surface.** `docs/use-cases.md`, `docs/quickstart.md`, `design/macf-consumer-onboarding.md` (or a fork to `local-registry-onboarding.md`), CHANGELOG, README — all need to communicate the new mode and its trade-offs.

### Neutral

- **`macf-marketplace` plugin unaffected.** The plugin's `mcpServers.macf-agent` config invokes the channel-server via `npx -y @groundnuty/macf-channel-server`. Whether that channel-server is configured for GitHub mode or local mode is determined by env vars set in the operator's `claude.sh`, not the plugin manifest. No plugin-side change needed.
- **Registry contract unchanged.** Every existing `Registry` consumer site (channel-server, CLI commands, MCP tools) reads through the same interface (`packages/macf-core/src/registry/types.ts:Registry`). Adding the local backend is a factory-side change; consumers don't know which backend they got.

## Alternatives considered

### Keep GitHub-only mode and add lightweight App-creation tooling

Build a `macf bootstrap-app` flow that automates GitHub-App creation via the GitHub manifest API (`templates/macf-app-manifest.json` already exists). Operator runs one command, App is created, install attached, ready to go. The bootstrap-friction case is solved without forking the registry contract.

**Rejected** for the use cases this DR targets. Bootstrap-friction is real but it's not the only obstacle:

- Air-gapped use case is not solved (no GitHub reachable means no `bootstrap-app`).
- Education / demo case is not solved (workshop attendees still need GitHub accounts, even with one-command App creation).
- Solo-laptop case ("too small project for full GitHub events") is not solved — the friction isn't App creation, it's the ongoing GitHub-thread orchestration overhead the operator explicitly does not want.

A `macf bootstrap-app` tool is independently a useful follow-up for GitHub mode (would simplify [DR-019](DR-019-app-permissions.md)'s setup story), but it does not subsume local mode's use cases.

### Use SSH-only routing for local mode and drop the registry concept entirely

In local mode, hardcode the peer list in agent config files; route directly via SSH or tmux send-keys per [DR-017](DR-017-ssh-elimination.md)'s pre-elimination architecture. No registry implementation needed.

**Rejected.** [DR-017](DR-017-ssh-elimination.md) eliminated SSH from active code paths for substantive reasons (channel-server is the canonical transport in Stage 3). Reintroducing SSH-only as a parallel mode reverses that direction. Hardcoded peer lists also break the symmetry that makes the existing `Registry` interface useful — every consumer site would need to switch on local-vs-non-local rather than just on the registry-config variant.

The `LocalRegistryClient` approach preserves the same interface contract as GitHub mode at every consumer site; the only difference is the backend. This is the cleaner factoring.

### Network-filesystem-shared registry across hosts (NFS / SMB / equivalent)

Mount a shared filesystem across multiple hosts; place the registry JSON on the share. Cross-host coordination via shared file.

**Rejected.** Reintroduces most of GitHub mode's threat model (cross-tenant trust, audit boundary, key distribution) without the audit benefits. Operators with cross-host needs are well-served by GitHub mode, which is built for that case. Filesystem-based cross-host coordination is a separate concern from the single-host use cases this DR targets.

### Plain-HTTPS-no-mTLS for local mode

Drop mTLS in local mode since the trust boundary is filesystem ownership anyway.

**Rejected.** Defense-in-depth reasoning: mTLS provides port-isolation between agents on the same host even with weak cert distribution. A local non-MACF process on the host (browser, package manager, anything binding loopback) cannot accidentally hit a MACF agent's `/notify` and receive a meaningful response. The cost of keeping mTLS in local mode is low (cert generation already automated); the benefit is surface-area reduction. Keep mTLS.

### Discriminated-union via parameterization (`{ type: 'local' | 'remote'; backend: ... }`)

Re-express registry config as a two-axis decision: locality (local vs remote) × backend (filesystem vs GitHub). Local-filesystem becomes one cell of a 2x2.

**Rejected.** Premature generalization. The four current variants don't decompose neatly along orthogonal axes — `repo`/`org`/`profile` are all GitHub-backed and differ in API path prefix only. Adding `local` as a fourth single-tag variant matches the existing pattern. If future variants emerge that warrant the 2-axis factoring, do it then.

## Cross-references

- [DR-005](DR-005-agent-registration.md) — Agent registration via per-agent variables. Local mode is the same logical contract (each agent owns its own record) over a different storage backend.
- [DR-010](DR-010-cert-signing.md) — `/sign` challenge-response. Local mode replaces this with pre-shared local-CA on the filesystem. The proof-of-trust differs; mTLS itself is preserved.
- [DR-017](DR-017-ssh-elimination.md) — SSH elimination from active code. Local mode does not reintroduce SSH; it uses the same channel-server transport as GitHub mode.
- [DR-019](DR-019-app-permissions.md) — required GitHub App permissions. Inapplicable in local mode (no GitHub App). `macf doctor`'s permission check is GitHub-mode-only.
- [DR-022](DR-022-channel-server-npm-npx.md) — channel-server distribution via npm + npx. Unaffected — same package serves all four registry modes.
- [DR-023](DR-023-stage3-hook-mcp-tool-architecture.md) — Stage-3 hook → MCP-tool architecture. `notify_peer` MCP tool works in local mode; it looks up peers via the `Registry` interface, which `LocalRegistryClient` implements identically.
- `docs/use-cases.md` — honest framing of where MACF helps and where it doesn't. Local mode addresses the "operator infrastructure unavailable" cases the document currently lists as not-supported.
- [macf#322](https://github.com/groundnuty/macf/issues/322) — issue tracking the design + implementation work. This DR addresses the design half; implementation is a follow-up PR.
- 2026-05-01 operator surfacing — see issue body for verbatim quote.

## Decision rule for future PRs

When implementing this DR (in follow-up PRs):

1. **Discriminated-union exhaustive switch at all consumer sites.** Every `switch (registry.type)` adds a `case 'local':` arm. TypeScript's exhaustiveness check fails the build if any consumer is missed.
2. **Runtime fail-fast on unknown registry type.** Zod parsing rejects any `type` string outside the literal union. The `parseRegistryConfig` function in `packages/macf-core/src/config.ts` throws `ConfigError` with an actionable message for unknown types — matches existing pattern for invalid `repo`/`org`/`profile` config.
3. **No silent fallbacks between modes.** If `MACF_REGISTRY_TYPE=local` is set but `MACF_REGISTRY_PATH` is absent and the default path is unwritable, fail loudly at config-parse time. Do not fall back to GitHub mode (would invite the [silent-fallback hazard class](https://github.com/groundnuty/macf-science-agent) noted in the science-agent's `silent-fallback-hazards.md`).
4. **Schema-version handling.** When reading a `<project>.json` file, validate `schema_version` and reject (or migrate) versions other than the current. Implementation PR must commit to a migration mechanism even if the only existing version is `1`.
5. **Cross-mode behavior is undefined and rejected.** A workspace cannot have `MACF_REGISTRY_TYPE=repo` while reading a local-registry file. The CLI must fail loudly on combinations that don't match.

## Open questions for review

These are points the implementation PR will resolve but are flagged here for science-agent's review during DR sign-off:

1. **Does the registry-file-path default (`~/.macf/registry/<project>.json`) collide with anything operator-facing today?** The directory `~/.macf/` is currently used for other workspace state (CA backups, agent indices). Need to confirm subpath `registry/` is unused or coordinate with the existing usage.
2. **Should `LocalRegistryClient` live in `@groundnuty/macf-core` or in a new `@groundnuty/macf-registry-local` package?** Argument for `macf-core`: matches existing `GitHubVariablesClient` location, no new package surface to publish + version. Argument against: pulls `proper-lockfile` (or equivalent) into core; modest dep weight.
3. **What's the `macf init --registry local` interactive flow?** The current `init.ts` registry-type handling assumes GitHub-backed types and prompts for App ID / installation ID / repo. Local mode skips all three. Whether this is a code-path branch in the existing `init` command, or a separate `macf init-local` subcommand, is a UX question.
4. **Should the migration path (`--migrate-from`) be a new subcommand (`macf migrate local-to-repo`) instead of an `init` flag?** Subcommand is cleaner; flag is more discoverable from existing operator muscle memory.

These do not block the DR landing — they bound the implementation-PR scope and ensure science-agent can flag any architectural concerns before code lands.

---

**Implementation:** see follow-up PR(s) on [macf#322](https://github.com/groundnuty/macf/issues/322).
