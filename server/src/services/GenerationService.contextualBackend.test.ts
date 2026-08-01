/**
 * End-to-end integration test: a blackjack character card.
 *
 * The card ships a contextual backend (Type B, scriptable-layers.md §2) that
 * implements the whole game in Lua — it only accepts `bet:N`, `hit`, `stand`,
 * and NEVER calls the underlying backend.
 *
 * Game state lives in the branch-aware script-state protocol (the lua_memory
 * mechanism): the adapter restores the newest `extra._toolState[backend.id]`
 * snapshot as the Lua `state` global before generate() and persists it after.
 * The deck is REAL and HIDDEN (52 cards, shuffled once per hand) — nothing
 * about the game state appears in the visible chat text.
 *
 * Asserts: the game protocol works across turns, unknown input is rejected,
 * the snapshot is stored on the assistant message extra (and not in the text),
 * and the writer backend is never invoked.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestHarness } from '../testing/TestHarness.js';
import type { BackendAdapter, BackendStreamItem, GenerationResult } from '../backends/BackendAdapter.js';
import { getMessageText } from '@tamari/types';

// ---------------------------------------------------------------------------
// The card's Lua: a real-deck blackjack table. `state` is restored/persisted
// by the adapter; the shuffle is seeded per hand so regenerating the same
// turn deals the same cards.
// ---------------------------------------------------------------------------
const BLACKJACK_LUA = `
local RANKS = { "A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K" }
local SUITS = { "S", "H", "D", "C" }

local function ensureState()
  if type(state) ~= "table" then state = {} end
  state.deck = state.deck or {}
  state.player = state.player or {}
  state.dealer = state.dealer or {}
  state.bet = state.bet or 0
  state.phase = state.phase or "idle"
  state.handsPlayed = state.handsPlayed or 0
end

local function newDeck(seed)
  local deck = {}
  for _, r in ipairs(RANKS) do
    for _, s in ipairs(SUITS) do
      deck[#deck + 1] = r .. s
    end
  end
  math.randomseed(seed)
  for i = #deck, 2, -1 do
    local j = math.random(i)
    deck[i], deck[j] = deck[j], deck[i]
  end
  return deck
end

local function draw()
  return table.remove(state.deck)
end

local function rankOf(card) return card:sub(1, #card - 1) end

local function handValue(cards)
  local total, aces = 0, 0
  for _, c in ipairs(cards) do
    local r = rankOf(c)
    if r == "A" then
      aces = aces + 1
      total = total + 11
    elseif r == "K" or r == "Q" or r == "J" or r == "10" then
      total = total + 10
    else
      total = total + tonumber(r)
    end
  end
  while total > 21 and aces > 0 do
    total = total - 10
    aces = aces - 1
  end
  return total
end

local HELP = "This table doesn't chat — it plays blackjack. Commands: bet:N (start a hand), hit, stand."

local function render(note)
  local lines = {}
  lines[#lines + 1] = "**Blackjack** — Bet: " .. state.bet
  lines[#lines + 1] = "You: " .. table.concat(state.player, " ") .. " (" .. handValue(state.player) .. ")"
  local dealerShown = state.dealer
  if state.phase == "player" then dealerShown = { state.dealer[1], "??" } end
  lines[#lines + 1] = "Dealer: " .. table.concat(dealerShown, " ")
  if note then lines[#lines + 1] = note end
  return table.concat(lines, "\\n")
end

function generate(prompt, ctx)
  ensureState()

  local input = ""
  for i = #prompt.messages, 1, -1 do
    local m = prompt.messages[i]
    if m.role == "user" and type(m.content) == "string" then input = m.content break end
  end
  input = input:gsub("^%s+", ""):gsub("%s+$", ""):lower()

  -- bet:N — start a new hand with a freshly shuffled (hidden) deck
  local amount = input:match("^bet:(%d+)$")
  if amount then
    if state.phase == "player" then
      return render("Finish this hand first (hit or stand).")
    end
    state.bet = tonumber(amount)
    state.handsPlayed = state.handsPlayed + 1
    state.deck = newDeck(state.bet * 1000 + state.handsPlayed)
    state.player = { draw(), draw() }
    state.dealer = { draw() }
    if handValue(state.player) == 21 then
      state.phase = "done"
      return render("**Result: blackjack!** You win " .. math.floor(state.bet * 1.5) .. ".")
    end
    state.phase = "player"
    return render("hit or stand?")
  end

  if state.phase ~= "player" then
    if input == "hit" or input == "stand" or input == "fold" or input == "draw" then
      return "No active hand. Place a bet first: bet:N"
    end
    return HELP
  end

  -- hit (alias: draw)
  if input == "hit" or input == "draw" then
    state.player[#state.player + 1] = draw()
    local v = handValue(state.player)
    if v > 21 then
      state.phase = "done"
      return render("**Result: bust (" .. v .. ").** You lose " .. state.bet .. ".")
    end
    if v == 21 then
      input = "stand" -- auto-stand on 21
    else
      return render("hit or stand?")
    end
  end

  -- stand (alias: fold) — dealer plays out
  if input == "stand" or input == "fold" then
    while handValue(state.dealer) < 17 do
      state.dealer[#state.dealer + 1] = draw()
    end
    local pv, dv = handValue(state.player), handValue(state.dealer)
    state.phase = "done"
    if dv > 21 then return render("**Result: dealer busts (" .. dv .. ").** You win " .. state.bet .. ".") end
    if pv > dv then return render("**Result: you win (" .. pv .. " vs " .. dv .. ").** +" .. state.bet .. ".") end
    if pv < dv then return render("**Result: dealer wins (" .. dv .. " vs " .. pv .. ").** -" .. state.bet .. ".") end
    return render("**Result: push (" .. pv .. ").** Bet returned.")
  end

  return HELP
end
`;

interface GameState {
  deck: string[];
  player: string[];
  dealer: string[];
  bet: number;
  phase: string;
  handsPlayed: number;
}

function makeCountingWriter(): { writer: BackendAdapter; calls: () => number } {
  let calls = 0;
  const writer: BackendAdapter = {
    id: 'mock-writer',
    supportsStreaming: true,
    supportsTools: false,
    async *stream(): AsyncGenerator<BackendStreamItem, GenerationResult> {
      calls++;
      yield { type: 'text', token: 'THE WRITER MODEL WAS CALLED — THIS SHOULD NOT HAPPEN' };
      return { finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1 } };
    },
    listModels: async () => [],
  };
  return { writer, calls: () => calls };
}

describe('blackjack card (contextual backend e2e)', () => {
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

  const lastGameState = async (): Promise<GameState | null> => {
    const msg = await lastAssistant();
    const raw = msg?.extra._toolState?.[`character-backend:${characterId}`];
    return raw ? (JSON.parse(raw) as GameState) : null;
  };

  const play = async (command: string): Promise<string> => {
    await h.deps.generationService.handleSend(chatId, command);
    await h.deps.generationService.handleGenerate(chatId);
    return lastAssistantText();
  };

  beforeEach(async () => {
    const { writer, calls } = makeCountingWriter();
    writerCalls = calls;
    h = new TestHarness({ backendFactory: { create: async () => writer } });
    await h.initSchema();

    const character = await h.deps.characters.create('char-bj', {
      name: 'Blackjack Table',
      extensions: { contextualBackend: { enabled: true, luaSource: BLACKJACK_LUA } },
    });
    characterId = character.id;
    chatId = crypto.randomUUID();
    await h.deps.chats.createChat(chatId, {
      characterId,
      personaId: null,
      name: 'blackjack',
      headMessageId: null,
      metadata: {},
    });
  });

  afterEach(async () => {
    await h.teardown();
  });

  it('plays a full session with hidden state and never calls the writer backend', async () => {
    // 1. Chatting at the table gets you the rules, not a completion.
    const help = await play('so, how about that weather?');
    expect(help).toContain("doesn't chat");
    expect(help).toContain('bet:N');

    // 2. Can't hit without an active hand.
    expect(await play('hit')).toContain('No active hand');

    // 3. Place a bet: two cards for the player, one upcard for the dealer.
    const dealt = await play('bet:100');
    expect(dealt).toContain('**Blackjack** — Bet: 100');
    expect(dealt).toContain('You:');
    expect(dealt).toContain('Dealer:');
    expect(dealt).not.toContain('State:'); // no scaffolding leaks into the chat

    // State snapshot persisted on the message extra, with a REAL deck.
    const state = await lastGameState();
    expect(state).not.toBeNull();
    expect(state!.bet).toBe(100);
    expect(state!.dealer).toHaveLength(1);
    expect(state!.handsPlayed).toBe(1);

    if (state!.phase === 'player') {
      expect(state!.player).toHaveLength(2);
      expect(state!.deck).toHaveLength(49); // 52 minus 3 dealt — hidden from the user
      expect(dealt).toContain('??'); // hole card hidden while playing

      // 4. Hit: a third card comes off the hidden deck, or the hand busts.
      await play('hit');
      const afterHit = await lastGameState();
      if (afterHit!.phase === 'player') {
        expect(afterHit!.player).toHaveLength(3);
        expect(afterHit!.deck).toHaveLength(48);
        await play('stand');
      }
      const settled = await lastAssistantText();
      expect(settled).toMatch(/\*\*Result:/);
      expect((await lastGameState())!.phase).toBe('done');
    } else {
      expect(state!.phase).toBe('done');
      expect(dealt).toContain('blackjack');
    }

    // 5. A new hand can start after settlement — with a fresh 52-card deck.
    await play('bet:50');
    const second = await lastGameState();
    expect(second!.bet).toBe(50);
    expect(second!.handsPlayed).toBe(2);
    expect(second!.deck.length).toBeGreaterThanOrEqual(49);

    // The whole point: the game never touched the underlying backend.
    expect(writerCalls()).toBe(0);
  });

  it('rejects a second bet while a hand is active', async () => {
    await play('bet:100');
    if ((await lastGameState())!.phase === 'player') {
      const again = await play('bet:200');
      expect(again).toContain('Finish this hand first');
      expect((await lastGameState())!.bet).toBe(100); // state unchanged
    }
    expect(writerCalls()).toBe(0);
  });

  it('restores state from the snapshot, not from message text', async () => {
    await play('bet:100');
    const before = await lastGameState();
    await play('hit');
    const after = await lastGameState();
    if (before!.phase === 'player' && after!.phase === 'player') {
      // The hit card is the top of the snapshot's deck — the state carried over.
      const expectedCard = before!.deck[before!.deck.length - 1];
      expect(after!.player).toContain(expectedCard);
    }
    expect(writerCalls()).toBe(0);
  });

  it('does nothing when the card logic is disabled', async () => {
    const character = (await h.deps.characters.getByName('Blackjack Table'))!;
    await h.deps.characters.update(character.id, {
      extensions: { contextualBackend: { enabled: false, luaSource: 'return "off"' } },
    });
    await play('bet:100');
    expect(writerCalls()).toBe(1); // disabled → the plain writer answers
  });
});

// ---------------------------------------------------------------------------
// A card whose backend logic requests a tool: round 1 returns `toolCalls`,
// GenerationService's tool loop executes them, and round 2 re-enters
// generate() with the tool result visible as a tool_result content part on
// the latest assistant prompt message (same shape built-in adapters consume).
// ---------------------------------------------------------------------------
const TOOL_CARD_LUA = `
function generate(prompt, ctx)
  for i = #prompt.messages, 1, -1 do
    local m = prompt.messages[i]
    if type(m.content) == "table" then
      for _, p in ipairs(m.content) do
        if p.type == "tool_result" then
          return "The tool said: " .. tostring(p.content)
        end
      end
    end
  end
  return { toolCalls = { { name = "announce", arguments = { text = "hello world" } } } }
end
`;

describe('custom backend tool calls (e2e)', () => {
  it('executes script-requested tool calls and re-enters generate() with the result', async () => {
    const { writer, calls: writerCalls } = makeCountingWriter();
    const executed: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const toolRegistry = {
      setToolsetRepository: () => {},
      setTemplateRepository: () => {},
      execute: async (call: { id: string; name: string; arguments: Record<string, unknown> }) => {
        executed.push(call);
        return { id: call.id, name: call.name, content: `ANNOUNCED[${String(call.arguments['text'])}]` };
      },
    } as never;

    const h = new TestHarness({ backendFactory: { create: async () => writer }, toolRegistry });
    await h.initSchema();
    try {
      const character = await h.deps.characters.create('char-tools', {
        name: 'Herald',
        extensions: { contextualBackend: { enabled: true, luaSource: TOOL_CARD_LUA } },
      });
      const chatId = crypto.randomUUID();
      await h.deps.chats.createChat(chatId, {
        characterId: character.id,
        personaId: null,
        name: 'tools',
        headMessageId: null,
        metadata: {},
      });

      await h.deps.generationService.handleSend(chatId, 'say hi to everyone');
      await h.deps.generationService.handleGenerate(chatId);

      expect(executed.map(({ name, arguments: args }) => ({ name, arguments: args }))).toEqual([
        { name: 'announce', arguments: { text: 'hello world' } },
      ]);

      const chain = await h.deps.chats.getMessageChain(chatId);
      const assistant = [...chain].reverse().find((m) => m.role === 'assistant');
      expect(getMessageText(assistant?.extra.parts)).toBe('The tool said: ANNOUNCED[hello world]');

      // The tool_use/tool_result round trip is persisted on the message parts.
      const partTypes = (assistant?.extra.parts ?? []).map((p) => p.type);
      expect(partTypes).toContain('tool_use');
      expect(partTypes).toContain('tool_result');

      // The writer backend was never needed — the script composed the answer.
      expect(writerCalls()).toBe(0);
    } finally {
      await h.teardown();
    }
  });

  it('regenerate: the tool_result part reaches the follow-up prompt (regression: bulk-only branch dropped the new swipe)', async () => {
    const REGEN_TOOL_LUA = `
      function generate(prompt, ctx)
        for i = #prompt.messages, 1, -1 do
          local m = prompt.messages[i]
          if type(m.content) == "table" then
            for _, p in ipairs(m.content) do
              if p.type == "tool_result" then
                return "The tool said: " .. tostring(p.content)
              end
            end
          end
        end
        if ctx.generationType == "regenerate" then
          return { toolCalls = { { name = "announce", arguments = { text = "round trip" } } } }
        end
        return "plain answer"
      end
    `;
    const { writer } = makeCountingWriter();
    const executed: Array<{ name: string }> = [];
    const toolRegistry = {
      setToolsetRepository: () => {},
      setTemplateRepository: () => {},
      execute: async (call: { id: string; name: string; arguments: Record<string, unknown> }) => {
        executed.push(call);
        return { id: call.id, name: call.name, content: `ANNOUNCED[${String(call.arguments['text'])}]` };
      },
    } as never;

    const h = new TestHarness({ backendFactory: { create: async () => writer }, toolRegistry });
    await h.initSchema();
    try {
      const character = await h.deps.characters.create('char-regen-tools', {
        name: 'Regen Herald',
        extensions: { contextualBackend: { enabled: true, luaSource: REGEN_TOOL_LUA } },
      });
      const chatId = crypto.randomUUID();
      await h.deps.chats.createChat(chatId, {
        characterId: character.id,
        personaId: null,
        name: 'regen-tools',
        headMessageId: null,
        metadata: {},
      });

      await h.deps.generationService.handleSend(chatId, 'hello');
      await h.deps.generationService.handleGenerate(chatId);
      await h.deps.generationService.handleRegenerate(chatId);

      // The loop must run exactly ONE tool round: round 2 re-enters with the
      // tool_result part visible on the new swipe's prompt message.
      expect(executed).toHaveLength(1);

      const chain = await h.deps.chats.getMessageChain(chatId);
      const assistant = [...chain].reverse().find((m) => m.role === 'assistant');
      expect(getMessageText(assistant?.extra.parts)).toBe('The tool said: ANNOUNCED[round trip]');
    } finally {
      await h.teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// Group chats: the active backend runs per speaker (scriptable-layers.md §2,
// "Group chats") — a contextual backend wraps only ITS character's turns.
// Default NATURAL strategy: every member responds, in insertion order.
// ---------------------------------------------------------------------------
describe('group chat with one scripted character (e2e)', () => {
  it('runs the card script only for the character that carries it', async () => {
    const { writer, calls: writerCalls } = makeCountingWriter();
    const h = new TestHarness({ backendFactory: { create: async () => writer } });
    await h.initSchema();
    try {
      const scripted = await h.deps.characters.create('char-gm', {
        name: 'Game Master',
        extensions: {
          contextualBackend: {
            enabled: true,
            luaSource: `function generate(prompt, ctx)
              return "GM[" .. (ctx.characterId or "?") .. "] speaks only in riddles."
            end`,
          },
        },
      });
      const plain = await h.deps.characters.create('char-plain', { name: 'Plain Jane' });

      const chatId = crypto.randomUUID();
      await h.deps.chats.createChat(chatId, {
        characterId: null,
        personaId: null,
        name: 'group',
        headMessageId: null,
        metadata: {},
      });
      await h.deps.chatMembers.addMember(chatId, scripted.id);
      await h.deps.chatMembers.addMember(chatId, plain.id);

      await h.deps.generationService.handleSend(chatId, 'hello everyone');
      await h.deps.generationService.handleGenerate(chatId);

      const chain = await h.deps.chats.getMessageChain(chatId);
      const assistants = chain.filter((m) => m.role === 'assistant');
      expect(assistants).toHaveLength(2);

      // Insertion order: the scripted character answered from its own code…
      expect(getMessageText(assistants[0]!.extra.parts)).toBe(
        `GM[${scripted.id}] speaks only in riddles.`,
      );
      // …and the unscripted one fell through to the plain writer backend.
      expect(getMessageText(assistants[1]!.extra.parts)).toContain('THE WRITER MODEL WAS CALLED');
      expect(writerCalls()).toBe(1);
    } finally {
      await h.teardown();
    }
  });
});

describe('full branch history (chat global + full-branch script-state scan)', () => {
  /**
   * The marker script: increments a state counter and reports chat.count().
   * With promptHistoryLimit = 4, after one card turn + five plain user
   * messages, the _toolState snapshot sits BEYOND the bounded branch read —
   * only the full-branch scan restores it, and only the full-branch loader
   * gives chat.count() the real branch length.
   */
  const MARKER_LUA = `
    function generate(prompt, ctx)
      if type(state) ~= "table" then state = {} end
      state.marker = (state.marker or 0) + 1
      local n = chat and chat.count():await() or -1
      return "marker=" .. state.marker .. " count=" .. n
    end
  `;

  it('restores script state and counts history beyond promptHistoryLimit', async () => {
    const { writer } = makeCountingWriter();
    const h = new TestHarness({ backendFactory: { create: async () => writer } });
    await h.initSchema();
    try {
      await h.deps.settings.setValue('promptHistoryLimit', 4);
      const character = await h.deps.characters.create('char-marker', {
        name: 'Marker',
        extensions: { contextualBackend: { enabled: true, luaSource: MARKER_LUA } },
      });
      const chatId = crypto.randomUUID();
      await h.deps.chats.createChat(chatId, {
        characterId: character.id,
        personaId: null,
        name: 'marker',
        headMessageId: null,
        metadata: {},
      });

      const lastText = async (): Promise<string> => {
        const chain = await h.deps.chats.getMessageChain(chatId);
        const msg = [...chain].reverse().find((m) => m.role === 'assistant');
        return msg ? getMessageText(msg.extra.parts) : '';
      };

      await h.deps.generationService.handleSend(chatId, 'one');
      await h.deps.generationService.handleGenerate(chatId);
      expect(await lastText()).toContain('marker=1');

      // Five plain user messages push the snapshot-bearing assistant message
      // past the 4-message cap.
      for (let i = 0; i < 5; i++) await h.deps.generationService.handleSend(chatId, `ping ${i}`);
      await h.deps.generationService.handleGenerate(chatId);

      const text = await lastText();
      expect(text).toContain('marker=2'); // state restored from the FULL branch
      const count = Number(text.match(/count=(\d+)/)?.[1]);
      expect(count).toBeGreaterThan(4); // the chat global sees beyond the cap
    } finally {
      await h.teardown();
    }
  });
});
