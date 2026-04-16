/**
 * Tests for label resolution in macf-plugin-cli (#83).
 *
 * Regression guard: before #83, `/macf-issues` defaulted to the
 * hardcoded 'code-agent' label, so science-agent and writing-agent saw
 * code-agent's queue instead of their own. Fix: derive from
 * MACF_AGENT_ROLE (exported by claude.sh) with explicit override and
 * sensible fallbacks.
 */
import { describe, it, expect } from 'vitest';
import { resolveAgentLabel } from '../../src/plugin/bin/macf-plugin-cli.js';

describe('resolveAgentLabel (#83)', () => {
  it('explicit MACF_AGENT_LABEL wins over everything', () => {
    const env = {
      MACF_AGENT_LABEL: 'triage',
      MACF_AGENT_ROLE: 'science-agent',
      MACF_AGENT_NAME: 'cv-architect',
    };
    expect(resolveAgentLabel(env)).toBe('triage');
  });

  it('falls through to MACF_AGENT_ROLE when label is unset', () => {
    // This is the main fix: science-agent invoking /macf-issues should
    // see science-agent's queue, not code-agent's.
    const env = {
      MACF_AGENT_ROLE: 'science-agent',
      MACF_AGENT_NAME: 'macf-science-agent',
    };
    expect(resolveAgentLabel(env)).toBe('science-agent');
  });

  it('falls through to MACF_AGENT_NAME when role is also unset', () => {
    const env = { MACF_AGENT_NAME: 'writing-agent' };
    expect(resolveAgentLabel(env)).toBe('writing-agent');
  });

  it('falls through to code-agent only when all three are unset', () => {
    // Legacy fallback — invoked outside a macf-init'd workspace.
    expect(resolveAgentLabel({})).toBe('code-agent');
  });

  it('treats empty-string MACF_AGENT_LABEL as set (?? semantics)', () => {
    // ?? only falls through on null/undefined, so an empty string is
    // taken literally. Document the behavior so empty-string misconfig
    // is noticed (empty label will return empty issue list — not secretly
    // fall through to code-agent).
    const env = { MACF_AGENT_LABEL: '', MACF_AGENT_ROLE: 'science-agent' };
    expect(resolveAgentLabel(env)).toBe('');
  });

  it('real-world: science-agent running /macf-issues in a CV workspace', () => {
    // Mirrors what claude.sh sets on the macf-science-agent host.
    const env = {
      MACF_AGENT_NAME: 'macf-science-agent',
      MACF_AGENT_ROLE: 'science-agent',
      MACF_AGENT_TYPE: 'permanent',
      MACF_PROJECT: 'CV',
    };
    expect(resolveAgentLabel(env)).toBe('science-agent');
  });

  it('real-world: code-agent running /macf-issues in macf workspace', () => {
    const env = {
      MACF_AGENT_NAME: 'macf-code-agent',
      MACF_AGENT_ROLE: 'code-agent',
    };
    expect(resolveAgentLabel(env)).toBe('code-agent');
  });
});
