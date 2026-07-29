import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import type { ISecretRepository } from '../repos/SecretRepository.js';

const SALT_LEN = 16;
const IV_LEN = 16;
const TAG_LEN = 16;
const ITERATIONS = 100_000;
const KEY_LEN = 32;
const DIGEST = 'sha256';
const ALGO = 'aes-256-gcm';

export interface SecretEntry {
  key: string;
  value: string;
  label?: string;
}

export class SecretService {
  constructor(private repo: ISecretRepository) {}

  encrypt(plaintext: string, password: string): string {
    const salt = randomBytes(SALT_LEN);
    const key = pbkdf2Sync(password, salt, ITERATIONS, KEY_LEN, DIGEST);
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALGO, key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([salt, iv, authTag, encrypted]).toString('base64');
  }

  decrypt(ciphertext: string, password: string): string {
    const buf = Buffer.from(ciphertext, 'base64');
    if (buf.length < SALT_LEN + IV_LEN + TAG_LEN) {
      throw new Error('Invalid ciphertext: too short');
    }
    const salt = buf.subarray(0, SALT_LEN);
    const iv = buf.subarray(SALT_LEN, SALT_LEN + IV_LEN);
    const authTag = buf.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + TAG_LEN);
    const encrypted = buf.subarray(SALT_LEN + IV_LEN + TAG_LEN);

    const key = pbkdf2Sync(password, salt, ITERATIONS, KEY_LEN, DIGEST);
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  }

  async set(key: string, plaintext: string, password: string, label?: string): Promise<void> {
    const ciphertext = this.encrypt(plaintext, password);
    await this.repo.set(key, ciphertext, label);
  }

  async get(key: string, password: string): Promise<SecretEntry> {
    const row = await this.repo.get(key);
    if (!row) throw new Error(`Secret not found: ${key}`);
    const plaintext = this.decrypt(row.value, password);
    return { key: row.key, value: plaintext, label: row.label ?? undefined };
  }

  async list(password: string): Promise<SecretEntry[]> {
    const rows = await this.repo.list();
    return rows.map((r) => ({
      key: r.key,
      value: this.decrypt(r.value, password),
      label: r.label ?? undefined,
    }));
  }

  async delete(key: string, password: string): Promise<void> {
    const row = await this.repo.get(key);
    if (row) {
      // Verify password before deleting
      this.decrypt(row.value, password);
    }
    await this.repo.delete(key);
  }

  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    const rows = await this.repo.list();
    for (const row of rows) {
      const plaintext = this.decrypt(row.value, oldPassword);
      const ciphertext = this.encrypt(plaintext, newPassword);
      await this.repo.set(row.key, ciphertext, row.label ?? undefined);
    }
  }

  /**
   * Verify that a password can decrypt all existing secrets.
   * Returns true if there are no secrets or all secrets decrypt successfully.
   */
  async verifyPassword(password: string): Promise<boolean> {
    const rows = await this.repo.list();
    if (rows.length === 0) return true;
    for (const row of rows) {
      try {
        this.decrypt(row.value, password);
      } catch {
        return false;
      }
    }
    return true;
  }
}
