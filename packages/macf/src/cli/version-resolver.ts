/**
 * Resolves latest stable versions for the three components pinned in
 * macf-agent.json: cli, plugin, actions. Each has a network fetcher
 * and a hardcoded fallback used when the lookup fails.
 *
 * Distinguishes:
 *   - ok            → value fetched successfully
 *   - not_published → HTTP 404 (package/release doesn't exist yet)
 *   - network_error → fetch threw (connection refused, timeout, DNS, ...)
 *   - rate_limited  → HTTP 403/429 from GitHub API, typically anon
 *                     rate-limit (60 req/h). See authHeaders() — if
 *                     `GH_TOKEN` is set in the environment the fetcher
 *                     uses it automatically (5000 req/h), so this
 *                     status fires only when anon AND quota-exhausted.
 *   - invalid_response → HTTP 200 but unparseable/schema-invalid
 *
 * The caller can produce clearer warnings than the old single "network
 * fetch failed" message. GitHub fetchers fall back from /releases/latest
 * to /tags so bare-tag versioning (no GitHub Release object) still works.
 */

export interface VersionSet {
  readonly cli: string;
  readonly plugin: string;
  readonly actions: string;
}

export type FetchStatus = 'ok' | 'not_published' | 'network_error' | 'rate_limited' | 'invalid_response';

/**
 * GitHub API headers. Uses `GH_TOKEN` from env if present — raises the
 * anonymous 60 req/h limit to 5000 req/h. Primary #186 fix: operators
 * on shared IPs (Tailscale, CI runners) were burning anon quota across
 * sessions + getting opaque "invalid_response" on subsequent runs.
 * `claude.sh` exports GH_TOKEN before `macf update` invocations, so
 * the token is available in the typical run path.
 */
function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Accept': 'application/vnd.github+json' };
  const token = process.env['GH_TOKEN'];
  if (token !== undefined && token !== '' && token !== 'null') {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

/**
 * Map a non-ok GitHub API response to the appropriate FetchStatus.
 * 403/429 (rate-limit) and 401 (bad auth) both surface as `rate_limited`
 * — operator-facing warning distinguishes them from other schema/5xx
 * errors that come back as `invalid_response`.
 */
function classifyGithubError(status: number): FetchStatus {
  if (status === 404) return 'not_published';
  if (status === 401 || status === 403 || status === 429) return 'rate_limited';
  return 'invalid_response';
}

export interface FetchResult {
  readonly status: FetchStatus;
  readonly value: string | null;
}

export interface ResolvedVersions {
  readonly versions: VersionSet;
  readonly sources: {
    readonly cli: FetchStatus;
    readonly plugin: FetchStatus;
    readonly actions: FetchStatus;
  };
}

export const FALLBACK_VERSIONS: VersionSet = {
  cli: '0.2.0-rc.0',
  plugin: '0.1.0',
  actions: 'v1',
};

export const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;
export const ACTIONS_TAG_PATTERN = /^v\d+(\.\d+){0,2}$/;

export function isValidSemver(v: string): boolean {
  return SEMVER_PATTERN.test(v);
}

export function isValidActionsRef(v: string): boolean {
  return ACTIONS_TAG_PATTERN.test(v) || v === 'main';
}

/**
 * Compare two semver strings (x.y.z) numerically. Returns negative if a < b,
 * zero if equal, positive if a > b. Used to pick the highest tag from a list.
 */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string): [number, number, number] => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v);
    if (!m) return [0, 0, 0];
    return [Number.parseInt(m[1]!, 10), Number.parseInt(m[2]!, 10), Number.parseInt(m[3]!, 10)];
  };
  const [aMaj, aMin, aPat] = parse(a);
  const [bMaj, bMin, bPat] = parse(b);
  if (aMaj !== bMaj) return aMaj - bMaj;
  if (aMin !== bMin) return aMin - bMin;
  return aPat - bPat;
}

/**
 * Fetch the highest semver tag from a GitHub repo's /tags list.
 * Returns the tag name (with leading 'v' if present) or null with reason.
 */
async function fetchHighestTag(repo: string): Promise<FetchResult> {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/tags`, {
      headers: githubHeaders(),
    });
    if (!res.ok) return { status: classifyGithubError(res.status), value: null };
    const data = await res.json() as Array<{ name?: unknown }>;
    if (!Array.isArray(data)) return { status: 'invalid_response', value: null };

    const semverTags = data
      .map(t => typeof t.name === 'string' ? t.name : null)
      .filter((n): n is string => n !== null && /^v?\d+\.\d+\.\d+$/.test(n));

    if (semverTags.length === 0) return { status: 'not_published', value: null };

    semverTags.sort((a, b) => compareSemver(b, a)); // descending
    return { status: 'ok', value: semverTags[0]! };
  } catch {
    return { status: 'network_error', value: null };
  }
}

/**
 * Fetch latest CLI version from npm registry.
 */
export async function fetchLatestCliVersion(): Promise<FetchResult> {
  try {
    const res = await fetch('https://registry.npmjs.org/@macf/cli', {
      headers: { 'Accept': 'application/json' },
    });
    if (res.status === 404) return { status: 'not_published', value: null };
    if (!res.ok) return { status: 'invalid_response', value: null };
    const data = await res.json() as { 'dist-tags'?: { latest?: string } };
    const latest = data['dist-tags']?.latest;
    if (typeof latest !== 'string' || !isValidSemver(latest)) {
      return { status: 'invalid_response', value: null };
    }
    return { status: 'ok', value: latest };
  } catch {
    return { status: 'network_error', value: null };
  }
}

/**
 * Fetch latest plugin version. Tries /releases/latest first, falls back
 * to /tags if no release exists (our marketplace uses bare tags).
 */
export async function fetchLatestPluginVersion(): Promise<FetchResult> {
  const repo = 'groundnuty/macf-marketplace';

  // Try /releases/latest first
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: githubHeaders(),
    });
    if (res.ok) {
      const data = await res.json() as { tag_name?: string };
      const tag = data.tag_name;
      if (typeof tag === 'string') {
        const semver = tag.replace(/^v/, '');
        if (isValidSemver(semver)) return { status: 'ok', value: semver };
      }
      return { status: 'invalid_response', value: null };
    }
    if (res.status !== 404) return { status: classifyGithubError(res.status), value: null };
    // fall through to /tags (404 = no Release object; marketplace uses bare tags)
  } catch {
    return { status: 'network_error', value: null };
  }

  // Fallback: /tags
  const tagsResult = await fetchHighestTag(repo);
  if (tagsResult.status !== 'ok' || !tagsResult.value) return tagsResult;
  const semver = tagsResult.value.replace(/^v/, '');
  if (!isValidSemver(semver)) return { status: 'invalid_response', value: null };
  return { status: 'ok', value: semver };
}

/**
 * Fetch latest actions version. Tries /releases/latest first, falls back
 * to /tags. Returns major-only tag (v1.2.3 → v1) to match floating-major pins.
 */
export async function fetchLatestActionsVersion(): Promise<FetchResult> {
  const repo = 'groundnuty/macf-actions';

  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: githubHeaders(),
    });
    if (res.ok) {
      const data = await res.json() as { tag_name?: string };
      const tag = data.tag_name;
      if (typeof tag === 'string' && isValidActionsRef(tag)) {
        const m = /^v(\d+)/.exec(tag);
        return { status: 'ok', value: m ? `v${m[1]}` : tag };
      }
      return { status: 'invalid_response', value: null };
    }
    if (res.status !== 404) return { status: classifyGithubError(res.status), value: null };
  } catch {
    return { status: 'network_error', value: null };
  }

  // Fallback: /tags
  const tagsResult = await fetchHighestTag(repo);
  if (tagsResult.status !== 'ok' || !tagsResult.value) return tagsResult;
  const m = /^v(\d+)/.exec(tagsResult.value);
  if (!m) return { status: 'invalid_response', value: null };
  return { status: 'ok', value: `v${m[1]}` };
}

/**
 * Resolve latest versions for all three components, falling back on error.
 * All three fetches run in parallel.
 */
export async function resolveLatestVersions(): Promise<ResolvedVersions> {
  const [cli, plugin, actions] = await Promise.all([
    fetchLatestCliVersion(),
    fetchLatestPluginVersion(),
    fetchLatestActionsVersion(),
  ]);

  return {
    versions: {
      cli: cli.value ?? FALLBACK_VERSIONS.cli,
      plugin: plugin.value ?? FALLBACK_VERSIONS.plugin,
      actions: actions.value ?? FALLBACK_VERSIONS.actions,
    },
    sources: {
      cli: cli.status,
      plugin: plugin.status,
      actions: actions.status,
    },
  };
}

/**
 * Human-readable message for a non-ok fetch status. Used by callers to
 * print actionable warnings instead of the generic "network fetch failed".
 */
export function statusMessage(component: string, status: FetchStatus): string {
  switch (status) {
    case 'ok': return `${component}: ok`;
    case 'not_published': return `${component}: no published release found (using default)`;
    case 'network_error': return `${component}: network fetch failed (using default)`;
    case 'rate_limited': return `${component}: GitHub API rate-limited or unauthorized — set GH_TOKEN to raise the anon 60 req/h limit (using default)`;
    case 'invalid_response': return `${component}: unexpected response format (using default)`;
  }
}
