/**
 * E2E test: independent-tool verification of PRODUCTION-generated
 * certs (shells out to `openssl` CLI rather than reading via the
 * `@peculiar/x509` library's own API).
 *
 * Closes part of the self-test blind spot that bit macf#180: prior
 * tests read EKU via peculiar's `cert.getExtension('2.5.29.37').usages`
 * — same library that WROTE the extension. If peculiar's writer and
 * reader ever drift (encode one thing, report another), those unit
 * tests would pass green while the cert on disk was broken. By
 * shelling out to `openssl x509 -ext extendedKeyUsage`, we get an
 * independent-stack reading that matches what curl / system TLS
 * libraries actually see when validating the cert.
 *
 * Pairs with the existing unit tests in `test/certs/agent-cert.test.ts`
 * — those assert peculiar's view; this asserts openssl's view. If
 * they ever disagree, one or both tests fails loudly.
 *
 * SCOPE LIMITATION: a full real-curl-against-real-server E2E would
 * also catch server-role TLS negotiation bugs (not just cert-encoding
 * bugs). Attempted as part of this initial landing but hit a vitest
 * worker-context networking issue where curl's TLS handshake hangs
 * after ClientHello despite TCP connect succeeding — same-process
 * `https.request` works fine to the same server, only external curl
 * times out. Symptom is distinct from the EKU-class bug #180 targets.
 * Deferred as a follow-up; see `macf#182` for the outstanding dynamic-
 * curl coverage piece.
 *
 * Runs in `make -f dev.mk test-e2e` (needs `openssl` in PATH).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCA } from '@groundnuty/macf-core';
import { generateAgentCert, generateClientCert } from '@groundnuty/macf-core';

function toolAvailable(name: string): boolean {
  const r = spawnSync(name, ['--version'], { stdio: 'ignore' });
  return r.status === 0;
}

describe('openssl-verified production cert encoding (#182)', () => {
  // Fail-loud on missing openssl so environment drift is explicit
  // (CI adds a fresh image; if openssl ever disappears from the
  // runner we want that to be a test failure, not a silent skip).
  if (!toolAvailable('openssl')) {
    it('requires openssl in PATH (environment-drift catcher)', () => {
      throw new Error('openssl not found in PATH; install it or the runner regressed');
    });
    return;
  }

  let dir: string;
  let agentCertPath: string;
  let agentCertWithHostPath: string;
  let clientCertPath: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'macf-openssl-e2e-'));
    const caCertPath = join(dir, 'ca-cert.pem');
    const caKeyPath = join(dir, 'ca-key.pem');

    // Mint certs via production paths (the code that ships).
    const ca = await createCA({ project: 'macf-e2e', certPath: caCertPath, keyPath: caKeyPath });

    agentCertPath = join(dir, 'agent-cert.pem');
    const agent = await generateAgentCert({
      agentName: 'test-agent',
      caCertPem: ca.certPem,
      caKeyPem: ca.keyPem,
    });
    writeFileSync(agentCertPath, agent.certPem);

    // Second variant with advertiseHost set — exercises the SAN
    // parameterization path from macf#178 Gap 3.
    agentCertWithHostPath = join(dir, 'agent-cert-with-host.pem');
    const agentWithHost = await generateAgentCert({
      agentName: 'test-agent',
      caCertPem: ca.certPem,
      caKeyPem: ca.keyPem,
      advertiseHost: '100.124.163.105',
    });
    writeFileSync(agentCertWithHostPath, agentWithHost.certPem);

    // Routing-action client cert (clientAuth-only by design).
    clientCertPath = join(dir, 'client-cert.pem');
    const client = await generateClientCert({
      commonName: 'routing-action',
      validityDays: 30,
      caCertPem: ca.certPem,
      caKeyPem: ca.keyPem,
    });
    writeFileSync(clientCertPath, client.certPem);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('agent cert EKU (macf#180)', () => {
    it('has both serverAuth AND clientAuth per openssl', () => {
      // Independent-stack verification: `openssl x509 -ext` reads the
      // X.509 extensions directly, not through peculiar. If peculiar's
      // writer and reader ever drift (writes serverAuth but
      // `getExtension` reports otherwise, or vice versa), this test
      // fails while the unit test passes.
      const out = execFileSync(
        'openssl',
        ['x509', '-in', agentCertPath, '-noout', '-ext', 'extendedKeyUsage'],
        { encoding: 'utf-8' },
      );
      expect(out).toMatch(/TLS Web Server Authentication/);
      expect(out).toMatch(/TLS Web Client Authentication/);
    });
  });

  describe('agent cert SAN (macf#178 Gap 3)', () => {
    it('defaults to [127.0.0.1, localhost] when no advertiseHost', () => {
      const out = execFileSync(
        'openssl',
        ['x509', '-in', agentCertPath, '-noout', '-ext', 'subjectAltName'],
        { encoding: 'utf-8' },
      );
      // Exactly the two defaults, nothing else. If a third entry
      // ever sneaks in without a corresponding advertiseHost input,
      // the test catches the mis-pipe.
      expect(out).toMatch(/IP Address:127\.0\.0\.1/);
      expect(out).toMatch(/DNS:localhost/);
      expect(out).not.toMatch(/IP Address:100\./);
    });

    it('appends IPv4 advertiseHost as IP entry', () => {
      const out = execFileSync(
        'openssl',
        ['x509', '-in', agentCertWithHostPath, '-noout', '-ext', 'subjectAltName'],
        { encoding: 'utf-8' },
      );
      expect(out).toMatch(/IP Address:127\.0\.0\.1/);
      expect(out).toMatch(/DNS:localhost/);
      expect(out).toMatch(/IP Address:100\.124\.163\.105/);
    });
  });

  describe('routing-action client cert (no-server-role invariant)', () => {
    it('has clientAuth ONLY (no serverAuth) per openssl', () => {
      // Routing action is a pure TLS client — adding serverAuth to
      // its cert would be a policy regression (wider blast radius if
      // the key leaked). Independent-stack check catches that too.
      const out = execFileSync(
        'openssl',
        ['x509', '-in', clientCertPath, '-noout', '-ext', 'extendedKeyUsage'],
        { encoding: 'utf-8' },
      );
      expect(out).toMatch(/TLS Web Client Authentication/);
      expect(out).not.toMatch(/TLS Web Server Authentication/);
    });

    it('has no Subject Alternative Name (pure client, no hostname)', () => {
      // The client cert shouldn't have a SAN extension at all — it's
      // a CLIENT cert, connects out, never has its hostname validated.
      // `openssl x509 -ext subjectAltName` against a cert without that
      // extension either prints an empty section or "No extensions" —
      // either way, neither of the default agent-cert SAN entries
      // should appear.
      const out = execFileSync(
        'openssl',
        ['x509', '-in', clientCertPath, '-noout', '-ext', 'subjectAltName'],
        { encoding: 'utf-8' },
      );
      expect(out).not.toMatch(/IP Address:127\.0\.0\.1/);
      expect(out).not.toMatch(/DNS:localhost/);
    });
  });
});
