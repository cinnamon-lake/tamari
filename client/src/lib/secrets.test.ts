import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listSecrets, setSecret, deleteSecret, isMaskedSecret } from './secrets.js';
import * as apiFetchModule from './apiFetch.js';

function mockResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe('secrets', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('isMaskedSecret', () => {
    it('identifies masked entries', () => {
      expect(isMaskedSecret({ key: 'k', masked: true, hint: '1234' })).toBe(true);
      expect(isMaskedSecret({ key: 'k', value: 'v' })).toBe(false);
    });
  });

  describe('listSecrets', () => {
    it('returns the parsed list', async () => {
      const entries = [
        { key: 'openai', masked: true, hint: 'sk-1' },
        { key: 'other', value: 'plain' },
      ];
      vi.spyOn(apiFetchModule, 'apiFetch').mockResolvedValue(mockResponse(entries));

      const result = await listSecrets();
      expect(result).toEqual(entries);
      expect(apiFetchModule.apiFetch).toHaveBeenCalledWith('/api/secrets');
    });

    it('throws on HTTP error', async () => {
      vi.spyOn(apiFetchModule, 'apiFetch').mockResolvedValue(mockResponse(null, false, 500));
      await expect(listSecrets()).rejects.toThrow('Failed to list secrets: HTTP 500');
    });
  });

  describe('setSecret', () => {
    it('posts key, value, and label as JSON', async () => {
      const spy = vi.spyOn(apiFetchModule, 'apiFetch').mockResolvedValue(mockResponse(null));

      await setSecret('openai', 'sk-secret', 'OpenAI key');

      expect(spy).toHaveBeenCalledWith('/api/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'openai', value: 'sk-secret', label: 'OpenAI key' }),
      });
    });

    it('omits label when not provided', async () => {
      const spy = vi.spyOn(apiFetchModule, 'apiFetch').mockResolvedValue(mockResponse(null));

      await setSecret('openai', 'sk-secret');

      const body = JSON.parse(spy.mock.calls[0]![1]!.body as string);
      expect(body).toEqual({ key: 'openai', value: 'sk-secret', label: undefined });
    });

    it('throws on HTTP error', async () => {
      vi.spyOn(apiFetchModule, 'apiFetch').mockResolvedValue(mockResponse(null, false, 403));
      await expect(setSecret('k', 'v')).rejects.toThrow('Failed to set secret: HTTP 403');
    });
  });

  describe('deleteSecret', () => {
    it('sends DELETE with an URL-encoded key', async () => {
      const spy = vi.spyOn(apiFetchModule, 'apiFetch').mockResolvedValue(mockResponse(null));

      await deleteSecret('key with spaces/slash');

      expect(spy).toHaveBeenCalledWith('/api/secrets/key%20with%20spaces%2Fslash', { method: 'DELETE' });
    });

    it('throws on HTTP error', async () => {
      vi.spyOn(apiFetchModule, 'apiFetch').mockResolvedValue(mockResponse(null, false, 404));
      await expect(deleteSecret('missing')).rejects.toThrow('Failed to delete secret: HTTP 404');
    });
  });
});
