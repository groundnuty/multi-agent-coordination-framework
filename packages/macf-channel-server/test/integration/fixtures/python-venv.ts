/**
 * Idempotent Python venv setup for integration tests that need the
 * official `a2a-sdk` Python SDK.
 *
 * Strategy: cache a venv at a stable absolute path inside
 * `node_modules/.cache/a2a-python-venv` so `node_modules` cleanup
 * sweeps it, and so subsequent test runs reuse the venv (pip install
 * is ~10s; cached run is sub-second). The cache is detected by the
 * presence of a sentinel file `.installed-${SDK_VERSION}` — if the
 * version changes, the venv is rebuilt.
 *
 * Devbox is mandatory: pip + python3 come from `python@3.12` pinned
 * in `devbox.json`. Without devbox's python, `python3` resolves to
 * whatever the host has (linuxbrew Python 3.14 was observed during
 * macf#376 implementation — would have made the test non-hermetic).
 *
 * The TS test should `await ensureA2aVenv()` once in beforeAll; the
 * returned `pythonPath` is then handed to `child_process.spawn`.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Pinned SDK version. Bumping requires regenerating the cached venv (the sentinel discriminates). */
export const A2A_SDK_VERSION = '1.0.3';

/** Pinned A2A spec version the SDK targets. */
export const A2A_SPEC_VERSION = '1.0';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Cache at <package-root>/node_modules/.cache/a2a-python-venv. Under
// the package's own node_modules so monorepo-wide `npm ci` sweep
// reclaims it; gitignored via the root `node_modules/` entry.
const PACKAGE_ROOT = resolve(__dirname, '../../../');
const VENV_DIR = resolve(PACKAGE_ROOT, 'node_modules/.cache/a2a-python-venv');

/**
 * Sentinel suffix changes whenever the installed dep set changes (not just
 * the SDK version). Bump when adding/removing extras (e.g., http-server)
 * so existing cached venvs get rebuilt instead of silently lacking deps.
 *
 * Current set (`v2`): `a2a-sdk[http-server]==1.0.3` + `httpx` (Phase 3
 * added `http-server` extra for the server-side probe; pre-Phase-3
 * venvs were `v1` = SDK + httpx only).
 */
const DEPSET_VERSION = 'v2';
const SENTINEL = resolve(VENV_DIR, `.installed-${A2A_SDK_VERSION}-${DEPSET_VERSION}`);
const PYTHON_BIN = resolve(VENV_DIR, 'bin/python3');
const PIP_BIN = resolve(VENV_DIR, 'bin/pip');

export interface VenvHandle {
  /** Absolute path to the venv's python3 binary. */
  readonly pythonPath: string;
  /** SDK version installed (for assertion / commit-msg cross-ref). */
  readonly sdkVersion: string;
  /** A2A spec version targeted. */
  readonly specVersion: string;
}

/**
 * Ensure the venv exists with the pinned `a2a-sdk` installed. Returns
 * a handle whose `pythonPath` can be passed to `child_process.spawn`.
 *
 * Idempotent: a second call with no version bump is sub-second.
 *
 * NOT auto-installable on missing-devbox hosts — fails loud with a
 * diagnostic if `python3` isn't available. Don't paper over that
 * failure mode; the test infra is opt-in (test:integration target),
 * so the operator running it should have the devbox tooling.
 */
export function ensureA2aVenv(): VenvHandle {
  if (existsSync(SENTINEL) && existsSync(PYTHON_BIN)) {
    return {
      pythonPath: PYTHON_BIN,
      sdkVersion: A2A_SDK_VERSION,
      specVersion: A2A_SPEC_VERSION,
    };
  }

  mkdirSync(dirname(VENV_DIR), { recursive: true });

  try {
    // `python3 -m venv` — fails loud if python3 isn't in PATH (devbox
    // shell not active; or python package not pinned in devbox.json).
    execFileSync('python3', ['-m', 'venv', VENV_DIR], {
      stdio: 'pipe',
    });
  } catch (err) {
    throw new Error(
      `Failed to create Python venv at ${VENV_DIR}. ` +
        `Is python3 in PATH? (Devbox should pin python@3.12.) ` +
        `Underlying error: ${(err as Error).message}`,
    );
  }

  try {
    // a2a-sdk[http-server] only adds `sse-starlette` per the SDK's
    // pyproject; the actual ASGI server (uvicorn) + starlette runtime
    // must be installed separately. Both are needed for the Phase 3
    // server-side probe (a2a_server_probe.py — uses Starlette routes
    // + uvicorn). The client-side probes only need httpx, but installing
    // all four is cheap (~10MB) and avoids two install cycles when the
    // integration tests touch both client + server modes.
    execFileSync(
      PIP_BIN,
      [
        'install',
        '--quiet',
        `a2a-sdk[http-server]==${A2A_SDK_VERSION}`,
        'httpx',
        'uvicorn',
        'starlette',
      ],
      { stdio: 'pipe' },
    );
  } catch (err) {
    throw new Error(
      `Failed to pip-install a2a-sdk==${A2A_SDK_VERSION} into ${VENV_DIR}. ` +
        `Underlying error: ${(err as Error).message}`,
    );
  }

  // Sentinel signals "this venv has the pinned SDK + dep set installed."
  // Created last so a partial install doesn't get mistaken for a complete
  // one. Dep set version bumps when extras change (e.g., http-server for
  // Phase 3 server-side probe).
  writeFileSync(
    SENTINEL,
    `a2a-sdk[http-server]==${A2A_SDK_VERSION}\nDEPSET_VERSION=${DEPSET_VERSION}\n`,
    'utf-8',
  );

  return {
    pythonPath: PYTHON_BIN,
    sdkVersion: A2A_SDK_VERSION,
    specVersion: A2A_SPEC_VERSION,
  };
}
