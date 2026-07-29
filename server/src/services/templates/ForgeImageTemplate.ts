import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ToolRegistry } from '../ToolRegistry.js';
import type { ToolContext, ToolExecuteResult, ToolTemplate } from '../ToolTemplate.js';
import type { FileStorage } from '../FileStorage.js';
import type { IAttachmentRepository } from '../../repos/AttachmentRepository.js';
import type { Attachment } from '@tamari/types';
import type { InlineContentPart } from '../../backends/BackendAdapter.js';
import { applyRequestScript, RequestScriptError } from '../../backends/RequestScript.js';
import { getLogger } from '../../lib/logger.js';

const logger = getLogger('forge-image');

/**
 * Arguments the model may pass to `generate_image`. Single source of truth:
 * the LLM-facing `parameters` schema (via `z.toJSONSchema`) and the runtime
 * validation in `execute` both derive from this, so they can't drift.
 */
const ForgeImageArgs = z.object({
  prompt: z.string().describe('Detailed description of the image to generate.'),
  orientation: z
    .enum(['square', 'portrait', 'landscape'])
    .optional()
    .describe('Image orientation. Defaults to square.'),
  negative_prompt: z.string().optional().describe('Things to avoid in the image.'),
});

export interface ForgeImageTemplateDeps {
  storage: FileStorage;
  attachments: IAttachmentRepository;
}

export function registerForgeImageTemplate(registry: ToolRegistry, deps: ForgeImageTemplateDeps): void {
  registry.registerTemplate(new ForgeImageTemplate(deps));
}

const ORIENTATION_SIZES: Record<string, { width: number; height: number }> = {
  square: { width: 1024, height: 1024 },
  portrait: { width: 832, height: 1216 },
  landscape: { width: 1216, height: 832 },
};

export class ForgeImageTemplate implements ToolTemplate {
  id = 'forge_image';
  name = 'Forge Image Generator';
  source = 'builtin' as const;

  constructor(private deps: ForgeImageTemplateDeps) {}

  getDefinition() {
    return {
      stateKey: 'forge_image',
      configSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'Forge API base URL',
            default: 'http://localhost:7860',
          },
          files: {
            type: 'string',
            format: 'file',
            multiple: true,
            description: 'Optional reference images (img2img, ControlNet, etc.). Available in the Lua script as the `files` table (array of base64 strings).',
            default: [],
          },
          requestScript: {
            type: 'string',
            format: 'textarea',
            description: 'Lua script to mutate the outgoing HTTP request. Receives `request.url`, `request.method`, `request.headers`, and `request.body`. Uploaded images are available as `files` (array of base64 strings).',
            default: '',
          },
        },
      },
      tools: [
        {
          name: 'generate_image',
          description:
            'Generate an image using Stable Diffusion WebUI Forge. Provide a detailed text prompt describing the desired image. When an image is successfully generated, the result will include a reference in the format {{attachment::ID}}. To display the image in your response, include this exact reference.',
          parameters: z.toJSONSchema(ForgeImageArgs) as Record<string, unknown>,
        },
      ],
    };
  }

  async execute(_toolName: string, args: Record<string, unknown>, context?: ToolContext): Promise<ToolExecuteResult> {
    const config = context?.config ?? {};
    const baseUrl = (typeof config['url'] === 'string' ? config['url'] : 'http://localhost:7860').replace(/\/$/, '');
    const requestScript = typeof config['requestScript'] === 'string' ? config['requestScript'] : '';
    const files = Array.isArray(config['files']) ? (config['files'] as string[]) : [];

    const parsed = ForgeImageArgs.safeParse(args);
    if (!parsed.success) {
      const missingPrompt = parsed.error.issues.some((i) => i.path[0] === 'prompt');
      return { content: missingPrompt ? 'Error: prompt is required' : 'Error: invalid generate_image arguments' };
    }
    const prompt = parsed.data.prompt.trim();
    if (!prompt) {
      return { content: 'Error: prompt is required' };
    }

    const orientation = parsed.data.orientation ?? 'square';
    const size = ORIENTATION_SIZES[orientation] ?? { width: 1024, height: 1024 };

    const body: Record<string, unknown> = {
      prompt,
      negative_prompt: parsed.data.negative_prompt ?? '',
      width: size.width,
      height: size.height,
      send_images: true,
      save_images: false,
    };

    let url = `${baseUrl}/sdapi/v1/txt2img`;
    let init: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };

    if (requestScript.trim()) {
      try {
        const result = await applyRequestScript(url, init, requestScript, { files }, true);
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
      return { content: `Forge request failed: ${msg}` };
    }

    if (!response.ok) {
      const text = await response.text().catch(() => 'Unknown error');
      return { content: `Forge returned ${response.status}: ${text}` };
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      return { content: 'Failed to parse Forge response as JSON.' };
    }

    const images = (data as Record<string, unknown>).images;
    if (!Array.isArray(images) || images.length === 0 || typeof images[0] !== 'string') {
      return { content: 'Forge returned no images.' };
    }

    const base64Image = images[0];
    let imageBuffer: Buffer;
    try {
      imageBuffer = Buffer.from(base64Image, 'base64');
    } catch {
      return { content: 'Failed to decode base64 image from Forge.' };
    }

    const attachmentId = randomUUID();
    const filePath = this.deps.storage.write('attachments', `${attachmentId}.png`, imageBuffer);

    let attachment: Attachment;
    try {
      attachment = await this.deps.attachments.create({ id: attachmentId, messageId: null, mimeType: 'image/png', filePath });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err: msg }, 'ForgeImageTemplate: failed to create attachment');
      return { content: `Image generated but failed to save attachment: ${msg}` };
    }

    const inlineContent: InlineContentPart[] = [
      {
        type: 'text',
        text: `Generated ${orientation} image. To display it in your response, include: {{attachment::${attachment.id}}}`,
      },
      {
        type: 'image',
        source: attachment.url,
        mimeType: 'image/png',
      },
    ];

    return {
      content: inlineContent,
      extra: { attachmentId: attachment.id, attachmentUrl: attachment.url, attachmentMimeType: attachment.mimeType },
    };
  }

  serialize(): string {
    return '';
  }

  deserialize(_raw: string): void {
    // no-op
  }
}
