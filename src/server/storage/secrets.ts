import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { exists, writeFileAtomic } from './atomic';
import { Mutex } from './mutex';

export interface SecretProtector {
  readonly name: 'os-protected' | 'file-permissions-only';
  encrypt(plain: Buffer): Buffer;
  decrypt(cipher: Buffer): Buffer;
}

/** Used when no OS key store is available (tests, headless Linux). Relies on file permissions only. */
export const filePermissionProtector: SecretProtector = {
  name: 'file-permissions-only',
  encrypt: (b) => b,
  decrypt: (b) => b,
};

export interface HostSecrets {
  hmacKey: string; // QR / registration token signing (base64)
  integrityKey: string; // hash-chain key (base64)
  caKeyPem?: string;
  leafKeyPem?: string;
}

interface SecretsFile {
  v: 1;
  protection: SecretProtector['name'];
  payload: string; // base64 of (optionally OS-encrypted) JSON
}

/**
 * Holds the host's own secrets (never employee private keys, which never leave phones). When Electron's
 * safeStorage is available (Windows DPAPI) the file is encrypted to the Windows user; otherwise it is
 * only protected by file permissions, which is reported on the health screen.
 */
export class SecretStore {
  private secrets!: HostSecrets;
  private readonly mutex = new Mutex();

  constructor(
    private readonly file: string,
    private readonly protector: SecretProtector,
  ) {}

  get protection(): SecretProtector['name'] {
    return this.protector.name;
  }

  get data(): Readonly<HostSecrets> {
    return this.secrets;
  }

  async load(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    if (!(await exists(this.file))) {
      this.secrets = {
        hmacKey: randomBytes(32).toString('base64'),
        integrityKey: randomBytes(32).toString('base64'),
      };
      await this.persist();
      return;
    }
    const parsed = JSON.parse(await fs.readFile(this.file, 'utf8')) as SecretsFile;
    if (parsed.protection !== this.protector.name) {
      throw new Error(
        `host-secrets.json was written with "${parsed.protection}" protection but this session provides "${this.protector.name}". ` +
          'Run PULSE as the same Windows user that created the data folder.',
      );
    }
    const plain = this.protector.decrypt(Buffer.from(parsed.payload, 'base64'));
    this.secrets = JSON.parse(plain.toString('utf8')) as HostSecrets;
  }

  private async persist(): Promise<void> {
    const plain = Buffer.from(JSON.stringify(this.secrets), 'utf8');
    const file: SecretsFile = {
      v: 1,
      protection: this.protector.name,
      payload: this.protector.encrypt(plain).toString('base64'),
    };
    await writeFileAtomic(this.file, JSON.stringify(file), { mode: 0o600, keepBackup: true });
  }

  async update(patch: Partial<HostSecrets>): Promise<void> {
    await this.mutex.run(async () => {
      const prev = this.secrets;
      this.secrets = { ...this.secrets, ...patch };
      try {
        await this.persist();
      } catch (e) {
        this.secrets = prev;
        throw e;
      }
    });
  }
}
