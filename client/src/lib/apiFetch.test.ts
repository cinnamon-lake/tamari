import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiFetch, authenticatedUrl, authenticateMediaInHtml } from './apiFetch.js';
import { setAuthToken, clearAuthToken } from './auth.js';

describe('apiFetch', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('ok'))),
    );
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

describe('authenticateMediaInHtml', () => {
  beforeEach(() => {
    clearAuthToken();
  });

  it('rewrites attachment media sources with the token', () => {
    setAuthToken('abc123');
    const out = authenticateMediaInHtml(
      '<p>look</p><img class="message-inline-img" src="/api/attachments/att-1" alt="">' +
        '<audio src="/api/attachments/att-2"></audio>',
    );
    expect(out).toContain('src="/api/attachments/att-1?token=abc123"');
    expect(out).toContain('src="/api/attachments/att-2?token=abc123"');
  });

  it('leaves other sources untouched', () => {
    setAuthToken('abc123');
    const out = authenticateMediaInHtml(
      '<img src="https://example.com/x.png"><img src="/api/characters/c1/assets/a.png">' +
        '<img src="/api/attachments/att-1">',
    );
    expect(out).toContain('src="https://example.com/x.png"');
    expect(out).toContain('src="/api/characters/c1/assets/a.png"');
    expect(out).toContain('src="/api/attachments/att-1?token=abc123"');
  });

  it('passes HTML through unchanged when no token is set', () => {
    const html = '<p>x</p><img src="/api/attachments/att-1">';
    expect(authenticateMediaInHtml(html)).toBe(html);
  });
});
