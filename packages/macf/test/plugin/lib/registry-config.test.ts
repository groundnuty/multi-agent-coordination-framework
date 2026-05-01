import { describe, it, expect } from 'vitest';
import { getRegistryConfig } from '../../../src/plugin/lib/registry-config.js';

describe('getRegistryConfig (#332 regression)', () => {
  describe('local mode (DR-024)', () => {
    it('returns { type: "local", path } when MACF_REGISTRY_TYPE=local + MACF_REGISTRY_PATH set', () => {
      const result = getRegistryConfig({
        MACF_REGISTRY_TYPE: 'local',
        MACF_REGISTRY_PATH: '/home/user/.macf/registry/myproject.json',
      });
      expect(result).toEqual({
        type: 'local',
        path: '/home/user/.macf/registry/myproject.json',
      });
    });

    it('throws fix-it diagnostic when MACF_REGISTRY_TYPE=local but MACF_REGISTRY_PATH is missing', () => {
      expect(() => getRegistryConfig({ MACF_REGISTRY_TYPE: 'local' })).toThrow(
        /MACF_REGISTRY_PATH is not set/,
      );
      expect(() => getRegistryConfig({ MACF_REGISTRY_TYPE: 'local' })).toThrow(
        /macf init --local/,
      );
    });

    it('throws when MACF_REGISTRY_TYPE=local but MACF_REGISTRY_PATH is empty string', () => {
      expect(() => getRegistryConfig({
        MACF_REGISTRY_TYPE: 'local',
        MACF_REGISTRY_PATH: '',
      })).toThrow(/MACF_REGISTRY_PATH is not set/);
    });

    it('local mode wins when both MACF_REGISTRY_TYPE=local and MACF_REGISTRY_REPO are set', () => {
      const result = getRegistryConfig({
        MACF_REGISTRY_TYPE: 'local',
        MACF_REGISTRY_PATH: '/tmp/reg.json',
        MACF_REGISTRY_REPO: 'someone/something',
      });
      expect(result).toEqual({ type: 'local', path: '/tmp/reg.json' });
    });
  });

  describe('GitHub-backed variants', () => {
    it('returns { type: "repo", owner, repo } when MACF_REGISTRY_REPO=owner/repo', () => {
      const result = getRegistryConfig({ MACF_REGISTRY_REPO: 'groundnuty/macf' });
      expect(result).toEqual({ type: 'repo', owner: 'groundnuty', repo: 'macf' });
    });

    it('returns { type: "org", org } when MACF_REGISTRY_ORG set (and no REPO)', () => {
      const result = getRegistryConfig({ MACF_REGISTRY_ORG: 'myorg' });
      expect(result).toEqual({ type: 'org', org: 'myorg' });
    });

    it('returns { type: "profile", user } when MACF_REGISTRY_USER set (and no REPO/ORG)', () => {
      const result = getRegistryConfig({ MACF_REGISTRY_USER: 'someone' });
      expect(result).toEqual({ type: 'profile', user: 'someone' });
    });

    it('REPO wins over ORG when both set', () => {
      const result = getRegistryConfig({
        MACF_REGISTRY_REPO: 'a/b',
        MACF_REGISTRY_ORG: 'org',
      });
      expect(result).toEqual({ type: 'repo', owner: 'a', repo: 'b' });
    });

    it('ignores malformed MACF_REGISTRY_REPO (no slash)', () => {
      const result = getRegistryConfig({ MACF_REGISTRY_REPO: 'bareword' });
      expect(result).toEqual({ type: 'repo', owner: 'groundnuty', repo: 'macf' });
    });

    it('ignores MACF_REGISTRY_REPO with empty owner or repo', () => {
      const result = getRegistryConfig({ MACF_REGISTRY_REPO: '/repo' });
      expect(result).toEqual({ type: 'repo', owner: 'groundnuty', repo: 'macf' });
    });
  });

  describe('default fallback', () => {
    it('returns groundnuty/macf default when no registry env vars set', () => {
      const result = getRegistryConfig({});
      expect(result).toEqual({ type: 'repo', owner: 'groundnuty', repo: 'macf' });
    });

    it('default fallback does NOT fire when MACF_REGISTRY_TYPE=local — local takes precedence even on missing PATH (throws instead)', () => {
      expect(() => getRegistryConfig({ MACF_REGISTRY_TYPE: 'local' })).toThrow();
    });
  });

  describe('precedence — explicit env wins', () => {
    it('uses provided env when explicit env arg passed (defaults to process.env otherwise)', () => {
      // Sanity check: function takes optional env and uses it for tests
      const result = getRegistryConfig({ MACF_REGISTRY_REPO: 'x/y' });
      expect(result).toEqual({ type: 'repo', owner: 'x', repo: 'y' });
    });
  });
});
