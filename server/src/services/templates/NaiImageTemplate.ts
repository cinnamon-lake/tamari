import { newId } from '@tamari/wordid';
import { z } from 'zod';
import { unzipWithCap } from '../../lib/zipGuard.js';
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

const logger = getLogger('services/templates/NaiImageTemplate');

/**
 * Arguments the model may pass to `generate_image`. Single source of truth:
 * the LLM-facing `parameters` schema (via `z.toJSONSchema`) and the runtime
 * validation in `execute` both derive from this, so they can't drift.
 */
const NaiCharacterPrompt = z.object({
  prompt: z
    .string()
    .describe(
      'Tags describing this character only: appearance, clothing, pose, expression. Keep it focused on the character.',
    ),
  negative_prompt: z.string().optional().describe('Things to avoid for this character. Defaults to empty.'),
  x: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('Horizontal center of the character (0 = left, 1 = right). Defaults to 0.5.'),
  y: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('Vertical center of the character (0 = top, 1 = bottom). Defaults to 0.5.'),
});

const NaiImageArgs = z.object({
  prompt: z
    .string()
    .describe(
      'Detailed description of the image. Comma-separated Danbooru-style tags ' +
        '(e.g. "1girl, purple hair, bob cut, looking at viewer, smug, cowboy shot"), plain English ' +
        'sentences, or a mix of both. Start with character counts, then character/series names, then the rest.',
    ),
  orientation: z
    .enum(['square', 'portrait', 'landscape'])
    .optional()
    .describe('Image orientation. Defaults to square.'),
  negative_prompt: z
    .string()
    .optional()
    .describe(
      'Things to avoid in the image. Defaults to NovelAI\'s "heavy" undesired-content preset, which ' +
        'already covers general quality issues — override only to ban specific concepts (e.g. "text" ' +
        'if text keeps appearing). Note that overriding replaces the preset entirely.',
    ),
  character_prompts: z
    .array(NaiCharacterPrompt)
    .optional()
    .describe(
      'Per-character prompts for multi-character scenes. Describe each character separately here ' +
        'instead of mixing their traits into the main prompt; the main prompt should still state how ' +
        'many characters there are (e.g. "2girls") and the shared scene/background. The model closely ' +
        'follows the x/y position of each character, so spread them across the canvas.',
    ),
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
            description:
              'NovelAI API key (pst-... token from account settings), or a vault reference (secret:<key>). Required.',
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
            description:
              'API base URL. Optional — override only for proxies; defaults to the official NovelAI image API.',
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
            'Generate an anime-style image using NovelAI Diffusion (V5 by default). Prompting rules:\n' +
            '- Tags and natural language both work and can be freely mixed. V5 understands full English sentences well, so when in doubt, describe the scene precisely in plain words instead of guessing tags.\n' +
            '- Commas are always parsed as tag separators, even inside natural language — write natural-language parts without commas.\n' +
            '- Use only tags that actually exist on Danbooru. If you suspect a tag does not exist, do not use it. Most established anime characters and series DO have Danbooru tags, so reference them by name (e.g. "hatsune miku, vocaloid").\n' +
            '- Tag order: character counts first ("1girl", "2boys"), then character and series names, then everything else in any order.\n' +
            '- Tag ONLY what should be visible in the image. If it would not be visible in the finished picture, do not tag it.\n' +
            '- Always lock in the framing explicitly: "portrait", "upper body", "cowboy shot", "full body", "close-up", etc. If omitted, the model picks one at random.\n' +
            '- Always lock in eye direction ("looking at viewer", "looking to the side", "looking away") and hand positions ("hands on own hips", "hand in own hair", "arms at sides") — eyes and hands drift when left unspecified.\n' +
            '- To render legible text in the image (V5 handles English, Japanese, Chinese), put the exact wording in quotes in a natural-language sentence, e.g. A speech bubble saying "Hello world!". Avoid the "no text" tag when you want text.\n' +
            '- Useful V5 tags: "high complexity" for normal detailed images ("low"/"ultra complexity" for more stylized looks), "transparent background" for a true alpha-channel background, "depthness" for deeper shading, "year XXXX" to bias the art style toward a given year.\n' +
            '- For scenes with multiple characters, pass character_prompts and describe each character separately there.\n' +
            'When an image is successfully generated, the result will include a reference in the format {{attachment::ID}}. To display the image in your response, include this exact reference.',
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
    const characters = (parsed.data.character_prompts ?? [])
      .map((c) => ({
        prompt: c.prompt.trim(),
        uc: c.negative_prompt ?? '',
        center: { x: c.x ?? 0.5, y: c.y ?? 0.5 },
      }))
      .filter((c) => c.prompt.length > 0);

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
        characterPrompts: characters.map((c) => ({ prompt: c.prompt, uc: c.uc, center: c.center, enabled: true })),
        straight_alpha: true,
        tag_hint_qt: 1,
        tag_hint_uc_preset: 2,
        v4_prompt: {
          caption: {
            base_caption: prompt,
            char_captions: characters.map((c) => ({ char_caption: c.prompt, centers: [c.center] })),
          },
          use_coords: false,
          use_order: true,
        },
        v4_negative_prompt: {
          caption: {
            base_caption: negativePrompt,
            char_captions: characters.map((c) => ({ char_caption: c.uc, centers: [c.center] })),
          },
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
      const files = unzipWithCap(zipBytes);
      imageBuffer = Object.values(files)[0];
    } catch {
      return { content: 'Failed to unzip NovelAI response.' };
    }
    if (!imageBuffer || imageBuffer.length === 0) {
      return { content: 'NovelAI returned no images.' };
    }

    const attachmentId = newId();
    const filePath = this.deps.storage.write('attachments', `${attachmentId}.png`, imageBuffer);

    let attachment: Attachment;
    try {
      attachment = await this.deps.attachments.create({
        id: attachmentId,
        messageId: null,
        mimeType: 'image/png',
        filePath,
      });
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
      extra: {
        attachmentId: attachment.id,
        attachmentUrl: attachment.url,
        attachmentMimeType: attachment.mimeType,
        seed,
      },
    };
  }

  serialize(): string {
    return '';
  }

  deserialize(_raw: string): void {
    // no-op
  }
}
