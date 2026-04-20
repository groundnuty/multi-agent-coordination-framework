/**
 * Generate self-signed test certificates for mTLS testing.
 * Used by integration and HTTPS tests.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export interface TestCerts {
  readonly dir: string;
  readonly caCert: string;
  readonly caKey: string;
  readonly agentCert: string;
  readonly agentKey: string;
  readonly untrustedCert: string;
  readonly untrustedKey: string;
  /**
   * CA-signed cert that LACKS the clientAuth EKU. Passes TLS trust
   * (same CA as agentCert) but fails the #121 EKU gate in src/https.ts.
   * Used by health-eku.test.ts to exercise the 403 reject path E2E —
   * without this, the only test of that gate is the unit-level
   * peerCertHasClientAuthEKU predicate, which doesn't catch a
   * regression where the predicate passes but the integration wiring
   * at https.ts breaks (or vice versa).
   */
  readonly noEkuCert: string;
  readonly noEkuKey: string;
}

export function generateTestCerts(): TestCerts {
  const dir = join(tmpdir(), `macf-test-certs-${Date.now()}`);
  mkdirSync(dir, { recursive: true });

  const caCert = join(dir, 'ca-cert.pem');
  const caKey = join(dir, 'ca-key.pem');
  const agentCert = join(dir, 'agent-cert.pem');
  const agentKey = join(dir, 'agent-key.pem');
  const agentCsr = join(dir, 'agent.csr');
  const agentExt = join(dir, 'agent-ext.cnf');
  const untrustedCert = join(dir, 'untrusted-cert.pem');
  const untrustedKey = join(dir, 'untrusted-key.pem');
  const noEkuCert = join(dir, 'no-eku-cert.pem');
  const noEkuKey = join(dir, 'no-eku-key.pem');
  const noEkuCsr = join(dir, 'no-eku.csr');
  const noEkuExt = join(dir, 'no-eku-ext.cnf');

  // Generate CA key and self-signed cert
  execFileSync('openssl', [
    'genrsa', '-out', caKey, '2048',
  ], { stdio: 'pipe' });
  execFileSync('openssl', [
    'req', '-x509', '-new', '-key', caKey, '-out', caCert,
    '-days', '1', '-subj', '/CN=test-ca',
  ], { stdio: 'pipe' });

  // Write SAN + EKU extension file for agent cert.
  // - subjectAltName: needed for 127.0.0.1 on server-side TLS.
  // - extendedKeyUsage=clientAuth: required by src/https.ts since
  //   #121 — every request (including /health) gets 403 if the peer
  //   cert lacks the clientAuth EKU. Production peer certs emit it
  //   via generateAgentCert + signCSR (#125). Test certs must match
  //   or all E2E tests fail uniformly at the EKU gate, not at the
  //   code path under test.
  writeFileSync(agentExt, [
    'subjectAltName=IP:127.0.0.1,DNS:localhost',
    // Test certs double as server AND client: the agent cert terminates
    // TLS server-side (server purpose: serverAuth) and authenticates the
    // outbound TLS handshake (client purpose: clientAuth). Production
    // splits these — routing-client certs get clientAuth only (#119),
    // agent peer certs get clientAuth (#125) + serverAuth implicitly via
    // @peculiar/x509's defaults. The test fixture has to carry both
    // because the client and server roles are played by the same cert
    // in one process.
    'extendedKeyUsage=clientAuth,serverAuth',
  ].join('\n'));

  // Generate agent key and CSR, sign with CA + SAN
  execFileSync('openssl', [
    'genrsa', '-out', agentKey, '2048',
  ], { stdio: 'pipe' });
  execFileSync('openssl', [
    'req', '-new', '-key', agentKey, '-out', agentCsr,
    '-subj', '/CN=code-agent',
  ], { stdio: 'pipe' });
  execFileSync('openssl', [
    'x509', '-req', '-in', agentCsr, '-CA', caCert, '-CAkey', caKey,
    '-CAcreateserial', '-out', agentCert, '-days', '1',
    '-extfile', agentExt,
  ], { stdio: 'pipe' });

  // Generate untrusted cert (self-signed, not from our CA)
  execFileSync('openssl', [
    'genrsa', '-out', untrustedKey, '2048',
  ], { stdio: 'pipe' });
  execFileSync('openssl', [
    'req', '-x509', '-new', '-key', untrustedKey, '-out', untrustedCert,
    '-days', '1', '-subj', '/CN=untrusted',
  ], { stdio: 'pipe' });

  // Generate no-EKU cert: CA-signed (same CA as agentCert), so the TLS
  // handshake's trust check passes. Critically, the extfile sets NO
  // `extendedKeyUsage` at all — a cert with no EKU is treated by Node's
  // TLS as valid-for-any-purpose (RFC 5280 §4.2.1.12), so it clears both
  // the client-side server-purpose check AND the server-side
  // client-purpose check at the TLS layer. Only src/https.ts's
  // application-layer #121 check then rejects it — which is exactly the
  // defense-in-depth case the #121 gate exists for. An old peer cert
  // emitted before #125 has this exact shape (no EKU extension emitted
  // at all). A cert with `serverAuth` alone would fail at TLS before
  // ever reaching the application layer, so we can't use that.
  writeFileSync(noEkuExt, [
    'subjectAltName=IP:127.0.0.1,DNS:localhost',
  ].join('\n'));
  execFileSync('openssl', [
    'genrsa', '-out', noEkuKey, '2048',
  ], { stdio: 'pipe' });
  execFileSync('openssl', [
    'req', '-new', '-key', noEkuKey, '-out', noEkuCsr,
    '-subj', '/CN=code-agent',
  ], { stdio: 'pipe' });
  execFileSync('openssl', [
    'x509', '-req', '-in', noEkuCsr, '-CA', caCert, '-CAkey', caKey,
    '-CAcreateserial', '-out', noEkuCert, '-days', '1',
    '-extfile', noEkuExt,
  ], { stdio: 'pipe' });

  return {
    dir,
    caCert,
    caKey,
    agentCert,
    agentKey,
    untrustedCert,
    untrustedKey,
    noEkuCert,
    noEkuKey,
  };
}

export function cleanupTestCerts(certs: TestCerts): void {
  if (existsSync(certs.dir)) {
    rmSync(certs.dir, { recursive: true, force: true });
  }
}
