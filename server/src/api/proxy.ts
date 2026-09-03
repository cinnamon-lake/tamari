/**
 * Anthropic-like proxy API (`/v1/models`, `/v1/messages`, no streaming).
 *
 * Exposes each BackendConfig as a model whose ID is `${configId}-${name}`.
 * Callers pass that ID in the `model` field of a messages request; the proxy
 * reads the config id back out of it, builds the regular adapter for that
 * config (secrets resolved, custom/Lua backends included), and forwards the
 * conversation. Request-level sampling knobs (temperature, max_tokens, …) are
 * deliberately NOT threaded through — the backend config's settings rule.
 * Tool definitions and tool_use/tool_result history blocks ARE forwarded to
 * the adapter; adapters without tool support ignore them.
 *
 * See https://platform.claude.com/docs/en/api/http/beta/messages/create for
 * the request/response shape this emulates.
 *
 * Gated on the `proxyApi.enabled` setting — 404 when off (same pattern as the
 * MCP router's `mcp.enabled` gate).
 *
 * Auth: NOT the app login token. The proxy has its own randomly generated API
 * key stored in settings (`proxyApi.apiKey`, created at boot when absent and
 * regenerable from the client), presented as `x-api-key` or a Bearer token.
 */

import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { getLogger } from '../lib/logger.js';
import type { ISettingsRepository } from '../repos/SettingsRepository.js';
import type { IBackendConfigRepository } from '../repos/BackendConfigRepository.js';
import type { BackendAdapter, FinishReason, PipelineMessage, Prompt } from '../backends/BackendAdapter.js';
import type { ContentPart, InlineContentPart, ToolDefinition } from '@tamari/types';
import { consumeStream } from '../backends/BackendAdapter.js';
import { buildBackendSettings } from '../backends/buildBackendSettings.js';

const log = getLogger('api/proxy');

/** Model IDs are `${configId}-${name}`; resolve by prefix-matching known config ids. */

const TextBlockSchema = z.object({ type: z.literal('text'), text: z.string() });

const ImageBlockSchema = z.object({
  type: z.literal('image'),
  source: z.union([
    z.object({ type: z.literal('base64'), media_type: z.string(), data: z.string() }),
    z.object({ type: z.literal('url'), url: z.string() }),
  ]),
});

/** Blocks that can appear inline in tool_result content (per the anthropic API). */
const InlineBlockSchema = z.discriminatedUnion('type', [TextBlockSchema, ImageBlockSchema]);

const ToolUseBlockSchema = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
});

const ToolResultBlockSchema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(InlineBlockSchema)]).optional(),
  is_error: z.boolean().optional(),
});

const ContentBlockSchema = z.discriminatedUnion('type', [
  TextBlockSchema,
  ImageBlockSchema,
  ToolUseBlockSchema,
  ToolResultBlockSchema,
]);

const ToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  input_schema: z.record(z.string(), z.unknown()).optional(),
});

// Extra fields anthropic clients send (max_tokens, temperature, tool_choice,
// metadata, …) are intentionally dropped: the backend config owns sampling.
const CreateMessageSchema = z.object({
  model: z.string().min(1),
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.union([z.string(), z.array(ContentBlockSchema)]),
      }),
    )
    .min(1),
  system: z.union([z.string(), z.array(TextBlockSchema)]).optional(),
  tools: z.array(ToolSchema).optional(),
});

type CreateMessageBody = z.infer<typeof CreateMessageSchema>;
type ContentBlock = z.infer<typeof ContentBlockSchema>;
type InlineBlock = z.infer<typeof InlineBlockSchema>;

function anthropicError(res: Response, status: number, type: string, message: string): void {
  res.status(status).json({ type: 'error', error: { type, message } });
}

function toInlinePart(block: InlineBlock): InlineContentPart {
  if (block.type === 'text') return { type: 'text', text: block.text };
  return block.source.type === 'base64'
    ? {
        type: 'image',
        source: `data:${block.source.media_type};base64,${block.source.data}`,
        mimeType: block.source.media_type,
      }
    : { type: 'image', source: block.source.url };
}

function toContentPart(block: ContentBlock): ContentPart {
  if (block.type === 'tool_use') {
    return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
  }
  if (block.type === 'tool_result') {
    return {
      type: 'tool_result',
      toolUseId: block.tool_use_id,
      content:
        block.content === undefined || typeof block.content === 'string'
          ? (block.content ?? '')
          : block.content.map(toInlinePart),
      ...(block.is_error !== undefined ? { isError: block.is_error } : {}),
    };
  }
  return toInlinePart(block);
}

/** Anthropic `{name, description, input_schema}` → pipeline ToolDefinition. */
function toToolDefinitions(tools: NonNullable<CreateMessageBody['tools']>): ToolDefinition[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

function toPipelineMessages(body: CreateMessageBody): PipelineMessage[] {
  const messages: PipelineMessage[] = [];
  if (body.system !== undefined) {
    const system = typeof body.system === 'string' ? body.system : body.system.map((b) => b.text).join('\n');
    if (system.length > 0) messages.push({ role: 'system', content: system });
  }
  for (const m of body.messages) {
    if (typeof m.content === 'string') {
      messages.push({ role: m.role, content: m.content });
      continue;
    }
    messages.push({ role: m.role, content: m.content.map(toContentPart) });
  }
  return messages;
}

const STOP_REASONS: Record<FinishReason, string> = {
  stop: 'end_turn',
  length: 'max_tokens',
  content_filter: 'refusal',
  error: 'end_turn',
};

/** Presented key: `x-api-key` header (anthropic convention) or a Bearer token. */
function presentedKey(req: Request): string | undefined {
  const header = req.headers['x-api-key'];
  if (typeof header === 'string' && header.length > 0) return header;
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  return undefined;
}

function keysEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function createProxyRouter(
  settingsRepo: ISettingsRepository,
  backendConfigRepo: IBackendConfigRepository,
  /** Resolves a fully-merged backend settings map to an adapter (secrets resolved, custom backends included). */
  createResolvedAdapter: (settings: Record<string, unknown>) => Promise<BackendAdapter | null>,
) {
  const router = Router();

  // Feature gate — the endpoint does not exist unless proxyApi.enabled is on.
  router.use((_req, res, next) => {
    settingsRepo
      .get('proxyApi.enabled')
      .then((enabled) => {
        if (enabled === true) next();
        else
          res.status(404).json({
            type: 'error',
            error: {
              type: 'not_found_error',
              message: 'The proxy API is unavailable! Enable it in the settings (proxyApi.enabled).',
            },
          });
      })
      .catch(next);
  });

  // Dedicated API key — the app login token is NOT accepted here.
  router.use((req, res, next) => {
    settingsRepo
      .get('proxyApi.apiKey')
      .then((stored) => {
        const presented = presentedKey(req);
        if (typeof stored === 'string' && presented && keysEqual(presented, stored)) next();
        else anthropicError(res, 401, 'authentication_error', 'Invalid or missing proxy API key');
      })
      .catch(next);
  });

  /**
   * GET /models — backend configs presented as anthropic-style models.
   */
  router.get('/models', async (_req, res) => {
    const configs = await backendConfigRepo.list();
    const data = configs.map((c) => ({
      type: 'model',
      id: `${c.id}-${c.name}`,
      display_name: c.name,
      created_at: new Date(c.createdAt * 1000).toISOString(),
    }));
    res.json({ data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null });
  });

  /**
   * POST /messages — non-streaming message creation through the config's adapter.
   */
  router.post('/messages', async (req, res) => {
    const parsed = CreateMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      anthropicError(res, 400, 'invalid_request_error', parsed.error.issues.map((e) => e.message).join(', '));
      return;
    }
    const body = parsed.data;

    const configs = await backendConfigRepo.list();
    const config = configs.find((c) => body.model === c.id || body.model.startsWith(`${c.id}-`));
    if (!config) {
      anthropicError(res, 404, 'not_found_error', `Model "${body.model}" was not found`);
      return;
    }

    try {
      // Long generations must outlive the server's default 30s request timeout.
      req.socket.setTimeout(0);

      const settings = { ...(await settingsRepo.list()) };
      const backendSettings = buildBackendSettings(settings, config);
      const adapter = await createResolvedAdapter(backendSettings);
      if (!adapter) {
        anthropicError(
          res,
          400,
          'invalid_request_error',
          'Backend config could not produce an adapter (missing credentials?)',
        );
        return;
      }

      const abort = new AbortController();
      req.on('close', () => {
        abort.abort();
      });

      // Adapters read the response-length cap from tokenUsage.completion
      // (ClaudeBackendAdapter sends it as max_tokens). 0 = unset: the config
      // owns sampling, so with no config maxTokens adapters omit the wire cap
      // entirely rather than sending a fabricated value upstream.
      const prompt: Prompt = {
        messages: toPipelineMessages(body),
        tokenUsage: { prompt: 0, completion: config.maxTokens ?? 0 },
        ...(body.tools && body.tools.length > 0 ? { tools: toToolDefinitions(body.tools) } : {}),
      };
      const { items, result } = await consumeStream(adapter.stream(prompt, abort.signal));

      if (result.error) {
        log.error({ message: result.error, configId: config.id }, 'proxy generation error');
        anthropicError(res, 500, 'api_error', result.error);
        return;
      }

      const text = items
        .filter((i): i is Extract<typeof i, { type: 'text' }> => i.type === 'text')
        .map((i) => i.token)
        .join('');

      const toolCalls = result.toolCalls ?? [];
      res.json({
        id: `msg_${randomUUID()}`,
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [
          ...(text.length > 0 || toolCalls.length === 0 ? [{ type: 'text', text }] : []),
          ...toolCalls.map((tc) => ({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments })),
        ],
        stop_reason: toolCalls.length > 0 ? 'tool_use' : STOP_REASONS[result.finishReason],
        stop_sequence: null,
        usage: {
          input_tokens: result.usage.promptTokens,
          output_tokens: result.usage.completionTokens,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ message, configId: config.id }, 'proxy request error');
      anthropicError(res, 500, 'api_error', message);
    }
  });

  return router;
}
