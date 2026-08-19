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
  ['loop', 'sanitize', 'chrome', 'ledger', 'toolset', 'todo', 'registry', 'summarize', 'maptag', 'rolling'].map((m) => [
    `lib/${m}.lua`,
    readFileSync(new URL(`../../../docs/design/examples/game-lib/${m}.lua`, import.meta.url), 'utf8'),
  ]),
);

const USAGE = { promptTokens: 1, completionTokens: 1 };

// A sparring ring: "start" begins a tracked fight (state.log), anything else
// is a mechanical line, "end" gists the log and serves it as a plain line.
const CARD_LUA = `
local summarize = require("lib/summarize")

function generate(prompt, ctx)
  if type(state) ~= "table" then state = {} end
  local last = prompt.messages[#prompt.messages]
  local cmd = last.content
  if cmd == "start" then
    state.log = { { role = "assistant", content = "The goblin blocks the way." } }
    return "The goblin blocks the way."
  end
  if cmd == "end" then
    local gist = summarize.gist(prompt, { span = state.log })
    state.log = nil
    return "You wipe the blade. " .. (gist or "It is over.")
  end
  if state.log then
    state.log[#state.log + 1] = { role = "user", content = cmd }
    local blow = "You trade blows. (-3 hp, a potion shattered)"
    state.log[#state.log + 1] = { role = "assistant", content = blow }
    return blow
  end
  return "You trade blows. (-3 hp, a potion shattered)"
end

function list_models() return { { id = "spar", name = "Spar" } } end
`;

// A registry/toolset probe card: drives the lib's validation directly, no
// delegate involved.
const PROBE_LUA = `
local registry = require("lib/registry")
local toolset = require("lib/toolset")

local enemies = registry.new({
  tool = "register_enemy",
  key = "enemies",
  id_from = "name",
  fields = {
    { name = "name", type = "string", required = true },
    { name = "tags", type = "array", required = true, closed = { "flying", "undead" } },
  },
})

function generate(prompt, ctx)
  if type(state) ~= "table" then state = {} end
  local cmd = prompt.messages[#prompt.messages].content
  if cmd == "missing" then
    return enemies.exec("register_enemy", { name = "Imp" })
  end
  if cmd == "nontable" then
    return enemies.exec("register_enemy", { name = "Imp", tags = "flying" })
  end
  if cmd == "ok" then
    return enemies.exec("register_enemy", { name = "Imp", tags = { "flying", "bogus" } })
  end
  if cmd == "long" then
    return enemies.exec("register_enemy", {
      name = "The Glass Knight of the Ninth Floor, Reflective Terror of the Lower Halls",
      tags = { "flying" },
    })
  end
  if cmd == "dupe" then
    local ts = toolset.new()
    ts:use(enemies)
    local ok, err = pcall(function() ts:handle("register_enemy", function() return "x" end) end)
    return tostring(ok) .. ": " .. tostring(err)
  end
  return "?"
end

function list_models() return { { id = "spar", name = "Spar" } } end
`;

const noDelegate = (): CustomBackendDelegate => ({
  generate: vi.fn(async (): Promise<DelegatedGenerateResult> => {
    throw new Error('delegate not expected');
  }),
  resolveAdapter: vi.fn(async () => {
    throw new Error('passthrough not expected');
  }),
});

function makeAdapter(delegate: CustomBackendDelegate, luaSource: string = CARD_LUA): LuaBackendAdapter {
  return new LuaBackendAdapter({
    id: 'custom:spar',
    name: 'Spar',
    luaSource,
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
    adapter.stream(prompt, new AbortController().signal, { chatId: 'spar-chat', generationType: 'send' }),
  );
  expect(result.error).toBeUndefined();
  return items
    .filter((i): i is Extract<BackendStreamItem, { type: 'text' }> => i.type === 'text')
    .map((i) => i.token)
    .join('');
}

describe('lib/summarize', () => {
  it('serves the delegate gist over the mechanical span as a plain line — and only the span', async () => {
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
    let t = await roll(adapter, undefined, 'start');
    t = await roll(adapter, t.scriptState, 'attack');
    const text = (await roll(adapter, t.scriptState, 'end')).text;

    // The gist was requested over exactly the tracked log.
    expect(summarizePrompts).toHaveLength(1);
    const spanText = JSON.stringify(summarizePrompts[0]!.messages);
    expect(spanText).toContain('The goblin blocks the way.');
    expect(spanText).toContain('trade blows');
    expect(spanText).toContain('potion shattered');

    // The memoir is a PLAIN line — no tag, nothing to regex away. The lib
    // enforces the one-line/no-double-quotes discipline: quotes fold to
    // singles, whitespace collapses.
    expect(text).toBe("You wipe the blade. You 'barely' made it, every potion spent.");
  });

  it('falls back when there is no tracked span (and never calls the delegate)', async () => {
    const delegate: CustomBackendDelegate = {
      generate: vi.fn(async (): Promise<DelegatedGenerateResult> => {
        throw new Error('delegate not expected — no span, no sub-gen');
      }),
      resolveAdapter: vi.fn(async () => {
        throw new Error('passthrough not expected');
      }),
    };
    const text = await runTurn(makeAdapter(delegate), 'end', [{ role: 'assistant', content: 'Nothing pending.' }]);
    expect(text).toBe('You wipe the blade. It is over.');
  });
});

describe('lib/registry required array fields', () => {
  it('rejects a missing required array instead of silently filing {}', async () => {
    const text = await runTurn(makeAdapter(noDelegate(), PROBE_LUA), 'missing', []);
    expect(text).toBe('rejected: tags required');
  });

  it('rejects a required array passed as a non-table', async () => {
    const text = await runTurn(makeAdapter(noDelegate(), PROBE_LUA), 'nontable', []);
    expect(text).toBe('rejected: tags required');
  });

  it('files a valid record and echoes dropped closed-list entries', async () => {
    const text = await runTurn(makeAdapter(noDelegate(), PROBE_LUA), 'ok', []);
    expect(text).toContain('"registered":"imp"');
    expect(text).toContain('"dropped":["bogus"]');
    expect(text).toContain('"tags":["flying"]');
  });

  it('files long text verbatim — string fields are never truncated', async () => {
    const name = 'The Glass Knight of the Ninth Floor, Reflective Terror of the Lower Halls';
    const text = await runTurn(makeAdapter(noDelegate(), PROBE_LUA), 'long', []);
    expect(text).toContain(`"name":"${name}"`);
    expect(text).toContain('"registered":"the-glass-knight-of-the-ninth-floor-reflective-terror-of-the-lower-halls"');
  });
});

describe('lib/toolset duplicate tools', () => {
  it('errors at composition time instead of shadowing silently', async () => {
    const text = await runTurn(makeAdapter(noDelegate(), PROBE_LUA), 'dupe', []);
    expect(text).toContain('false');
    expect(text).toContain("duplicate tool 'register_enemy'");
  });
});

describe('lib/summarize error handling', () => {
  it('propagates a delegate error instead of phoning in a fallback gist', async () => {
    const delegate: CustomBackendDelegate = {
      generate: vi.fn(async (): Promise<DelegatedGenerateResult> => {
        throw new Error('connection refused');
      }),
      resolveAdapter: vi.fn(async () => {
        throw new Error('passthrough not expected');
      }),
    };
    const adapter = makeAdapter(delegate);
    const started = await roll(adapter, undefined, 'start');
    const { result } = await roll(adapter, started.scriptState, 'end');
    // The turn fails with the REAL error — no canned fallback gist, and no
    // state snapshot (scriptState absent), so a swipe retries from a clean world.
    expect(result.finishReason).toBe('error');
    expect(result.error).toContain('connection refused');
    expect(result.scriptState).toBeUndefined();
  });
});

// A loop probe: the delegate never stops calling tools.
const LOOP_LUA = `
local loop = require("lib/loop")

function generate(prompt, ctx)
  local sub = {}
  for k, v in pairs(prompt) do sub[k] = v end
  sub.tools = nil
  sub.messages = { { role = "user", content = "go" } }
  local res = backends.generate(sub):await()
  res = loop.run(sub, res, function(name, args) return "ok" end, 2)
  return res.text or "done"
end

function list_models() return { { id = "spar", name = "Spar" } } end
`;

describe('lib/loop round cap', () => {
  it('throws when the cap is hit with tool calls still pending', async () => {
    const wedged: CustomBackendDelegate = {
      generate: vi.fn(async (): Promise<DelegatedGenerateResult> => ({
        text: '',
        finishReason: 'stop',
        usage: USAGE,
        toolCalls: [{ id: 'w1', name: 'ping', arguments: {} }],
      })),
      resolveAdapter: vi.fn(async () => {
        throw new Error('passthrough not expected');
      }),
    };
    const adapter = makeAdapter(wedged, LOOP_LUA);
    const prompt: Prompt = {
      messages: [
        { role: 'system', content: 'Base system prompt.' },
        { role: 'user', content: 'go' },
      ],
      tokenUsage: { prompt: 0, completion: 0 },
    };
    const { result } = await consumeStream(
      adapter.stream(prompt, new AbortController().signal, { chatId: 'spar-chat', generationType: 'send' }),
    );
    expect(result.finishReason).toBe('error');
    expect(result.error).toContain('tool loop exceeded 2 rounds');
    expect(result.error).toContain('ping'); // names the pending tools
    expect(result.scriptState).toBeUndefined();
  });
});

describe('lib/loop thinking round-trip', () => {
  it("sends the delegate's thinking (with signature) and narration back in the next round's assistant message", async () => {
    const prompts: Prompt[] = [];
    let round = 0;
    const thinking: CustomBackendDelegate = {
      generate: vi.fn(async (_cfg: string | null, prompt: Prompt): Promise<DelegatedGenerateResult> => {
        prompts.push(JSON.parse(JSON.stringify(prompt)) as Prompt);
        round += 1;
        if (round === 1) {
          return {
            text: 'Let me check the roster.',
            reasoning: 'the roster first, then cast',
            reasoningSignature: 'sig-1',
            finishReason: 'stop',
            usage: USAGE,
            toolCalls: [{ id: 't1', name: 'ping', arguments: { x: 1 } }],
          };
        }
        return { text: 'All set.', finishReason: 'stop', usage: USAGE };
      }),
      resolveAdapter: vi.fn(async () => {
        throw new Error('passthrough not expected');
      }),
    };
    const adapter = makeAdapter(thinking, LOOP_LUA);
    const text = await runTurn(adapter, 'go', []);
    expect(text).toBe('All set.');
    expect(prompts).toHaveLength(2);
    // The second round's request ends with the assistant message the delegate
    // actually produced: thinking → narration → tool_use → tool_result.
    const last = prompts[1]!.messages.at(-1)!;
    expect(last.role).toBe('assistant');
    expect(Array.isArray(last.content)).toBe(true);
    const parts = last.content as unknown as Array<Record<string, unknown>>;
    expect(parts[0]).toEqual({ type: 'reasoning', text: 'the roster first, then cast', signature: 'sig-1' });
    expect(parts[1]).toEqual({ type: 'text', text: 'Let me check the roster.' });
    expect(parts[2]).toEqual({ type: 'tool_use', id: 't1', name: 'ping', input: { x: 1 } });
    expect(parts[3]!['type']).toBe('tool_result');
    expect(parts[3]!['toolUseId']).toBe('t1');
  });

  it('omits the reasoning part when the delegate reports no thinking, and the signature key when there is none', async () => {
    const prompts: Prompt[] = [];
    let round = 0;
    const plain: CustomBackendDelegate = {
      generate: vi.fn(async (_cfg: string | null, prompt: Prompt): Promise<DelegatedGenerateResult> => {
        prompts.push(JSON.parse(JSON.stringify(prompt)) as Prompt);
        round += 1;
        if (round === 1) {
          return {
            text: '',
            reasoning: 'unsigned thought',
            finishReason: 'stop',
            usage: USAGE,
            toolCalls: [{ id: 't1', name: 'ping', arguments: {} }],
          };
        }
        return { text: 'done', finishReason: 'stop', usage: USAGE };
      }),
      resolveAdapter: vi.fn(async () => {
        throw new Error('passthrough not expected');
      }),
    };
    const text = await runTurn(makeAdapter(plain, LOOP_LUA), 'go', []);
    expect(text).toBe('done');
    const parts = prompts[1]!.messages.at(-1)!.content as unknown as Array<Record<string, unknown>>;
    // Unsigned thinking still rides (adapters inline it as text); no empty
    // text part is injected when the delegate said nothing.
    expect(parts[0]).toEqual({ type: 'reasoning', text: 'unsigned thought' });
    expect(parts[1]!['type']).toBe('tool_use');
    expect(parts.some((p) => p['type'] === 'text')).toBe(false);
  });
});

// A rolling-summary probe card: push/briefing/inspect over state.story.
const ROLLING_LUA = `
local rolling = require("lib/rolling")

function generate(prompt, ctx)
  if type(state) ~= "table" then state = {} end
  state.story = state.story or rolling.channel()
  rolling.bind(prompt)
  local cmd = prompt.messages[#prompt.messages].content
  local label, gist = cmd:match("^push:([^|]+)|(.+)$")
  if label then
    return rolling.push(state.story, { label = label, gist = gist,
      content = { { role = "user", content = "turn of " .. label }, "plain log line" } })
  end
  if cmd == "push-gist-only" then
    return rolling.push(state.story, { label = "quiet walk", gist = "Nothing happened." })
  end
  if cmd == "plant-missing" then
    state.story.ids[#state.story.ids + 1] = "roll#99" -- an id with no blob (a bug)
    return "planted"
  end
  if cmd == "push-blocks" then
    return rolling.push(state.story, { label = "scene", gist = "Talked to the knight.", content = {
      { role = "user", content = "I need a knight." },
      { role = "assistant", content = {
        { type = "tool_use", id = "t1", name = "get_character", input = { id = "ser-aldric" } },
        { type = "tool_result", toolUseId = "t1", name = "get_character", content = "the knight's file" },
      } },
      { role = "assistant", content = "State your business." },
    } })
  end
  if cmd == "briefing" then return rolling.briefing(state.story) end
  local id = cmd:match("^inspect:(.+)$")
  if id then return rolling.inspect(id) or "nil" end
  return "?"
end

function list_models() return { { id = "spar", name = "Spar" } } end
`;

async function roll(
  adapter: LuaBackendAdapter,
  scriptState: string | undefined,
  cmd: string,
): Promise<{ text: string; scriptState?: string; result: { finishReason: string; error?: string; scriptState?: string } }> {
  const prompt: Prompt = {
    messages: [
      { role: 'system', content: 'Base system prompt.' },
      { role: 'user', content: cmd },
    ],
    tokenUsage: { prompt: 0, completion: 0 },
  };
  const { items, result } = await consumeStream(
    adapter.stream(prompt, new AbortController().signal, { chatId: 'spar-chat', generationType: 'send', scriptState }),
  );
  const text = items
    .filter((i): i is Extract<BackendStreamItem, { type: 'text' }> => i.type === 'text')
    .map((i) => i.token)
    .join('');
  return { text, scriptState: result.scriptState, result };
}

const digestDelegate = (digest = 'A folded digest of the early episodes.'): CustomBackendDelegate => ({
  generate: vi.fn(async (_cfg: string | null, prompt: Prompt): Promise<DelegatedGenerateResult> => {
    if (sysOf(prompt).includes('Compress these episode summaries')) {
      return { text: digest, finishReason: 'stop', usage: USAGE };
    }
    return { text: 'ok', finishReason: 'stop', usage: USAGE };
  }),
  resolveAdapter: vi.fn(async () => {
    throw new Error('passthrough not expected');
  }),
});

function sysOf(p: Prompt): string {
  return typeof p.messages[0]?.content === 'string' ? (p.messages[0].content as string) : '';
}

describe('lib/rolling', () => {
  it('push files entries; briefing serves id-bearing lines ("" when empty)', async () => {
    const adapter = makeAdapter(noDelegate(), ROLLING_LUA);
    let t = await roll(adapter, undefined, 'briefing');
    expect(t.text).toBe('');
    t = await roll(adapter, t.scriptState, 'push:first delve|Cleared the upper halls.');
    expect(t.text).toBe('roll#1');
    t = await roll(adapter, t.scriptState, 'push:bar fight|Threw down with the dealer.');
    t = await roll(adapter, t.scriptState, 'briefing');
    expect(t.text).toContain('STORY SO FAR');
    expect(t.text).toContain('[roll#1: first delve] Cleared the upper halls.');
    expect(t.text).toContain('[roll#2: bar fight] Threw down with the dealer.');
  });

  it('folds the oldest entries at the threshold, and inspect zooms digest → descriptors → raw log', async () => {
    const adapter = makeAdapter(digestDelegate(), ROLLING_LUA);
    let t = await roll(adapter, undefined, 'x');
    for (const w of ['one', 'two', 'three', 'four', 'five', 'six', 'seven']) {
      t = await roll(adapter, t.scriptState, `push:episode ${w}|gist ${w}`);
    }
    t = await roll(adapter, t.scriptState, 'briefing');
    expect(t.text).toContain('[roll#8: 4 episodes] A folded digest of the early episodes.');
    expect(t.text).toContain('[roll#7: episode seven] gist seven');
    expect(t.text).not.toContain('gist one]'); // folded away from the briefing
    // Zoom level 1: the fold entry's content is the descriptor list.
    t = await roll(adapter, t.scriptState, 'inspect:roll#8');
    expect(t.text).toContain('- [roll#1: episode one] gist one');
    expect(t.text).toContain('- [roll#4: episode four] gist four');
    expect(t.text).not.toContain('roll#7'); // recent entries were never folded
    // Zoom level 2: a folded-away id still resolves — the store is the archive.
    t = await roll(adapter, t.scriptState, 'inspect:roll#1');
    expect(t.text).toContain('user: turn of episode one');
    expect(t.text).toContain('plain log line');
  });

  it('a failing fold fails the turn loudly; the retry folds fine', async () => {
    let failFold = true;
    const dm: CustomBackendDelegate = {
      generate: vi.fn(async (_cfg: string | null, prompt: Prompt): Promise<DelegatedGenerateResult> => {
        if (sysOf(prompt).includes('Compress these episode summaries')) {
          if (failFold) throw new Error('backend down');
          return { text: 'A folded digest of the early episodes.', finishReason: 'stop', usage: USAGE };
        }
        return { text: 'ok', finishReason: 'stop', usage: USAGE };
      }),
      resolveAdapter: vi.fn(async () => {
        throw new Error('passthrough not expected');
      }),
    };
    const adapter = makeAdapter(dm, ROLLING_LUA); // one adapter: the store survives the failed turn
    let t = await roll(adapter, undefined, 'x');
    for (const w of ['one', 'two', 'three', 'four', 'five', 'six', 'seven']) {
      t = await roll(adapter, t.scriptState, `push:episode ${w}|gist ${w}`);
    }
    const failed = await roll(adapter, t.scriptState, 'briefing');
    expect(failed.result.finishReason).toBe('error');
    expect(failed.result.error).toContain('backend down');
    expect(failed.result.scriptState).toBeUndefined();
    failFold = false;
    const retry = await roll(adapter, t.scriptState, 'briefing'); // the swipe: same pre-state, healthy delegate
    expect(retry.text).toContain('A folded digest of the early episodes.');
  });

  it('inspect renders content blocks: tool_use and tool_result lines', async () => {
    const adapter = makeAdapter(noDelegate(), ROLLING_LUA);
    let t = await roll(adapter, undefined, 'push-blocks');
    t = await roll(adapter, t.scriptState, 'inspect:roll#1');
    expect(t.text).toContain('user: I need a knight.');
    expect(t.text).toContain('→ get_character({"id":"ser-aldric"})');
    expect(t.text).toContain('← the knight\'s file');
    expect(t.text).toContain('assistant: State your business.');
  });

  it('inspect handles gist-only entries and unknown ids; a missing blob is loud', async () => {
    const adapter = makeAdapter(noDelegate(), ROLLING_LUA);
    let t = await roll(adapter, undefined, 'push-gist-only');
    t = await roll(adapter, t.scriptState, 'inspect:roll#1');
    expect(t.text).toContain('no recorded content');
    t = await roll(adapter, t.scriptState, 'inspect:roll#42');
    expect(t.text).toBe('nil');
    t = await roll(adapter, t.scriptState, 'plant-missing');
    const failed = await roll(adapter, t.scriptState, 'briefing');
    expect(failed.result.finishReason).toBe('error');
    expect(failed.result.error).toContain('summary blob missing');
  });
});

// A kv-channel probe: the non-compacting half of lib/rolling.
const KV_LUA = `
local rolling = require("lib/rolling")
local toolset = require("lib/toolset")

function generate(prompt, ctx)
  if type(state) ~= "table" then state = {} end
  state.story = state.story or rolling.channel()
  rolling.bind(prompt)
  local cmd = prompt.messages[#prompt.messages].content
  if cmd == "set" then rolling.set(state.story, "guild_name", "The Sunken Guildhall") return "set" end
  if cmd == "overwrite" then rolling.set(state.story, "guild_name", "The REBUILT Guildhall") return "ok" end
  if cmd == "get" then return rolling.get(state.story, "guild_name") or "nil" end
  if cmd == "tools" then
    local ts = toolset.new()
    ts:use(rolling.tools(state.story))
    local ex = ts:exec()
    return ex("list_facts", {}) .. " | " .. ex("set_fact", { key = "grudge", value = "the guild" })
      .. " | " .. ex("get_fact", { key = "grudge" }) .. " | " .. ex("list_facts", {})
  end
  if cmd == "briefing" then return rolling.briefing(state.story) end
  local label = cmd:match("^push:(.+)$")
  if label then return rolling.push(state.story, { label = label, gist = "gist " .. label }) end
  return "?"
end

function list_models() return { { id = "spar", name = "Spar" } } end
`;

describe('lib/rolling kv (the non-compacting half)', () => {
  it('set/get round-trip; overwrite is canon', async () => {
    const adapter = makeAdapter(noDelegate(), KV_LUA);
    let t = await roll(adapter, undefined, 'set');
    t = await roll(adapter, t.scriptState, 'get');
    expect(t.text).toBe('The Sunken Guildhall');
    t = await roll(adapter, t.scriptState, 'overwrite');
    t = await roll(adapter, t.scriptState, 'get');
    expect(t.text).toBe('The REBUILT Guildhall');
  });

  it('briefing renders FACTS verbatim before STORY SO FAR', async () => {
    const adapter = makeAdapter(noDelegate(), KV_LUA);
    let t = await roll(adapter, undefined, 'set');
    t = await roll(adapter, t.scriptState, 'push:first delve');
    t = await roll(adapter, t.scriptState, 'briefing');
    expect(t.text).toContain('FACTS:\n- guild_name: The Sunken Guildhall');
    expect(t.text).toContain('STORY SO FAR');
    expect(t.text.indexOf('FACTS:')).toBeLessThan(t.text.indexOf('STORY SO FAR'));
  });

  it('the kv block never folds', async () => {
    const adapter = makeAdapter(digestDelegate(), KV_LUA);
    let t = await roll(adapter, undefined, 'set');
    for (const w of ['one', 'two', 'three', 'four', 'five', 'six', 'seven']) {
      t = await roll(adapter, t.scriptState, `push:${w}`);
    }
    t = await roll(adapter, t.scriptState, 'briefing');
    expect(t.text).toContain('A folded digest of the early episodes.'); // the log folded
    expect(t.text).toContain('- guild_name: The Sunken Guildhall'); // the fact survived verbatim
  });

  it('rolling.tools(ch) exposes list_facts / get_fact / set_fact over the channel', async () => {
    const adapter = makeAdapter(noDelegate(), KV_LUA);
    let t = await roll(adapter, undefined, 'set');
    t = await roll(adapter, t.scriptState, 'tools');
    expect(t.text).toBe('guild_name | {"fact_set":"grudge"} | the guild | grudge, guild_name');
  });
});

// A partitioned-registry probe: rooms routed by floor into packs.
const PACK_LUA = `
local registry = require("lib/registry")

local rooms = registry.new({
  tool = "add_room",
  key = "rooms",
  id_from = "name",
  partition_by = function(rec) return rec.floor end,
  cap = 4,
  fields = {
    { name = "name", type = "string", required = true },
    { name = "floor", type = "string", required = true },
    { name = "hp", type = "integer", min = 1, max = 20, default = 6 },
    { name = "tags", type = "array", closed = { "dark", "flooded" } },
  },
  mutable = { "hp" },
  queries = {
    { name = "rooms_with_tag",
      args = { { name = "tag", type = "string", required = true } },
      run = function(records, args)
        local out = {}
        for _, r in ipairs(records) do
          for _, t in ipairs(r.tags or {}) do
            if t == args.tag then out[#out + 1] = r.id break end
          end
        end
        return out
      end },
  },
})

function generate(prompt, ctx)
  if type(state) ~= "table" then state = {} end
  local cmd = prompt.messages[#prompt.messages].content
  local f, name = cmd:match("^create:([^:]+):(.+)$")
  if f then
    local id, status = rooms.create({ name = name, floor = f, hp = 30, tags = { "dark" } }) -- hp 30 clamps to 20
    return tostring(id) .. (status and (" (" .. status .. ")") or "")
  end
  local lf = cmd:match("^list:(.+)$")
  if lf then
    local names = {}
    for _, r in ipairs(rooms.list(lf)) do names[#names + 1] = r.id .. "=" .. tostring(r.hp) end
    return table.concat(names, ", ")
  end
  local gf, gid = cmd:match("^get:([^:]+):(.+)$")
  if gf then
    local r = rooms.get(gf, gid)
    return r and json.encode(r) or "nil"
  end
  if cmd == "flush" then registry.flush() return "flushed" end
  if cmd == "pointers" then return json.encode(state.packIds or {}) end
  if cmd == "qlen" then return tostring(type(state._regq) == "table" and #state._regq or 0) end
  local rb = cmd:match("^readblob:(.+)$")
  if rb then return store.getJson(rb):await() or "missing" end
  if cmd == "plant-bad-pointer" then
    state.packIds = state.packIds or {}
    state.packIds.f9 = "pack#99"
    return "planted"
  end
  if cmd == "update-hp" then return rooms.exec("update_rooms", { id = "cell", hp = 25 }) end
  if cmd == "update-nope" then return rooms.exec("update_rooms", { id = "ghost", hp = 5 }) end
  if cmd == "update-nothing" then return rooms.exec("update_rooms", { id = "cell", floor = "f2" }) end
  if cmd == "card-update" then
    local ok, err = rooms.update("f1", "cell", { hp = 3 })
    if ok then return "true" end
    return "false " .. tostring(err)
  end
  if cmd == "tag-query" then return rooms.exec("rooms_with_tag", { tag = "dark" }) end
  if cmd == "tag-method" then return json.encode(rooms.rooms_with_tag({ tag = "dark" })) end
  return "?"
end

function list_models() return { { id = "spar", name = "Spar" } } end
`;

describe('lib/registry partitioned (packs)', () => {
  it('writes queue and reads resolve base+queue; flush moves one pointer per partition', async () => {
    const adapter = makeAdapter(noDelegate(), PACK_LUA);
    let t = await roll(adapter, undefined, 'create:f1:Cell');
    expect(t.text).toBe('cell');
    t = await roll(adapter, t.scriptState, 'create:f1:Hall');
    t = await roll(adapter, t.scriptState, 'create:f2:Crypt');
    t = await roll(adapter, t.scriptState, 'qlen');
    expect(t.text).toBe('3');
    // Unflushed: reads resolve through the queue.
    t = await roll(adapter, t.scriptState, 'list:f1');
    expect(t.text).toBe('cell=20, hall=20');
    t = await roll(adapter, t.scriptState, 'flush');
    expect(t.text).toBe('flushed');
    t = await roll(adapter, t.scriptState, 'qlen');
    expect(t.text).toBe('0');
    const pointers = JSON.parse((await roll(adapter, t.scriptState, 'pointers')).text) as Record<string, string>;
    expect(pointers['f1']).toBeDefined();
    expect(pointers['f2']).toBeDefined();
    // Next turn: reads load from the flushed blob.
    t = await roll(adapter, t.scriptState, 'list:f1');
    expect(t.text).toBe('cell=20, hall=20');
    t = await roll(adapter, t.scriptState, 'get:f2:crypt');
    expect(t.text).toContain('"name":"Crypt"');
  });

  it('a flush is a NEW put plus a pointer move — old branches keep their version', async () => {
    const adapter = makeAdapter(noDelegate(), PACK_LUA);
    let t = await roll(adapter, undefined, 'create:f1:Cell');
    t = await roll(adapter, t.scriptState, 'flush');
    const s1 = t.scriptState;
    const pid1 = JSON.parse((await roll(adapter, s1, 'pointers')).text)['f1'] as string;
    // Mutate and flush: the pointer moves to a new blob.
    t = await roll(adapter, s1, 'create:f1:Hall');
    t = await roll(adapter, t.scriptState, 'flush');
    const s2 = t.scriptState;
    const pid2 = JSON.parse((await roll(adapter, s2, 'pointers')).text)['f1'] as string;
    expect(pid2).not.toBe(pid1);
    // The old branch's blob is untouched.
    const oldBlob = (await roll(adapter, s2, `readblob:${pid1}`)).text;
    expect(oldBlob).toContain('cell');
    expect(oldBlob).not.toContain('hall');
    // Re-filing from the post-mutation branch converges (swipe-stable).
    t = await roll(adapter, s2, 'create:f1:Hall');
    expect(t.text).toBe('hall (already_registered)');
  });

  it('a pointer whose blob is missing fails loudly', async () => {
    const adapter = makeAdapter(noDelegate(), PACK_LUA);
    const t = await roll(adapter, undefined, 'plant-bad-pointer');
    const failed = await roll(adapter, t.scriptState, 'list:f9');
    expect(failed.result.finishReason).toBe('error');
    expect(failed.result.error).toContain('pack blob missing');
  });

  it('cap applies per partition', async () => {
    const adapter = makeAdapter(noDelegate(), PACK_LUA);
    let t = await roll(adapter, undefined, 'x');
    for (const n of ['a', 'b', 'c', 'd']) {
      t = await roll(adapter, t.scriptState, `create:f1:Room ${n}`);
    }
    t = await roll(adapter, t.scriptState, 'create:f1:Room e');
    expect(t.text).toContain('registry full');
    expect(t.text).toContain('in f1');
    t = await roll(adapter, t.scriptState, 'create:f2:Room e'); // another partition is unaffected
    expect(t.text).toBe('room-e');
  });
});

describe('lib/registry mutable fields and queries', () => {
  it('the update tool overwrites mutable fields with the same clamps', async () => {
    const adapter = makeAdapter(noDelegate(), PACK_LUA);
    let t = await roll(adapter, undefined, 'create:f1:Cell');
    t = await roll(adapter, t.scriptState, 'update-hp'); // hp 25 → clamped to 20
    expect(t.text).toContain('"updated":"cell"');
    expect(t.text).toContain('"hp":20');
    t = await roll(adapter, t.scriptState, 'get:f1:cell');
    expect(t.text).toContain('"hp":20');
  });

  it('update rejects unknown ids and updates with no mutable field', async () => {
    const adapter = makeAdapter(noDelegate(), PACK_LUA);
    let t = await roll(adapter, undefined, 'create:f1:Cell');
    t = await roll(adapter, t.scriptState, 'update-nope');
    expect(t.text).toBe('unknown rooms: ghost');
    t = await roll(adapter, t.scriptState, 'update-nothing'); // floor is not mutable
    expect(t.text).toContain('rejected: nothing to update');
  });

  it('card-side update(pk, id, fields) queues against the partition', async () => {
    const adapter = makeAdapter(noDelegate(), PACK_LUA);
    let t = await roll(adapter, undefined, 'create:f1:Cell');
    t = await roll(adapter, t.scriptState, 'card-update');
    expect(t.text).toBe('true');
    t = await roll(adapter, t.scriptState, 'get:f1:cell');
    expect(t.text).toContain('"hp":3');
  });

  it('custom queries work as tool and as card-side method, cross-partition', async () => {
    const adapter = makeAdapter(noDelegate(), PACK_LUA);
    let t = await roll(adapter, undefined, 'create:f1:Cell');
    t = await roll(adapter, t.scriptState, 'create:f2:Crypt');
    t = await roll(adapter, t.scriptState, 'tag-query');
    expect(t.text).toBe('["cell","crypt"]');
    t = await roll(adapter, t.scriptState, 'tag-method');
    expect(t.text).toBe('["cell","crypt"]');
  });
});

// A ledger probe: set semantics for promises.
const LEDGER_LUA = `
local ledger = require("lib/ledger")

function generate(prompt, ctx)
  if type(state) ~= "table" then state = {} end
  state.turn = state.turn or 0
  ledger.bind(function() return state.turn end)
  local cmd = prompt.messages[#prompt.messages].content
  if cmd == "file" then return ledger.exec("promise", { id = "bro", what = "design the brother", due = state.turn + 5 }) end
  if cmd == "refile" then return ledger.exec("promise", { id = "bro", what = "REDESIGN the brother", due = state.turn + 8 }) end
  if cmd == "resolve" then return ledger.exec("resolve_promise", { id = "bro", outcome = "kept" }) end
  if cmd == "fail" then return ledger.exec("resolve_promise", { id = "bro", outcome = "failed" }) end
  if cmd == "unknown" then return ledger.exec("resolve_promise", { id = "nope", outcome = "kept" }) end
  if cmd == "badoutcome" then return ledger.exec("resolve_promise", { id = "bro", outcome = "sorta" }) end
  if cmd == "briefing" then return ledger.briefing() end
  return "?"
end

function list_models() return { { id = "spar", name = "Spar" } } end
`;

describe('lib/ledger set semantics', () => {
  it('re-filing a pending id overwrites what/due (replaced = true)', async () => {
    const adapter = makeAdapter(noDelegate(), LEDGER_LUA);
    let t = await roll(adapter, undefined, 'file');
    expect(t.text).toContain('"promised":"bro"');
    expect(t.text).toContain('"due":5');
    t = await roll(adapter, t.scriptState, 'refile');
    expect(t.text).toContain('"replaced":true');
    expect(t.text).toContain('"due":8');
    t = await roll(adapter, t.scriptState, 'briefing');
    expect(t.text).toContain('REDESIGN the brother');
    expect(t.text).toContain('due 8');
    expect(t.text).not.toContain('design the brother (due 5)');
  });

  it('resolve overwrites status even on a resolved entry; unknown ids error', async () => {
    const adapter = makeAdapter(noDelegate(), LEDGER_LUA);
    let t = await roll(adapter, undefined, 'file');
    t = await roll(adapter, t.scriptState, 'resolve');
    expect(t.text).toContain('"outcome":"kept"');
    t = await roll(adapter, t.scriptState, 'fail');
    expect(t.text).toContain('"outcome":"failed"');
    t = await roll(adapter, t.scriptState, 'briefing');
    expect(t.text).toContain('FAILED — canon');
    t = await roll(adapter, t.scriptState, 'unknown');
    expect(t.text).toBe('unknown promise: nope');
    // Outcome is validated: anything but "kept"/"failed" is rejected outright.
    t = await roll(adapter, t.scriptState, 'badoutcome');
    expect(t.text).toBe('rejected: outcome must be "kept" or "failed"');
  });
});
