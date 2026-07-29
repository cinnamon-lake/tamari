import { describe, it, expect, vi } from 'vitest';
import { applyRequestScript, RequestScriptError } from './RequestScript.js';

vi.mock('dns', () => ({
  default: {
    promises: {
      lookup: vi.fn(async (_hostname: string, _opts: unknown) => {
        // Simulate public DNS resolution for test hostnames
        return [{ address: '93.184.216.34', family: 4 }];
      }),
    },
  },
}));

describe('applyRequestScript', () => {
  it('returns unchanged request when script is empty', async () => {
    const result = await applyRequestScript('http://example.com', { method: 'POST', body: '{}' }, '');
    expect(result.url).toBe('http://example.com');
    expect(result.init.method).toBe('POST');
  });

  it('returns unchanged request when script is undefined', async () => {
    const result = await applyRequestScript('http://example.com', { method: 'POST', body: '{}' }, undefined);
    expect(result.url).toBe('http://example.com');
  });

  it('mutates url, headers, and body via Lua', async () => {
    const result = await applyRequestScript(
      'http://example.com',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"temperature":1}',
      },
      `
        request.url = "http://proxy.local:8080"
        request.headers["X-Custom-Auth"] = "secret"
        request.body.temperature = 0.5
      `,
    );

    expect(result.url).toBe('http://proxy.local:8080');
    const headers = result.init.headers as Record<string, string>;
    expect(headers['X-Custom-Auth']).toBe('secret');
    const body = JSON.parse(result.init.body as string);
    expect(body.temperature).toBe(0.5);
  });

  it('handles table replacement when script reassigns request', async () => {
    const result = await applyRequestScript(
      'http://example.com',
      { method: 'POST', body: '{}' },
      `
        request = {
          url = "http://other.local",
          method = "GET",
          headers = {},
          body = {stream = true}
        }
      `,
    );

    expect(result.url).toBe('http://other.local');
    expect(result.init.method).toBe('GET');
    const body = JSON.parse(result.init.body as string);
    expect(body.stream).toBe(true);
  });

  it('throws RequestScriptError on bad Lua syntax', async () => {
    await expect(
      applyRequestScript('http://example.com', { method: 'POST', body: '{}' }, 'error("bad")'),
    ).rejects.toBeInstanceOf(RequestScriptError);
  });

  it('rejects runaway scripts via the execution timeout', async () => {
    await expect(
      applyRequestScript('http://example.com', { method: 'POST', body: '{}' }, 'while true do end'),
    ).rejects.toBeInstanceOf(RequestScriptError);
  }, 15000);

  it('injects extras as Lua globals', async () => {
    const result = await applyRequestScript(
      'http://example.com',
      { method: 'POST', body: '{}' },
      'request.body.prompt = files[1]',
      { files: ['base64abc', 'base64def'] },
    );

    const body = JSON.parse(result.init.body as string);
    expect(body.prompt).toBe('base64abc');
  });

  it('allows scripts on a loopback-configured backend (literal IP)', async () => {
    const result = await applyRequestScript(
      'http://127.0.0.1:9876/v1/chat/completions',
      { method: 'POST', body: '{"temperature":1}' },
      'request.body.temperature = 0.5',
    );
    const body = JSON.parse(result.init.body as string);
    expect(body.temperature).toBe(0.5);
  });

  it('allows scripts on a localhost-named backend, including loopback redirects', async () => {
    const result = await applyRequestScript(
      'http://localhost:8080/completion',
      { method: 'POST', body: '{}' },
      'request.url = "http://127.0.0.1:8081/completion"',
    );
    expect(result.url).toBe('http://127.0.0.1:8081/completion');
  });

  it('still blocks a script redirecting a cloud backend to loopback', async () => {
    await expect(
      applyRequestScript(
        'http://example.com/v1/chat/completions',
        { method: 'POST', body: '{}' },
        'request.url = "http://127.0.0.1:9876/admin"',
      ),
    ).rejects.toBeInstanceOf(RequestScriptError);
  });

  it('still blocks a loopback backend script redirecting to a private LAN address', async () => {
    await expect(
      applyRequestScript(
        'http://127.0.0.1:9876/v1/chat/completions',
        { method: 'POST', body: '{}' },
        'request.url = "http://10.0.0.5/internal"',
      ),
    ).rejects.toBeInstanceOf(RequestScriptError);
  });
});
