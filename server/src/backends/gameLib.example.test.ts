/**
 * Validates lib/summarize (the production half of compaction) through the
 * real adapter: a mini card opens a tagged block, serves mechanical turns,
 * then closes it with a model-written gist from the summarize sub-gen.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { LuaRuntime } from '../scripting/LuaRuntime.js';
import {
  LuaBackendAdapter,
  type CustomBackendDelegate,
  type DelegatedGenerateResult,
} from './LuaBackendAdapter.js';
import { consumeStream, type BackendStreamItem, type Prompt } from './BackendAdapter.js';

const LIB_FILES: Record<string, string> = Object.fromEntries(
  ['loop', 'collapse', 'transcript', 'sanitize', 'chrome', 'ledger', 'toolset', 'todo', 'registry', 'summarize', 'maptag'].map((m) => [
    `lib/${m}.lua`,
    readFileSync(new URL(`../../../docs/design/examples/game-lib/${m}.lua`, import.meta.url), 'utf8'),
  ]),
);

const USAGE = { promptTokens: 1, completionTokens: 1 };

// A sparring ring: "start" opens a [fight] block, anything else is a
// mechanical line, "end" closes the block with a delegate-written gist.
const CARD_LUA = `
local summarize = require("lib/summarize")

function generate(prompt, ctx)
  if type(state) ~= "table" then state = {} end
  local last = prompt.messages[#prompt.messages]
  local cmd = last.content
  if cmd == "start" then
    return summarize.open("fight") .. "\\nThe goblin blocks the way."
  end
  if cmd == "end" then
    local gist = summarize.summarize("fight", prompt)
    return "You wipe the blade. " .. (gist and summarize.close("fight", gist) or summarize.close("fight", "It is over."))
  end
  return "You trade blows. (-3 hp, a potion shattered)"
end

function list_models() return { { id = "spar", name = "Spar" } } end
`;

function makeAdapter(delegate: CustomBackendDelegate): LuaBackendAdapter {
  return new LuaBackendAdapter({
    id: 'custom:spar',
    name: 'Spar',
    luaSource: CARD_LUA,
    runtime: new LuaRuntime(),
    delegate,
    vfsFiles: LIB_FILES,
  });
}

async function runTurn(
  adapter: LuaBackendAdapter,
  userText: string,
  history: Array<{ role: string; content: string }>,
): Promise<string> {
  const prompt: Prompt = {
    messages: [
      { role: 'system', content: 'Base system prompt.' },
      ...history.map((h) => ({ role: h.role as 'user' | 'assistant', content: h.content })),
      { role: 'user', content: userText },
    ],
    tokenUsage: { prompt: 0, completion: 0 },
  };
  const { items, result } = await consumeStream(
    adapter.stream(prompt, new AbortController().signal, { chatId: 'spar-chat', generationType: 'normal' }),
  );
  expect(result.error).toBeUndefined();
  return items
    .filter((i): i is Extract<BackendStreamItem, { type: 'text' }> => i.type === 'text')
    .map((i) => i.token)
    .join('');
}

describe('lib/summarize', () => {
  it('closes the block with the delegate gist over the mechanical span — and only the span', async () => {
    const summarizePrompts: Prompt[] = [];
    const delegate: CustomBackendDelegate = {
      generate: vi.fn(async (_configId: string | null, prompt: Prompt): Promise<DelegatedGenerateResult> => {
        summarizePrompts.push(JSON.parse(JSON.stringify(prompt)) as Prompt);
        return { text: ' You "barely" made it,  every potion spent. ', finishReason: 'stop', usage: USAGE };
      }),
      resolveAdapter: vi.fn(async () => {
        throw new Error('passthrough not expected');
      }),
    };
    const adapter = makeAdapter(delegate);
    const history: Array<{ role: string; content: string }> = [
      { role: 'user', content: 'we head into the crypt' }, // BEFORE the open: not part of the span
      { role: 'assistant', content: '[fight]\nThe goblin blocks the way.' },
      { role: 'user', content: 'attack' },
      { role: 'assistant', content: 'You trade blows. (-3 hp, a potion shattered)' },
    ];
    const text = await runTurn(adapter, 'end', history);

    // The gist was requested over the span: the open-tag message (tag
    // stripped — the intro is part of the fight) plus everything after it.
    expect(summarizePrompts).toHaveLength(1);
    const spanText = JSON.stringify(summarizePrompts[0]!.messages);
    expect(spanText).toContain('The goblin blocks the way.');
    expect(spanText).toContain('trade blows');
    expect(spanText).toContain('potion shattered');
    expect(spanText).not.toContain('head into the crypt');
    expect(spanText).not.toContain('[fight]');

    // The close tag carries the gist — quotes flattened, whitespace tamed.
    expect(text).toContain('You wipe the blade. [/fight summary="You \'barely\' made it, every potion spent."]');
  });

  it('falls back when the open tag is not visible (no span to summarize)', async () => {
    const delegate: CustomBackendDelegate = {
      generate: vi.fn(async (): Promise<DelegatedGenerateResult> => {
        throw new Error('delegate not expected — no open tag, no sub-gen');
      }),
      resolveAdapter: vi.fn(async () => {
        throw new Error('passthrough not expected');
      }),
    };
    const text = await runTurn(makeAdapter(delegate), 'end', [{ role: 'assistant', content: 'Nothing pending.' }]);
    expect(text).toContain('[/fight summary="It is over."]');
  });
});
