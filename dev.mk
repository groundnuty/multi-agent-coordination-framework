.PHONY: install check test lint typecheck build clean test-e2e install-hooks

install:
	devbox run -- npm ci

# CI gate — installs deps, type-checks (no emit), lints, runs tests.
# Does NOT emit dist/ — validation doesn't need an artifact and the
# extra tsc emit adds ~8s to every CI run. Use `make -f dev.mk build`
# for emit. See #127 for the rename rationale.
check: install typecheck lint test

# Type-check only (no emit). Fast; safe for editors and pre-commit
# hooks. Formerly named `build` — renamed per #127 because it doesn't
# produce a build artifact.
typecheck:
	devbox run -- npx tsc --noEmit

# Real compile — emits dist/ via tsc config, then stamps
# dist/.build-info.json via the npm postbuild hook so stale-dist
# detection has data to work with (#144). Must go through
# `npm run build`, not bare `npx tsc`, or the postbuild hook won't
# fire. Needed when installing the CLI globally (`npm link`) or
# publishing; the dist/ that npm-link consumes must be rebuilt after
# source changes. See #127 for the hard-to-debug failure mode
# surfaced during the #125 / #126 EKU rollout step 2.
build:
	devbox run -- npm run build

lint:
	devbox run -- npx eslint src/

test:
	devbox run -- npx vitest run

test-e2e:
	devbox run -- npx vitest run --config vitest.e2e.config.ts

clean:
	rm -rf dist coverage

# Wire the repo-local commit-msg hook that runs commitlint against
# every local commit. One-time per clone; sets `core.hooksPath` to
# `.githooks/` so the hook is picked up going forward. Closes the
# loop on #158 (three commitlint violations in a week caught on CI
# rather than locally). Opt-in by design — operators who use their
# own shared hook infrastructure (global hooksPath, husky, etc.) can
# skip this step; CI keeps enforcing as a backstop.
install-hooks:
	git config core.hooksPath .githooks
	@echo "Installed commit-msg hook. Future commits will run commitlint locally before landing."
