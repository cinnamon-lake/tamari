/**
 * Card VFS end-to-end: a character whose contextual backend script requires a
 * module from `extensions.contextualBackend.files` — generation resolves the
 * require against the card's module map (docs/design/complex-card-scripting.md).
 * A card WITHOUT files keeps working unchanged (backwards compat).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestHarness } from '../testing/TestHarness.js';
import type { BackendAdapter, GenerationResult } from '../backends/BackendAdapter.js';
import { getMessageText } from '@tamari/types';

const WRITER: BackendAdapter = {
  id: 'writer',
  supportsStreaming: true,
  supportsTools: false,
  // Card scripts never delegate in these tests — an empty stream is all we need.
  // eslint-disable-next-line require-yield
  async *stream(): AsyncGenerator<never, GenerationResult> {
    return { finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1 } };
  },
  async listModels() {
    return [];
  },
};

const LUA_WITH_REQUIRE = `
local u = require('lib/utils')
function generate(prompt, ctx)
  return u.reply()
end
`;

const FILES = {
  'lib/utils.lua': `
local M = {}
function M.reply()
  return 'MODULE-PROVIDED-TEXT'
end
return M
`,
};

const LUA_NO_REQUIRE = `
function generate(prompt, ctx)
  return 'PLAIN-SCRIPT-TEXT'
end
`;

describe('card VFS require (contextual backend)', () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = new TestHarness({ backendFactory: { create: async () => WRITER } });
    await h.initSchema();
  });

  afterEach(async () => {
    await h.teardown();
  });

  async function play(chatId: string, command: string): Promise<string> {
    await h.deps.generationService.handleSend(chatId, command);
    await h.deps.generationService.handleGenerate(chatId);
    const chain = await h.deps.chats.getMessageChain(chatId);
    const msg = [...chain].reverse().find((m) => m.role === 'assistant');
    return msg ? getMessageText(msg.extra.parts) : '';
  }

  async function makeCharAndChat(luaSource: string, files?: Record<string, string>) {
    const character = await h.deps.characters.create('char-vfs', {
      name: 'VFS Card',
      extensions: { contextualBackend: { enabled: true, luaSource, ...(files ? { files } : {}) } },
    });
    const chatId = crypto.randomUUID();
    await h.deps.chats.createChat(chatId, {
      characterId: character.id,
      personaId: null,
      name: 'vfs',
      headMessageId: null,
      metadata: {},
    });
    return { characterId: character.id, chatId };
  }

  it('resolves require against the card files map during generation', async () => {
    const { chatId } = await makeCharAndChat(LUA_WITH_REQUIRE, FILES);
    expect(await play(chatId, 'hello')).toBe('MODULE-PROVIDED-TEXT');
  });

  it('a card without files works unchanged', async () => {
    const { chatId } = await makeCharAndChat(LUA_NO_REQUIRE);
    expect(await play(chatId, 'hello')).toBe('PLAIN-SCRIPT-TEXT');
  });

  it('an unknown module surfaces as a generation error, not a crash', async () => {
    const client = h.connectClient();
    const { chatId } = await makeCharAndChat(`function generate(p, c) return require('nope') end`, { 'lib/other.lua': 'return 1' });
    // require fires with an EMPTY files map — module not found → error result.
    await h.deps.generationService.handleSend(chatId, 'hello');
    await h.deps.generationService.handleGenerate(chatId);
    const err = client.messages.find((m) => m.type === 'generation.error');
    expect(err).toBeDefined();
    expect(err!.type === 'generation.error' && err!.error).toContain('module not found');
  });
});
