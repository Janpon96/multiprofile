import fs from 'node:fs';
import path from 'node:path';
import { DomainError } from '@multiprofile/domain';
import type { ISecretStore } from './secret-store.js';

/**
 * OS-backed cipher abstraction. In the desktop app this is Electron `safeStorage`
 * (Windows DPAPI). It is injected so storage stays free of an Electron dependency.
 */
export interface SecretCipher {
  isAvailable(): boolean;
  encrypt(plaintext: string): Buffer;
  decrypt(data: Buffer): string;
}

/**
 * Secrets persisted to disk, each value encrypted by the OS-backed cipher.
 * There is no plaintext fallback: when the cipher is unavailable every operation
 * fails with SECRET_UNAVAILABLE (plan §9.3, AT-035).
 */
export class PersistentSecretStore implements ISecretStore {
  constructor(
    private readonly filePath: string,
    private readonly cipher: SecretCipher
  ) {}

  private assertAvailable(): void {
    if (!this.cipher.isAvailable()) {
      throw new DomainError('SECRET_UNAVAILABLE', 'OS secret backend is unavailable');
    }
  }

  private load(): Record<string, string> {
    if (!fs.existsSync(this.filePath)) return {};
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
    } catch {
      throw new DomainError('SECRET_UNAVAILABLE', 'Secret file is corrupted');
    }
  }

  private save(map: Record<string, string>): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(map), 'utf-8');
    fs.renameSync(tmp, this.filePath);
  }

  public async setSecret(ref: string, plaintext: string): Promise<void> {
    if (!ref || !plaintext) {
      throw new DomainError('CHECK_INCONCLUSIVE', 'Secret ref and plaintext are required');
    }
    this.assertAvailable();
    const map = this.load();
    map[ref] = this.cipher.encrypt(plaintext).toString('base64');
    this.save(map);
  }

  public async getSecret(ref: string): Promise<string> {
    this.assertAvailable();
    const blob = this.load()[ref];
    if (!blob) {
      throw new DomainError('SECRET_UNAVAILABLE', `Secret ref '${ref}' not found in store`);
    }
    try {
      return this.cipher.decrypt(Buffer.from(blob, 'base64'));
    } catch {
      throw new DomainError('SECRET_UNAVAILABLE', `Failed to decrypt secret ref '${ref}'`);
    }
  }

  public async deleteSecret(ref: string): Promise<void> {
    const map = this.load();
    if (ref in map) {
      delete map[ref];
      this.save(map);
    }
  }
}
