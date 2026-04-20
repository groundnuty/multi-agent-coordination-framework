.PHONY: install check test lint typecheck build clean test-e2e

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
