import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ToolRegistry } from '../ToolRegistry.js';
import type { ToolContext, ToolExecuteResult, ToolTemplate } from '../ToolTemplate.js';
import type { FileStorage } from '../FileStorage.js';
import type { IAttachmentRepository } from '../../repos/AttachmentRepository.js';
import type { SecretService } from '../SecretService.js';
import { resolveSecretSettings } from '../SecretResolver.js';
import type { Attachment } from '@tamari/types';
import type { InlineContentPart } from '../../backends/BackendAdapter.js';
import { createTtsAdapter } from '../../tts/factory.js';
import { getLogger } from '../../lib/logger.js';
import { str } from '../../lib/coerce.js';

const logger = getLogger('speak');

/** Args for `speak`. Single source of truth for the LLM schema and runtime validation. */
const SpeakArgs = z.object({
  text: z.string().describe('Text to speak, including natural-language prosody/emotion tags if supported by the provider.'),
});

export interface SpeakTemplateDeps {
  storage: FileStorage;
  attachments: IAttachmentRepository;
  secretService: SecretService;
  secretsPassword: string;
}

export function registerSpeakTemplate(registry: ToolRegistry, deps: SpeakTemplateDeps): void {
  registry.registerTemplate(new SpeakTemplate(deps));
}

export class SpeakTemplate implements ToolTemplate {
  id = 'speak';
  name = 'Speak';
  source = 'builtin' as const;

  constructor(private deps: SpeakTemplateDeps) {}

  getDefinition() {
    return {
      stateKey: 'speak',
      configSchema: {
        type: 'object',
        properties: {
          provider: {
            type: 'string',
            description: 'TTS provider. Required.',
            enum: [
              'fishaudio',
              'kokoro',
              'elevenlabs',
              'openai',
              'azure',
              'minimax',
              'volcengine',
              'alltalk',
              'vits',
              'silero',
              'gptsovits',
            ],
            default: '',
          },
          voiceId: {
            type: 'string',
            description: 'Voice ID. Optional — uses provider default if empty. For Azure this is the voice ShortName (e.g. en-US-JennyNeural); for GPT-SoVITS the server-side reference-audio path.',
            default: '',
          },
          baseUrl: {
            type: 'string',
            description: 'API base URL. Optional — uses provider default if empty. For Azure this is the regional host (e.g. https://eastus.tts.speech.microsoft.com).',
            default: '',
          },
          apiKey: {
            type: 'string',
            format: 'secret',
            description: 'API key / access token, or a vault reference (secret:<key>). Optional.',
            default: '',
          },
          model: {
            type: 'string',
            description: 'Model id (OpenAI / ElevenLabs / MiniMax). Optional — uses provider default if empty.',
            default: '',
          },
          appId: {
            type: 'string',
            description: 'App ID (VolcEngine). Optional for other providers.',
            default: '',
          },
          referenceAudio: {
            type: 'string',
            format: 'file',
            description: 'Reference audio file for voice cloning. Optional.',
            default: '',
          },
          referenceText: {
            type: 'string',
            description: 'Transcript of the reference audio. Required if referenceAudio is provided.',
            default: '',
          },
          requestScript: {
            type: 'string',
            format: 'textarea',
            description: 'Lua script to mutate the outgoing HTTP request. The script receives a `request` table with `url`, `method`, `headers`, and `body` fields.',
            default: '',
          },
        },
      },
      tools: [
        {
          name: 'speak',
          description:
            'Convert text to speech using the configured TTS provider. Provide the text to speak, including any natural-language voice direction tags (e.g. [whisper in small voice], [excitedly], [pitch up]). When audio is successfully generated, the result will include a reference in the format {{attachment::ID}}. To let the user play the audio, include this exact reference in your response.',
          parameters: z.toJSONSchema(SpeakArgs) as Record<string, unknown>,
        },
      ],
    };
  }

  async execute(_toolName: string, args: Record<string, unknown>, context?: ToolContext): Promise<ToolExecuteResult> {
    const parsed = SpeakArgs.safeParse(args);
    if (!parsed.success) return { content: 'Error: text is required' };
    const text = parsed.data.text.trim();
    if (!text) return { content: 'Error: text is required' };

    const config = context?.config ?? {};

    const provider = str(config['provider']);
    if (!provider) {
      return { content: 'Error: no TTS provider configured in toolset config' };
    }

    const voiceId = str(config['voiceId']);
    const baseUrl = str(config['baseUrl']);
    const apiKey = str(config['apiKey']);
    const requestScript = str(config['requestScript']);
    const model = str(config['model']);
    const appId = str(config['appId']);

    const settings: Record<string, unknown> = { 'tts.provider': provider };
    if (voiceId) settings[`tts.${provider}.voiceId`] = voiceId;
    if (baseUrl) settings[`tts.${provider}.baseUrl`] = baseUrl;
    if (apiKey) settings[`tts.${provider}.apiKey`] = apiKey;
    if (requestScript) settings[`tts.${provider}.requestScript`] = requestScript;
    if (model) settings[`tts.${provider}.model`] = model;
    if (appId) settings[`tts.${provider}.appId`] = appId;

    await resolveSecretSettings(settings, this.deps.secretService, this.deps.secretsPassword);
    const adapter = createTtsAdapter(settings);
    if (!adapter) {
      return { content: `Error: could not create TTS adapter for provider "${provider}"` };
    }

    const opts: Record<string, unknown> = {};
    const referenceAudio = str(config['referenceAudio']);
    const referenceText = str(config['referenceText']);
    if (referenceAudio) {
      if (!referenceText) {
        return { content: 'Error: referenceText is required when referenceAudio is provided' };
      }
      opts.extra = {
        references: [{ audio: referenceAudio, text: referenceText }],
      };
    }

    let result: { audio: Uint8Array; contentType: string };
    try {
      result = await adapter.generate(text, referenceAudio ? '' : voiceId, opts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `TTS generation failed: ${msg}` };
    }

    const attachmentId = randomUUID();
    const ext = this.mimeToExt(result.contentType);
    const filePath = this.deps.storage.write('attachments', `${attachmentId}.${ext}`, Buffer.from(result.audio));

    let attachment: Attachment;
    try {
      attachment = await this.deps.attachments.create({ id: attachmentId, messageId: null, mimeType: result.contentType, filePath });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err: msg }, 'SpeakTemplate: failed to create attachment');
      return { content: `Audio generated but failed to save attachment: ${msg}` };
    }

    const inlineContent: InlineContentPart[] = [
      {
        type: 'text',
        text: `{{attachment::${attachment.id}}}`,
      },
    ];

    return {
      content: inlineContent,
      extra: { attachmentId: attachment.id, attachmentUrl: attachment.url, attachmentMimeType: attachment.mimeType },
    };
  }

  private mimeToExt(mimeType: string): string {
    if (mimeType.includes('wav')) return 'wav';
    if (mimeType.includes('mp3') || mimeType.includes('mpeg')) return 'mp3';
    if (mimeType.includes('ogg')) return 'ogg';
    if (mimeType.includes('flac')) return 'flac';
    if (mimeType.includes('aac')) return 'aac';
    if (mimeType.includes('opus')) return 'opus';
    return 'bin';
  }

  serialize(): string {
    return '';
  }

  deserialize(_raw: string): void {
    // no-op
  }
}
