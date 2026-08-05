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
    local gist = summarize.gist("fight", prompt)
    return "You wipe the blade. " .. (gist and summarize.close("fight", gist) or summarize.close("fight", "It is over."))
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
    { name = "name", type = "string", required = true, max = 40 },
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
    const prompt: Prompt = {
      messages: [
        { role: 'system', content: 'Base system prompt.' },
        { role: 'assistant', content: '[fight]\nThe goblin blocks the way.' },
        { role: 'user', content: 'end' },
      ],
      tokenUsage: { prompt: 0, completion: 0 },
    };
    const { result } = await consumeStream(
      adapter.stream(prompt, new AbortController().signal, { chatId: 'spar-chat', generationType: 'normal' }),
    );
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
      adapter.stream(prompt, new AbortController().signal, { chatId: 'spar-chat', generationType: 'normal' }),
    );
    expect(result.finishReason).toBe('error');
    expect(result.error).toContain('tool loop exceeded 2 rounds');
    expect(result.error).toContain('ping'); // names the pending tools
    expect(result.scriptState).toBeUndefined();
  });
});

// A rolling-summary probe card: push/briefing/inspect over state.story.
const ROLLING_LUA = `
local rolling = require("lib/rolling")

function generate(prompt, ctx)
  if type(state) ~= "table" then state = {} end
  state.story = state.story or {}
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
    state.story[#state.story + 1] = "roll#99" -- an id with no blob (a bug)
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
    adapter.stream(prompt, new AbortController().signal, { chatId: 'spar-chat', generationType: 'normal', scriptState }),
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
