import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SpeakTemplate } from './SpeakTemplate.js';
import type { FileStorage } from '../FileStorage.js';
import type { IAttachmentRepository } from '../../repos/AttachmentRepository.js';
import type { SecretService } from '../SecretService.js';

function makeMockDeps(): {
  storage: FileStorage;
  attachments: IAttachmentRepository;
  secretService: SecretService;
  secretsPassword: string;
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
    secretService: { get: vi.fn() } as unknown as SecretService,
    secretsPassword: 'test-password',
  };
}

describe('SpeakTemplate', () => {
  let template: SpeakTemplate;
  let deps: ReturnType<typeof makeMockDeps>;

  beforeEach(() => {
    deps = makeMockDeps();
    template = new SpeakTemplate(deps);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns error when text is missing', async () => {
    const result = await template.execute('speak', {}, { config: { provider: 'fishaudio' } });
    expect(typeof result.content === 'string' ? result.content : (result.content[0] as { text: string }).text).toContain('text is required');
  });

  it('returns error when no TTS provider is configured', async () => {
    const result = await template.execute('speak', { text: 'hello' }, {});
    expect(result.content).toContain('no TTS provider configured');
  });

  it('generates audio and returns attachment macro', async () => {
    const fakeAudio = new Uint8Array([0x52, 0x49, 0x46, 0x46]); // RIFF header
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'audio/wav' }),
      arrayBuffer: async () => fakeAudio.buffer,
    } as Response));

    const result = await template.execute('speak', { text: 'Hello world' }, { config: { provider: 'fishaudio', baseUrl: 'http://localhost:8080/v1' } });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe('http://localhost:8080/v1/tts');

    const body = JSON.parse(init.body as string);
    expect(body.text).toBe('Hello world');

    expect(Array.isArray(result.content)).toBe(true);
    const parts = result.content as Array<{ type: string; text?: string }>;
    expect(parts).toHaveLength(1);
    expect(parts[0]!.type).toBe('text');
    expect(parts[0]!.text).toMatch(/\{\{attachment::/);

    expect(result.extra).toBeDefined();
    expect(typeof result.extra!.attachmentId).toBe('string');
    expect(typeof result.extra!.attachmentUrl).toBe('string');
    expect(result.extra!.attachmentMimeType).toBe('audio/wav');

    expect(deps.storage.write).toHaveBeenCalledWith('attachments', expect.stringMatching(/\.[\w]+$/), expect.any(Uint8Array));
    expect(deps.attachments.create).toHaveBeenCalledTimes(1);
  });

  it('uses toolset config for provider and voice', async () => {
    const fakeAudio = new Uint8Array([0x00]);
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'audio/mp3' }),
      arrayBuffer: async () => fakeAudio.buffer,
    } as Response));

    await template.execute('speak', { text: 'hello' }, {
      config: { provider: 'kokoro', voiceId: 'custom-voice', baseUrl: 'http://kokoro:8880/v1' },
    });

    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe('http://kokoro:8880/v1/audio/speech');

    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse(init.body as string);
    expect(body.voice).toBe('custom-voice');
  });

  it('mutates request via requestScript', async () => {
    const fakeAudio = new Uint8Array([0x00]);
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'audio/wav' }),
      arrayBuffer: async () => fakeAudio.buffer,
    } as Response));

    const script = 'request.body.format = "mp3"';
    await template.execute('speak', { text: 'hello' }, {
      config: { provider: 'fishaudio', baseUrl: 'http://example.com:8080/v1', requestScript: script },
    });

    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse(init.body as string);
    expect(body.format).toBe('mp3');
  });

  it('returns error when referenceAudio is provided without referenceText', async () => {
    const result = await template.execute('speak', { text: 'hello' }, {
      config: { provider: 'fishaudio', baseUrl: 'http://localhost:8080/v1', referenceAudio: 'base64data' },
    });
    expect(result.content).toContain('referenceText is required');
  });

  it('sends inline references when referenceAudio and referenceText are provided', async () => {
    const fakeAudio = new Uint8Array([0x00]);
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'audio/wav' }),
      arrayBuffer: async () => fakeAudio.buffer,
    } as Response));

    await template.execute('speak', { text: 'hello' }, {
      config: {
        provider: 'fishaudio',
        baseUrl: 'http://localhost:8080/v1',
        voiceId: 'custom-voice',
        referenceAudio: 'base64data',
        referenceText: 'reference transcript',
      },
    });

    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse(init.body as string);
    expect(body.voiceId).toBeUndefined();
    expect(body.reference_id).toBeUndefined();
    expect(body.references).toEqual([{ audio: 'base64data', text: 'reference transcript' }]);
  });

  it('returns error on fetch failure', async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    } as Response));

    const result = await template.execute('speak', { text: 'hello' }, { config: { provider: 'fishaudio', baseUrl: 'http://localhost:8080/v1' } });
    expect(result.content).toContain('TTS generation failed');
  });

  it.each([
    { mime: 'audio/wav', ext: 'wav' },
    { mime: 'audio/mpeg', ext: 'mp3' },
    { mime: 'audio/ogg', ext: 'ogg' },
    { mime: 'audio/flac', ext: 'flac' },
    { mime: 'audio/aac', ext: 'aac' },
    { mime: 'audio/opus', ext: 'opus' },
  ])('uses .$ext extension for $mime', async ({ mime, ext }) => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': mime }),
      arrayBuffer: async () => new Uint8Array([0x00]).buffer,
    } as Response));

    await template.execute('speak', { text: 'test' }, { config: { provider: 'fishaudio', baseUrl: 'http://localhost:8080/v1' } });

    const writeCall = (deps.storage.write as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(writeCall[1]).toMatch(new RegExp(`\\.${ext}$`));
  });
});
