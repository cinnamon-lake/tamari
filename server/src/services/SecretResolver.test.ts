import { describe, it, expect, vi } from 'vitest';
import { resolveSecretValue, resolveSecretSettings, isSecretRef } from './SecretResolver.js';
import type { SecretService } from './SecretService.js';

/** Minimal SecretService stub: only `get` is used by the resolver. */
function fakeSecretService(entries: Record<string, string>): SecretService {
  return {
    get: vi.fn(async (key: string) => {
      if (!(key in entries)) throw new Error(`Secret not found: ${key}`);
      return { key, value: entries[key] };
    }),
  } as unknown as SecretService;
}

describe('isSecretRef', () => {
  it('detects secret: references', () => {
    expect(isSecretRef('secret:openai-key')).toBe(true);
    expect(isSecretRef('sk-real-key')).toBe(false);
    expect(isSecretRef(null)).toBe(false);
    expect(isSecretRef(123)).toBe(false);
    expect(isSecretRef(undefined)).toBe(false);
  });
});

describe('resolveSecretValue', () => {
  const svc = fakeSecretService({ 'openai-key': 'sk-resolved' });

  it('passes raw values through unchanged', async () => {
    expect(await resolveSecretValue('sk-raw', svc, 'pw')).toBe('sk-raw');
    expect(await resolveSecretValue(null, svc, 'pw')).toBeNull();
    expect(await resolveSecretValue(undefined, svc, 'pw')).toBeUndefined();
  });

  it('resolves secret:<key> to the vault value', async () => {
    expect(await resolveSecretValue('secret:openai-key', svc, 'pw')).toBe('sk-resolved');
  });

  it('leaves the literal when the vault entry is missing', async () => {
    expect(await resolveSecretValue('secret:nope', svc, 'pw')).toBe('secret:nope');
  });
});

describe('resolveSecretSettings', () => {
  it('resolves secret: entries in place and leaves the rest', async () => {
    const svc = fakeSecretService({ 'openai-key': 'sk-resolved', 'tts-key': 'tts-resolved' });
    const values: Record<string, unknown> = {
      apiKey: 'secret:openai-key',
      model: 'gpt-4o',
      'tts.key': 'secret:tts-key',
      plain: 'sk-plain',
      nothing: null,
    };
    await resolveSecretSettings(values, svc, 'pw');
    expect(values).toEqual({
      apiKey: 'sk-resolved',
      model: 'gpt-4o',
      'tts.key': 'tts-resolved',
      plain: 'sk-plain',
      nothing: null,
    });
  });
});
