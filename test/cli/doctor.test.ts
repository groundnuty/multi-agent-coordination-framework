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
