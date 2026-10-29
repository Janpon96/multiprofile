import crypto from 'node:crypto';
import os from 'node:os';
import { DomainError } from '@multiprofile/domain';

export interface ISecretStore {
  setSecret(ref: string, plaintext: string): Promise<void>;
  getSecret(ref: string): Promise<string>;
  deleteSecret(ref: string): Promise<void>;
}

export class LocalSecretStore implements ISecretStore {
  private inMemorySecrets: Map<string, Buffer> = new Map();
  private encryptionKey: Buffer;

  constructor(customKey?: Buffer) {
    if (customKey) {
      this.encryptionKey = customKey;
    } else {
      // Generate a machine/user-bound key derivation salt
      const machineSeed = `${os.hostname()}-${os.userInfo().username}-multiprofile-key`;
      this.encryptionKey = crypto.scryptSync(machineSeed, 'multiprofile_salt_v1', 32);
    }
  }

  public async setSecret(ref: string, plaintext: string): Promise<void> {
    if (!ref || !plaintext) {
      throw new DomainError('CHECK_INCONCLUSIVE', 'Secret ref and plaintext are required');
    }
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Store payload: [12-byte IV][16-byte Tag][Encrypted Data]
    const combined = Buffer.concat([iv, authTag, encrypted]);
    this.inMemorySecrets.set(ref, combined);
  }

  public async getSecret(ref: string): Promise<string> {
    const raw = this.inMemorySecrets.get(ref);
    if (!raw) {
      throw new DomainError('SECRET_UNAVAILABLE', `Secret ref '${ref}' not found in store`);
    }

    try {
      const iv = raw.subarray(0, 12);
      const authTag = raw.subarray(12, 28);
      const encrypted = raw.subarray(28);

      const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
      return decrypted.toString('utf-8');
    } catch {
      throw new DomainError('SECRET_UNAVAILABLE', `Failed to decrypt secret ref '${ref}'`);
    }
  }

  public async deleteSecret(ref: string): Promise<void> {
    this.inMemorySecrets.delete(ref);
  }
}
