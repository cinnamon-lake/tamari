import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { configureMockBackend, patchActiveBackendConfig, resetBackendConfig } from '../helpers/backendConfig.js';
import { enableBuiltinToolset, deleteToolset } from '../helpers/tools.js';
import { getLastLlmRequest, resetLlmRequests } from '../helpers/llm.js';
import { setSetting } from '../helpers/settings.js';
import { App } from '../helpers/app.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

// Minimal 1x1 transparent PNG in base64 (same as attachments.spec.ts).
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

interface WireMessage {
  role?: string;
  content?: unknown;
  tool_calls?: Array<{
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
  tool_call_id?: string;
}

function wireMessages(body: unknown): WireMessage[] {
  const b = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  return Array.isArray(b.messages) ? (b.messages as WireMessage[]) : [];
}

test.describe('Generation Tools — history serialization', () => {
  let toolsetId: string | undefined;

  test.beforeEach(async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
    await resetLlmRequests();
  });

  test.afterEach(async ({ page }) => {
    // These persist on the shared e2e server — restore defaults unconditionally.
    await setSetting(page, 'reasoningAddToPrompts', false);
    await setSetting(page, 'mediaVerboseMode', false);
    await resetBackendConfig(page);
    await patchActiveBackendConfig(page, { supportsImages: true });
    if (toolsetId) {
      await deleteToolset(page, toolsetId);
      toolsetId = undefined;
    }
  });

  test('serializes tool calls and tool results into the follow-up request', async ({ page }) => {
    const app = new App(page);
    // ChatCompletionRenderer strips tool_use/tool_result parts from OLD
    // assistant messages unless reasoningAddToPrompts is on (default: off) —
    // enable it so the follow-up request carries the full tool history.
    await setSetting(page, 'reasoningAddToPrompts', true);
    toolsetId = await enableBuiltinToolset(page, 'lua_dice');
    await app.createCharacterAndChat({ name: uniqueName('ToolHistory Char'), firstMes: 'Ready.' });

    await app.sendUserMessage('tool:roll_dice{"sides":6}', { expectReply: true });

    const bubble = app.lastBubble('assistant');
    // roll_dice has renderType 'dice': its tool_use block is suppressed and the
    // result renders as the dice widget ("Dice Roll 1 (1d6)"), not the raw
    // "Rolled 1d6: ..." text — that string only exists on the wire, asserted below.
    const resultBlock = bubble.locator('.tool-result-block.dice-result').first();
    await expect(resultBlock).toBeVisible({ timeout: 10000 });
    await expect(resultBlock).toContainText('1d6');

    await app.sendUserMessage('respond: after tool', { expectReply: true });
    await expect(app.lastBubble('assistant').locator('.message-content')).toContainText('after tool');

    // The follow-up request must carry the prior tool exchange: an assistant
    // message with a tool_calls array and a role:'tool' message keyed by id.
    const cap = await getLastLlmRequest();
    const messages = wireMessages(cap.body);

    const withToolCalls = messages.filter((m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0);
    expect(withToolCalls.length).toBeGreaterThan(0);
    const call = withToolCalls[0]!.tool_calls![0]!;
    expect(call.type).toBe('function');
    expect(call.function?.name).toBe('roll_dice');
    expect(JSON.parse(call.function?.arguments ?? '{}')).toEqual({ sides: 6 });

    const toolMessages = messages.filter((m) => m.role === 'tool');
    expect(toolMessages.length).toBeGreaterThan(0);
    expect(toolMessages[0]!.tool_call_id).toBe(call.id);
    expect(String(toolMessages[0]!.content ?? '')).toContain('Rolled 1d6');
  });

  test('image attachment degrades to a text placeholder when the backend lacks image support', async ({ page }) => {
    const app = new App(page);
    // supportsImages off + mediaVerboseMode on -> ChatCompletionRenderer emits
    // the '[Attached image]' text placeholder instead of an image part.
    await setSetting(page, 'mediaVerboseMode', true);
    await patchActiveBackendConfig(page, { supportsImages: false });
    await app.createCharacterAndChat({ name: uniqueName('ImgHistory Char'), firstMes: 'Ready.' });

    const fileInput = page.locator('.message-input-area .hidden-file-input');
    await fileInput.setInputFiles({
      name: 'test-image.png',
      mimeType: 'image/png',
      buffer: Buffer.from(PNG_BASE64, 'base64'),
    });
    await expect(page.locator('.attachment-previews .attachment-preview')).toBeVisible({ timeout: 5000 });

    // The user message serializes as a content-part ARRAY (text + placeholder),
    // and the mock's `respond:` selector only reads string content — so this
    // turn gets the mock's default reply. The wire assertions below are the point.
    await app.sendUserMessage('image noted', { expectReply: true });
    await expect(app.lastBubble('assistant').locator('.message-content')).toContainText('deterministic mock response');

    const cap = await getLastLlmRequest();
    const messages = wireMessages(cap.body);
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    expect(lastUser).toBeDefined();
    expect(JSON.stringify(lastUser!.content)).toContain('[Attached image]');
    expect(JSON.stringify(lastUser!.content)).toContain('image noted');
  });
});
