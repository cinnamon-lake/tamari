/**
 * Validates the event-engine patterns against a real card script:
 * docs/design/examples/guildhall/main.lua ("The Guildhall").
 * Real LuaBackendAdapter, scripted delegates (DM + scene-runner), scriptState
 * and branch history threaded between turns like the engine does.
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

const luaSource = readFileSync(new URL('../../../docs/design/examples/guildhall/main.lua', import.meta.url), 'utf8');

// The card VFS: main.lua requires the vendored game lib as lib/*.lua.
const LIB_FILES: Record<string, string> = Object.fromEntries(
  ['loop', 'collapse', 'transcript', 'chrome', 'ledger', 'toolset', 'registry', 'events'].map((m) => [
    `lib/${m}.lua`,
    readFileSync(new URL(`../../../docs/design/examples/game-lib/${m}.lua`, import.meta.url), 'utf8'),
  ]),
);

const USAGE = { promptTokens: 1, completionTokens: 1 };

interface GuildState {
  gold: number;
  party: string[];
  flags: Record<string, unknown>;
  dossiers: Record<string, { digest: string; takes: Array<{ event: string; take: string }> }>;
  pending: Record<string, { label: string; gold?: number; party?: string }>;
  suggestN: number;
  turn: number;
  event?: { id: string; kind: string; context: string; participants: string[]; closed?: { gist: string } };
  characters?: Array<{ id: string; name: string; role?: string; personality?: string }>;
}

function makeAdapter(delegate: CustomBackendDelegate, source = luaSource): LuaBackendAdapter {
  return new LuaBackendAdapter({
    id: 'custom:guildhall',
    name: 'The Guildhall',
    luaSource: source,
    runtime: new LuaRuntime(),
    delegate,
    vfsFiles: LIB_FILES,
  });
}

function noPassthrough() {
  return vi.fn(async () => {
    throw new Error('passthrough not expected');
  });
}

/** Delegate that must never be called — serve turns are free. */
function neverDelegate(): CustomBackendDelegate {
  return {
    generate: vi.fn(async (): Promise<DelegatedGenerateResult> => {
      throw new Error('delegate not expected');
    }),
    resolveAdapter: noPassthrough(),
  };
}

async function runTurn(
  adapter: LuaBackendAdapter,
  userText: string,
  scriptState: string | undefined,
  history?: Array<{ role: string; content: string }>,
  generationType: 'normal' | 'continue' = 'normal',
): Promise<{ text: string; state: GuildState; scriptState: string }> {
  const prompt: Prompt = {
    messages: [
      { role: 'system', content: 'Base system prompt.' },
      ...(history ?? []).map((h) => ({ role: h.role as 'user' | 'assistant', content: h.content })),
      { role: 'user', content: userText },
    ],
    tokenUsage: { prompt: 0, completion: 0 },
  };
  const { items, result } = await consumeStream(
    adapter.stream(prompt, new AbortController().signal, {
      chatId: 'guild-chat',
      generationType,
      scriptState,
    }),
  );
  expect(result.error).toBeUndefined();
  const text = items
    .filter((i): i is Extract<BackendStreamItem, { type: 'text' }> => i.type === 'text')
    .map((i) => i.token)
    .join('');
  expect(result.scriptState).toBeDefined();
  return { text, state: JSON.parse(result.scriptState!) as GuildState, scriptState: result.scriptState! };
}

const ALDRIC = { id: 'ser-aldric', name: 'Ser Aldric', role: 'old knight', personality: 'grizzled, debt-hungry, quietly honorable' };

/** State with an open recruitment event featuring Ser Aldric. */
function eventState(extra?: Record<string, unknown>): string {
  return JSON.stringify({
    gold: 30,
    party: [],
    characters: [ALDRIC],
    event: { id: 'e1', kind: 'recruitment', context: 'A barbarian recruiting an old knight', participants: ['ser-aldric'] },
    ...extra,
  });
}

function sysOf(prompt: Prompt): string {
  const sys = prompt.messages[0]!;
  return typeof sys.content === 'string' ? sys.content : '';
}

const clone = (prompt: Prompt): Prompt => JSON.parse(JSON.stringify(prompt)) as Prompt;

describe('The Guildhall (event-engine card)', () => {
  it('idle menu is free: served deterministically, delegate NOT called', async () => {
    const adapter = makeAdapter(neverDelegate());
    const t1 = await runTurn(adapter, '/delve', undefined);
    expect(t1.state.gold).toBeGreaterThan(30); // the stub delve pays 1-6
    expect(t1.state.gold).toBeLessThanOrEqual(36);
    expect(t1.text).toContain('gold');
    expect(t1.text).toContain('data-post-response="/delve"');

    // continue never resolves: ambient line only, still no delegate.
    const t2 = await runTurn(adapter, '', t1.scriptState, undefined, 'continue');
    expect(t2.text).toContain('The hall murmurs on.');
    expect(t2.state.gold).toBe(t1.state.gold);
  });

  it('escalation: the DM frames the event (no casting), the scene-runner casts and writes', async () => {
    const dmPrompts: Prompt[] = [];
    const chatPrompts: Prompt[] = [];
    let chatRound = 0;
    const delegate: CustomBackendDelegate = {
      generate: vi.fn(async (_configId: string | null, prompt: Prompt): Promise<DelegatedGenerateResult> => {
        const sys = sysOf(prompt);
        if (sys.includes('dungeon master')) {
          dmPrompts.push(clone(prompt));
          if (!JSON.stringify(prompt.messages).includes('"open_event"')) {
            return {
              text: '', finishReason: 'stop', usage: USAGE,
              toolCalls: [{ id: 'o1', name: 'open_event', arguments: {
                kind: 'recruitment',
                context: '{{user}} is a barbarian, back from a delve, asking after the old knight at the quest board',
              } }],
            };
          }
          return { text: 'You cross the hall to the quest board.', finishReason: 'stop', usage: USAGE };
        }
        chatPrompts.push(clone(prompt));
        chatRound++;
        if (chatRound === 1) {
          return { text: '', finishReason: 'stop', usage: USAGE,
            toolCalls: [{ id: 'l1', name: 'list_characters', arguments: {} }] };
        }
        if (chatRound === 2) {
          return { text: '', finishReason: 'stop', usage: USAGE,
            toolCalls: [
              { id: 'r1', name: 'register_character', arguments: { name: 'Ser Aldric', role: 'old knight', personality: 'grizzled, debt-hungry, quietly honorable' } },
              { id: 'a1', name: 'add_to_chat', arguments: { id: 'ser-aldric' } },
            ] };
        }
        return { text: 'The old knight turns. "Aye, maybe. What\'s the offer?"', finishReason: 'stop', usage: USAGE };
      }),
      resolveAdapter: noPassthrough(),
    };
    const { text, state } = await runTurn(makeAdapter(delegate), 'I ask the old knight at the board if he wants to party up', undefined);

    // The boundary turn: event open + DM transition + first chat block, one message.
    expect(text).toContain('[event recruitment]');
    expect(text).toContain('You cross the hall to the quest board.');
    expect(text).toContain('[chat featuring="ser-aldric"]');
    expect(text).toContain("What's the offer?");
    expect(text).toContain('[/chat]');
    expect(text).toContain('data-post-response="/leave"');
    expect(text).not.toContain('data-post-response="/delve"'); // menu is gated

    // Facts landed in state: the event, the registered character, the participant.
    expect(state.event?.kind).toBe('recruitment');
    expect(state.event?.participants).toEqual(['ser-aldric']);
    expect(state.characters).toHaveLength(1);
    expect(state.characters![0]!.id).toBe('ser-aldric');

    // The two delegates are different prompts: the DM frames, the scene-runner
    // gets the frozen system + the DM's context — and casts for itself.
    expect(dmPrompts.length).toBeGreaterThan(0);
    expect(chatPrompts.length).toBeGreaterThan(0);
    expect(sysOf(chatPrompts[0]!)).toContain('scene-runner');
    expect(sysOf(chatPrompts[0]!)).toContain('barbarian');
    expect(sysOf(dmPrompts[0]!)).toContain('dungeon master');
    expect(sysOf(dmPrompts[0]!)).not.toContain('You write EVERY participant'); // the chat contract is the scene-runner's
    // The scene-runner discovered the empty registry through a READ tool.
    expect(JSON.stringify(chatPrompts[1]!.messages)).toContain('registry: empty');
  });

  it('frozen prefix: within an event, turn N is a strict prefix of turn N+1', async () => {
    const chatPrompts: Prompt[] = [];
    const delegate: CustomBackendDelegate = {
      generate: vi.fn(async (_configId: string | null, prompt: Prompt): Promise<DelegatedGenerateResult> => {
        const sys = sysOf(prompt);
        if (sys.includes('dungeon master')) {
          if (!JSON.stringify(prompt.messages).includes('"open_event"')) {
            return { text: '', finishReason: 'stop', usage: USAGE,
              toolCalls: [{ id: 'o1', name: 'open_event', arguments: { kind: 'recruitment', context: 'A barbarian recruiting an old knight' } }] };
          }
          return { text: 'You cross the hall.', finishReason: 'stop', usage: USAGE };
        }
        chatPrompts.push(clone(prompt));
        return { text: `The knight strokes his beard. (line ${chatPrompts.length})`, finishReason: 'stop', usage: USAGE };
      }),
      resolveAdapter: noPassthrough(),
    };
    const adapter = makeAdapter(delegate);

    const t1 = await runTurn(adapter, 'I ask the old knight to party up', undefined);
    const t2 = await runTurn(adapter, 'What is your rate?', t1.scriptState, [
      { role: 'user', content: 'I ask the old knight to party up' },
      { role: 'assistant', content: t1.text },
    ]);
    await runTurn(adapter, 'Twenty gold? Steep.', t2.scriptState, [
      { role: 'user', content: 'I ask the old knight to party up' },
      { role: 'assistant', content: t1.text },
      { role: 'user', content: 'What is your rate?' },
      { role: 'assistant', content: t2.text },
    ]);

    expect(chatPrompts).toHaveLength(3);
    const [, p2, p3] = chatPrompts;
    // The system block is byte-identical across turns — frozen per event.
    expect(sysOf(p3!)).toBe(sysOf(p2!));
    expect(sysOf(p2!)).toContain('EVENT: recruitment');
    // Append-only: turn 2's whole prompt is a strict prefix of turn 3's.
    expect(p3!.messages.length).toBeGreaterThan(p2!.messages.length);
    expect(p3!.messages.slice(0, p2!.messages.length)).toEqual(p2!.messages);
    // The growing tail carries the actual chat, chrome-stripped.
    expect(JSON.stringify(p3!.messages)).toContain('The knight strokes his beard.');
    expect(JSON.stringify(p3!.messages)).not.toContain('data-post-response');
    expect(JSON.stringify(p3!.messages)).not.toContain('[HUD|');
  });

  it('close_event: the gist rides the close tag, targeted takes file the dossiers', async () => {
    const chatPrompts: Prompt[] = [];
    let chatRound = 0;
    const delegate: CustomBackendDelegate = {
      generate: vi.fn(async (_configId: string | null, prompt: Prompt): Promise<DelegatedGenerateResult> => {
        chatPrompts.push(clone(prompt));
        chatRound++;
        if (chatRound === 1) {
          return { text: '', finishReason: 'stop', usage: USAGE,
            toolCalls: [{ id: 'c1', name: 'close_event', arguments: {
              gist: 'Recruited Ser Aldric at the quest board for 20g.',
              takes: {
                'ser-aldric': 'Hired by a barbarian who asked straight questions and paid up front.',
                'a-ghost': 'was never here',
              },
            } }] };
        }
        return { text: '"Done, then." He shoulders his pack.', finishReason: 'stop', usage: USAGE };
      }),
      resolveAdapter: noPassthrough(),
    };
    const { text, state } = await runTurn(makeAdapter(delegate), 'Great. Let\'s head out.', eventState());

    // The script splices the close tag with the neutral gist; the model never
    // typed a bracket.
    expect(text).toContain('[/event recruitment summary="Recruited Ser Aldric at the quest board for 20g."]');
    expect(text).toContain('"Done, then."');
    // The participant's take is filed; the non-participant's was dropped and
    // the canonical result said so.
    expect(state.dossiers['ser-aldric']!.takes).toHaveLength(1);
    expect(state.dossiers['ser-aldric']!.takes[0]!.take).toContain('paid up front');
    expect(state.dossiers['a-ghost']).toBeUndefined();
    expect(JSON.stringify(chatPrompts[1]!.messages)).toContain('takes_dropped');
    expect(JSON.stringify(chatPrompts[1]!.messages)).toContain('a-ghost');
    // Back to idle: event cleared, offers cleared, menu buttons return.
    expect(state.event).toBeUndefined();
    expect(text).toContain('data-post-response="/delve"');
  });

  it('dossiers: a returning character is served their own history as a read-tool result', async () => {
    const chatPrompts: Prompt[] = [];
    const seeded = JSON.stringify({
      gold: 30,
      party: ['ser-aldric'],
      characters: [ALDRIC],
      dossiers: { 'ser-aldric': { digest: '', takes: [{ event: 'recruitment', take: 'Hired by a barbarian who paid up front.' }] } },
    });
    let chatRound = 0;
    const delegate: CustomBackendDelegate = {
      generate: vi.fn(async (_configId: string | null, prompt: Prompt): Promise<DelegatedGenerateResult> => {
        const sys = sysOf(prompt);
        if (sys.includes('dungeon master')) {
          if (!JSON.stringify(prompt.messages).includes('"open_event"')) {
            return { text: '', finishReason: 'stop', usage: USAGE,
              toolCalls: [{ id: 'o1', name: 'open_event', arguments: { kind: 'reunion', context: 'The barbarian seeks out Ser Aldric about the delve' } }] };
          }
          return { text: 'You find the knight by the hearth.', finishReason: 'stop', usage: USAGE };
        }
        chatPrompts.push(clone(prompt));
        chatRound++;
        if (chatRound === 1) {
          return { text: '', finishReason: 'stop', usage: USAGE,
            toolCalls: [{ id: 'g1', name: 'get_character', arguments: { id: 'ser-aldric' } }] };
        }
        return { text: '"Back already?" The knight almost smiles.', finishReason: 'stop', usage: USAGE };
      }),
      resolveAdapter: noPassthrough(),
    };
    const { state } = await runTurn(makeAdapter(delegate), 'I go find Ser Aldric', seeded);

    // The dossier arrived in the TAIL, as a read-tool result — the frozen
    // prefix never rebuilds for history.
    expect(chatPrompts).toHaveLength(2);
    const toolResultRound = JSON.stringify(chatPrompts[1]!.messages);
    expect(toolResultRound).toContain('Hired by a barbarian who paid up front.');
    expect(toolResultRound).toContain('older_takes'); // the dossier field arrived (nested JSON escapes the key)
    expect(sysOf(chatPrompts[0]!)).not.toContain('paid up front'); // not injected into the prefix
    expect(state.event?.kind).toBe('reunion');
  });

  it('suggest: the confirmed write posts a button; acceptance is serve-land', async () => {
    let chatRound = 0;
    const delegate: CustomBackendDelegate = {
      generate: vi.fn(async (_configId: string | null, _prompt: Prompt): Promise<DelegatedGenerateResult> => {
        chatRound++;
        if (chatRound === 1) {
          return { text: '', finishReason: 'stop', usage: USAGE,
            toolCalls: [{ id: 's1', name: 'suggest', arguments: { label: 'Hire Ser Aldric — 20g', gold: 20, party: 'ser-aldric' } }] };
        }
        return { text: '"Twenty gold a delve. That\'s the rate."', finishReason: 'stop', usage: USAGE };
      }),
      resolveAdapter: noPassthrough(),
    };
    const t1 = await runTurn(makeAdapter(delegate), 'What is your rate?', eventState());
    expect(t1.text).toContain('data-post-response="/accept s1"');
    expect(t1.text).toContain('Hire Ser Aldric');
    expect(t1.state.gold).toBe(30); // nothing deducted yet — the PLAYER decides
    expect(Object.keys(t1.state.party)).toHaveLength(0); // (empty table serializes as {})

    // Acceptance is a bare command: deterministic, zero delegate calls.
    const freeAdapter = makeAdapter(neverDelegate());
    const t2 = await runTurn(freeAdapter, '/accept s1', t1.scriptState);
    expect(t2.text).toContain('Deal struck.');
    expect(t2.text).toContain('-20 gold');
    expect(t2.state.gold).toBe(10);
    expect(t2.state.party).toEqual(['ser-aldric']);
    expect(Object.keys(t2.state.pending)).toHaveLength(0);
  });

  it('/leave: a deterministic exit — memory is best-effort, freedom is not', async () => {
    // The finalize gen FAILS (no delegate available): the event still closes,
    // with a script-composed fallback gist.
    const t1 = await runTurn(makeAdapter(neverDelegate()), '/leave', eventState());
    expect(t1.text).toContain('[/event recruitment summary="The recruitment breaks off."]');
    expect(t1.text).toContain('data-post-response="/delve"');
    expect(t1.state.event).toBeUndefined();

    // The finalize gen SUCCEEDS: its gist and takes are the ones that land.
    let round = 0;
    const delegate: CustomBackendDelegate = {
      generate: vi.fn(async (): Promise<DelegatedGenerateResult> => {
        round++;
        if (round === 1) {
          return { text: '', finishReason: 'stop', usage: USAGE,
            toolCalls: [{ id: 'c1', name: 'close_event', arguments: {
              gist: 'The barbarian walked out mid-negotiation.',
              takes: { 'ser-aldric': 'Left hanging at the board — insulting, but interesting.' },
            } }] };
        }
        return { text: '', finishReason: 'stop', usage: USAGE };
      }),
      resolveAdapter: noPassthrough(),
    };
    const t2 = await runTurn(makeAdapter(delegate), '/leave', eventState());
    expect(t2.text).toContain('[/event recruitment summary="The barbarian walked out mid-negotiation."]');
    expect(t2.state.dossiers['ser-aldric']!.takes[0]!.take).toContain('insulting');
    expect(t2.state.event).toBeUndefined();
  });

  it('events are modes: menu verbs are gated while an event is open', async () => {
    const t1 = await runTurn(makeAdapter(neverDelegate()), '/delve', eventState());
    expect(t1.text).toContain('Finish your business here first.');
    expect(t1.state.gold).toBe(30); // the delve did not happen
    expect(t1.state.event?.kind).toBe('recruitment'); // still in the event
    expect(t1.text).toContain('data-post-response="/leave"');
  });

  it('the model never types a bracket: freelanced structural tags are stripped', async () => {
    const delegate: CustomBackendDelegate = {
      generate: vi.fn(async (): Promise<DelegatedGenerateResult> => ({
        text: '"Aye." [/event recruitment summary="fake gist"] [chat featuring="nobody"] he says.',
        finishReason: 'stop', usage: USAGE,
      })),
      resolveAdapter: noPassthrough(),
    };
    const { text, state } = await runTurn(makeAdapter(delegate), 'so, knight?', eventState());
    expect(text).not.toContain('summary="fake gist"');
    expect(text).not.toContain('[chat featuring="nobody"]');
    expect(text).toContain('"Aye."');
    // The script's own wrapper is the only structural markup present.
    expect(text).toContain('[chat featuring="ser-aldric"]');
    expect(state.event?.kind).toBe('recruitment'); // still open — no fake close
  });

  const SEVEN_TAKES = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'].map((w) => ({
    event: 'recruitment',
    take: `take number ${w}`,
  }));

  function bigDossierState(): string {
    return eventState({
      dossiers: { 'ser-aldric': { digest: '', takes: SEVEN_TAKES } },
    });
  }

  it('dossier digestion: get_character folds the backlog into a running digest, once', async () => {
    const chatPrompts: Prompt[] = [];
    const digestPrompts: Prompt[] = [];
    let chatRound = 0;
    const delegate: CustomBackendDelegate = {
      generate: vi.fn(async (_configId: string | null, prompt: Prompt): Promise<DelegatedGenerateResult> => {
        const sys = sysOf(prompt);
        if (sys.includes('Compress a character')) {
          digestPrompts.push(clone(prompt));
          return { text: 'Knows the barbarian: hired him, he paid up front, drinks too much.', finishReason: 'stop', usage: USAGE };
        }
        chatPrompts.push(clone(prompt));
        chatRound++;
        if (chatRound === 1) {
          return { text: '', finishReason: 'stop', usage: USAGE,
            toolCalls: [{ id: 'g1', name: 'get_character', arguments: { id: 'ser-aldric' } }] };
        }
        return { text: '"Back again?" He nods slowly.', finishReason: 'stop', usage: USAGE };
      }),
      resolveAdapter: noPassthrough(),
    };
    const { state } = await runTurn(makeAdapter(delegate), 'hey knight', bigDossierState());

    // The fold fired exactly once, over the OLDEST takes (recent 3 survive).
    expect(digestPrompts).toHaveLength(1);
    const foldInput = JSON.stringify(digestPrompts[0]!.messages);
    expect(foldInput).toContain('take number one');
    expect(foldInput).toContain('take number four');
    expect(foldInput).not.toContain('take number seven');

    // The tool result carries the digest plus the recent takes.
    const toolResultRound = JSON.stringify(chatPrompts[1]!.messages);
    expect(toolResultRound).toContain('Knows the barbarian');
    expect(toolResultRound).toContain('take number seven');

    // State: digest filed, backlog dropped. A second read folds nothing.
    expect(state.dossiers['ser-aldric']!.digest).toContain('Knows the barbarian');
    expect(state.dossiers['ser-aldric']!.takes).toHaveLength(3);
    expect(state.dossiers['ser-aldric']!.takes[0]!.take).toContain('five');
  });

  it('dossier digestion is fail-soft: a delegate error serves cap-and-count, memory intact', async () => {
    const chatPrompts: Prompt[] = [];
    let chatRound = 0;
    const delegate: CustomBackendDelegate = {
      generate: vi.fn(async (_configId: string | null, prompt: Prompt): Promise<DelegatedGenerateResult> => {
        const sys = sysOf(prompt);
        if (sys.includes('Compress a character')) throw new Error('backend down');
        chatPrompts.push(clone(prompt));
        chatRound++;
        if (chatRound === 1) {
          return { text: '', finishReason: 'stop', usage: USAGE,
            toolCalls: [{ id: 'g1', name: 'get_character', arguments: { id: 'ser-aldric' } }] };
        }
        return { text: '"Hm." He says nothing.', finishReason: 'stop', usage: USAGE };
      }),
      resolveAdapter: noPassthrough(),
    };
    const { state } = await runTurn(makeAdapter(delegate), 'hey knight', bigDossierState());

    // No digest filed, every take preserved, and the read still answered
    // (recent takes + the older count).
    expect(state.dossiers['ser-aldric']!.digest).toBe('');
    expect(state.dossiers['ser-aldric']!.takes).toHaveLength(7);
    const toolResultRound = JSON.stringify(chatPrompts[1]!.messages);
    expect(toolResultRound).toContain('take number seven');
    expect(toolResultRound).toContain('older_takes');
  });
});
