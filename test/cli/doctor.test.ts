/**
 * Tests for `macf doctor` — pure `diffPermissions` logic plus the
 * formatted-row helper. The full `runDoctor` integration test would
 * require mocking `execFileSync`, which is painful with vi.mock's
 * module semantics — we cover the business logic (diff + format)
 * directly and trust the wrapper.
 */
import { describe, it, expect } from 'vitest';
import {
  MACF_REQUIRED_PERMISSIONS,
  diffPermissions,
  formatPermissionRow,
  describeNonJwtOutput,
  type RequiredPermission,
} from '../../src/cli/commands/doctor.js';

describe('MACF_REQUIRED_PERMISSIONS', () => {
  it('has exactly the seven DR-019 permissions (canonical API names)', () => {
    const names = MACF_REQUIRED_PERMISSIONS.map(p => p.name).sort();
    expect(names).toEqual([
      'actions', 'actions_variables', 'contents', 'issues', 'metadata',
      'pull_requests', 'workflows',
    ]);
  });

  it('uses canonical API name actions_variables, not UI label variables', () => {
    // Regression guard: GitHub's API returns actions_variables; the UI
    // shows "Variables". Using the UI label would give false negatives.
    const names = MACF_REQUIRED_PERMISSIONS.map(p => p.name);
    expect(names).toContain('actions_variables');
    expect(names).not.toContain('variables');
  });

  it('actions is read-level (coordinator self-debug)', () => {
    const actions = MACF_REQUIRED_PERMISSIONS.find(p => p.name === 'actions');
    expect(actions?.level).toBe('read');
  });

  it('every write-level permission has a rationale referencing a concrete use', () => {
    for (const p of MACF_REQUIRED_PERMISSIONS.filter(x => x.level === 'write')) {
      expect(p.why.length).toBeGreaterThan(10);
    }
  });
});

describe('diffPermissions', () => {
  function allOk(): Record<string, string> {
    return {
      metadata: 'read',
      contents: 'write',
      issues: 'write',
      pull_requests: 'write',
      actions_variables: 'write',
      workflows: 'write',
      actions: 'read',
    };
  }

  it('finds no gaps when every required permission is granted at the required level', () => {
    const finding = diffPermissions(allOk());
    expect(finding.missing).toEqual([]);
    expect(finding.insufficient).toEqual([]);
  });

  it('flags missing permissions as missing', () => {
    const actual = allOk();
    delete actual.actions; // coordinator gap observed in the wild
    const finding = diffPermissions(actual);
    expect(finding.missing.map(p => p.name)).toEqual(['actions']);
    expect(finding.insufficient).toEqual([]);
  });

  it('flags write-required-but-read-granted as insufficient (not missing)', () => {
    const actual = allOk();
    actual.actions_variables = 'read'; // downgraded
    const finding = diffPermissions(actual);
    expect(finding.missing).toEqual([]);
    expect(finding.insufficient.map(x => x.required.name)).toEqual(['actions_variables']);
    expect(finding.insufficient[0]?.actual).toBe('read');
  });

  it('does NOT flag read-required-but-write-granted — user exceeds requirement', () => {
    const actual = allOk();
    actual.actions = 'write'; // more than we asked for
    const finding = diffPermissions(actual);
    expect(finding.missing).toEqual([]);
    expect(finding.insufficient).toEqual([]);
  });

  it('handles the observed real-world gap (no actions_variables, no actions)', () => {
    // This matches what `GET /app/installations/:id` returns for an App
    // created before the #72 doctrine added variables/actions.
    const actual: Record<string, string> = {
      contents: 'write',
      issues: 'write',
      metadata: 'read',
      pull_requests: 'write',
      workflows: 'write',
    };
    const finding = diffPermissions(actual);
    const missingNames = finding.missing.map(p => p.name).sort();
    expect(missingNames).toEqual(['actions', 'actions_variables']);
  });

  it('handles completely empty permission map (broken token)', () => {
    const finding = diffPermissions({});
    expect(finding.missing.length).toBe(7); // all seven missing
    expect(finding.insufficient).toEqual([]);
  });
});

describe('formatPermissionRow', () => {
  const req: RequiredPermission = {
    name: 'actions',
    level: 'read',
    why: 'gh run list for self-debug',
  };

  it('marks satisfied permissions with ✓', () => {
    const row = formatPermissionRow(req, 'read');
    expect(row).toMatch(/^✓ /);
    expect(row).toContain('actions');
    expect(row).toContain('required=read');
    expect(row).toContain('actual=read');
  });

  it('marks missing permissions with ✗ and includes rationale', () => {
    const row = formatPermissionRow(req, undefined);
    expect(row).toMatch(/^✗ /);
    expect(row).toContain('MISSING');
    expect(row).toContain('gh run list for self-debug');
  });

  it('marks insufficient (write-required, read-granted) with ⚠', () => {
    const writeReq: RequiredPermission = {
      name: 'actions_variables',
      level: 'write',
      why: 'Registry',
    };
    const row = formatPermissionRow(writeReq, 'read');
    expect(row).toMatch(/^⚠ /);
    expect(row).toContain('need write, have read');
  });
});

describe('describeNonJwtOutput (#86 — no JWT leak)', () => {
  it('reports at most the first 6 characters of non-JWT output', () => {
    // Simulate a genuinely-valid JWT that trips the startsWith check
    // due to e.g. a leading whitespace char. Must NOT leak beyond 6.
    const fakeJwt = ' eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature';
    const msg = describeNonJwtOutput(fakeJwt);
    // First 6 chars end at "eyJhbG" (after the leading space)... actually
    // the slice is on the raw string: " eyJhb" (leading space + 5 chars).
    // Length should match.
    expect(msg).toContain(`length=${fakeJwt.length}`);
    // Body of message should contain EXACTLY 6 characters of the input
    // and no more. Check that no fragment longer than 6 chars of the
    // original appears in the message.
    const longFragment = fakeJwt.slice(0, 20);
    expect(msg).not.toContain(longFragment);
    // And the payload segment must not be present.
    expect(msg).not.toContain('payload');
    expect(msg).not.toContain('signature');
  });

  it('handles empty output cleanly', () => {
    const msg = describeNonJwtOutput('');
    expect(msg).toContain('(empty)');
    expect(msg).toContain('length=0');
  });

  it('handles short error-message output (e.g. "401")', () => {
    const msg = describeNonJwtOutput('401');
    expect(msg).toContain("prefix='401'");
    expect(msg).toContain('length=3');
  });

  it('does not include the word "undefined" when input is an empty string', () => {
    // Guard against "prefix='undefined'" or similar drift
    const msg = describeNonJwtOutput('');
    expect(msg).not.toContain('undefined');
  });

  it('never exceeds 6 chars of raw input exposure, even for long inputs', () => {
    const secret = 'a'.repeat(400);
    const msg = describeNonJwtOutput(secret);
    // 7 consecutive 'a's would mean we leaked >6 chars
    expect(msg).not.toContain('aaaaaaa');
    expect(msg).toContain('length=400');
  });
});
