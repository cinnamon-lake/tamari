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
      write: vi.fn((sub: string, name: string, data: Uint8Array) => {
        const rel = `files/${sub}/${name}`;
        files.set(rel, data);
        return rel;
      }),
      exists: vi.fn((rel: string) => files.has(rel)),
      read: vi.fn((rel: string) => {
        const data = files.get(rel);
        if (!data) throw new Error(`no such file: ${rel}`);
        return Buffer.from(data);
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
    expect(
      typeof result.content === 'string' ? result.content : (result.content[0] as { text: string }).text,
    ).toContain('text is required');
  });

  it('returns error when no TTS provider is configured', async () => {
    const result = await template.execute('speak', { text: 'hello' }, {});
    expect(result.content).toContain('no TTS provider configured');
  });

  it('generates audio and returns attachment macro', async () => {
    const fakeAudio = new Uint8Array([0x52, 0x49, 0x46, 0x46]); // RIFF header
    global.fetch = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'audio/wav' }),
          arrayBuffer: async () => fakeAudio.buffer,
        }) as Response,
    );

    const result = await template.execute(
      'speak',
      { text: 'Hello world' },
      { config: { provider: 'fishaudio', baseUrl: 'http://localhost:8080/v1' } },
    );

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

    expect(deps.storage.write).toHaveBeenCalledWith(
      'attachments',
      expect.stringMatching(/\.[\w]+$/),
      expect.any(Uint8Array),
    );
    expect(deps.attachments.create).toHaveBeenCalledTimes(1);
  });

  it('uses toolset config for provider and voice', async () => {
    const fakeAudio = new Uint8Array([0x00]);
    global.fetch = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'audio/mp3' }),
          arrayBuffer: async () => fakeAudio.buffer,
        }) as Response,
    );

    await template.execute(
      'speak',
      { text: 'hello' },
      {
        config: { provider: 'kokoro', voiceId: 'custom-voice', baseUrl: 'http://kokoro:8880/v1' },
      },
    );

    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe('http://kokoro:8880/v1/audio/speech');

    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse(init.body as string);
    expect(body.voice).toBe('custom-voice');
  });

  it('mutates request via requestScript', async () => {
    const fakeAudio = new Uint8Array([0x00]);
    global.fetch = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'audio/wav' }),
          arrayBuffer: async () => fakeAudio.buffer,
        }) as Response,
    );

    const script = 'request.body.format = "mp3"';
    await template.execute(
      'speak',
      { text: 'hello' },
      {
        config: { provider: 'fishaudio', baseUrl: 'http://example.com:8080/v1', requestScript: script },
      },
    );

    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse(init.body as string);
    expect(body.format).toBe('mp3');
  });

  it('returns error when referenceAudio is provided without referenceText', async () => {
    const result = await template.execute(
      'speak',
      { text: 'hello' },
      {
        config: { provider: 'fishaudio', baseUrl: 'http://localhost:8080/v1', referenceAudio: 'base64data' },
      },
    );
    expect(result.content).toContain('referenceText is required');
  });

  it('sends inline references when referenceAudio and referenceText are provided', async () => {
    const fakeAudio = new Uint8Array([0x00]);
    global.fetch = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'audio/wav' }),
          arrayBuffer: async () => fakeAudio.buffer,
        }) as Response,
    );

    await template.execute(
      'speak',
      { text: 'hello' },
      {
        config: {
          provider: 'fishaudio',
          baseUrl: 'http://localhost:8080/v1',
          voiceId: 'custom-voice',
          referenceAudio: 'base64data',
          referenceText: 'reference transcript',
        },
      },
    );

    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse(init.body as string);
    expect(body.voiceId).toBeUndefined();
    expect(body.reference_id).toBeUndefined();
    expect(body.references).toEqual([{ audio: 'base64data', text: 'reference transcript' }]);
  });

  it('returns error on fetch failure', async () => {
    global.fetch = vi.fn(
      async () =>
        ({
          ok: false,
          status: 500,
          text: async () => 'Internal Server Error',
        }) as Response,
    );

    const result = await template.execute(
      'speak',
      { text: 'hello' },
      { config: { provider: 'fishaudio', baseUrl: 'http://localhost:8080/v1' } },
    );
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
    global.fetch = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': mime }),
          arrayBuffer: async () => new Uint8Array([0x00]).buffer,
        }) as Response,
    );

    await template.execute(
      'speak',
      { text: 'test' },
      { config: { provider: 'fishaudio', baseUrl: 'http://localhost:8080/v1' } },
    );

    const writeCall = (deps.storage.write as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(writeCall[1]).toMatch(new RegExp(`\\.${ext}$`));
  });

  it('getDefinition shows design_voice for qwen or config-less previews, hides it otherwise', () => {
    const all = template.getDefinition() as { tools: Array<{ name: string }> };
    expect(all.tools.map((t) => t.name)).toEqual(['speak', 'design_voice']);

    const qwen = template.getDefinition({ provider: 'qwen' }) as { tools: Array<{ name: string }> };
    expect(qwen.tools.map((t) => t.name)).toEqual(['speak', 'design_voice']);

    const fish = template.getDefinition({ provider: 'fishaudio' }) as { tools: Array<{ name: string }> };
    expect(fish.tools.map((t) => t.name)).toEqual(['speak']);
  });

  it('getDefinition includes the speak language arg only for qwen', () => {
    type Def = { tools: Array<{ name: string; parameters: { properties: Record<string, unknown> } }> };
    const toDef = (def: unknown) => def as Def;
    const speakParams = (def: unknown) => toDef(def).tools.find((t) => t.name === 'speak')!.parameters.properties;

    expect(speakParams(template.getDefinition())).toHaveProperty('language');
    expect(speakParams(template.getDefinition({ provider: 'qwen' }))).toHaveProperty('language');
    expect(speakParams(template.getDefinition({ provider: 'fishaudio' }))).not.toHaveProperty('language');
    expect(speakParams(template.getDefinition({ provider: 'fishaudio' }))).toHaveProperty('voiceId');
  });

  it('speak language arg overrides the configured language', async () => {
    const fakeAudio = new Uint8Array([0x00]);
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ code: '', output: { audio: { data: '', url: '/audio/x.wav' } } }),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'audio/wav' }),
        arrayBuffer: async () => fakeAudio.buffer,
      });

    await template.execute(
      'speak',
      { text: 'hello', language: 'Japanese' },
      {
        config: {
          provider: 'qwen',
          baseUrl: 'http://qwen.local',
          language: 'English',
          voiceId: 'qwen-tts-vd-x-1',
          model: 'qwen3-tts-vd-2026-01-26',
        },
      },
    );

    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse(init.body as string);
    expect(body.input.language_type).toBe('Japanese');
  });

  it('design_voice returns error for non-qwen providers', async () => {
    const result = await template.execute(
      'design_voice',
      { voicePrompt: 'a calm narrator', previewText: 'Hello.' },
      { config: { provider: 'fishaudio', baseUrl: 'http://localhost:8080/v1' } },
    );
    expect(result.content).toContain('only available with the `qwen` TTS provider');
  });

  it('design_voice requires voicePrompt and previewText', async () => {
    const result = await template.execute(
      'design_voice',
      {},
      { config: { provider: 'qwen', baseUrl: 'http://qwen.local' } },
    );
    expect(result.content).toContain('voicePrompt and previewText are required');
  });

  it('design_voice posts to the customization endpoint and returns voice + preview attachment', async () => {
    const preview = Buffer.from('RIFF-preview');
    global.fetch = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({
            output: {
              voice: 'qwen-tts-vd-announcer-voice-20260904-a1b2',
              preview_audio: { data: preview.toString('base64'), sample_rate: 24000, response_format: 'wav' },
              target_model: 'qwen3-tts-vd-2026-01-26',
            },
            usage: { count: 1 },
            request_id: 'req-1',
          }),
          text: async () => '',
        }) as unknown as Response,
    );

    const result = await template.execute(
      'design_voice',
      { voicePrompt: 'A composed announcer.', previewText: 'Welcome to the news.', language: 'en' },
      {
        config: {
          provider: 'qwen',
          baseUrl: 'http://qwen.local',
          apiKey: 'sk-test',
          model: 'qwen3-tts-vd-2026-01-26',
        },
      },
    );

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe('http://qwen.local/api/v1/services/audio/tts/customization');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('qwen-voice-design');
    expect(body.input.target_model).toBe('qwen3-tts-vd-2026-01-26');
    expect(body.input.voice_prompt).toBe('A composed announcer.');

    const parts = result.content as Array<{ type: string; text?: string }>;
    expect(parts[0]!.text).toContain('qwen-tts-vd-announcer-voice-20260904-a1b2');
    expect(parts[0]!.text).toMatch(/\{\{attachment::/);
    expect(result.extra!.voice).toBe('qwen-tts-vd-announcer-voice-20260904-a1b2');
    expect(deps.attachments.create).toHaveBeenCalledTimes(1);

    // The design def is persisted so speak can recreate the voice later.
    const defs = JSON.parse(deps.storage.read('files/tts/qwen-voices.json').toString('utf8')) as Record<
      string,
      unknown
    >;
    expect(defs['qwen-tts-vd-announcer-voice-20260904-a1b2']).toEqual({
      voicePrompt: 'A composed announcer.',
      previewText: 'Welcome to the news.',
      language: 'en',
    });
  });

  it('speak voiceId arg overrides the configured voice', async () => {
    const fakeAudio = new Uint8Array([0x00]);
    global.fetch = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'audio/wav' }),
          arrayBuffer: async () => fakeAudio.buffer,
        }) as Response,
    );

    await template.execute(
      'speak',
      { text: 'hello', voiceId: 'call-voice' },
      { config: { provider: 'kokoro', voiceId: 'config-voice', baseUrl: 'http://kokoro:8880/v1' } },
    );

    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse(init.body as string);
    expect(body.voice).toBe('call-voice');
  });

  it.each(['BadRequest.VoiceNotFound', 'BadRequest.VoiceModelMismatch'])(
    'recreates a missing Qwen voice from its stored def on %s and retries',
    async (code) => {
      deps.storage.write(
        'tts',
        'qwen-voices.json',
        Buffer.from(
          JSON.stringify({
            'qwen-tts-vd-old-voice-1': {
              voicePrompt: 'A composed announcer.',
              previewText: 'Welcome.',
              language: 'en',
            },
          }),
        ),
      );

      const fakeAudio = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
      global.fetch = vi
        .fn()
        // 1: generation attempt fails — voice missing / bound to another model
        .mockResolvedValueOnce({
          ok: false,
          status: 400,
          text: async () => JSON.stringify({ status_code: 400, code, message: 'voice gone' }),
        })
        // 2: recreation via the customization endpoint
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            output: {
              voice: 'qwen-tts-vd-new-voice-2',
              target_model: 'qwen3-tts-vd-2026-01-26',
              preview_audio: { data: Buffer.from('p').toString('base64'), response_format: 'wav' },
            },
          }),
          text: async () => '',
        })
        // 3: generation retry with the new voice
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ code: '', output: { audio: { data: '', url: '/audio/x.wav' } } }),
          text: async () => '',
        })
        // 4: audio fetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'audio/wav' }),
          arrayBuffer: async () => fakeAudio.buffer,
        });

      const result = await template.execute(
        'speak',
        { text: 'hi', voiceId: 'qwen-tts-vd-old-voice-1' },
        {
          config: {
            provider: 'qwen',
            baseUrl: 'http://qwen.local',
            model: 'qwen3-tts-vd-2026-01-26',
            language: 'English',
          },
        },
      );

      expect(global.fetch).toHaveBeenCalledTimes(4);
      const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls as Array<[string, RequestInit]>;

      // Recreation used the stored def, bound to the currently configured model.
      expect(calls[1]![0]).toBe('http://qwen.local/api/v1/services/audio/tts/customization');
      const designBody = JSON.parse(calls[1]![1].body as string);
      expect(designBody.input.voice_prompt).toBe('A composed announcer.');
      expect(designBody.input.target_model).toBe('qwen3-tts-vd-2026-01-26');

      // The retry used the new voice name.
      const retryBody = JSON.parse(calls[2]![1].body as string);
      expect(retryBody.input.voice).toBe('qwen-tts-vd-new-voice-2');

      const parts = result.content as Array<{ type: string; text?: string }>;
      expect(parts[0]!.text).toMatch(/\{\{attachment::/);
      expect(parts[0]!.text).toContain('qwen-tts-vd-new-voice-2');
      expect(result.extra!.recreatedVoice).toBe('qwen-tts-vd-new-voice-2');

      // The new voice name is persisted under the same def.
      const defs = JSON.parse(deps.storage.read('files/tts/qwen-voices.json').toString('utf8')) as Record<
        string,
        unknown
      >;
      expect(defs['qwen-tts-vd-new-voice-2']).toBeDefined();
    },
  );

  it('returns the original error when no def is stored for a missing Qwen voice', async () => {
    global.fetch = vi.fn(
      async () =>
        ({
          ok: false,
          status: 400,
          text: async () =>
            JSON.stringify({ status_code: 400, code: 'BadRequest.VoiceNotFound', message: 'Voice not found: x' }),
        }) as unknown as Response,
    );

    const result = await template.execute(
      'speak',
      { text: 'hi', voiceId: 'qwen-tts-vd-unknown-1' },
      { config: { provider: 'qwen', baseUrl: 'http://qwen.local' } },
    );

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(result.content).toContain('TTS generation failed');
    expect(result.content).toContain('VoiceNotFound');
  });
});
