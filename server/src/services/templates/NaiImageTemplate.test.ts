import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { zipSync } from 'fflate';
import { NaiImageTemplate } from './NaiImageTemplate.js';
import type { FileStorage } from '../FileStorage.js';
import type { IAttachmentRepository } from '../../repos/AttachmentRepository.js';
import type { SecretService } from '../SecretService.js';

function makeMockDeps(): {
  storage: FileStorage;
  attachments: IAttachmentRepository;
  secretService: SecretService;
} {
  const files = new Map<string, Uint8Array>();
  return {
    storage: {
      write: vi.fn((_sub: string, name: string, data: Uint8Array) => {
        files.set(name, data);
        return `files/attachments/${name}`;
      }),
    } as unknown as FileStorage,
    attachments: {
      create: vi.fn(
        async ({
          id,
          messageId,
          mimeType,
          filePath,
        }: {
          id: string;
          messageId: number | null;
          mimeType: string;
          filePath: string;
        }) => ({
          id,
          messageId,
          mimeType,
          filePath,
          url: `/api/attachments/${id}`,
          meta: {},
        }),
      ),
    } as unknown as IAttachmentRepository,
    secretService: {
      get: vi.fn(async (key: string) => ({ key, value: `vault-value-for-${key}` })),
    } as unknown as SecretService,
  };
}

function makeZipResponse(payload: Record<string, Uint8Array>): Response {
  const zipped = zipSync(payload);
  const bytes = new Uint8Array(zipped).buffer as ArrayBuffer;
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => bytes,
    text: async () => '',
  } as Response;
}

function textOf(result: { content: unknown }): string {
  const c = result.content;
  return typeof c === 'string' ? c : ((c as Array<{ text?: string }>)[0]?.text ?? '');
}

describe('NaiImageTemplate', () => {
  let template: NaiImageTemplate;
  let deps: ReturnType<typeof makeMockDeps>;

  beforeEach(() => {
    deps = makeMockDeps();
    template = new NaiImageTemplate({ ...deps, secretsPassword: 'pw' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns error when prompt is missing', async () => {
    const result = await template.execute('generate_image', {}, {});
    expect(textOf(result)).toContain('prompt is required');
  });

  it('returns error when no API key is configured', async () => {
    const result = await template.execute('generate_image', { prompt: 'a cat' }, { config: {} });
    expect(textOf(result)).toContain('no NovelAI API key configured');
  });

  it('builds correct request and returns image parts from the zip response', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    global.fetch = vi.fn(async () => makeZipResponse({ 'image_0.png': png }));

    const result = await template.execute(
      'generate_image',
      { prompt: '1girl, purple hair' },
      { config: { apiKey: 'pst-test' } },
    );

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe('https://image.novelai.net/ai/generate-image');

    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer pst-test');
    expect(headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(init.body as string);
    expect(body.input).toBe('1girl, purple hair');
    expect(body.model).toBe('nai-diffusion-5-full');
    expect(body.action).toBe('generate');
    expect(body.parameters.width).toBe(1024);
    expect(body.parameters.height).toBe(1024);
    expect(typeof body.parameters.seed).toBe('number');
    expect(body.parameters.negative_prompt).toContain('lowres');
    expect(body.parameters.v4_prompt.caption.base_caption).toBe('1girl, purple hair');
    expect(body.parameters.v4_negative_prompt.caption.base_caption).toBe(body.parameters.negative_prompt);

    expect(Array.isArray(result.content)).toBe(true);
    const parts = result.content as Array<{ type: string; text?: string; source?: string }>;
    expect(parts).toHaveLength(2);
    expect(parts[0]!.type).toBe('text');
    expect(parts[0]!.text).toContain('square');
    expect(parts[0]!.text).toContain('{{attachment::');
    expect(parts[1]!.type).toBe('image');
    expect(parts[1]!.source).toMatch(/^\/api\/attachments\//);

    expect(result.extra).toBeDefined();
    expect(typeof result.extra!.attachmentId).toBe('string');
    expect(typeof result.extra!.seed).toBe('number');

    expect(deps.storage.write).toHaveBeenCalledWith('attachments', expect.stringMatching(/^[\w-]+\.png$/), png);
    expect(deps.attachments.create).toHaveBeenCalledTimes(1);
  });

  it('maps portrait orientation to 832x1216', async () => {
    global.fetch = vi.fn(async () => makeZipResponse({ 'image_0.png': new Uint8Array([1]) }));

    await template.execute('generate_image', { prompt: 'a dog', orientation: 'portrait' }, { config: { apiKey: 'k' } });

    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse(init.body as string);
    expect(body.parameters.width).toBe(832);
    expect(body.parameters.height).toBe(1216);
  });

  it('maps landscape orientation to 1216x832', async () => {
    global.fetch = vi.fn(async () => makeZipResponse({ 'image_0.png': new Uint8Array([1]) }));

    await template.execute(
      'generate_image',
      { prompt: 'a tree', orientation: 'landscape' },
      { config: { apiKey: 'k' } },
    );

    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse(init.body as string);
    expect(body.parameters.width).toBe(1216);
    expect(body.parameters.height).toBe(832);
  });

  it('passes an explicit seed through and reports it', async () => {
    global.fetch = vi.fn(async () => makeZipResponse({ 'image_0.png': new Uint8Array([1]) }));

    const result = await template.execute(
      'generate_image',
      { prompt: 'a bird', seed: 1234 },
      { config: { apiKey: 'k' } },
    );

    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse(init.body as string);
    expect(body.parameters.seed).toBe(1234);
    expect(result.extra!.seed).toBe(1234);
  });

  it('honors custom model and baseUrl config', async () => {
    global.fetch = vi.fn(async () => makeZipResponse({ 'image_0.png': new Uint8Array([1]) }));

    await template.execute(
      'generate_image',
      { prompt: 'a bird' },
      { config: { apiKey: 'k', model: 'nai-diffusion-3', baseUrl: 'https://proxy.example.com/' } },
    );

    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe('https://proxy.example.com/ai/generate-image');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('nai-diffusion-3');
  });

  it('resolves vault secret references for the API key', async () => {
    global.fetch = vi.fn(async () => makeZipResponse({ 'image_0.png': new Uint8Array([1]) }));

    await template.execute('generate_image', { prompt: 'a bird' }, { config: { apiKey: 'secret:nai' } });

    expect(deps.secretService.get).toHaveBeenCalledWith('nai', 'pw');
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer vault-value-for-nai');
  });

  it('mutates body via requestScript', async () => {
    global.fetch = vi.fn(async () => makeZipResponse({ 'image_0.png': new Uint8Array([1]) }));

    const script = 'request.body.parameters.steps = 40\nrequest.body.parameters.scale = 11';
    await template.execute('generate_image', { prompt: 'a bird' }, { config: { apiKey: 'k', requestScript: script } });

    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse(init.body as string);
    expect(body.parameters.steps).toBe(40);
    expect(body.parameters.scale).toBe(11);
  });

  it('returns error on Lua script error', async () => {
    const script = 'error("bad syntax")';
    const result = await template.execute(
      'generate_image',
      { prompt: 'a bird' },
      { config: { apiKey: 'k', requestScript: script } },
    );
    expect(textOf(result)).toContain('Request script error');
  });

  it('returns error on fetch failure', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('network down');
    });

    const result = await template.execute('generate_image', { prompt: 'a fish' }, { config: { apiKey: 'k' } });
    expect(textOf(result)).toContain('NovelAI request failed: network down');
  });

  it('returns error on non-ok response', async () => {
    global.fetch = vi.fn(
      async () =>
        ({
          ok: false,
          status: 401,
          text: async () => 'Unauthorized',
        }) as Response,
    );

    const result = await template.execute('generate_image', { prompt: 'a fish' }, { config: { apiKey: 'bad' } });
    expect(textOf(result)).toContain('NovelAI returned 401');
  });

  it('returns error when the zip contains no files', async () => {
    global.fetch = vi.fn(async () => makeZipResponse({}));

    const result = await template.execute('generate_image', { prompt: 'a fish' }, { config: { apiKey: 'k' } });
    expect(textOf(result)).toContain('NovelAI returned no images');
  });

  it('returns error when the response is not a zip', async () => {
    const bytes = new TextEncoder().encode('not a zip').buffer as ArrayBuffer;
    global.fetch = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          arrayBuffer: async () => bytes,
          text: async () => '',
        }) as Response,
    );

    const result = await template.execute('generate_image', { prompt: 'a fish' }, { config: { apiKey: 'k' } });
    expect(textOf(result)).toContain('Failed to unzip NovelAI response');
  });
});
