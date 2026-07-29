import { describe, it, expect, beforeEach } from 'vitest';
import { SecretService } from './SecretService.js';
import type { ISecretRepository } from '../repos/SecretRepository.js';
import type { SecretRow } from '@tamari/types';

class InMemorySecretRepo implements ISecretRepository {
  private store = new Map<string, SecretRow>();

  async get(key: string): Promise<SecretRow | undefined> {
    return this.store.get(key);
  }

  async list(): Promise<SecretRow[]> {
    return Array.from(this.store.values()).sort((a, b) => a.key.localeCompare(b.key));
  }

  async set(key: string, value: string, label?: string): Promise<void> {
    this.store.set(key, { key, value, label: label ?? null, updatedAt: Math.floor(Date.now() / 1000) });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

describe('SecretService', () => {
  let repo: InMemorySecretRepo;
  let service: SecretService;

  beforeEach(() => {
    repo = new InMemorySecretRepo();
    service = new SecretService(repo);
  });

  it('encrypts and decrypts round-trip', () => {
    const password = 'hunter2';
    const plaintext = 'my-api-key-12345';
    const ciphertext = service.encrypt(plaintext, password);
    expect(ciphertext).not.toBe(plaintext);
    expect(ciphertext.length).toBeGreaterThan(0);

    const decrypted = service.decrypt(ciphertext, password);
    expect(decrypted).toBe(plaintext);
  });

  it('produces different ciphertext for same plaintext', () => {
    const password = 'hunter2';
    const plaintext = 'secret';
    const c1 = service.encrypt(plaintext, password);
    const c2 = service.encrypt(plaintext, password);
    expect(c1).not.toBe(c2);
  });

  it('fails to decrypt with wrong password', () => {
    const ciphertext = service.encrypt('secret', 'correct');
    expect(() => service.decrypt(ciphertext, 'wrong')).toThrow();
  });

  it('stores and retrieves a secret', async () => {
    await service.set('apiKey', 'sk-123', 'pass', 'OpenAI Key');
    const entry = await service.get('apiKey', 'pass');
    expect(entry.value).toBe('sk-123');
    expect(entry.label).toBe('OpenAI Key');
  });

  it('lists all secrets', async () => {
    await service.set('a', '1', 'pass');
    await service.set('b', '2', 'pass');
    const list = await service.list('pass');
    expect(list).toHaveLength(2);
    expect(list.map((s) => s.value)).toEqual(['1', '2']);
  });

  it('deletes a secret', async () => {
    await service.set('x', 'val', 'pass');
    await service.delete('x', 'pass');
    await expect(service.get('x', 'pass')).rejects.toThrow();
  });

  it('changes password for all secrets', async () => {
    await service.set('a', '1', 'old');
    await service.set('b', '2', 'old');
    await service.changePassword('old', 'new');

    const a = await service.get('a', 'new');
    const b = await service.get('b', 'new');
    expect(a.value).toBe('1');
    expect(b.value).toBe('2');
    await expect(service.get('a', 'old')).rejects.toThrow();
  });

  it('verifies password against stored secrets', async () => {
    await service.set('a', '1', 'correct');
    expect(await service.verifyPassword('correct')).toBe(true);
    expect(await service.verifyPassword('wrong')).toBe(false);
  });

  it('verifies password when no secrets exist', async () => {
    expect(await service.verifyPassword('anything')).toBe(true);
  });
});
