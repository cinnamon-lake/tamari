import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture logged objects so we can assert on them without relying on pino output
const loggedMessages: Array<Record<string, unknown>> = [];
const loggedLevels: string[] = [];

vi.mock('../lib/logger.js', () => ({
  getLogger: () => ({
    info: (obj: unknown, _msg: string) => {
      loggedLevels.push('info');
      loggedMessages.push(obj as Record<string, unknown>);
    },
    error: (obj: unknown, _msg: string) => {
      loggedLevels.push('error');
      loggedMessages.push(obj as Record<string, unknown>);
    },
    debug: (obj: unknown, _msg: string) => {
      loggedLevels.push('debug');
      loggedMessages.push(obj as Record<string, unknown>);
    },
    isLevelEnabled: (_level: string) => true,
  }),
}));

import { logDelta, logHttpError, logRequest } from './RequestLogger.js';

describe('RequestLogger', () => {
  beforeEach(() => {
    loggedMessages.length = 0;
    loggedLevels.length = 0;
  });

  // The body is ALWAYS logged at info — prompt debugging needs the exact request.
  const getLoggedBody = (): string | undefined => {
    const entry = loggedMessages.find((m) => 'body' in m);
    return entry?.['body'] as string | undefined;
  };

  it('redacts apiKey in JSON body', () => {
    logRequest('openai', 'https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', apiKey: 'sk-secret123', messages: [] }),
    });

    const parsed = JSON.parse(getLoggedBody() as string);
    expect(parsed.apiKey).toBe('[REDACTED]');
    expect(parsed.model).toBe('gpt-4o');
  });

  it('redacts nested sensitive fields', () => {
    logRequest('openai', 'https://api.openai.com/v1/chat/completions', {
      body: JSON.stringify({
        model: 'gpt-4o',
        credentials: { access_token: 'tok', refresh_token: 'ref' },
      }),
    });

    const parsed = JSON.parse(getLoggedBody() as string);
    expect(parsed.credentials.access_token).toBe('[REDACTED]');
    expect(parsed.credentials.refresh_token).toBe('[REDACTED]');
  });

  it('redacts headers but preserves non-sensitive ones', () => {
    logRequest('openai', 'https://api.openai.com/v1/chat/completions', {
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
    });

    const reqLog = loggedMessages.find((m) => 'headers' in m);
    expect(reqLog!.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(getLoggedBody()).toBe('[empty]');
  });

  it('logs the full body untruncated', () => {
    const longBody = JSON.stringify({ model: 'gpt-4o', text: 'x'.repeat(10_000) });
    logRequest('openai', 'https://api.openai.com/v1/chat/completions', { body: longBody });

    const body = getLoggedBody() as string;
    expect(body).toBe(longBody);
    expect(body).not.toContain('[truncated]');
  });

  it('always logs the request body at info level', () => {
    logRequest('openai', 'https://api.openai.com/v1/chat/completions', {
      body: JSON.stringify({ model: 'gpt-4o', apiKey: 'sk-secret123' }),
    });

    const infoLog = loggedMessages.find((m) => 'bodyLength' in m);
    expect(infoLog).toBeDefined();
    // ...and alongside it, the full (scrubbed) body, at the same level.
    expect(getLoggedBody()).toContain('gpt-4o');
  });

  it('redacts compound credential keys (proxy_password, client_secret, refreshToken)', () => {
    logRequest('openai', 'https://api.openai.com/v1/chat/completions', {
      body: JSON.stringify({ model: 'gpt-4o', proxy_password: 'super-secret', client_secret: 'shh', refreshToken: 'tok', messages: [] }),
    });

    const parsed = JSON.parse(getLoggedBody() as string);
    expect(parsed.proxy_password).toBe('[REDACTED]');
    expect(parsed.client_secret).toBe('[REDACTED]');
    expect(parsed.refreshToken).toBe('[REDACTED]');
    expect(parsed.model).toBe('gpt-4o');
  });

  it('logHttpError logs status and scrubbed error body', () => {
    logHttpError('openai', 401, JSON.stringify({ error: { message: 'invalid key', token: 'sk-secret123' } }));

    const errLog = loggedMessages.find((m) => 'errorBody' in m);
    expect(errLog).toBeDefined();
    expect(errLog!['status']).toBe(401);
    const parsed = JSON.parse(errLog!['errorBody'] as string);
    expect(parsed.error.message).toBe('invalid key');
    expect(parsed.error.token).toBe('[REDACTED]');
  });

  describe('logDelta', () => {
    it('logs the terminal stream object at info for every provider shape', () => {
      const terminalShapes: Array<[string, unknown]> = [
        ['openai', { choices: [{ delta: {}, finish_reason: 'stop' }] }],
        ['gemini', { candidates: [{ finishReason: 'STOP' }] }],
        ['claude', { type: 'message_delta', delta: { stop_reason: 'end_turn' } }],
        ['koboldcpp', { finish_reason: 'length' }],
        ['llamacpp', { stop: true, stopped_eos: true }],
      ];
      for (const [adapterId, delta] of terminalShapes) {
        loggedMessages.length = 0;
        loggedLevels.length = 0;
        logDelta(adapterId, delta);
        expect(loggedMessages).toHaveLength(1);
        expect(loggedMessages[0]).toMatchObject({ adapterId, delta });
        expect(loggedLevels).toEqual(['info']);
      }
    });

    it('logs per-token deltas at debug only', () => {
      const noise: unknown[] = [
        { choices: [{ delta: { content: 'Hello' }, finish_reason: null }] },
        { choices: [{ delta: { role: 'assistant' } }] },
        { candidates: [{ content: { parts: [{ text: 'Hi' }] } }] },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } },
        { token: 'Hi' },
        { content: 'Hi', stop: false },
        'a string',
        null,
      ];
      for (const delta of noise) {
        logDelta('openai', delta);
      }
      expect(loggedMessages).toHaveLength(noise.length);
      expect(loggedLevels).toEqual(noise.map(() => 'debug'));
    });
  });
});
