import { newId } from '@tamari/wordid';
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
import { QwenTtsAdapter, QwenTtsError } from '../../tts/QwenTtsAdapter.js';
import type { TtsAdapter } from '../../tts/TtsAdapter.js';
import { getLogger } from '../../lib/logger.js';
import { str } from '../../lib/coerce.js';

const logger = getLogger('services/templates/SpeakTemplate');

/** Args for `speak`. Single source of truth for the LLM schema and runtime validation. */
const SpeakArgs = z.object({
  text: z
    .string()
    .describe('Text to speak, including natural-language prosody/emotion tags if supported by the provider.'),
  voiceId: z
    .string()
    .optional()
    .describe(
      'Voice to use for this call, overriding the toolset config. For Qwen voice design, pass the voice name returned by design_voice.',
    ),
  language: z
    .string()
    .optional()
    .describe(
      'Language of the synthesized audio for this call, overriding the toolset config (Qwen `language_type`: Auto, Chinese, English, German, Italian, Portuguese, Spanish, Japanese, Korean, French, Russian).',
    ),
});

/** Args for `design_voice` (Qwen voice design). Single source of truth for the LLM schema and runtime validation. */
const DesignVoiceArgs = z.object({
  voicePrompt: z
    .string()
    .describe(
      'Text description of the voice to design (e.g. "A composed middle-aged male announcer with a deep, magnetic voice"). Chinese and English only.',
    ),
  previewText: z.string().describe('Text spoken in the generated preview clip.'),
  preferredName: z
    .string()
    .optional()
    .describe('Keyword embedded in the voice name (alphanumeric and underscores, max 16 chars). Optional.'),
  language: z
    .string()
    .optional()
    .describe(
      'Language code of the voice: zh, en, de, it, pt, es, ja, ko, fr, ru. Must match the previewText language.',
    ),
});

/** Where designed Qwen voice definitions are persisted, keyed by voice name. */
const QWEN_VOICE_DEFS_PATH = 'files/tts/qwen-voices.json';

/** Original design definition of a Qwen voice — enough to recreate it server-side. */
interface StoredVoiceDef {
  voicePrompt: string;
  previewText: string;
  preferredName?: string;
  language?: string;
}

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

  getDefinition(config?: Record<string, unknown>) {
    // design_voice is Qwen-only: hide it from the model-facing tool list when a
    // concrete toolset config names another provider. Config-less callers (UI
    // previews) see the full tool list.
    const isQwen = !config || str(config['provider']) === 'qwen';
    // The speak `language` arg only exists for providers with a language
    // parameter (Qwen's language_type) — strip it from the schema otherwise.
    const speakParameters = z.toJSONSchema(SpeakArgs) as Record<string, unknown>;
    if (!isQwen) {
      const properties = { ...(speakParameters.properties as Record<string, unknown>) };
      delete properties.language;
      speakParameters.properties = properties;
    }
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
              'qwen',
            ],
            default: '',
          },
          voiceId: {
            type: 'string',
            description:
              'Voice ID. Optional — uses provider default if empty. For Azure this is the voice ShortName (e.g. en-US-JennyNeural); for GPT-SoVITS the server-side reference-audio path; for Qwen voice design, the generated voice name (e.g. qwen-tts-vd-...).',
            default: '',
          },
          baseUrl: {
            type: 'string',
            description:
              'API base URL. Optional — uses provider default if empty. For Azure this is the regional host (e.g. https://eastus.tts.speech.microsoft.com).',
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
            description:
              'Model id (OpenAI / ElevenLabs / MiniMax / Qwen). For Qwen, the synthesis model — e.g. qwen3-tts-vd-2026-01-26 for voice-design voices; voices designed with design_voice are transparently re-created onto this model if they go missing server-side. Optional — uses provider default if empty.',
            default: '',
          },
          language: {
            type: 'string',
            description:
              'Language of the synthesized audio — Qwen `language_type` (e.g. English, Chinese). Optional; Qwen Cloud defaults to Auto, but local Qwen VoiceDesign servers require an explicit value.',
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
            description:
              'Lua script to mutate the outgoing HTTP request. The script receives a `request` table with `url`, `method`, `headers`, and `body` fields.',
            default: '',
          },
        },
      },
      tools: [
        {
          name: 'speak',
          description:
            'Convert text to speech using the configured TTS provider. Provide the text to speak, including any natural-language voice direction tags (e.g. [whisper in small voice], [excitedly], [pitch up]). Use the optional voiceId to override the configured voice for a single call (e.g. a voice just created with design_voice). When audio is successfully generated, the result will include a reference in the format {{attachment::ID}}. To let the user play the audio, include this exact reference in your response.',
          parameters: speakParameters,
        },
        ...(isQwen
          ? [
              {
                name: 'design_voice',
                description:
                  "Design a custom TTS voice from a text description (Qwen voice design). Returns a preview clip as an {{attachment::ID}} reference — include it in your response so the user can listen — plus the generated voice name, which the user can set as this toolset's voiceId.",
                parameters: z.toJSONSchema(DesignVoiceArgs) as Record<string, unknown>,
              },
            ]
          : []),
      ],
    };
  }

  async execute(toolName: string, args: Record<string, unknown>, context?: ToolContext): Promise<ToolExecuteResult> {
    if (toolName === 'design_voice') return this.executeDesignVoice(args, context);
    return this.executeSpeak(args, context);
  }

  private async executeSpeak(args: Record<string, unknown>, context?: ToolContext): Promise<ToolExecuteResult> {
    const parsed = SpeakArgs.safeParse(args);
    if (!parsed.success) return { content: 'Error: text is required' };
    const text = parsed.data.text.trim();
    if (!text) return { content: 'Error: text is required' };

    const config = context?.config ?? {};

    const provider = str(config['provider']);
    if (!provider) {
      return { content: 'Error: no TTS provider configured in toolset config' };
    }

    const adapter = await this.buildAdapter(provider, config, { language: parsed.data.language });
    if (!adapter) {
      return { content: `Error: could not create TTS adapter for provider "${provider}"` };
    }

    const voiceId = parsed.data.voiceId || str(config['voiceId']);
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
    let recreatedVoice: string | undefined;
    try {
      result = await adapter.generate(text, referenceAudio ? '' : voiceId, opts);
    } catch (err) {
      // Qwen voice-design voices can go missing (deleted server-side, or bound
      // to a different target model than the configured one): recreate from the
      // stored design def — bound to the currently configured model — and retry once.
      const recreated = await this.tryRecreateQwenVoice(adapter, voiceId, err);
      if (!recreated) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: `TTS generation failed: ${msg}` };
      }
      try {
        result = await adapter.generate(text, recreated, opts);
        recreatedVoice = recreated;
      } catch (retryErr) {
        const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        return { content: `TTS generation failed even after recreating voice "${recreated}": ${msg}` };
      }
    }

    try {
      const saved = await this.saveAudioAttachment(result.audio, result.contentType);
      const note = recreatedVoice
        ? `\n(Note: voice "${voiceId}" was no longer available, so it was re-created as "${recreatedVoice}" — use that name for future speak calls.)`
        : '';
      const inlineContent: InlineContentPart[] = [
        {
          type: 'text',
          text: `{{attachment::${saved.attachment.id}}}${note}`,
        },
      ];

      return {
        content: inlineContent,
        extra: {
          attachmentId: saved.attachment.id,
          attachmentUrl: saved.attachment.url,
          attachmentMimeType: saved.attachment.mimeType,
          ...(recreatedVoice ? { recreatedVoice } : {}),
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Audio generated but failed to save attachment: ${msg}` };
    }
  }

  /** `design_voice` — Qwen voice design. Creates a voice from a text description and returns the preview clip. */
  private async executeDesignVoice(args: Record<string, unknown>, context?: ToolContext): Promise<ToolExecuteResult> {
    const parsed = DesignVoiceArgs.safeParse(args);
    if (!parsed.success) return { content: 'Error: voicePrompt and previewText are required' };

    const config = context?.config ?? {};
    const provider = str(config['provider']);
    if (!provider) {
      return { content: 'Error: no TTS provider configured in toolset config' };
    }

    const adapter = await this.buildAdapter(provider, config);
    if (!adapter) {
      return { content: `Error: could not create TTS adapter for provider "${provider}"` };
    }
    if (!(adapter instanceof QwenTtsAdapter)) {
      return { content: 'Error: design_voice is only available with the `qwen` TTS provider' };
    }

    let designed;
    try {
      designed = await adapter.designVoice({
        voicePrompt: parsed.data.voicePrompt,
        previewText: parsed.data.previewText,
        preferredName: parsed.data.preferredName,
        language: parsed.data.language,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Voice design failed: ${msg}` };
    }

    // Persist the design def so `speak` can recreate the voice if it goes
    // missing server-side. A storage failure must not sink the design itself.
    try {
      this.rememberQwenVoiceDef(designed.voice, {
        voicePrompt: parsed.data.voicePrompt,
        previewText: parsed.data.previewText,
        preferredName: parsed.data.preferredName,
        language: parsed.data.language,
      });
    } catch (err) {
      logger.warn({ err }, 'SpeakTemplate: failed to persist voice def');
    }

    try {
      const saved = await this.saveAudioAttachment(designed.previewAudio, designed.previewContentType);
      const inlineContent: InlineContentPart[] = [
        {
          type: 'text',
          text: `Designed voice "${designed.voice}" (target model: ${designed.targetModel}). Preview: {{attachment::${saved.attachment.id}}}\nTo speak with this voice, pass voiceId "${designed.voice}" to the speak tool, or set it as the toolset's voiceId.`,
        },
      ];

      return {
        content: inlineContent,
        extra: {
          voice: designed.voice,
          targetModel: designed.targetModel,
          attachmentId: saved.attachment.id,
          attachmentUrl: saved.attachment.url,
          attachmentMimeType: saved.attachment.mimeType,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Voice "${designed.voice}" designed but failed to save preview attachment: ${msg}` };
    }
  }

  /**
   * Recreate a missing Qwen voice-design voice from its stored def and return
   * the new voice name; null when the failure isn't a recreatable voice error
   * or no def was stored for the voice. The recreation binds to the adapter's
   * configured model, so a VoiceModelMismatch heals onto the current model.
   */
  private async tryRecreateQwenVoice(adapter: TtsAdapter, voiceId: string, err: unknown): Promise<string | null> {
    if (!(adapter instanceof QwenTtsAdapter) || !(err instanceof QwenTtsError)) return null;
    if (err.code !== 'BadRequest.VoiceNotFound' && err.code !== 'BadRequest.VoiceModelMismatch') return null;
    const def = this.loadQwenVoiceDefs()[voiceId];
    if (!def) return null;
    try {
      const recreated = await adapter.designVoice(def);
      const defs = this.loadQwenVoiceDefs();
      defs[recreated.voice] = def;
      this.deps.storage.write('tts', 'qwen-voices.json', Buffer.from(JSON.stringify(defs, null, 2)));
      logger.info({ from: voiceId, to: recreated.voice }, 'SpeakTemplate: recreated missing Qwen voice');
      return recreated.voice;
    } catch (recreateErr) {
      logger.warn({ err: recreateErr, voiceId }, 'SpeakTemplate: Qwen voice recreation failed');
      return null;
    }
  }

  /** Record the design def of a newly created voice, keyed by its voice name. */
  private rememberQwenVoiceDef(voice: string, def: StoredVoiceDef): void {
    const defs = this.loadQwenVoiceDefs();
    defs[voice] = def;
    this.deps.storage.write('tts', 'qwen-voices.json', Buffer.from(JSON.stringify(defs, null, 2)));
  }

  private loadQwenVoiceDefs(): Record<string, StoredVoiceDef> {
    try {
      if (!this.deps.storage.exists(QWEN_VOICE_DEFS_PATH)) return {};
      return JSON.parse(this.deps.storage.read(QWEN_VOICE_DEFS_PATH).toString('utf8')) as Record<
        string,
        StoredVoiceDef
      >;
    } catch (err) {
      logger.warn({ err }, 'SpeakTemplate: failed to read Qwen voice defs');
      return {};
    }
  }

  /** Build the TTS adapter from toolset config, resolving vault-referenced secrets. Per-call args win over config. */
  private async buildAdapter(provider: string, config: Record<string, unknown>, overrides?: { language?: string }) {
    const baseUrl = str(config['baseUrl']);
    const apiKey = str(config['apiKey']);
    const requestScript = str(config['requestScript']);
    const model = str(config['model']);
    const appId = str(config['appId']);
    const language = overrides?.language || str(config['language']);

    const settings: Record<string, unknown> = { 'tts.provider': provider };
    if (baseUrl) settings[`tts.${provider}.baseUrl`] = baseUrl;
    if (apiKey) settings[`tts.${provider}.apiKey`] = apiKey;
    if (requestScript) settings[`tts.${provider}.requestScript`] = requestScript;
    if (model) settings[`tts.${provider}.model`] = model;
    if (appId) settings[`tts.${provider}.appId`] = appId;
    if (language) settings[`tts.${provider}.language`] = language;

    await resolveSecretSettings(settings, this.deps.secretService, this.deps.secretsPassword);
    return createTtsAdapter(settings);
  }

  /** Persist generated audio as an attachment; throws on repository failure. */
  private async saveAudioAttachment(audio: Uint8Array, contentType: string): Promise<{ attachment: Attachment }> {
    const attachmentId = newId();
    const ext = this.mimeToExt(contentType);
    const filePath = this.deps.storage.write('attachments', `${attachmentId}.${ext}`, Buffer.from(audio));

    try {
      const attachment = await this.deps.attachments.create({
        id: attachmentId,
        messageId: null,
        mimeType: contentType,
        filePath,
      });
      return { attachment };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err: msg }, 'SpeakTemplate: failed to create attachment');
      throw err instanceof Error ? err : new Error(msg);
    }
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
