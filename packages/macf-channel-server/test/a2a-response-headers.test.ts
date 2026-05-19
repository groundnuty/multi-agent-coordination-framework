/**
 * Source-shape regression test for the A2A v1.0 response headers
 * (macf#390 Phase 2a).
 *
 * Spec § 3.6 requires the `A2A-Version: 1.0` response header on
 * A2A-protocol endpoints. This test pins the header constant + the
 * `sendA2aJson` helper presence + the helper's wiring into every
 * sendJson call in the `/a2a/v1` route block — catches accidental
 * regression where a contributor adds a new response path in the A2A
 * block but uses the unwrapped `sendJson` instead of `sendA2aJson`.
 *
 * E2E-level header assertion (real TLS handshake + real HTTP response)
 * is deferred to Phase 2b alongside the Python SDK integration test
 * extension — both will land together to keep the E2E suite scoped
 * to one PR.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTTPS_SOURCE = resolve(__dirname, '../src/https.ts');

describe('A2A v1.0 response headers (#390 Phase 2a — spec § 3.6)', () => {
  it('source declares A2A_RESPONSE_HEADERS constant with A2A-Version: 1.0', () => {
    const content = readFileSync(HTTPS_SOURCE, 'utf-8');
    expect(content).toContain('A2A_RESPONSE_HEADERS');
    expect(content).toMatch(/'A2A-Version':\s*'1\.0'/);
  });

  it('source defines the sendA2aJson helper wrapping sendJson with A2A_RESPONSE_HEADERS', () => {
    const content = readFileSync(HTTPS_SOURCE, 'utf-8');
    expect(content).toContain('function sendA2aJson(');
    // Helper must wire the headers constant in, not redefine inline.
    expect(content).toMatch(/sendJson\(res,\s*status,\s*body,\s*A2A_RESPONSE_HEADERS\)/);
  });

  it('A2A endpoint route block uses sendA2aJson (no bare sendJson on the A2A path)', () => {
    // Scoped read: extract the A2A block (between the
    // `if (method === 'POST' && url === A2A_ENDPOINT_PATH)` line and
    // the closing `}` before the fall-through 404). Verify every
    // sendJson call inside is the sendA2aJson variant — catches the
    // "added a new branch + forgot the header" regression class.
    const content = readFileSync(HTTPS_SOURCE, 'utf-8');
    const blockStart = content.indexOf("if (method === 'POST' && url === A2A_ENDPOINT_PATH)");
    expect(blockStart).toBeGreaterThan(-1);
    const fallThroughMarker = "sendJson(res, 404, { error: 'Not found' });";
    const blockEnd = content.indexOf(fallThroughMarker, blockStart);
    expect(blockEnd).toBeGreaterThan(blockStart);
    const a2aBlock = content.slice(blockStart, blockEnd);
    // Every response-emitting call inside the A2A block must use sendA2aJson.
    expect(a2aBlock).not.toMatch(/\bsendJson\(res,/);
    // And the block must contain at least 5 sendA2aJson calls (the
    // five error/result paths). Loose lower bound — exact count may
    // grow as Phase 2b adds more.
    const count = (a2aBlock.match(/\bsendA2aJson\(res,/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(5);
  });
});
