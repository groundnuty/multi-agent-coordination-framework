# Changelog

All notable changes to the `macf` CLI. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning per
[SemVer](https://semver.org/spec/v2.0.0.html).

Plugin + routing-workflow changes ship from separate repos
([`groundnuty/macf-marketplace`](https://github.com/groundnuty/macf-marketplace),
[`groundnuty/macf-actions`](https://github.com/groundnuty/macf-actions))
and are not included here — pin them explicitly in each workspace.

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
