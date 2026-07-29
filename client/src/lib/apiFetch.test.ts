import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiFetch, authenticatedUrl } from './apiFetch.js';
import { setAuthToken, clearAuthToken } from './auth.js';

describe('apiFetch', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('ok'))));
    clearAuthToken();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not add Authorization header when no token', async () => {
    await apiFetch('/api/test');
    const call = vi.mocked(fetch).mock.calls[0]!;
    const headers = call[1]?.headers as Headers;
    expect(headers.get('Authorization')).toBeNull();
  });

  it('adds Bearer token when authenticated', async () => {
    setAuthToken('my-token');
    await apiFetch('/api/test');
    const call = vi.mocked(fetch).mock.calls[0]!;
    const headers = call[1]?.headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer my-token');
  });

  it('preserves existing headers', async () => {
    await apiFetch('/api/test', {
      headers: { 'Content-Type': 'application/json' },
    });
    const call = vi.mocked(fetch).mock.calls[0]!;
    const headers = call[1]?.headers as Headers;
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('overrides existing Authorization header with token', async () => {
    setAuthToken('my-token');
    await apiFetch('/api/test', {
      headers: { Authorization: 'Bearer old' },
    });
    const call = vi.mocked(fetch).mock.calls[0]!;
    const headers = call[1]?.headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer my-token');
  });
});

describe('authenticatedUrl', () => {
  beforeEach(() => {
    clearAuthToken();
  });

  it('returns url unchanged when no token', () => {
    expect(authenticatedUrl('/api/test')).toBe('/api/test');
  });

  it('appends token as query param', () => {
    setAuthToken('abc123');
    expect(authenticatedUrl('/api/test')).toBe('/api/test?token=abc123');
  });

  it('appends token with & when query params exist', () => {
    setAuthToken('abc123');
    expect(authenticatedUrl('/api/test?foo=bar')).toBe('/api/test?foo=bar&token=abc123');
  });

  it('URL-encodes the token', () => {
    setAuthToken('a/b+c');
    expect(authenticatedUrl('/api/test')).toBe('/api/test?token=a%2Fb%2Bc');
  });
});
