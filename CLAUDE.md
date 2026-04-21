# Multi-Agent Coordination Framework (MACF)

## What This Is

A framework for coordinating multiple Claude Code agents via GitHub. Agents communicate through MCP channels (HTTP/mTLS), register via GitHub variables, and coordinate work through Issues/PRs.

## Repository Layout

```
src/
  cli/            ← `macf` CLI (init, update, repo-init, doctor, rules,
                    certs, status, peers, cd, claude-sh, plugin-fetcher)
  certs/          ← CA creation, agent certs, challenge-response for /sign,
                    in-memory challenge-store (DR-010 per #80)
  registry/       ← GitHub Variables registry (repo/org/profile scopes)
  plugin/
    bin/          ← macf-plugin-cli.ts (invoked by skills)
    lib/          ← health ping, peer list, dashboard/table/health-detail
                    formatting, issue queue
  server.ts       ← HTTPS + MCP entrypoint, loaded by claude.sh per DR-013
  https.ts, mcp.ts, health.ts, collision.ts, shutdown.ts, ...
  token.ts        ← GitHub App installation token generation

scripts/          ← shipped with CLI, copied into <workspace>/.claude/scripts/
  macf-gh-token.sh       ← fail-loud token helper (#61)
  macf-whoami.sh         ← identity/attribution check (#61)
  tmux-send-to-claude.sh ← canonical tmux-submit pattern (#56)
  check-gh-token.sh      ← PreToolUse attribution-trap hook (#140)
  write-build-info.mjs   ← postbuild: stamps dist/.build-info.json for stale-dist detection (#144)

templates/
  macf-app-manifest.json ← GitHub App manifest with DR-019 permissions

plugin/
  .claude-plugin/plugin.json  ← manifest
  agents/         ← 7 agent identity templates (3 permanent + 4 exp-*)
  skills/         ← 4 skills (macf-status, macf-peers, macf-ping, macf-issues)
  hooks/hooks.json
  rules/
    coordination.md  ← canonical cross-cutting rules, distributed to
                       every workspace by `macf init` / `macf update` /
                       `macf rules refresh`

design/
  decisions/      ← 19 decision records (DR-001 through DR-019)
  phases/         ← 7 implementation phase specs (P1 through P7)
research/         ← literature reviews, empirical analysis

test/             ← unit tests (default vitest run) + test/e2e/ (excluded)
```

## Implementation Status

P1–P7 all implemented. Post-P7 work is bug-fix + security + hardening driven
by issue queue and periodic audits. Currently at **v0.1.1** (see `CHANGELOG.md`).
Recent security-critical landings:

- **#140 / attribution-trap PreToolUse hook** — structural block of `gh` /
  `git push` invocations when `GH_TOKEN` isn't a `ghs_` bot token.
  Catches `sudo gh`, `bash -c "gh ..."`, `bash -xc`, `GH_TOKEN=x gh`,
  and other wrapped forms. Moved the attribution trap from behavioral
  (5 recurrences in one day) to structural.
- **#161 / cross-repo token paths** — `claude.sh` exports
  `MACF_WORKSPACE_DIR` and absolutizes `KEY_PATH` so the token helper
  resolves from any cwd. Closes the cross-repo cwd variant of the
  attribution trap (6th recurrence).
- **#87 / DR-010 fix** — `/sign` challenge-response now actually verifies
  (was tautological; any mTLS cert holder could obtain certs for arbitrary
  agent names before fix). In-memory challenge store with 5-min TTL.
- **#98 / #89** — `extractCN` rejects multi-CN + non-CN-prefix subjects.
- **#99 / #94** — `decryptCAKey` semantic-checks PEM shape of output
  (catches ~6% of wrong-passphrase attempts that previously returned garbage).

Other recent doctrine: **DR-019** codifies the 7 required App permissions
(`metadata`, `contents`, `issues`, `pull_requests`, `actions_variables`,
`workflows`, `actions`). Coordinator agents especially need `actions: read`.
`macf doctor` verifies a workspace's token against DR-019.

## Tech Stack

- TypeScript, ESM-only (`.js` import extensions, `"type": "module"`)
- Node.js 22+ (v25 dev target)
- `@modelcontextprotocol/sdk` — MCP channel protocol
- `@peculiar/x509` + `@peculiar/webcrypto` — cert operations (node:crypto
  can't create X.509; known early decision)
- `node:https` — HTTPS/mTLS server
- `node:crypto` — `pbkdf2`, `createCipheriv`, `timingSafeEqual`, JWT-adjacent
- Zod v4 — runtime validation, `z.infer<>` for types
- Commander v14 — CLI command dispatch
- Vitest v4 — testing
- `gh` CLI + `gh-token` plugin for App token generation

## Development Environment

- **Devbox** is mandatory — do NOT install tools on host
- **Makefile (`dev.mk`) is the primary interface** — always use `make -f dev.mk <target>`
- Never run `devbox run -- npx ...` or `npm` directly from the host for
  first-order workflows; `make -f dev.mk check` is the canonical gate

Key targets:
- `make -f dev.mk check` — full CI: install + typecheck + lint + test (671/671 tests
  as of 2026-04-21)
- `make -f dev.mk typecheck` — type check only (`tsc --noEmit`; formerly `build`, renamed per #127)
- `make -f dev.mk build` — real compile, emits `dist/` (matches `npm run build`)
- `make -f dev.mk lint` — ESLint
- `make -f dev.mk test` — unit tests (no API calls)
- `make -f dev.mk test-e2e` — E2E tests (require real mTLS certs)

One-off test: `devbox run -- npx vitest run test/path/to/file.test.ts`

**Workflow note (after #127):** `make -f dev.mk check` only runs `typecheck`, not `build`. If you've `npm link`ed the CLI for operator use and then modified source, run `make -f dev.mk build` before invoking the linked CLI — otherwise `dist/` is stale and you'll run yesterday's code. Surfaced the hard way during #125 / #126 EKU rollout.

**Stale-dist detection (after #144):** `macf update` warns when the installed CLI's `dist/` is behind the source repo's current HEAD (build-info stamp comparison). Run `macf self-update` to pull origin/main + rebuild in one step. The `dev.mk build` target now routes through `npm run build` so the `postbuild` hook writes `dist/.build-info.json`. Direct `npx tsc` bypasses the hook and triggers a softer "can't verify freshness" warning on next `macf update`.

**E2E runs on cadence (after #149):** `.github/workflows/e2e.yml` runs the E2E suite on every push to main + daily at 07:00 UTC + on `workflow_dispatch`. `make check` stays fast by not including E2E; the workflow catches fixture/gate drift within minutes instead of days (two silent-for-days cases surfaced in one session motivated the split). On failure, the workflow auto-opens (or appends to an existing) `code-agent`/`blocked` issue routed to code-agent's tmux via the router. On the next GREEN push or schedule run, the workflow's self-close-on-green step (#163) closes the open incident issue with a comment citing the green run's SHA + URL — no manual operator close needed. Incident re-opens via title-prefix dedup if failures recur.

**Pre-commit commitlint (after #158):** `.githooks/commit-msg` runs commitlint locally against every staged commit so subject violations (length, type, case) are caught before the commit lands. One-time per clone — run `make -f dev.mk install-hooks` to wire it via `git config core.hooksPath .githooks`. CI keeps the check as a backstop; local runs it too. Clones that haven't opted in are unaffected (no global hooks install).

## Conventions

- Immutable interfaces (`readonly` properties); avoid mutable schema types
- Small files (200-400 lines, 800 max)
- Functions under 50 lines
- Explicit error handling at boundaries
- `import type` for type-only imports (enforced by `verbatimModuleSyntax`)
- Zod schemas for runtime validation, TypeScript types via `z.infer<>`
- Error classes extend `MacfError` with a unique `code` string
- ESM-only: `.js` import extensions in all imports
- Commit types per `commitlint.config.mjs`: feat / fix / **security** /
  **reliability** / refactor / perf / docs / test / chore / ci / revert /
  build / style. Use `security:` for vulnerability fixes + hardening
  (not `fix:`); use `reliability:` for observability / robustness fixes
  from audit / ultrareview findings (not `fix:`) so release notes and
  `git log --grep='^security\|^reliability'` surface them distinctly.

## CLI Surface

`macf` (published via npm when released):
- `init` — set up an agent workspace (`.macf/`, claude.sh, certs, plugin)
- `update` — refresh pinned versions + rules/scripts/plugin assets
- `repo-init` — bootstrap a REPO for routing (agent-config.json, workflow, labels)
- `doctor` — verify bot token permissions vs DR-019
- `rules refresh` — distribute canonical rules/scripts into non-init'd workspaces
- `self-update` — for npm-link dev installs: pull origin/main + rebuild `dist/` (#144)
- `certs init / recover / rotate` — CA key lifecycle
- `status / peers / cd / list` — operational helpers

`macf-plugin-cli` (invoked by plugin skills, not user-facing):
- `status / peers / ping / issues` — backing `/macf-*` skills

## Distribution Pipeline

- CLI ships via npm (eventual)
- Plugin ships via `groundnuty/macf-marketplace@v<version>` (separate repo)
  — `macf init` and `macf update` clone `macf-marketplace:macf-agent/` at
  the pinned tag into `<workspace>/.macf/plugin/`; `claude.sh` uses
  `--plugin-dir` per DR-013
- Routing workflow ships via `groundnuty/macf-actions@v<version>` — consumers
  reference it from their `.github/workflows/agent-router.yml` via
  `uses: groundnuty/macf-actions/.github/workflows/agent-router.yml@v1`
- Canonical helpers (coordination.md, tmux-send-to-claude.sh,
  macf-gh-token.sh, macf-whoami.sh, check-gh-token.sh) ship IN the
  CLI package and are distributed to workspaces at `macf init` /
  `macf update` / `macf rules refresh`

## Where to Start When Debugging

| Symptom                                      | Likely location                          |
|----------------------------------------------|------------------------------------------|
| `gh` operations attributed to user not bot   | `scripts/macf-gh-token.sh` + coordination.md Token & Git Hygiene |
| `macf doctor` reports missing permission     | DR-019 — update the App on GitHub        |
| Routing not delivering to tmux               | `groundnuty/macf-actions` workflow + target agent's `agent-config.json` workspace_dir |
| `/sign` unexpected behavior                  | `src/certs/challenge.ts` + `challenge-store.ts` + DR-010 |
| Version pins weirdness                       | `src/cli/version-resolver.ts` + `macf-agent.json.versions` |
| Agent template out of sync across workspaces | `plugin/rules/coordination.md` (canonical); re-run `macf rules refresh` |
| PreToolUse hook blocks legitimate `gh` call  | `GH_TOKEN` not `ghs_`-prefixed; refresh via `macf-gh-token.sh`; see `scripts/check-gh-token.sh` + #140 |
| E2E suite failing silently / fixture drift   | `.github/workflows/e2e.yml` + auto-opened `code-agent/blocked` issue on main |
| Linked CLI behavior doesn't match main       | Stale `dist/`; run `macf self-update` (or `make -f dev.mk build`); see #144 |
