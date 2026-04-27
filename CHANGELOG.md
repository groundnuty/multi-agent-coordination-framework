# Changelog

All notable changes to the `macf` CLI. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning per
[SemVer](https://semver.org/spec/v2.0.0.html).

Plugin + routing-workflow changes ship from separate repos
([`groundnuty/macf-marketplace`](https://github.com/groundnuty/macf-marketplace),
[`groundnuty/macf-actions`](https://github.com/groundnuty/macf-actions))
and are not included here — pin them explicitly in each workspace.

## [0.2.5] — 2026-04-27

### Added
- **OTel metric instrumentation in channel-server ([#280], closes [#278]; T6 closure on [testbed#242])** —
  `macf.notify_received_total{type, agent}` and `macf.notify_peer_total{event, delivered, agent}`
  counters via a new `MeterProvider` bootstrap alongside the existing `TracerProvider` in `otel.ts`.
  Same dynamic-import + `OTEL_EXPORTER_OTLP_ENDPOINT` env-gating + zero-cost-default doctrine (DR-021).
  Increments fire on validated `/notify` requests (server side) and per attempted peer in `notify_peer`
  broadcasts (client side; one increment per peer with `delivered=true|false` label for Prom rate
  computation). `PeriodicExportingMetricReader` at default 60s cadence; shutdown handler force-flushes
  both providers on SIGTERM/SIGINT. Closes the deferred T6 metrics AC from testbed#242 Phase D /
  Claim 1b synthesis.
- **PreToolUse hook for mention-routing-hygiene ([#275], closes [#272])** —
  `check-mention-routing.sh` distributed via canonical scripts directory; blocks `gh issue comment`
  / `gh pr comment` / `gh issue close --comment` invocations whose `--body` contains raw
  `@<bot>[bot]` mentions in describing-context positions (mid-line, not backticked, not at
  line-start). Implements `mention-routing-hygiene.md` §5 enforcement structurally per
  science-agent's empirical motivation (6 routing-hygiene class breaches in 1.5 days; codification
  caught ~80%; structural defense closes the 20% gap). Override: `MACF_SKIP_MENTION_CHECK=1`.
  Bash command-type hook (not mcp_tool) per the substrate-compatibility decision rule documented
  in DR-023 amendment ([#279]).

### Documentation
- **DR-023 substrate-compatibility amendment ([#279])** —
  Promotes the architectural insight from PR #275 to DR-level decision rule: `PreToolUse`-blocking
  hooks (UC-2 LGTM gate, UC-4 routing-leak) must use bash command-type form because mcp_tool hooks
  fail open (non-blocking) when the named MCP server is unavailable — permanent state on substrate
  workspaces, transient state on consumer workspaces. `Stop` / `SessionStart` best-effort hooks
  (UC-1 notify_peer, UC-3 checkpoint) keep mcp_tool form because failure-to-fire only loses an
  observability event there. UC-2 ([#270]) issue body reframed accordingly.

[#270]: https://github.com/groundnuty/macf/issues/270
[#272]: https://github.com/groundnuty/macf/issues/272
[#275]: https://github.com/groundnuty/macf/pull/275
[#278]: https://github.com/groundnuty/macf/issues/278
[#279]: https://github.com/groundnuty/macf/pull/279
[#280]: https://github.com/groundnuty/macf/pull/280
[testbed#242]: https://github.com/groundnuty/macf-testbed/issues/242

## [0.2.4] — 2026-04-27

### Reliability
- **Cross-agent loop in `notify_peer` (Option d, [#268], fixes [#267] Finding 2)** —
  Stop hook on agent A → notify_peer broadcasts → agent B's tmux wakes
  → B's LLM processes input → completes turn → B's Stop hook fires →
  notify back to A → loop. ~6s round-trip; 8 cycles in 50s observed
  during macf#256 v0.2.3 testbed validation before manual kill. The
  DR-023 §"Cycle prevention" same-agent `(server, tool, input)` dedup
  doesn't catch cross-agent ping-pong (each leg has its own MCP context).
  Fix: `server.ts` `onNotify` discriminates by payload type. For
  `type === 'peer_notification'` → MCP push only, tmux wake skipped.
  All other NotifyTypes preserve current wake-on-receipt behavior.
  Recipient SEES the notification (channel state via `/macf-status`)
  but doesn't auto-respond as a fresh turn → no Stop hook firing in
  response → no notify back. SessionStart polling-fallback (DR-020)
  catches missed notifications next session start.
- **Sender timeout 1s → 5s ([#268], fixes [#267] Finding 1)** —
  v0.2.3's 1s `notify_peer` timeout cut off mid-receiver-wake (~1050ms
  total per Tempo trace `6a4764e42ac5...` — `tmux_wake_delivered` alone
  was 1044ms). Sender reported `peers_delivered=0` even when delivery
  succeeded → unreliable structuredContent metrics. Bumped to 5s;
  Option d's tmux-wake-skip drops /notify response to ~5ms, so 5s is
  comfortable margin even for any future receiver-path latency.

### Features
- **Sender-side OTel span `macf.tool.notify_peer` ([#268], fixes [#267] Finding 3)** —
  v0.2.3 `notify_peer` invoked `httpsRequest` directly without OTel
  instrumentation → sender side invisible in Tempo (only receiver's
  `macf.server.notify_received` appeared). Fix: wrap body in
  `tracer.startActiveSpan(SpanNames.ToolNotifyPeer, CLIENT, ...)`. Span
  attributes: `gen_ai.operation.name=peer_notify`, `macf.notify.type`,
  `macf.notify.event` (session-end | turn-complete | error | custom),
  `macf.notify.target` (peer-name | "broadcast"),
  `macf.notify.peers_attempted`, `macf.notify.peers_delivered`. Phase
  D / Claim 1b cell-effect dimensions are now sliceable.
- **W3C traceparent propagation cross-channel-server ([#268], fixes [#267] Finding 4)** —
  v0.2.3 outbound POST had no traceparent header → receiver's
  `notify_received` span was a ROOT (no parent) → cross-trace correlation
  impossible. Fix: `notify-peer.ts` `postToPeer` injects via
  `propagation.inject(context.active(), headers)` before sending.
  Receiver-side extract was already in place from macf#194
  (`https.ts` calls `propagation.extract(context.active(), req.headers)`
  + uses as parent context for `notify_received` span). Result:
  receiver's `NotifyReceived` becomes a child of sender's `notify_peer`
  span; full cross-channel-server parent-child trace relationship.

### Docs
- **DR-023 §UC-1 inline amendment** documenting all 4 refinements
  (Option d observational semantic, cross-agent loop class, sender-side
  OTel span emission, traceparent propagation flow + 5s timeout
  rationale) — future implementers get the WHY for each post-hoc fix.

[#267]: https://github.com/groundnuty/macf/issues/267
[#268]: https://github.com/groundnuty/macf/pull/268

## [0.2.3] — 2026-04-27

### Reliability
- **`notify_peer` self-exclusion normalization ([#266], fixes [#256] Bug 1)** —
  `Registry.list()` returns names in GitHub Variables canonical form
  (`MACF_TESTER_1_AGENT` — uppercased + hyphens-to-underscores per
  `toVariableSegment`); `selfAgentName` is the canonical agent identity
  (`macf-tester-1-agent`). Raw string comparison never matched →
  broadcasts looped back to self → triggered the `(server, tool, input)`
  deduplication cycle DR-023 §"Cycle prevention" warns about. Bug surfaced
  during macf#256 v0.2.2 testbed validation (`peers_attempted=2` when
  registry had only 1 peer + self). Fix normalizes BOTH sides via
  `toVariableSegment` before comparison; applies to both single-peer
  (`to` short-circuit) and broadcast (filter list) modes.

### Features
- **`peer_notification` NotifyType ([#266], fixes [#256] Bug 2)** —
  v0.2.2 `notify_peer` POSTed `type: input.event` (e.g., `"session-end"`),
  but the `/notify` endpoint validates against the closed `NotifyTypeSchema`
  enum → HTTP 400 validation error. Per Option B (operator-authorized
  on macf#256), `peer_notification` is added as a dedicated NotifyType
  variant in `@groundnuty/macf-core` with a new narrow producer schema
  `PeerNotificationPayloadSchema`. `notify_peer` now sends
  `type: "peer_notification"`, `event: input.event`, `source: selfAgentName`.
  `notify-formatter.ts` renders the new type (`"Peer X reports event: Y"`
  or producer's `message`); `tracing.ts` `operationNameForNotifyType`
  maps to `peer_notify` GenAI op-name (distinct from `notify` /
  `invoke_agent` — preserves Phase D / Claim 1b cell-effect measurement
  clarity).

### Docs
- **DR-023 §UC-1 inline amendment** documenting both refinements
  (peer_notification payload variant + self-exclusion-must-normalize
  discipline) so future implementers get the WHY, not just the WHAT.
- **`packages/macf/plugin/hooks/hooks.json` server-reference fix** —
  bare `"server": "macf-agent"` → `"server": "plugin:macf-agent:macf-agent"`
  (Claude Code 2.1.x mounts plugin-provided MCP servers under that prefix;
  bare key resolves only against global registry → "not connected" error).
  Matches marketplace v0.2.2 fix.

[#266]: https://github.com/groundnuty/macf/pull/266

## [0.2.2] — 2026-04-27

### Features
- **`notify_peer` MCP tool ([#265], implements [#256] Sub 2 of Stage 3 master tracker [#254])** —
  new tool registered on `@groundnuty/macf-channel-server`'s MCP surface,
  invokable from the plugin's `Stop` hook (`type: "mcp_tool"`). Resolves
  peer agent's channel-server URL from the project registry, mTLS-POSTs
  to peer's `/notify` HTTP endpoint. Supports both single-peer mode (`to`
  argument) and broadcast mode (`to` absent → fan out to all registered
  peers, exclude self for cycle prevention). Per DR-023 §UC-1; refines
  the literal `to: z.string()` to `to: z.string().optional()` per the
  Option A impl-time scope refinement (universal hook entry, no
  per-workspace customization needed).
- **`McpServer` API uplift in channel-server** — switched from low-level
  `Server` to `McpServer` (canonical v1.x API per `@modelcontextprotocol/sdk`
  1.29.0). `pushNotification` path preserved via the underlying
  `mcp.server.notification` accessor for the Claude-Code-extension
  `notifications/claude/channel` method. Same wire behavior; new tool
  registration path enabled.
- **Plugin `Stop` hook entry** in `packages/macf/plugin/hooks/hooks.json`
  invoking `macf-agent:notify_peer` with `{event: "session-end"}`. Universal
  across consumer workspaces (no per-agent `to:` customization needed).

### Reliability
- **Self-exclusion cycle prevention** for `notify_peer` in both single-peer
  (`to === selfAgentName` short-circuit) and broadcast (registry.list filter)
  modes. Blocks the `(server, tool, input)` deduplication cycle DR-023
  §"Cycle prevention" warned about for universally-shipped hook inputs.

### Tests
- **789/789 unit + integration pass** (was 778; +10 new `notify-peer.test.ts`
  cases covering single/broadcast modes + cycle prevention + transport
  errors + partial-success aggregation; +1 `mcp.test.ts` for the new
  `.mcp` accessor on the channel surface).

### Docs
- **DR-023 §UC-1 inline update** documenting the Option A refinement
  (`to` optional + broadcast semantic + `isError` semantic asymmetry
  between single-peer and broadcast modes).

[#256]: https://github.com/groundnuty/macf/issues/256
[#265]: https://github.com/groundnuty/macf/pull/265

## [0.2.1] — 2026-04-26

### Reliability
- **Fallback-version regression for plugin manifest ([#260], fixes [#259])** —
  `FALLBACK_VERSIONS.plugin = '0.1.0'` was sticking consumers on the
  pre-DR-022 plugin manifest (`mcpServers.macf-agent.command: "node"`
  against `${CLAUDE_PLUGIN_ROOT}/dist/server.js`) when the version-
  resolver's network fetch fell through (anon GitHub API rate limit
  during bootstrap). The v0.1.0 manifest fails on Claude Code spawn
  with `Cannot find package '@modelcontextprotocol/sdk'` (deps land in
  `CLAUDE_PLUGIN_DATA`, node looks from `PLUGIN_ROOT`). v0.2.0
  marketplace plugin cut over to `npx -y @groundnuty/macf-channel-server`
  (DR-022 npm-dispatch), but the fallback never moved with it.
  Bumped to `'0.2.0'`. Empirical impact: testbed (`groundnuty/macf-testbed#229`)
  blocked at Phase C; substrate workspaces (macf#257 Sub 3) unable to
  bootstrap channel servers via `macf init`. Fix verified — tester-1
  channel server spawned (port 9777, instance `2a7f82`) + registry
  variable populated at `MACF_TESTBED_AGENT_MACF_TESTER_1_AGENT`
  timestamp `2026-04-26T22:25:11Z`. Test (`init-versions.test.ts:49`)
  updated to reference `FALLBACK_VERSIONS.plugin` constant instead of
  hardcoding (lockstep pattern per macf#216).

[#259]: https://github.com/groundnuty/macf/issues/259
[#260]: https://github.com/groundnuty/macf/pull/260

## [Unreleased]

Merged after the `v0.1.1` tag on 2026-04-20/21. Will be included in the
next tag (candidate `v0.1.2` unless a breaking change lands first).

### Security
- **Cross-repo absolute-path token refresh ([#161])** — `claude.sh`
  exports `MACF_WORKSPACE_DIR` and absolutizes `KEY_PATH`. 7 agent
  templates + workspace rules rewritten from `./.claude/scripts/` to
  `$MACF_WORKSPACE_DIR/.claude/scripts/`. Closes the 6th attribution-
  trap recurrence (cross-repo cwd variant).

### Reliability / CI
- **E2E workflow install step ([#156], fixes [#154])** — adds
  `make -f dev.mk install` before `test-e2e` on CI runners.
- **E2E self-close on green ([#166], fixes [#163])** — post-merge
  push + schedule runs auto-close open auto-opened incident issues
  when E2E passes. Machine-enforces the "stays open until green"
  contract.
- **E2E cert-tmpdir race + version-bump completeness ([#162], fixes
  [#160])** — `randomUUID()` suffix for parallel-safe temp dirs; 3
  missed E2E version assertions aligned with v0.1.1.
- **`INCIDENT_TITLE_PREFIX` env extraction ([#168])** — job-level env
  so auto-open + self-close share a single title-prefix source.

### Tests
- **Pre-commit commitlint hook ([#159], fixes [#158])** —
  `.githooks/commit-msg` + `make -f dev.mk install-hooks` target.
- **Real-SDK MCP smoke test ([#169])** — `test/mcp-integration.test.ts`
  with `CapturingTransport` verifies `notifications/claude/channel`
  reaches the transport. Catches silent SDK framing drift the mocks
  can't see.
- **Version-literal helper ([#167])** — `test/version-helper.ts`
  exports `EXPECTED_VERSION` from `package.json`; 5 test sites
  rewritten. Next bump is single-site.

### Docs
- **Coordination.md auto-opened-issue rule ([#165], fixes [#164])** —
  Issue Lifecycle rule 5 codifies `Refs #N` (not `Closes`) on bot-
  filed issues, explicit reviewer ping (not bot-reporter echo), and
  wait-for-green-before-close doctrine.
- **Post-session CLAUDE.md refresh ([#170])** — test count, security
  landings, scripts list, debugging table updated. Rule 5 staleness
  fix post-#166 merge.
- **Dogfood hook install ([#175])** — `.claude/scripts/check-gh-token.sh`
  added to match existing workspace-script convention.

[#154]: https://github.com/groundnuty/macf/issues/154
[#158]: https://github.com/groundnuty/macf/issues/158
[#160]: https://github.com/groundnuty/macf/issues/160
[#163]: https://github.com/groundnuty/macf/issues/163
[#164]: https://github.com/groundnuty/macf/issues/164
[#156]: https://github.com/groundnuty/macf/pull/156
[#159]: https://github.com/groundnuty/macf/pull/159
[#161]: https://github.com/groundnuty/macf/pull/161
[#162]: https://github.com/groundnuty/macf/pull/162
[#165]: https://github.com/groundnuty/macf/pull/165
[#166]: https://github.com/groundnuty/macf/pull/166
[#167]: https://github.com/groundnuty/macf/pull/167
[#168]: https://github.com/groundnuty/macf/pull/168
[#169]: https://github.com/groundnuty/macf/pull/169
[#170]: https://github.com/groundnuty/macf/pull/170
[#175]: https://github.com/groundnuty/macf/pull/175

## [0.1.1] — 2026-04-20

First release after the 2026-04-17 ultrareview + 2026-04-20 audit arc.
Eleven merges across five categories, covering attribution-trap
hardening, stale-dist detection, E2E backfill, and CI cadence. No
breaking changes; operators upgrading from 0.1.0 pick everything up on
next `npm link` rebuild (or via the new `macf self-update`).

### Security
- **PreToolUse hook blocks `gh` / `git push` on non-`ghs_` tokens
  ([#140], PR [#142])** — structural enforcement of the
  attribution-trap rule. Moved from operator-discipline to
  harness-enforced; blocks the command before it runs when
  `GH_TOKEN` is missing or user-scoped.
- **Hook covers shell-wrapper bypass paths ([#153], PR [#155])** —
  post-audit fixes for `bash -c "gh ..."`, `sh -c '...'`, `bash -x -c`,
  and combined-flag forms (`-xc`, `-exc`, `-lc`). Earlier regex missed
  the wrapping shell; now matches the whole wrapper → gh chain.

### Features
- **`macf self-update` command ([#144], PR [#146])** — for npm-link
  dev installs. Fetches origin/main, ff-merges, conditionally runs
  `npm ci` only when `package-lock.json` changed, then `npm run build`.
  Refuses dirty trees; clamps oversized status output.
- **Stale-dist detection in `macf update` ([#144], PR [#146])** —
  three-way freshness check: `dist/.build-info.json` stamp matches
  source HEAD → silent; stamp older → loud warning with SHAs + fix
  command; stamp missing or `unknown` commit → softer warning pointing
  at `npm run build`. Bootstrap-limitation documented: detection only
  helps versions from 0.1.1 forward.

### Tests
- **`/sign` E2E suite ([#137] Chunk 2, PR [#148])** — 14 cases
  covering the two-step DR-010 challenge-response, error-status
  mapping, endpoint-level gates, and transport edges. Resurrected
  the silently-broken E2E fixture as a side effect (no clientAuth
  EKU since the #121 gate landed; all E2E tests had been 403'ing for
  3 days without detection).
- **`/health` EKU-reject E2E ([#137] Chunk 3, PR [#151])** — 5 cases
  pinning the clientAuth-EKU gate invariants across `/health`,
  `/notify`, `/sign`, and unknown routes. Adds a no-EKU cert fixture
  to exercise the actual reject path that #121 was built for.
- **Weak-PRNG repo-wide guard (PR [#150])** — widened from `src/https.ts`
  only to `src/**/*.ts`. `Math.random` repo-banned; `crypto.randomInt`
  / `randomUUID` / `randomBytes` are the canonical sources.

### Reliability
- **Self-update output polish (PR [#150])** — dirty-tree error clamps
  to 20 status lines + `(N more; run \`git status\`)` footer for
  pathological cases (post-`rm -rf node_modules/` rebuild etc.).
- **`.claude/rules/` gitignored at source repo (PR [#150])** —
  `macf rules refresh` artifacts no longer trip the `macf self-update`
  dirty-tree check when run on the macf source repo itself.
- **CI install step before E2E ([#154], PR [#156])** — E2E workflow
  now calls `make -f dev.mk install` before `test-e2e`. Caught by
  the workflow's own auto-open mechanism within 1 min of the #152
  merge — feedback loop working as designed.

### CI
- **E2E suite runs on cadence ([#149], PR [#152])** — `.github/workflows/e2e.yml`
  fires on push-to-main (with paths filter) + daily 07:00 UTC + on
  `workflow_dispatch`. On failure, auto-opens (or appends to existing)
  `code-agent` / `blocked` issue with title-prefix dedup.

### Docs
- **`coordination.md` Issue Lifecycle rule 4: body is frozen during
  active work (#141, PR [#145])** — scope edits on an in-flight issue
  go as follow-up comments; body edits during active work silently
  shift the target under the assignee.
- **`coordination.md` Communication rule 3: verify your comment
  actually posted (#143, PR [#145])** — writing a review in prose
  isn't the same as posting it via tool; mandatory `gh issue view
  --json comments --jq '.comments[-1].author.login'` verification
  tail on any review-producing turn.
- **Top-level `README.md` (PR [#147])** — architecture overview,
  setup walkthrough, dogfooding evidence, related-repos section,
  example configs appendix. Reviewed + corrected for CLI flag names,
  DR file paths, empirical claims.

### Dependencies
- **`hono` 4.12.12 → 4.12.14** — transitive via `@modelcontextprotocol/sdk`
  → `@hono/node-server`; closes GHSA-458j-xx4x-4375 (moderate HTML
  injection in hono/jsx SSR; not exploitable in MACF's usage but cleanest
  to stay on supported version).
- **`@modelcontextprotocol/sdk` pin `^1.12.1` → `~1.29.0`** — previous
  caret-range allowed 17 minor-version silent drift. Patch-level range
  now requires deliberate `package.json` edit to accept new minors.

### Meta
Companion cross-repo fix in `groundnuty/macf-actions` PR #14 closes
[`groundnuty/macf-actions#13`][mamt-13] (regex → fixed-string match
for mention routing). Filed from the same audit sweep.

[#137]: https://github.com/groundnuty/macf/issues/137
[#140]: https://github.com/groundnuty/macf/issues/140
[#141]: https://github.com/groundnuty/macf/issues/141
[#143]: https://github.com/groundnuty/macf/issues/143
[#144]: https://github.com/groundnuty/macf/issues/144
[#149]: https://github.com/groundnuty/macf/issues/149
[#153]: https://github.com/groundnuty/macf/issues/153
[#154]: https://github.com/groundnuty/macf/issues/154
[#142]: https://github.com/groundnuty/macf/pull/142
[#145]: https://github.com/groundnuty/macf/pull/145
[#146]: https://github.com/groundnuty/macf/pull/146
[#147]: https://github.com/groundnuty/macf/pull/147
[#148]: https://github.com/groundnuty/macf/pull/148
[#150]: https://github.com/groundnuty/macf/pull/150
[#151]: https://github.com/groundnuty/macf/pull/151
[#152]: https://github.com/groundnuty/macf/pull/152
[#155]: https://github.com/groundnuty/macf/pull/155
[#156]: https://github.com/groundnuty/macf/pull/156
[mamt-13]: https://github.com/groundnuty/macf-actions/issues/13

## [0.1.0] — 2026-04-15

Initial release. Phases P1–P7 from the design doc set landed; CLI,
channel server, registry, certs, plugin distribution, routing workflow
all shipped. See `design/decisions/` and `design/phases/` for the
architectural context; see the Git log for the ~60 merges from the
2026-04-15 → 2026-04-17 development sprint.
