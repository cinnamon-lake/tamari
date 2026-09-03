import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { TestHarness } from '../testing/TestHarness.js';
import { createProxyRouter } from './proxy.js';
import type { BackendAdapter } from '../backends/BackendAdapter.js';

const CONFIG_ID = '11111111-2222-3333-4444-555555555555';
const API_KEY = 'test-proxy-key';

function makeAdapter(overrides?: Partial<BackendAdapter>): BackendAdapter {
  return {
    id: 'test',
    supportsStreaming: true,
    supportsTools: false,
    stream: vi.fn(async function* () {
      yield { type: 'text' as const, token: 'Hello' };
      yield { type: 'text' as const, token: ' world' };
      return { finishReason: 'stop' as const, usage: { promptTokens: 3, completionTokens: 2 } };
    }),
    listModels: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as BackendAdapter;
}

function createApp(harness: TestHarness, adapter: BackendAdapter | null) {
  const createResolvedAdapter = vi.fn().mockResolvedValue(adapter);
  const app = express();
  app.use(express.json());
  app.use('/v1', createProxyRouter(harness.deps.settings, harness.deps.backendConfigs, createResolvedAdapter));
  return { app, createResolvedAdapter };
}

async function seedConfig(h: TestHarness, id = CONFIG_ID, name = 'Test Config', maxTokens: number | null = 300) {
  await h.deps.backendConfigs.create(id, {
    name,
    description: '',
    backendProvider: 'openai',
    generationMode: 'chat',
    model: 'gpt-4',
    instructTemplate: '',
    providerParams: {},
    maxTokens,
  });
}

describe('createProxyRouter', () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = new TestHarness();
    await h.initSchema();
    await h.deps.settings.setValue('proxyApi.enabled', true);
    await h.deps.settings.setValue('proxyApi.apiKey', API_KEY);
  });

  afterEach(async () => {
    await h.teardown();
  });

  it('404s both endpoints when proxyApi.enabled is off', async () => {
    await h.deps.settings.setValue('proxyApi.enabled', false);
    await seedConfig(h);
    const { app, createResolvedAdapter } = createApp(h, makeAdapter());

    const models = await request(app).get('/v1/models').expect(404);
    expect(models.body.error.type).toBe('not_found_error');

    await request(app)
      .post('/v1/messages')
      .set('x-api-key', API_KEY)
      .send({ model: `${CONFIG_ID}-Test Config`, messages: [{ role: 'user', content: 'hi' }] })
      .expect(404);
    expect(createResolvedAdapter).not.toHaveBeenCalled();
  });

  it('rejects requests without the proxy API key', async () => {
    await seedConfig(h);
    const { app, createResolvedAdapter } = createApp(h, makeAdapter());

    const noKey = await request(app)
      .post('/v1/messages')
      .send({ model: `${CONFIG_ID}-Test Config`, messages: [{ role: 'user', content: 'hi' }] })
      .expect(401);
    expect(noKey.body.error.type).toBe('authentication_error');

    await request(app)
      .post('/v1/messages')
      .set('x-api-key', 'wrong-key')
      .send({ model: `${CONFIG_ID}-Test Config`, messages: [{ role: 'user', content: 'hi' }] })
      .expect(401);

    await request(app).get('/v1/models').expect(401);
    expect(createResolvedAdapter).not.toHaveBeenCalled();
  });

  it('accepts the key as a Bearer token too', async () => {
    await seedConfig(h);
    const { app } = createApp(h, makeAdapter());

    await request(app).get('/v1/models').set('Authorization', `Bearer ${API_KEY}`).expect(200);
  });

  it('lists backend configs as anthropic-style models', async () => {
    await seedConfig(h);
    const { app } = createApp(h, null);

    const res = await request(app).get('/v1/models').set('x-api-key', API_KEY).expect(200);
    expect(res.body.has_more).toBe(false);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      type: 'model',
      id: `${CONFIG_ID}-Test Config`,
      display_name: 'Test Config',
    });
    expect(res.body.first_id).toBe(`${CONFIG_ID}-Test Config`);
    expect(res.body.last_id).toBe(`${CONFIG_ID}-Test Config`);
  });

  it('rejects a model id matching no config', async () => {
    const { app, createResolvedAdapter } = createApp(h, makeAdapter());

    const res = await request(app)
      .post('/v1/messages')
      .set('x-api-key', API_KEY)
      .send({ model: 'not-a-proxy-model', messages: [{ role: 'user', content: 'hi' }] })
      .expect(404);
    expect(res.body.error.type).toBe('not_found_error');
    expect(createResolvedAdapter).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown config id', async () => {
    const { app } = createApp(h, makeAdapter());

    const res = await request(app)
      .post('/v1/messages')
      .set('x-api-key', API_KEY)
      .send({ model: `${CONFIG_ID}-Missing`, messages: [{ role: 'user', content: 'hi' }] })
      .expect(404);
    expect(res.body.error.type).toBe('not_found_error');
  });

  it('rejects an invalid request body', async () => {
    const { app } = createApp(h, makeAdapter());

    const res = await request(app)
      .post('/v1/messages')
      .set('x-api-key', API_KEY)
      .send({ model: `${CONFIG_ID}-X` })
      .expect(400);
    expect(res.body.error.type).toBe('invalid_request_error');
  });

  it('streams through the config adapter and returns an anthropic-style message', async () => {
    await seedConfig(h);
    const adapter = makeAdapter();
    const { app, createResolvedAdapter } = createApp(h, adapter);

    const res = await request(app)
      .post('/v1/messages')
      .set('x-api-key', API_KEY)
      .send({
        model: `${CONFIG_ID}-Test Config`,
        system: 'You are terse.',
        max_tokens: 12345, // deliberately ignored — the config owns sampling
        temperature: 0.01,
        messages: [{ role: 'user', content: 'hi' }],
      })
      .expect(200);

    expect(res.body).toMatchObject({
      type: 'message',
      role: 'assistant',
      model: `${CONFIG_ID}-Test Config`,
      content: [{ type: 'text', text: 'Hello world' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 2 },
    });
    expect(res.body.id).toMatch(/^msg_/);

    // The adapter received the translated prompt, and settings were built from the config.
    expect(createResolvedAdapter).toHaveBeenCalledOnce();
    expect(adapter.stream).toHaveBeenCalledWith(
      {
        messages: [
          { role: 'system', content: 'You are terse.' },
          { role: 'user', content: 'hi' },
        ],
        tokenUsage: { prompt: 0, completion: 300 },
      },
      expect.any(AbortSignal),
    );
  });

  it('sends an unset (0) completion budget when the config has no maxTokens', async () => {
    await seedConfig(h, CONFIG_ID, 'Test Config', null);
    const adapter = makeAdapter();
    const { app } = createApp(h, adapter);

    await request(app)
      .post('/v1/messages')
      .set('x-api-key', API_KEY)
      .send({ model: `${CONFIG_ID}-Test Config`, messages: [{ role: 'user', content: 'hi' }] })
      .expect(200);

    // 0 = unset: adapters omit the wire cap entirely. The config owns
    // sampling — there is no global maxResponseTokens fallback anymore.
    expect(adapter.stream).toHaveBeenCalledWith(
      expect.objectContaining({ tokenUsage: { prompt: 0, completion: 0 } }),
      expect.any(AbortSignal),
    );
  });

  it('translates content blocks including base64 images', async () => {
    await seedConfig(h);
    const adapter = makeAdapter();
    const { app } = createApp(h, adapter);

    await request(app)
      .post('/v1/messages')
      .set('x-api-key', API_KEY)
      .send({
        model: `${CONFIG_ID}-Test Config`,
        system: [{ type: 'text', text: 'block system' }],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'what is this?' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } },
            ],
          },
        ],
      })
      .expect(200);

    expect(adapter.stream).toHaveBeenCalledWith(
      {
        messages: [
          { role: 'system', content: 'block system' },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'what is this?' },
              { type: 'image', source: 'data:image/png;base64,aGk=', mimeType: 'image/png' },
            ],
          },
        ],
        tokenUsage: { prompt: 0, completion: 300 },
      },
      expect.any(AbortSignal),
    );
  });

  it('maps tool calls to tool_use blocks', async () => {
    await seedConfig(h);
    const adapter = makeAdapter({
      stream: vi.fn(async function* () {
        yield { type: 'toolCall' as const, id: 'call_1', name: 'get_weather', arguments: { city: 'Oslo' } };
        return {
          finishReason: 'stop' as const,
          usage: { promptTokens: 5, completionTokens: 4 },
          toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: { city: 'Oslo' } }],
        };
      }),
    });
    const { app } = createApp(h, adapter);

    const res = await request(app)
      .post('/v1/messages')
      .set('x-api-key', API_KEY)
      .send({ model: `${CONFIG_ID}-Test Config`, messages: [{ role: 'user', content: 'weather?' }] })
      .expect(200);

    expect(res.body.content).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Oslo' } },
    ]);
    expect(res.body.stop_reason).toBe('tool_use');
  });

  it('forwards tool definitions and tool_use/tool_result history to the adapter', async () => {
    await seedConfig(h);
    const adapter = makeAdapter({
      stream: vi.fn(async function* () {
        yield { type: 'toolCall' as const, id: 'call_2', name: 'get_weather', arguments: { city: 'Bergen' } };
        return {
          finishReason: 'stop' as const,
          usage: { promptTokens: 8, completionTokens: 6 },
          toolCalls: [{ id: 'call_2', name: 'get_weather', arguments: { city: 'Bergen' } }],
        };
      }),
    });
    const { app } = createApp(h, adapter);

    const res = await request(app)
      .post('/v1/messages')
      .set('x-api-key', API_KEY)
      .send({
        model: `${CONFIG_ID}-Test Config`,
        tools: [
          {
            name: 'get_weather',
            description: 'Get the weather for a city',
            input_schema: { type: 'object', properties: { city: { type: 'string' } } },
          },
        ],
        messages: [
          { role: 'user', content: 'weather?' },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Oslo' } }],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call_1',
                is_error: false,
                content: [{ type: 'text', text: 'sunny, 20°C' }],
              },
            ],
          },
        ],
      })
      .expect(200);

    // The loop can continue: the follow-up tool_use comes back to the client.
    expect(res.body.content).toEqual([
      { type: 'tool_use', id: 'call_2', name: 'get_weather', input: { city: 'Bergen' } },
    ]);
    expect(res.body.stop_reason).toBe('tool_use');

    expect(adapter.stream).toHaveBeenCalledWith(
      {
        messages: [
          { role: 'user', content: 'weather?' },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Oslo' } }],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                toolUseId: 'call_1',
                isError: false,
                content: [{ type: 'text', text: 'sunny, 20°C' }],
              },
            ],
          },
        ],
        tokenUsage: { prompt: 0, completion: 300 },
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              description: 'Get the weather for a city',
              parameters: { type: 'object', properties: { city: { type: 'string' } } },
            },
          },
        ],
      },
      expect.any(AbortSignal),
    );
  });

  it('omits the prompt tools key when the request has none', async () => {
    await seedConfig(h);
    const adapter = makeAdapter();
    const { app } = createApp(h, adapter);

    await request(app)
      .post('/v1/messages')
      .set('x-api-key', API_KEY)
      .send({ model: `${CONFIG_ID}-Test Config`, messages: [{ role: 'user', content: 'hi' }] })
      .expect(200);

    const prompt = (adapter.stream as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    expect(prompt).not.toHaveProperty('tools');
  });

  it('returns an anthropic-style error when the adapter reports failure', async () => {
    await seedConfig(h);
    const adapter = makeAdapter({
      stream: vi.fn(async function* () {
        yield { type: 'backendDebug' as const, token: 'about to fail' };
        return { finishReason: 'error' as const, usage: { promptTokens: 0, completionTokens: 0 }, error: 'boom' };
      }),
    });
    const { app } = createApp(h, adapter);

    const res = await request(app)
      .post('/v1/messages')
      .set('x-api-key', API_KEY)
      .send({ model: `${CONFIG_ID}-Test Config`, messages: [{ role: 'user', content: 'hi' }] })
      .expect(500);
    expect(res.body).toEqual({ type: 'error', error: { type: 'api_error', message: 'boom' } });
  });

  it('returns 400 when the config produces no adapter', async () => {
    await seedConfig(h);
    const { app } = createApp(h, null);

    const res = await request(app)
      .post('/v1/messages')
      .set('x-api-key', API_KEY)
      .send({ model: `${CONFIG_ID}-Test Config`, messages: [{ role: 'user', content: 'hi' }] })
      .expect(400);
    expect(res.body.error.type).toBe('invalid_request_error');
  });
});
