import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ForgeImageTemplate } from './ForgeImageTemplate.js';
import type { FileStorage } from '../FileStorage.js';
import type { IAttachmentRepository } from '../../repos/AttachmentRepository.js';

function makeMockDeps(): {
  storage: FileStorage;
  attachments: IAttachmentRepository;
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
      create: vi.fn(async ({ id, messageId, mimeType, filePath }: { id: string; messageId: number | null; mimeType: string; filePath: string }) => ({
        id,
        messageId,
        mimeType,
        filePath,
        url: `/api/attachments/${id}`,
        meta: {},
      })),
    } as unknown as IAttachmentRepository,
  };
}

describe('ForgeImageTemplate', () => {
  let template: ForgeImageTemplate;
  let deps: ReturnType<typeof makeMockDeps>;

  beforeEach(() => {
    deps = makeMockDeps();
    template = new ForgeImageTemplate(deps);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns error when prompt is missing', async () => {
    const result = await template.execute('generate_image', {}, {});
    expect(typeof result.content === 'string' ? result.content : (result.content[0] as { text: string }).text).toContain('prompt is required');
  });

  it('builds correct request body and returns image parts', async () => {
    const base64Image = Buffer.from('fake-png-bytes').toString('base64');
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ images: [base64Image], parameters: {}, info: '{}' }),
      text: async () => '',
    } as Response));

    const result = await template.execute('generate_image', { prompt: 'a cat' }, { config: {} });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe('http://localhost:7860/sdapi/v1/txt2img');

    const body = JSON.parse(init.body as string);
    expect(body.prompt).toBe('a cat');
    expect(body.negative_prompt).toBe('');
    expect(body.width).toBe(1024);
    expect(body.height).toBe(1024);
    expect(body.send_images).toBe(true);
    expect(body.save_images).toBe(false);

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
    expect(typeof result.extra!.attachmentUrl).toBe('string');

    expect(deps.storage.write).toHaveBeenCalledWith('attachments', expect.stringMatching(/^[\w-]+\.png$/), expect.any(Uint8Array));
    expect(deps.attachments.create).toHaveBeenCalledTimes(1);
  });

  it('maps portrait orientation to 832x1216', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ images: ['aW1hZ2U='], parameters: {}, info: '{}' }),
      text: async () => '',
    } as Response));

    await template.execute('generate_image', { prompt: 'a dog', orientation: 'portrait' }, { config: {} });

    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse(init.body as string);
    expect(body.width).toBe(832);
    expect(body.height).toBe(1216);
  });

  it('maps landscape orientation to 1216x832', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ images: ['aW1hZ2U='], parameters: {}, info: '{}' }),
      text: async () => '',
    } as Response));

    await template.execute('generate_image', { prompt: 'a tree', orientation: 'landscape' }, { config: {} });

    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse(init.body as string);
    expect(body.width).toBe(1216);
    expect(body.height).toBe(832);
  });

  it('passes negative_prompt through', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ images: ['aW1hZ2U='], parameters: {}, info: '{}' }),
      text: async () => '',
    } as Response));

    await template.execute('generate_image', { prompt: 'a bird', negative_prompt: 'blurry, low quality' }, { config: {} });

    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse(init.body as string);
    expect(body.negative_prompt).toBe('blurry, low quality');
  });

  it('mutates body via requestScript', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ images: ['aW1hZ2U='], parameters: {}, info: '{}' }),
      text: async () => '',
    } as Response));

    const script = 'request.body.steps = 50\nrequest.body.cfg_scale = 12';
    await template.execute('generate_image', { prompt: 'a bird' }, { config: { requestScript: script } });

    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse(init.body as string);
    expect(body.steps).toBe(50);
    expect(body.cfg_scale).toBe(12);
  });

  it('passes files as Lua globals for requestScript', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ images: ['aW1hZ2U='], parameters: {}, info: '{}' }),
      text: async () => '',
    } as Response));

    const script = 'request.body.init_images = { files[1] }\nrequest.body.denoising_strength = 0.75';
    await template.execute('generate_image', { prompt: 'a bird' }, { config: { requestScript: script, files: ['base64abc'] } });

    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse(init.body as string);
    expect(body.init_images).toEqual(['base64abc']);
    expect(body.denoising_strength).toBe(0.75);
  });

  it('returns error on Lua script error', async () => {
    const script = 'error("bad syntax")';
    const result = await template.execute('generate_image', { prompt: 'a bird' }, { config: { requestScript: script } });
    expect(typeof result.content === 'string' ? result.content : (result.content[0] as { text: string }).text).toContain('Request script error');
  });

  it('returns error on fetch failure', async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    } as Response));

    const result = await template.execute('generate_image', { prompt: 'a fish' }, { config: {} });
    expect(typeof result.content === 'string' ? result.content : (result.content[0] as { text: string }).text).toContain('Forge returned 500');
  });
});
