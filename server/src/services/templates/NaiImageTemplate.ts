import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { unzipSync } from 'fflate';
import type { ToolRegistry } from '../ToolRegistry.js';
import type { ToolContext, ToolExecuteResult, ToolTemplate } from '../ToolTemplate.js';
import type { FileStorage } from '../FileStorage.js';
import type { IAttachmentRepository } from '../../repos/AttachmentRepository.js';
import type { SecretService } from '../SecretService.js';
import { resolveSecretValue } from '../SecretResolver.js';
import type { Attachment } from '@tamari/types';
import type { InlineContentPart } from '../../backends/BackendAdapter.js';
import { applyRequestScript, RequestScriptError } from '../../backends/RequestScript.js';
import { getLogger } from '../../lib/logger.js';
import { str } from '../../lib/coerce.js';

const logger = getLogger('nai-image');

/**
 * Arguments the model may pass to `generate_image`. Single source of truth:
 * the LLM-facing `parameters` schema (via `z.toJSONSchema`) and the runtime
 * validation in `execute` both derive from this, so they can't drift.
 */
const NaiImageArgs = z.object({
  prompt: z.string().describe('Detailed description of the image to generate, in NovelAI tag style.'),
  orientation: z
    .enum(['square', 'portrait', 'landscape'])
    .optional()
    .describe('Image orientation. Defaults to square.'),
  negative_prompt: z.string().optional().describe('Things to avoid in the image.'),
  seed: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Random seed for reproducible results. Omit for a random seed.'),
});

export interface NaiImageTemplateDeps {
  storage: FileStorage;
  attachments: IAttachmentRepository;
  secretService: SecretService;
  secretsPassword: string;
}

export function registerNaiImageTemplate(registry: ToolRegistry, deps: NaiImageTemplateDeps): void {
  registry.registerTemplate(new NaiImageTemplate(deps));
}

const ORIENTATION_SIZES: Record<string, { width: number; height: number }> = {
  square: { width: 1024, height: 1024 },
  portrait: { width: 832, height: 1216 },
  landscape: { width: 1216, height: 832 },
};

/** Default negative prompt, matching the NovelAI "heavy" undesired-content preset. */
const DEFAULT_NEGATIVE_PROMPT =
  'nsfw, lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page';

export class NaiImageTemplate implements ToolTemplate {
  id = 'nai_image';
  name = 'NovelAI Image Generator';
  source = 'builtin' as const;

  constructor(private deps: NaiImageTemplateDeps) {}

  getDefinition() {
    return {
      stateKey: 'nai_image',
      configSchema: {
        type: 'object',
        properties: {
          apiKey: {
            type: 'string',
            format: 'secret',
            description: 'NovelAI API key (pst-... token from account settings), or a vault reference (secret:<key>). Required.',
            default: '',
          },
          model: {
            type: 'string',
            description:
              'NovelAI diffusion model id (e.g. nai-diffusion-5-full, nai-diffusion-4-5-full, nai-diffusion-4-full, nai-diffusion-3).',
            default: 'nai-diffusion-5-full',
          },
          baseUrl: {
            type: 'string',
            description: 'API base URL. Optional — override only for proxies; defaults to the official NovelAI image API.',
            default: 'https://image.novelai.net',
          },
          requestScript: {
            type: 'string',
            format: 'textarea',
            description:
              'Lua script to mutate the outgoing HTTP request. Receives `request.url`, `request.method`, `request.headers`, and `request.body` — use it to tweak steps, scale, sampler, etc.',
            default: '',
          },
        },
      },
      tools: [
        {
          name: 'generate_image',
          description:
            'Generate an anime-style image using NovelAI Diffusion. Provide a detailed text prompt describing the desired image (tag style works best, e.g. "1girl, purple hair, ..."). When an image is successfully generated, the result will include a reference in the format {{attachment::ID}}. To display the image in your response, include this exact reference.',
          parameters: z.toJSONSchema(NaiImageArgs) as Record<string, unknown>,
        },
      ],
    };
  }

  async execute(_toolName: string, args: Record<string, unknown>, context?: ToolContext): Promise<ToolExecuteResult> {
    const parsed = NaiImageArgs.safeParse(args);
    if (!parsed.success) {
      const missingPrompt = parsed.error.issues.some((i) => i.path[0] === 'prompt');
      return { content: missingPrompt ? 'Error: prompt is required' : 'Error: invalid generate_image arguments' };
    }
    const prompt = parsed.data.prompt.trim();
    if (!prompt) {
      return { content: 'Error: prompt is required' };
    }

    const config = context?.config ?? {};
    const rawApiKey = str(config['apiKey']);
    const apiKey = str(await resolveSecretValue(rawApiKey, this.deps.secretService, this.deps.secretsPassword));
    if (!apiKey) {
      return { content: 'Error: no NovelAI API key configured in toolset config' };
    }
    const model = str(config['model']) || 'nai-diffusion-5-full';
    const baseUrl = (str(config['baseUrl']) || 'https://image.novelai.net').replace(/\/$/, '');
    const requestScript = str(config['requestScript']);

    const orientation = parsed.data.orientation ?? 'square';
    const size = ORIENTATION_SIZES[orientation] ?? { width: 1024, height: 1024 };
    const seed = parsed.data.seed ?? Math.floor(Math.random() * 0xffffffff) + 1;
    const negativePrompt = parsed.data.negative_prompt ?? DEFAULT_NEGATIVE_PROMPT;

    // Mirrors the payload the NovelAI web UI sends for nai-diffusion-5
    // (params_version 4, v4_prompt caption structure, karras schedule).
    const body: Record<string, unknown> = {
      input: prompt,
      model,
      action: 'generate',
      parameters: {
        params_version: 4,
        width: size.width,
        height: size.height,
        scale: 7,
        sampler: 'k_euler_ancestral',
        steps: 23,
        seed,
        n_samples: 1,
        ucPresetId: 'heavy',
        qualityPresetId: 'standard',
        autoSmea: false,
        dynamic_thresholding: false,
        controlnet_strength: 1,
        legacy: false,
        add_original_image: true,
        cfg_rescale: 0,
        legacy_v3_extend: false,
        use_coords: false,
        legacy_uc: false,
        normalize_reference_strength_multiple: true,
        inpaintImg2ImgStrength: 1,
        characterPrompts: [],
        straight_alpha: true,
        tag_hint_qt: 1,
        tag_hint_uc_preset: 2,
        v4_prompt: {
          caption: { base_caption: prompt, char_captions: [] },
          use_coords: false,
          use_order: true,
        },
        v4_negative_prompt: {
          caption: { base_caption: negativePrompt, char_captions: [] },
          legacy_uc: false,
        },
        negative_prompt: negativePrompt,
        deliberate_euler_ancestral_bug: false,
        prefer_brownian: true,
        noise_schedule: 'karras',
        image_format: 'png',
      },
    };

    let url = `${baseUrl}/ai/generate-image`;
    let init: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    };

    if (requestScript.trim()) {
      try {
        const result = await applyRequestScript(url, init, requestScript, {}, true);
        url = result.url;
        init = result.init;
      } catch (err) {
        const msg = err instanceof RequestScriptError ? err.message : String(err);
        return { content: `Request script error: ${msg}` };
      }
    }

    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `NovelAI request failed: ${msg}` };
    }

    if (!response.ok) {
      const text = await response.text().catch(() => 'Unknown error');
      return { content: `NovelAI returned ${response.status}: ${text}` };
    }

    // The generate-image endpoint answers with a zip archive containing the
    // generated image(s) as PNG files.
    let zipBytes: Uint8Array;
    try {
      zipBytes = new Uint8Array(await response.arrayBuffer());
    } catch {
      return { content: 'Failed to read NovelAI response body.' };
    }

    let imageBuffer: Uint8Array | undefined;
    try {
      const files = unzipSync(zipBytes);
      imageBuffer = Object.values(files)[0];
    } catch {
      return { content: 'Failed to unzip NovelAI response.' };
    }
    if (!imageBuffer || imageBuffer.length === 0) {
      return { content: 'NovelAI returned no images.' };
    }

    const attachmentId = randomUUID();
    const filePath = this.deps.storage.write('attachments', `${attachmentId}.png`, imageBuffer);

    let attachment: Attachment;
    try {
      attachment = await this.deps.attachments.create({ id: attachmentId, messageId: null, mimeType: 'image/png', filePath });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err: msg }, 'NaiImageTemplate: failed to create attachment');
      return { content: `Image generated but failed to save attachment: ${msg}` };
    }

    const inlineContent: InlineContentPart[] = [
      {
        type: 'text',
        text: `Generated ${orientation} image (seed ${seed}). To display it in your response, include: {{attachment::${attachment.id}}}`,
      },
      {
        type: 'image',
        source: attachment.url,
        mimeType: 'image/png',
      },
    ];

    return {
      content: inlineContent,
      extra: { attachmentId: attachment.id, attachmentUrl: attachment.url, attachmentMimeType: attachment.mimeType, seed },
    };
  }

  serialize(): string {
    return '';
  }

  deserialize(_raw: string): void {
    // no-op
  }
}
