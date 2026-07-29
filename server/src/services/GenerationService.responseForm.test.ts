/**
 * End-to-end integration test: the Layer-3 form protocol
 * (docs/design/scriptable-layers.md §4 "Forms").
 *
 * The client side (serializer + submit wiring) is covered by unit tests in
 * client/src/lib/responseForm.test.ts and client/src/components/ChatView.test.tsx,
 * which pin the EXACT wire format posted as the user's message. This test is
 * the other half of the contract: the payload the client produces is fed
 * through GenerationService to a card whose contextual backend parses it with
 * the documented parse_fields Lua recipe — proving the "parseable in Lua"
 * invariant end-to-end, not just in principle.
 *
 * Asserts: the fenced-XML block is parsed (incl. entity unescaping of prose),
 * checkbox presence semantics, defaults for absent/empty fields, the honest
 * user message is persisted verbatim, the scripted card never calls the
 * writer — and the graceful-degradation path: with the script disabled the
 * plain writer receives the raw fenced block in its prompt.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestHarness } from '../testing/TestHarness.js';
import type {
  BackendAdapter,
  BackendStreamItem,
  GenerationResult,
  Prompt,
} from '../backends/BackendAdapter.js';
import { getMessageText } from '@tamari/types';

// ---------------------------------------------------------------------------
// The exact payload the client posts, byte-identical to the expectation in
// client/src/components/ChatView.test.tsx ("submitting a data-post-response
// form posts fenced XML then generates"). The two tests pin the same contract
// from both ends.
// ---------------------------------------------------------------------------
const CLIENT_PAYLOAD =
  '```xml\n' +
  '<action>\n' +
  '  <target>the goblin</target>\n' +
  '  <sneak>yes</sneak>\n' +
  '  <weapon>bow</weapon>\n' +
  '  <flourish>from &lt;the&gt; shadows</flourish>\n' +
  '</action>\n' +
  '```';

const SECOND_PAYLOAD =
  '```xml\n' +
  '<action>\n' +
  '  <target>the skeleton</target>\n' +
  '  <weapon>sword</weapon>\n' +
  '  <flourish></flourish>\n' +
  '</action>\n' +
  '```';

// ---------------------------------------------------------------------------
// The card's Lua: an arena that only understands action-form submissions.
// parse_fields is the documented recipe from scriptable-layers.md §4,
// verbatim — if the doc and reality drift, this test fails.
// ---------------------------------------------------------------------------
const ARENA_LUA = `
local function parse_fields(xml)
  local t = {}
  -- strip the single root wrapper first — otherwise gmatch's lazy body
  -- for <root> swallows every inner tag in its first match
  local inner = xml:match("^%s*<[%w._%-]+>%s*(.-)%s*</[%w._%-]+>%s*$") or xml
  for tag, body in inner:gmatch("<([%w._%-]+)>(.-)</%1>") do
    t[tag] = body:gsub("&lt;", "<"):gsub("&gt;", ">"):gsub("&quot;", '"')
                 :gsub("&apos;", "'"):gsub("&amp;", "&")
  end
  return t
end

local HELP = "The arena doesn't chat — it fights. Submit the action form."
local FENCE = string.char(96):rep(3) -- triple backtick, kept out of the source

function generate(prompt, ctx)
  if type(state) ~= "table" then state = {} end
  state.hits = state.hits or 0

  local input = ""
  for i = #prompt.messages, 1, -1 do
    local m = prompt.messages[i]
    if m.role == "user" and type(m.content) == "string" then input = m.content break end
  end

  local block = input:match(FENCE .. "xml\\n(.-)\\n" .. FENCE)
  if not block then return HELP end
  local root = block:match("^<([%w._%-]+)>")
  if root ~= "action" then return "The arena ignores a <" .. tostring(root) .. ">." end

  local f = parse_fields(block)
  if not f.target then return "You swing at nothing." end

  state.hits = state.hits + 1
  state.lastTarget = f.target
  state.lastWeapon = f.weapon or "fists"
  state.lastFlourish = f.flourish or ""
  state.lastSneak = f.sneak or ""

  local out = { "You strike " .. f.target .. " with your " .. state.lastWeapon .. "!" }
  if f.sneak then out[#out + 1] = "(sneak " .. f.sneak .. ")" end
  if f.flourish and f.flourish ~= "" then out[#out + 1] = f.flourish end
  out[#out + 1] = "Hits so far: " .. state.hits
  return table.concat(out, " ")
end
`;

interface ArenaState {
  hits: number;
  lastTarget: string;
  lastWeapon: string;
  lastFlourish: string;
  lastSneak: string;
}

function makeCapturingWriter(): {
  writer: BackendAdapter;
  calls: () => number;
  promptText: () => string;
} {
  let calls = 0;
  let lastPrompt = '';
  const writer: BackendAdapter = {
    id: 'mock-writer',
    supportsStreaming: true,
    supportsTools: false,
    async *stream(prompt: Prompt): AsyncGenerator<BackendStreamItem, GenerationResult> {
      calls++;
      lastPrompt = prompt.messages
        .map((m) =>
          typeof m.content === 'string'
            ? m.content
            : m.content
                .filter((p) => p.type === 'text')
                .map((p) => ('text' in p ? p.text : ''))
                .join('\n'),
        )
        .join('\n');
      yield { type: 'text', token: 'WRITER REPLY' };
      return { finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1 } };
    },
    listModels: async () => [],
  };
  return { writer, calls: () => calls, promptText: () => lastPrompt };
}

describe('response-form card (Layer-3 forms e2e)', () => {
  let h: TestHarness;
  let writerCalls: () => number;
  let chatId: string;
  let characterId: string;

  const lastAssistant = async () => {
    const chain = await h.deps.chats.getMessageChain(chatId);
    return [...chain].reverse().find((m) => m.role === 'assistant');
  };

  const lastAssistantText = async (): Promise<string> => {
    const msg = await lastAssistant();
    return msg ? getMessageText(msg.extra.parts) : '';
  };

  const lastArenaState = async (): Promise<ArenaState | null> => {
    const msg = await lastAssistant();
    const raw = msg?.extra._toolState?.[`character-backend:${characterId}`];
    return raw ? JSON.parse(raw) : null;
  };

  const play = async (command: string): Promise<string> => {
    await h.deps.generationService.handleSend(chatId, command);
    await h.deps.generationService.handleGenerate(chatId);
    return lastAssistantText();
  };

  beforeEach(async () => {
    const { writer, calls } = makeCapturingWriter();
    writerCalls = calls;
    h = new TestHarness({ backendFactory: { create: async () => writer } });
    await h.initSchema();

    const character = await h.deps.characters.create('char-arena', {
      name: 'Arena Master',
      extensions: { contextualBackend: { enabled: true, luaSource: ARENA_LUA } },
    });
    characterId = character.id;
    chatId = crypto.randomUUID();
    await h.deps.chats.createChat(chatId, {
      characterId,
      personaId: null,
      name: 'arena',
      headMessageId: null,
      metadata: {},
    });
  });

  afterEach(async () => {
    await h.teardown();
  });

  it('parses the client wire format with the documented Lua recipe', async () => {
    // 1. Plain chatter gets the rules, not a completion.
    expect(await play('nice arena you have here')).toContain('Submit the action form');

    // 2. Submit the exact payload the client serializer produces.
    const narration = await play(CLIENT_PAYLOAD);
    expect(narration).toContain('You strike the goblin with your bow!');
    expect(narration).toContain('(sneak yes)');
    // The escaped prose round-tripped through XML unescaping in Lua.
    expect(narration).toContain('from <the> shadows');
    expect(narration).toContain('Hits so far: 1');

    // 3. Parsed fields landed in the branch-aware state snapshot.
    const state = await lastArenaState();
    expect(state).not.toBeNull();
    expect(state!.hits).toBe(1);
    expect(state!.lastTarget).toBe('the goblin');
    expect(state!.lastWeapon).toBe('bow');
    expect(state!.lastFlourish).toBe('from <the> shadows');
    expect(state!.lastSneak).toBe('yes');

    // 4. The honest user message is persisted verbatim — fence, escapes and all.
    const chain = await h.deps.chats.getMessageChain(chatId);
    const userMsg = [...chain].reverse().find((m) => m.role === 'user');
    expect(getMessageText(userMsg?.extra.parts)).toBe(CLIENT_PAYLOAD);

    // 5. The whole exchange never touched the writer backend.
    expect(writerCalls()).toBe(0);
  });

  it('applies checkbox-presence and empty-field semantics', async () => {
    await play(CLIENT_PAYLOAD);
    const narration = await play(SECOND_PAYLOAD);

    // No <sneak> element → not a sneak attack; empty <flourish> → omitted.
    expect(narration).toContain('You strike the skeleton with your sword!');
    expect(narration).not.toContain('sneak');
    expect(narration).toContain('Hits so far: 2');

    const state = await lastArenaState();
    expect(state!.hits).toBe(2); // state carried across turns via the snapshot
    expect(state!.lastSneak).toBe('');
    expect(state!.lastFlourish).toBe('');
    expect(writerCalls()).toBe(0);
  });

  it('rejects blocks the card does not recognize, without calling the writer', async () => {
    const ignored = await play('```xml\n<shopping>\n  <item>rope</item>\n</shopping>\n```');
    expect(ignored).toContain('The arena ignores a <shopping>');
    expect((await lastArenaState())!.hits).toBe(0);
    expect(writerCalls()).toBe(0);
  });

  it('degrades gracefully on a plain backend: the model sees the honest block', async () => {
    const { writer, calls, promptText } = makeCapturingWriter();
    const plain = new TestHarness({ backendFactory: { create: async () => writer } });
    await plain.initSchema();
    try {
      const character = await plain.deps.characters.create('char-plain-arena', {
        name: 'Just A Barbarian', // no contextualBackend — a plain card
      });
      const plainChatId = crypto.randomUUID();
      await plain.deps.chats.createChat(plainChatId, {
        characterId: character.id,
        personaId: null,
        name: 'plain-arena',
        headMessageId: null,
        metadata: {},
      });

      await plain.deps.generationService.handleSend(plainChatId, CLIENT_PAYLOAD);
      await plain.deps.generationService.handleGenerate(plainChatId);

      // The plain writer ran, and the raw fenced block is right there in its
      // prompt — ugly but honest, and models parse simple XML fine.
      expect(calls()).toBe(1);
      const seen = promptText();
      expect(seen).toContain('```xml');
      expect(seen).toContain('<action>');
      expect(seen).toContain('<target>the goblin</target>');
      expect(seen).toContain('from &lt;the&gt; shadows</flourish>');
    } finally {
      await plain.teardown();
    }
  });
});
