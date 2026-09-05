/**
 * Lua transformer scripts — generation-level coverage of the
 * handle(messages, ctx) contract.
 *
 * The UI for both management modals lives in transformers-ui.spec.ts; this
 * spec drives scripts + chains over the WS bus (setup/cleanup only) and
 * asserts on the captured mock-LLM request:
 * - a handle() step rewrites the outgoing request (user turn gets a marker)
 * - an old-contract script (chunk without handle) is SKIPPED with a trace
 *   note — the request goes out untransformed and the generation still
 *   succeeds (a chain never aborts a generation)
 *
 * Verified against:
 * - server/src/transformers/luaRunner.ts (handle contract + failure notes)
 * - server/src/transformers/chainExecutor.ts (skip-on-failure)
 * - server/src/pipeline/PromptStages.ts (requestTransformers stage)
 *
 * The e2e server is shared per run: created chains/scripts are deleted and
 * the active config's transformerChainId is reset in afterEach.
 */

import { smokeTest as test, expect } from '../fixtures/smoke.js';
import type { Page } from '@playwright/test';
import { getLastLlmRequest, waitForNextLlmRequest } from '../helpers/llm.js';
import { patchActiveBackendConfig } from '../helpers/backendConfig.js';
import { wsRpc } from '../helpers/ws.js';
import { uniqueName } from '../helpers/names.js';

/** Last user-message string content in a captured mock-LLM request body. */
function lastUserContent(body: unknown): string {
  const messages = (body as { messages?: Array<{ role?: string; content?: unknown }> })?.messages ?? [];
  const lastUser = messages
    .slice()
    .reverse()
    .find((m) => m.role === 'user');
  const content = lastUser?.content;
  return typeof content === 'string' ? content : JSON.stringify(content ?? '');
}

/** handle() appends a marker to every string user message. */
const MARKING_SOURCE = `function handle(messages, ctx)
  for _, m in ipairs(messages) do
    if m.role == 'user' and type(m.content) == 'string' then
      m.content = m.content .. ' [lua]'
    end
  end
  return messages
end`;

// ── WS helpers (setup/cleanup only) ─────────────────────────────────────────

const createdChainIds: string[] = [];
const createdScriptIds: string[] = [];

async function createScript(page: Page, name: string, luaSource: string): Promise<string> {
  const created = await wsRpc<{ item: { id: string } }>(
    page,
    { type: 'transformerscript.save', data: { name, description: '', luaSource } },
    'transformerscript.created',
  );
  return created.item.id;
}

async function createChainWithLuaStep(page: Page, name: string, scriptId: string): Promise<string> {
  const created = await wsRpc<{ item: { id: string } }>(
    page,
    {
      type: 'transformerchain.save',
      data: { name, description: '', steps: [{ kind: 'lua', scriptId, enabled: true }] },
    },
    'transformerchain.created',
  );
  return created.item.id;
}

// ── spec ────────────────────────────────────────────────────────────────────

test.describe('Lua transformer scripts', () => {
  test.describe.configure({ mode: 'serial' });

  test.afterEach(async ({ page }) => {
    await patchActiveBackendConfig(page, { transformerChainId: null });
    for (const id of createdChainIds.splice(0)) {
      await wsRpc(page, { type: 'transformerchain.delete', id }, 'transformerchain.deleted');
    }
    for (const id of createdScriptIds.splice(0)) {
      await wsRpc(page, { type: 'transformerscript.delete', id }, 'transformerscript.deleted');
    }
  });

  test('a handle() lua step rewrites the outgoing request', async ({ page, app }) => {
    await app.createCharacterAndChat({ name: uniqueName('Lua Handle'), firstMes: 'Ready.' });

    const scriptId = await createScript(page, uniqueName('E2E Mark'), MARKING_SOURCE);
    createdScriptIds.push(scriptId);
    const chainId = await createChainWithLuaStep(page, uniqueName('E2E Chain'), scriptId);
    createdChainIds.push(chainId);
    await patchActiveBackendConfig(page, { transformerChainId: chainId });

    const before = (await getLastLlmRequest()).count;
    await app.sendUserMessage('respond:plain text', { expectReply: true });
    const captured = await waitForNextLlmRequest(before);
    expect(lastUserContent(captured.body)).toBe('respond:plain text [lua]');
  });

  test('a script without handle() is skipped — untransformed request, generation succeeds', async ({ page, app }) => {
    await app.createCharacterAndChat({ name: uniqueName('Lua Legacy'), firstMes: 'Ready.' });

    // The pre-handle contract: a bare chunk. It loads fine but defines no
    // handle(), so the step is skipped with a trace note.
    const scriptId = await createScript(page, uniqueName('E2E Legacy'), 'return messages');
    createdScriptIds.push(scriptId);
    const chainId = await createChainWithLuaStep(page, uniqueName('E2E Chain'), scriptId);
    createdChainIds.push(chainId);
    await patchActiveBackendConfig(page, { transformerChainId: chainId });

    const before = (await getLastLlmRequest()).count;
    await app.sendUserMessage('respond:still works', { expectReply: true });
    const captured = await waitForNextLlmRequest(before);
    expect(lastUserContent(captured.body)).toBe('respond:still works');
    // The chain failing a step never aborts the generation.
    expect(await app.lastAssistantText()).toBe('still works');
  });
});
