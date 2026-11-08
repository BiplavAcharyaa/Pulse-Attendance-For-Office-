import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import forge from 'node-forge';
import { exists, writeFileAtomic } from './storage/atomic';
import type { SecretStore } from './storage/secrets';

export interface TlsMaterial {
  caCertPem: string;
  caCertDer: Buffer;
  leafCertPem: string;
  leafKeyPem: string;
  caFingerprint: string; // SHA-256, colon separated
  leafExpires: string;
  names: string[];
}

interface TlsMeta {
  names: string[];
  leafNotAfter: string;
  caNotAfter: string;
}

function rsaKeypair(): { privatePem: string; publicPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return { privatePem: privateKey, publicPem: publicKey };
}

function serial(): string {
  return '01' + randomBytes(15).toString('hex');
}

function fingerprint(der: Buffer): string {
  return createHash('sha256')
    .update(der)
    .digest('hex')
    .toUpperCase()
    .replace(/(.{2})(?=.)/g, '$1:');
}

function certDer(cert: forge.pki.Certificate): Buffer {
  return Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), 'binary');
}

function makeCa(): { certPem: string; keyPem: string; notAfter: Date } {
  const keys = rsaKeypair();
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(keys.publicPem);
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  cert.validity.notAfter = new Date(Date.now() + 3650 * 24 * 3600 * 1000);
  const attrs = [
    { name: 'commonName', value: `PULSE Local CA (${os.hostname()})` },
    { name: 'organizationName', value: 'PULSE Attendance' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, pathLenConstraint: 0, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(forge.pki.privateKeyFromPem(keys.privatePem), forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), keyPem: keys.privatePem, notAfter: cert.validity.notAfter };
}

function makeLeaf(caCertPem: string, caKeyPem: string, ip: string, dnsNames: string[]): { certPem: string; keyPem: string; notAfter: Date } {
  const keys = rsaKeypair();
  const caCert = forge.pki.certificateFromPem(caCertPem);
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(keys.publicPem);
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  // Apple platforms reject server certificates valid for more than 825 days.
  cert.validity.notAfter = new Date(Date.now() + 800 * 24 * 3600 * 1000);
  cert.setSubject([{ name: 'commonName', value: 'PULSE Attendance Host' }, { name: 'organizationName', value: 'PULSE Attendance' }]);
  cert.setIssuer(caCert.subject.attributes);
  const altNames: Array<{ type: number; value?: string; ip?: string }> = [
    ...dnsNames.map((d) => ({ type: 2, value: d })),
    ...Array.from(new Set([ip, '127.0.0.1'])).map((i) => ({ type: 7, ip: i })),
  ];
  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames },
    { name: 'subjectKeyIdentifier' },
    { name: 'authorityKeyIdentifier', keyIdentifier: caCert.generateSubjectKeyIdentifier().getBytes() },
  ]);
  cert.sign(forge.pki.privateKeyFromPem(caKeyPem), forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), keyPem: keys.privatePem, notAfter: cert.validity.notAfter };
}

/**
 * Creates (once) a local certificate authority and issues a TLS server certificate covering the host's
 * LAN IP and names. Phones trust the CA once; the server certificate can then be re-issued whenever the
 * LAN address changes without touching the phones again.
 */
export async function ensureTls(opts: { dataDir: string; secrets: SecretStore; address: string; hostnames: string[]; now?: () => number }): Promise<TlsMaterial> {
  const dir = path.join(opts.dataDir, 'tls');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const caPemFile = path.join(dir, 'pulse-ca.pem');
  const caDerFile = path.join(dir, 'pulse-ca.crt');
  const leafPemFile = path.join(dir, 'server.pem');
  const metaFile = path.join(dir, 'tls-meta.json');

  const names = Array.from(new Set(['localhost', os.hostname(), ...opts.hostnames])).filter(Boolean);
  const wanted = [...names, opts.address].sort();

  let caCertPem = (await exists(caPemFile)) ? await fs.readFile(caPemFile, 'utf8') : '';
  let caKeyPem = opts.secrets.data.caKeyPem ?? '';
  let meta: TlsMeta | null = null;
  if (await exists(metaFile)) {
    try {
      meta = JSON.parse(await fs.readFile(metaFile, 'utf8')) as TlsMeta;
    } catch {
      meta = null;
    }
  }

  const nowMs = (opts.now ?? Date.now)();
  const thirtyDays = 30 * 24 * 3600 * 1000;
  let caNotAfter = meta?.caNotAfter ?? '';

  if (!caCertPem || !caKeyPem || !meta || new Date(caNotAfter).getTime() - nowMs < thirtyDays) {
    const ca = makeCa();
    caCertPem = ca.certPem;
    caKeyPem = ca.keyPem;
    caNotAfter = ca.notAfter.toISOString();
    await opts.secrets.update({ caKeyPem, leafKeyPem: undefined });
    meta = null; // force a new leaf
  }

  let leafCertPem = (await exists(leafPemFile)) ? await fs.readFile(leafPemFile, 'utf8') : '';
  let leafKeyPem = opts.secrets.data.leafKeyPem ?? '';
  const sameNames = meta && JSON.stringify([...meta.names].sort()) === JSON.stringify(wanted);
  const leafFresh = meta && new Date(meta.leafNotAfter).getTime() - nowMs > thirtyDays;

  if (!leafCertPem || !leafKeyPem || !sameNames || !leafFresh) {
    const leaf = makeLeaf(caCertPem, caKeyPem, opts.address, names);
    leafCertPem = leaf.certPem;
    leafKeyPem = leaf.keyPem;
    await opts.secrets.update({ leafKeyPem });
    await writeFileAtomic(leafPemFile, leafCertPem, { mode: 0o644 });
    meta = { names: wanted, leafNotAfter: leaf.notAfter.toISOString(), caNotAfter };
  }

  const caDer = certDer(forge.pki.certificateFromPem(caCertPem));
  await writeFileAtomic(caPemFile, caCertPem, { mode: 0o644 });
  await writeFileAtomic(caDerFile, caDer, { mode: 0o644 });
  await writeFileAtomic(metaFile, JSON.stringify(meta, null, 2), { mode: 0o644 });

  return {
    caCertPem,
    caCertDer: caDer,
    leafCertPem,
    leafKeyPem,
    caFingerprint: fingerprint(caDer),
    leafExpires: meta!.leafNotAfter,
    names: wanted,
  };
}
