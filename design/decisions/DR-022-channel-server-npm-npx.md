# DR-022: Channel-server distribution via npm + npx

**Status:** Proposed
**Date:** 2026-04-22

## Context

Plugin v0.1.8 (marketplace) ships the MACF channel server as `dist/server.js`
inside the plugin tarball. The MCP is configured as
`node ${CLAUDE_PLUGIN_ROOT}/dist/server.js`. The server has Node
dependencies (6 packages including the OpenTelemetry SDK from DR-021)
resolved via a SessionStart npm-install hook writing to
`${CLAUDE_PLUGIN_DATA}/node_modules`, symlinked into
`${CLAUDE_PLUGIN_ROOT}/node_modules` because ESM ignores `NODE_PATH`.

This pattern is the one Claude Code's plugins-reference documents. It has
two structural flaws:

1. **Race between MCP spawn and SessionStart hook.** Claude Code spawns
   the MCP process in parallel with SessionStart hook execution. First-
   launch `node dist/server.js` runs before `npm install` has populated
   `node_modules/`, triggering `ERR_MODULE_NOT_FOUND` on
   `@opentelemetry/api` (or any other statically-imported dep), MCP dies
   with no retry. Second-launch works because deps now exist. Reproduced
   on cv-architect + cv-project-archaeologist on 2026-04-22 with plugin
   v0.1.8 — the post-#196 fix exposed it because the OTEL package set
   is larger than v0.1.7 had.

2. **ESM + NODE_PATH mismatch.** The documented `NODE_PATH` example in
   the plugin docs works only for CommonJS packages. For
   `"type": "module"` packages — which macf-agent is, and every modern
   Node MCP server tends to be — ESM resolution ignores `NODE_PATH` and
   only walks `node_modules/` adjacent to the importer. The current
   workaround is a symlink from `.macf/plugin/node_modules` to
   `${CLAUDE_PLUGIN_DATA}/node_modules`. Fragile, undocumented, and
   itself subject to the race above (symlink exists before npm-install
   populates its target).

Meanwhile, Anthropic's own reference MCP plugin (`context7` in
`claude-plugins-official`) uses a fundamentally different pattern:

    { "context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] } }

Zero local install, zero race condition, zero symlink machinery. The MCP
package is its own npm module, cached by npm, invoked on-demand.

Investigation on 2026-04-22 (captured in
`research/2026-04-22-otel-rollout-postmortem.md` in the science-agent
workspace) compared the three viable distribution patterns and
concluded:

| Pattern | Used by | Race-safe? | Ecosystem norm? |
|---|---|---|---|
| `npx` on-demand fetch | `context7` (Anthropic's own) | yes | yes — the de-facto pattern |
| SessionStart install hook → `CLAUDE_PLUGIN_DATA` | macf-agent v0.1.8 | no (our bug) | documented but only viable for CJS / for servers with no eager imports |
| Bundled `node_modules/` in plugin tarball | none observed in the wild | yes | no — violates Claude Code's cache model |
| Pre-install via `macf` CLI | none (MACF-specific) | yes at next-launch | no — ties install to a framework-specific CLI |

## Decision

**Migrate channel-server distribution to npm + `npx` dispatch,
version-bump marketplace plugin to v0.2.0.**

Publish two npm packages under the `@groundnuty` scope:

1. **`@groundnuty/macf`** — the CLI.
   - Binary: `macf` → `dist/cli/index.js`
   - Replaces the current dev-only `npm link` install flow
   - Operator install: `npm install -g @groundnuty/macf`

2. **`@groundnuty/macf-channel-server`** — the MCP channel server.
   - Binary: `macf-channel-server` → `dist/server.js`
   - Replaces the bundled `dist/server.js` in the marketplace plugin tarball

Marketplace plugin `plugin.json` becomes:

    {
      "mcpServers": {
        "macf-agent": {
          "command": "npx",
          "args": ["-y", "@groundnuty/macf-channel-server"]
        }
      }
    }

Delete from the marketplace plugin:

- SessionStart `npm install` hook (`macf-agent/hooks/hooks.json` or wherever
  it lives post-v0.1.8)
- Bundled `dist/` directory — plugin ships only agents, skills, hooks,
  rules; no runtime code
- `package.json` declaring runtime deps (no longer resolved from the
  plugin dir)

## Rationale

- **Race-condition class eliminated.** `npx` resolution is atomic — npm
  fetches + extracts the package completely before executing. No
  half-populated `node_modules/` for Node to stumble over.
- **ESM-native.** `npx` invokes the package via its published `bin`
  entry in npm's own cache; Node's resolver finds transitive deps via
  the package's own adjacent `node_modules/`. Works regardless of
  `"type": "module"`.
- **Matches ecosystem norm.** Plugin.json shape mirrors `context7`
  (`npx -y @scope/name`). Any developer already familiar with Claude
  Code plugins reads the config without friction.
- **Plugin tarball shrinks 5-10×.** Marketplace plugin becomes config +
  static assets (agents, skills, hooks, rules). No runtime code
  duplication across plugin versions.
- **Version alignment cleaner.** `@groundnuty/macf-channel-server`
  versions independently from the plugin manifest. Plugin.json can pin
  a caret range (`npx -y @groundnuty/macf-channel-server@^0.2`) if we
  want to gate on channel-server compatibility separately from
  plugin-asset changes.
- **CLI install story improved.** `npm install -g @groundnuty/macf`
  supersedes the current `devbox run -- npm ci && npm run build && npm link`
  dance (documented in the macf README). Reduces dev-setup friction.

## Decisions within this DR

### Package split: two packages (option B from triage)

Two packages, not one. `@groundnuty/macf` (CLI) and
`@groundnuty/macf-channel-server` (server). Matches the `context7`
pattern exactly. Plugin.json gets the clean form
`npx -y @groundnuty/macf-channel-server` instead of the wordier
`npx -y -p @groundnuty/macf macf-channel-server`.

Tradeoff: two publish targets to keep in sync, deps may duplicate
between them. Acceptable because:

- CLI rarely needs runtime overlap with the channel server (different
  execution contexts: CLI is a one-shot command, server is a long-lived
  process).
- `@groundnuty/macf` can depend on `@groundnuty/macf-channel-server` if
  any CLI command needs the server's types — npm dedupes transitively.

### Migration strategy: clean cutover (option A)

Plugin v0.1.x becomes unsupported once v0.2.0 ships. No dual-path.
Rationale:

- Three live workspaces total (academic-resume, cv-project-archaeologist,
  macf); no installed-base to protect.
- Dual-path adds complexity without user benefit.
- Current v0.1.8 race makes v0.1.x unfit for production anyway.

Operators on v0.1.x: one `macf update` pulls v0.2.0, relaunch fetches
the channel server from npm (one-time cold-fetch, cached after), MCP
comes up clean.

### Publish pipeline: CI on tag (option A)

GitHub Actions workflow in `groundnuty/macf`: on `v*` tag push, run
`npm publish` for both packages. Requires:

- `groundnuty` npm organization created on npmjs.com (doesn't exist yet)
- `NPM_TOKEN` secret provisioned on `groundnuty/macf` repo with write
  access to the scope
- A tagging convention — propose: `v<semver>` tags on `groundnuty/macf`
  trigger publish of both packages at that version

### Package contents: ship `dist/` (option a)

Both packages ship their built `dist/` directory via `files: ["dist/"]`
in package.json. No bundling (rollup/esbuild) for the initial publish.
Rationale:

- Simpler publish pipeline (just `npm run build && npm publish`)
- Avoids bundler gotchas with ESM + native deps
- Install size is fine for CLI tooling (context7's published package is
  also unbundled)

Optimization (single-file bundle via esbuild or rollup) deferred to a
follow-up DR if install-size becomes a complaint.

## Alternatives considered

### Wrapper shell script that busy-waits for deps

`${CLAUDE_PLUGIN_ROOT}/launch.sh` busy-waits until `node_modules/`
contains the required packages, then `exec`s node. Closes the race
inside the current pattern without requiring npm publish.

**Rejected:** band-aid, adds startup latency (polling sleep), keeps the
ESM/NODE_PATH gotcha, doesn't match the Anthropic reference-plugin
pattern. Every future plugin release re-inherits the structural issue.

### Bundle `node_modules/` into the plugin tarball

Ship the pre-installed dep tree inside the plugin. No race, no install
step.

**Rejected:** violates Claude Code's per-version cache model — every
marketplace plugin version stored separately in `~/.claude/plugins/cache/`
means the full `node_modules/` blob gets re-downloaded and stored on
each update. 5-10× tarball bloat, no cross-version dedup. Zero plugins
in the observed ecosystem use this.

### Pre-install deps during `macf update`

MACF's CLI stages `node_modules/` into `${CLAUDE_PLUGIN_DATA}/` before
the next agent launch. Avoids race at launch time.

**Rejected:** works only because MACF ships its own CLI (not portable
to pure plugin consumers without MACF). Ties install state to a
framework-specific lifecycle rather than the Claude-Code-native one.

## Consequences

### Positive

- First-launch race (v0.1.8 bug class) eliminated structurally
- Plugin tarball shrinks; marketplace install + cache update faster
- CLI installable via standard `npm install -g @groundnuty/macf` —
  drops the dev-time `npm link` requirement from the README
- Operator rollout on v0.2.0: `macf update` → relaunch. First-launch
  pulls the channel server from npm (~5-10 s cold fetch), cached
  thereafter for all future launches across all workspaces

### Negative / cost

- `groundnuty` npm org must be created + ownership claimed (manual
  one-time step, requires an npm account under groundnuty's control)
- `NPM_TOKEN` secret must be provisioned on `groundnuty/macf` repo
- CI publish workflow must be authored + tested
- First launch in a new workspace now requires internet (npm fetch).
  Existing MACF agents run offline fine once deps are cached — same
  property we had before, minus the install-from-source on first boot
- Ongoing burden: semver discipline, package-deprecation workflow,
  namespace stewardship. Non-trivial but standard.

### Neutral

- Rollout scope touches three repos:
  - `groundnuty/macf`: package.json refactor to publish three packages
    (CLI, server, deprecated-internal core — see Amendment A), build
    targets for each, npm publish workflow
  - `groundnuty/macf-marketplace`: plugin.json swap, remove bundled
    `dist/` + `package.json` + SessionStart hook, version bump 0.1.8 → 0.2.0
  - `groundnuty/macf-science-agent` (this workspace): rules docs update
    to drop install-hook/symlink mentions, research/postmortem links
    back to this DR

## Follow-ups

Tracked as code-agent issue (filed after this DR merges). Scope:

1. Create `groundnuty` npm org + claim scope ownership
2. Provision `NPM_TOKEN` secret on `groundnuty/macf` repo
3. Refactor `groundnuty/macf` to an npm-workspaces monorepo publishing
   three packages (per Amendment A):
   - `@groundnuty/macf-core` (deprecated-internal), `@groundnuty/macf`
     (CLI), `@groundnuty/macf-channel-server` (server)
   - Add `files` field to each package's manifest for clean publish
     contents
   - Author npm publish GitHub Actions workflow with
     `npm publish --provenance` across all three (per Amendment B)
4. Cut first publish manually once scope is owned — verify all three
   packages install + invoke correctly via `npx`, verify
   `@groundnuty/macf-core` surfaces its deprecation warning on direct
   install — then automate the same flow in CI
5. Update `groundnuty/macf-marketplace`:
   - plugin.json → `npx` dispatch
   - Delete bundled `dist/`, `package.json`, SessionStart install hook
   - Version bump to v0.2.0 + CHANGELOG entry
6. Update rules docs (`plugin/rules/coordination.md`, README in
   `groundnuty/macf`) — remove install-hook + symlink references,
   document new `npm install -g @groundnuty/macf` CLI install path
7. Verify end-to-end on all three agent workspaces: `macf update` →
   relaunch → MCP boots clean → `macf-agent-<name>` appears in Jaeger
   within 30 s

This sequence replaces the currently-open verification path for
[groundnuty/macf#196](https://github.com/groundnuty/macf/issues/196) +
[#197](https://github.com/groundnuty/macf/issues/197) +
[#200](https://github.com/groundnuty/macf/issues/200) — those fixes
stay merged on main, but the user-observable bug (empty Jaeger, failing
MCP on first launch) is closed by the v0.2.0 cutover, not by the v0.1.8
rollout.

## Links

- Plugins reference: [code.claude.com/docs/en/plugins-reference](https://code.claude.com/docs/en/plugins-reference)
- Investigation artifact: `research/2026-04-22-otel-rollout-postmortem.md`
  in `groundnuty/macf-science-agent` workspace
- Upstream precedent: `~/.claude/plugins/cache/claude-plugins-official/context7/unknown/.mcp.json`
  (Anthropic's `context7` plugin, `npx -y @upstash/context7-mcp`)
- Current-pattern reference: DR-013 (plugin-dir adoption), DR-021 (OTEL
  instrumentation — introduced the dep-heavy server that exposed the
  race)

## Amendments post-review (2026-04-22)

Feasibility review by `macf-code-agent[bot]` on [PR #205](https://github.com/groundnuty/macf/pull/205) surfaced several items that tighten the decisions above. Captured here so the DR document alone (not the PR thread) conveys the as-merged shape.

### Amendment A — Package split revised to B3 (npm workspaces + internal core)

The original §"Package split" claimed CLI/server had limited shared-code overlap. Empirical import-graph analysis (by code-agent) found the overlap is substantial — `src/server.ts` imports from 15 shared modules (`certs/*`, `registry/*`, `config`, `token`, `errors`, `logger`, `otel`, `tracing`, `collision`, `shutdown`, `https`, `mcp`, `health`, `tmux-wake`, `types`), and the CLI overlaps on `certs/`, `registry/`, `token`, `config`.

Confirmed package layout: **npm workspaces monorepo, three packages, all three published**:

- `@groundnuty/macf-core` — shared modules. Published to npm with a `deprecated` field in `package.json` reading *"internal shared code for @groundnuty/macf and @groundnuty/macf-channel-server — do not depend on this directly; use the consumer packages instead."* External consumers who `npm install @groundnuty/macf-core` see the deprecation warning.
- `@groundnuty/macf` — CLI. Published. Declares a concrete runtime dep on `@groundnuty/macf-core` at the lock-step version.
- `@groundnuty/macf-channel-server` — server. Published. Same concrete runtime dep on core.

**Correction from the pre-review version of this amendment:** an earlier draft claimed npm would "inline" the internal core into each public package's tarball on publish. That's not how `npm publish` works — when a workspace package declares a dep on another workspace package without additional tooling, the published `package.json` gets a `workspace:*` protocol specifier that external consumers fail to resolve at install time (the name must exist on the registry). See the [PR #205](https://github.com/groundnuty/macf/pull/205) thread for the technical exchange.

Publishing core as a third package is the ecosystem-standard fix — matches Babel's `@babel/helper-*`, React Native's `@react-native/*`, Angular's `@angular/*` internal packages. The `deprecated` field steers external consumers away from depending on what we keep free to refactor, without requiring a publish-time bundler (option 2 — contradicts §"Package contents: ship `dist/`" doctrine) or a workspace-deps rewriter (option 3 — fragile specialized tooling; both rejected).

Concrete publish pipeline implications:
- Three `npm publish` invocations per release tag, not two
- Provenance (Amendment B) applies uniformly across all three
- Lock-step versioning (Amendment D) applies to all three — one `v<semver>` tag publishes all three at that version
- Operator story unchanged: `npm install -g @groundnuty/macf` resolves `@groundnuty/macf-core` as a transitive dep silently

### Amendment B — npm provenance enabled on all three publishes

All three published packages (`@groundnuty/macf-core`, `@groundnuty/macf`, `@groundnuty/macf-channel-server` — see Amendment A for why core is published) publish with `npm publish --provenance`. Requires:
- OIDC trust configured on npmjs.com → `groundnuty/macf` repo (one-time step on the publish settings for each package)
- `permissions: { id-token: write }` in the publish GitHub Actions workflow
- No new secret — OIDC replaces long-lived credentials for this flow

Provenance attestations appear on each package's npmjs.com page, tying the version to the specific CI run + commit SHA that built it. Supply-chain trust win appropriate for a framework that manages App tokens and PreToolUse hooks.

### Amendment C — `NPM_TOKEN` must be a scope-level granular access token (not classic)

When 2FA is enabled on the `@groundnuty` scope (default and recommended), classic automation tokens can't publish. The `NPM_TOKEN` secret provisioned in amendment 2 of the original DR must be a **granular access token** scoped to `@groundnuty/*` with **Publish** permission. Creating it: npmjs.com → Account → Access Tokens → Generate New Token → Granular Access Token form, not the "classic" tab.

### Amendment D — CLI + server version lock-step

Original DR left open whether the CLI and server packages version independently. Confirmed: **lock-step for v0.2.0 and forward, across all three published packages** (core + CLI + server per Amendment A). One `v<semver>` git tag on `groundnuty/macf` publishes all three at the same version. If lifecycles diverge later (empirically unlikely — CLI and server both depend on core and churn together), introduce `cli/v*` + `server/v*` + `core/v*` tag prefixes then. Don't pay the flexibility tax upfront.

### Amendment E — First-launch SLA split by cache state

Original DR implied a "30 s Jaeger service appearance" AC for verification. Cold-cache npm fetch on flaky or low-bandwidth networks can exceed this. Split:

| Launch state | MCP boot | Jaeger service appearance |
|---|---|---|
| First launch ever (cold npm cache) | ≤ 60 s | ≤ 90 s |
| Subsequent launches (warm cache) | ≤ 10 s | ≤ 30 s |

Cold-fetch cost is paid exactly once per workspace. Worth documenting in operator rollout notes for v0.2.0.

### Amendment F — `macf self-update` branches on install path

Operator install path post-cutover: `npm install -g @groundnuty/macf`. Contributor dev install path: `git clone` + `npm run build` + `npm link`. `macf self-update` detects which and branches:

- npm-global install → `npm install -g @groundnuty/macf@latest`
- npm-link dev install → `git pull origin main && npm run build` (existing behavior)

README "Installing macf" section is restructured: npm-global becomes the primary install path; the current `npm link` flow moves to a "Contributing" subsection. The #144 stale-dist warning (build-info check on `macf update`) becomes a dev-install-only signal.

### Amendment G — Tarball before/after listing required in the follow-up AC

Concrete `tar tvzf` of marketplace plugin v0.1.8 vs v0.2.0 side-by-side is a required artifact on the follow-up implementation issue. Defensive against accidental deletion of agent templates, skills, hooks (non-install), or rules during the bundled-dist removal.

### Amendment H — Rollback constraint: verification must complete within 72 h unpublish window

npm allows unpublish for 72 h after publish; after that, remediation is publish a patch (v0.2.1), not rollback. Operator-facing implication: end-to-end verification on all three agent workspaces (academic-resume, cv-project-archaeologist, macf) must complete within the window. Explicit timeline AC in the follow-up issue.

### Amendment I — Marketplace plugin repo location unchanged

Post-cutover the marketplace plugin is config-only (agents, skills, hooks, rules, `plugin.json`) and small. No restructuring needed — `groundnuty/macf-marketplace/macf-agent/` stays as-is. The marketplace repo remains the canonical discovery path for Claude Code plugin installs.
