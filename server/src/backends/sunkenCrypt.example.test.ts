/**
 * Validates the factory-ratio patterns against a real card script:
 * docs/design/examples/sunken-crypt/main.lua ("The Sunken Crypt").
 * Real LuaBackendAdapter, scripted delegate, scriptState and branch
 * history threaded between turns like the engine does.
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

const luaSource = readFileSync(new URL('../../../docs/design/examples/sunken-crypt/main.lua', import.meta.url), 'utf8');

const USAGE = { promptTokens: 1, completionTokens: 1 };

interface CryptState {
  hp: number;
  maxHp: number;
  atk: number;
  gold: number;
  inventory: Record<string, number>;
  room: string;
  flags: Record<string, unknown>;
  promises?: Array<{ id: string; what: string; turn: number; status?: string }>;
  combat?: { name: string; hp: number; maxHp: number; atk: number; lines: { intro: string; hit: string; death: string }; reward: number };
  turn: number;
  escalations: number;
  won: boolean;
  dead: boolean;
}

interface FloorPack {
  id: string;
  name: string;
  description: string;
  entrance: string;
  stairsDown: string;
  rooms: Record<string, { name: string; desc: string; exits: Record<string, string> }>;
  encounterTable: Array<{ name: string; hp: number; maxHp: number; atk: number; reward: number; lines: Record<string, string> }>;
  interactables: Record<string, { responses: string[]; effect?: { gold?: number; hp?: number; item?: string } }>;
  ambient: string[];
}

const F1_BLOB = `[pack f1]
{"id":"f1","name":"The Upper Halls","description":"Dust and old bones, galleries collapsing inward.","entrance":"r1","stairsDown":"r3","rooms":{"r1":{"name":"Collapsed Nave","desc":"Dust and old bones.","exits":{"north":"r2"}},"r2":{"name":"Ossuary","desc":"Stacked femurs like cordwood.","exits":{"south":"r1","east":"r3"}},"r3":{"name":"Silent Choir","desc":"Stone seats in rows.","exits":{"west":"r2","down":"down"}}},"encounterTable":[{"name":"Crypt Rat","hp":3,"maxHp":3,"atk":1,"reward":5,"lines":{"intro":"It lunges.","hit":"The rat sinks its teeth in.","death":"The rat twitches and is still."}}],"interactables":{"r1:crate":{"responses":["Inside: a few coins and a rat nest.","Just the rat nest now."],"effect":{"gold":5}}},"ambient":["Water drips below."]}
[/pack f1 summary="Designed The Upper Halls: 3 rooms, 1 monsters, stairs in Silent Choir."]`;

function makeAdapter(delegate: CustomBackendDelegate, source = luaSource): LuaBackendAdapter {
  return new LuaBackendAdapter({
    id: 'custom:crypt',
    name: 'The Sunken Crypt',
    luaSource: source,
    runtime: new LuaRuntime(),
    delegate,
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
  extraMessages?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
): Promise<{ text: string; state: CryptState; scriptState: string }> {
  const prompt: Prompt = {
    messages: [
      { role: 'system', content: 'Base system prompt.' },
      ...(extraMessages ?? []),
      { role: 'user', content: userText },
    ],
    tokenUsage: { prompt: 0, completion: 0 },
  };
  const { items, result } = await consumeStream(
    adapter.stream(prompt, new AbortController().signal, {
      chatId: 'crypt-chat',
      generationType,
      scriptState,
      ...(history
        ? { branchHistory: async () => history.map((h, i) => ({ id: `h-${i + 1}`, role: h.role, content: h.content })) }
        : {}),
    }),
  );
  expect(result.error).toBeUndefined();
  const text = items
    .filter((i): i is Extract<BackendStreamItem, { type: 'text' }> => i.type === 'text')
    .map((i) => i.token)
    .join('');
  expect(result.scriptState).toBeDefined();
  return { text, state: JSON.parse(result.scriptState!) as CryptState, scriptState: result.scriptState! };
}

function packFrom(text: string, fid = 'f1'): FloorPack {
  const json = text.match(new RegExp(`\\[pack ${fid}\\]\\n(.*?)\\n\\[\\/pack ${fid}`, 's'))?.[1];
  expect(json).toBeDefined();
  return JSON.parse(json!) as FloorPack;
}

/** Delegate that designs floor 1 via tool calls, then writes the intro. */
function planningDelegate(calls: Prompt[]): CustomBackendDelegate {
  return {
    generate: vi.fn(async (_configId: string | null, prompt: Prompt): Promise<DelegatedGenerateResult> => {
      calls.push(JSON.parse(JSON.stringify(prompt)) as Prompt);
      const sys = prompt.messages[0]!;
      const sysContent = typeof sys.content === 'string' ? sys.content : '';
      if (sysContent.includes('content designer')) {
        const transcript = JSON.stringify(prompt.messages);
        if (!transcript.includes('"add_ambient"')) {
          return {
            text: '', finishReason: 'stop', usage: USAGE,
            toolCalls: [
              { id: 't1', name: 'add_description', arguments: { text: 'Dust and old bones, galleries collapsing inward.' } },
              { id: 't2', name: 'add_rooms', arguments: { rooms: [
                { id: 'r1', name: 'Collapsed Nave', desc: 'Dust and old bones.', exits: { north: 'r2' } },
                { id: 'r2', name: 'Ossuary', desc: 'Stacked femurs like cordwood.', exits: { south: 'r1', east: 'r3' } },
                { id: 'r3', name: 'Silent Choir', desc: 'Stone seats in rows.', exits: { west: 'r2', down: 'DOWN' } },
              ] } },
              { id: 't3', name: 'add_encounter', arguments: { name: 'Crypt Rat', hp: 3, atk: 1, reward: 5,
                lines: { intro: 'It lunges.', hit: 'The rat sinks its teeth in.', death: 'The rat twitches and is still.' } } },
              { id: 't4', name: 'add_interactable', arguments: { room: 'r1', name: 'crate',
                responses: ['Inside: a few coins and a rat nest.', 'Just the rat nest now.'], effect: { gold: 5 } } },
              { id: 't5', name: 'add_ambient', arguments: { lines: ['Water drips somewhere below.', 'The dark breathes.'] } },
            ],
          };
        }
        return { text: 'You stand in the Collapsed Nave.', finishReason: 'stop', usage: USAGE };
      }
      return { text: 'The narrator speaks.', finishReason: 'stop', usage: USAGE };
    }),
    resolveAdapter: noPassthrough(),
  };
}

describe('The Sunken Crypt (factory-ratio card)', () => {
  it('planning at the boundary: ONE sub-gen designs the whole floor graph, pack in the LOG not state', async () => {
    const calls: Prompt[] = [];
    const { text, state } = await runTurn(makeAdapter(planningDelegate(calls)), 'look', undefined);
    expect(calls).toHaveLength(2); // tool round, then intro
    expect(text).toContain('[pack f1]');
    expect(text).toContain('[/pack f1 summary="');
    expect(text).toContain('You stand in the Collapsed Nave.');
    expect(text).toContain('stairs in Silent Choir');
    const pack = packFrom(text);
    expect(pack.entrance).toBe('r1');
    expect(pack.stairsDown).toBe('r3');
    expect(pack.rooms['r2']!.exits['east']).toBe('r3');
    expect(pack.rooms['r3']!.exits['down']).toBe('down');
    expect(pack.encounterTable).toHaveLength(1);
    expect(pack.interactables['r1:crate']!.effect!.gold).toBe(5);
    expect(state.room).toBe('f1:r1'); // placed at the designed entrance
    expect('pack' in state).toBe(false); // hot state only
  });

  it('graph validation: dangling exits dropped, unreachable rooms pruned, stairs guaranteed', async () => {
    const calls: Prompt[] = [];
    const delegate: CustomBackendDelegate = {
      generate: vi.fn(async (_configId: string | null, prompt: Prompt): Promise<DelegatedGenerateResult> => {
        calls.push(JSON.parse(JSON.stringify(prompt)) as Prompt);
        const transcript = JSON.stringify(prompt.messages);
        if (!transcript.includes('"add_rooms"')) {
          return {
            text: '', finishReason: 'stop', usage: USAGE,
            toolCalls: [
              { id: 't1', name: 'add_rooms', arguments: { rooms: [
                { id: 'r1', name: 'Nave', desc: 'Dust.', exits: { north: 'r2' } },
                { id: 'r2', name: 'Ossuary', desc: 'Bones.', exits: { south: 'r1', east: 'r9' } }, // r9: dangling
                { id: 'r4', name: 'Lost Cell', desc: 'Dripping.', exits: { north: 'r1' } }, // unreachable: nothing points AT r4
              ] } },
            ],
          };
        }
        return { text: 'You arrive.', finishReason: 'stop', usage: USAGE };
      }),
      resolveAdapter: noPassthrough(),
    };
    const { text } = await runTurn(makeAdapter(delegate), 'look', undefined);
    const pack = packFrom(text);
    expect(pack.rooms['r4']).toBeUndefined(); // pruned
    expect(pack.rooms['r2']!.exits['east']).toBeUndefined(); // dangling, dropped
    expect(pack.stairsDown).toBe('r2'); // farthest room got the stairs the model forgot
    expect(pack.rooms['r2']!.exits['down']).toBe('down');
    expect(text).toContain('repairs'); // the repair count rides the summary
  });

  it('serve turns are free: canned response, effect applied, delegate NOT called', async () => {
    const adapter = makeAdapter(neverDelegate());
    const t1 = await runTurn(adapter, 'open the crate', JSON.stringify({ room: 'f1:r1' }),
      [{ role: 'assistant', content: F1_BLOB }]);
    expect(t1.text).toContain('Inside: a few coins and a rat nest.');
    expect(t1.state.gold).toBe(5);
    // Repeat use: the alternate canned line, no second reward.
    const t2 = await runTurn(adapter, 'open the crate', t1.scriptState,
      [{ role: 'assistant', content: F1_BLOB }]);
    expect(t2.text).toContain('Just the rat nest now.');
    expect(t2.state.gold).toBe(5);
  });

  it('in-floor movement is free, and the newest pack version wins', async () => {
    const v2 = F1_BLOB
      .replace('"exits":{"north":"r2"}', '"exits":{"north":"r2","east":"r3"}')
      .replace('Designed The Upper Halls', 'Designed The Upper Halls v2');
    const adapter = makeAdapter(neverDelegate());
    const { text, state } = await runTurn(adapter, '/go east', JSON.stringify({ room: 'f1:r1' }),
      [
        { role: 'assistant', content: F1_BLOB }, // oldest first: v1…
        { role: 'assistant', content: v2 },      // …then v2, which must win
      ]);
    expect(state.room).toBe('f1:r3'); // only possible if the v2 pack was read
    expect(text).toContain('Stone seats in rows.');
  });

  it('random encounters: Lua rolls the floor roster on room entry, kills quiet the room', async () => {
    // Deterministic roll: flip the script's own chance knob to "always".
    const luaAlways = luaSource.replace('local ENCOUNTER_CHANCE = 0.3', 'local ENCOUNTER_CHANCE = 1');
    expect(luaAlways).not.toBe(luaSource); // guards the knob's name
    const adapter = makeAdapter(neverDelegate(), luaAlways);
    const history = [{ role: 'assistant', content: F1_BLOB }];

    // Entering a non-entrance room starts a fight from the roster — zero delegate.
    const t1 = await runTurn(adapter, '/go north', JSON.stringify({ room: 'f1:r1' }), history);
    expect(t1.state.room).toBe('f1:r2');
    expect(t1.text).toContain('It lunges.');
    expect(t1.state.combat?.name).toBe('Crypt Rat');

    // The kill is served from canned lines and quiets the room.
    const t2 = await runTurn(adapter, 'attack', t1.scriptState, history);
    expect(t2.text).toContain('The rat twitches and is still.');
    expect(t2.state.combat).toBeUndefined();
    expect(t2.state.gold).toBe(5);
    expect(t2.state.flags['quiet:f1:r2']).toBeDefined();

    // Back out (the entrance never rolls) and return inside the cooldown:
    // no encounter even at 100% chance.
    const t3 = await runTurn(adapter, 'go south', t2.scriptState, history);
    expect(t3.state.room).toBe('f1:r1');
    const t4 = await runTurn(adapter, 'go north', t3.scriptState, history);
    expect(t4.state.room).toBe('f1:r2');
    expect(t4.state.combat).toBeUndefined();
    expect(t4.text).not.toContain('It lunges.');
    expect(t4.text).toContain('Stacked femurs like cordwood.');
  });

  it('descending the stairs crosses the boundary: planning fires for the next floor', async () => {
    const calls: Prompt[] = [];
    const delegate: CustomBackendDelegate = {
      generate: vi.fn(async (_configId: string | null, prompt: Prompt): Promise<DelegatedGenerateResult> => {
        calls.push(JSON.parse(JSON.stringify(prompt)) as Prompt);
        const sys = prompt.messages[0]!;
        const sysContent = typeof sys.content === 'string' ? sys.content : '';
        expect(sysContent).toContain('The Flooded Stacks'); // f2, not f1
        const transcript = JSON.stringify(prompt.messages);
        if (!transcript.includes('"add_rooms"')) {
          return {
            text: '', finishReason: 'stop', usage: USAGE,
            toolCalls: [
              { id: 't1', name: 'add_description', arguments: { text: 'Black water, rotting shelves.' } },
              { id: 't2', name: 'add_rooms', arguments: { rooms: [
                { id: 'r1', name: 'Sunken Aisle', desc: 'Knee-deep black water.', exits: { down: 'DOWN' } },
              ] } },
            ],
          };
        }
        return { text: 'You wade into the Flooded Stacks.', finishReason: 'stop', usage: USAGE };
      }),
      resolveAdapter: noPassthrough(),
    };
    const { text, state } = await runTurn(makeAdapter(delegate), '/go down', JSON.stringify({ room: 'f1:r3' }),
      [{ role: 'assistant', content: F1_BLOB }]);
    expect(calls).toHaveLength(2);
    expect(text).toContain('[pack f2]');
    expect(state.room).toBe('f2:r1'); // the new floor's designed entrance
  });

  it('escalation resolves novelty through the tool economy (costs deducted by Lua)', async () => {
    const calls: Prompt[] = [];
    let dmRound = 0;
    const delegate: CustomBackendDelegate = {
      generate: vi.fn(async (_configId: string | null, prompt: Prompt): Promise<DelegatedGenerateResult> => {
        calls.push(JSON.parse(JSON.stringify(prompt)) as Prompt);
        dmRound++;
        if (dmRound === 1) {
          return {
            text: '', finishReason: 'stop', usage: USAGE,
            toolCalls: [{ id: 'a1', name: 'attempt', arguments: { action: 'blow up the wall', difficulty: 12 } }],
          };
        }
        if (dmRound === 2) {
          return {
            text: '', finishReason: 'stop', usage: USAGE,
            toolCalls: [
              { id: 'a2', name: 'remove_item', arguments: { name: 'bomb' } },
              { id: 'a3', name: 'add_exit', arguments: { direction: 'east', to: 'r2', via: 'blown wall' } },
            ],
          };
        }
        return { text: 'The wall folds down in dust.', finishReason: 'stop', usage: USAGE };
      }),
      resolveAdapter: noPassthrough(),
    };
    const start = { inventory: { bomb: 1 }, room: 'f1:r1' };
    const { text, state } = await runTurn(
      makeAdapter(delegate), 'blow the east wall open with my bomb', JSON.stringify(start), [{ role: 'assistant', content: F1_BLOB }],
    );
    expect(state.escalations).toBe(1);
    expect(state.inventory['bomb']).toBeUndefined(); // consumed by Lua
    expect(text).toContain('The wall folds down in dust.');
    expect(text).toContain('[pack f1]'); // new pack version appended
    expect(text).toContain('"east":"r2"');
    // The attempt result — roll, total, difficulty — reached the model as a tool_result.
    const transcript = JSON.stringify(calls[calls.length - 1]!.messages);
    expect(transcript).toContain('\\"roll\\":');
    expect(transcript).toContain('\\"difficulty\\":12');
  });

  it('canonical records: removing an un-carried item and invalid exits come back as failures', async () => {
    const calls: Prompt[] = [];
    const delegate: CustomBackendDelegate = {
      generate: vi.fn(async (_configId: string | null, prompt: Prompt): Promise<DelegatedGenerateResult> => {
        calls.push(JSON.parse(JSON.stringify(prompt)) as Prompt);
        const transcript = JSON.stringify(prompt.messages);
        if (!transcript.includes('"remove_item"')) {
          return {
            text: '', finishReason: 'stop', usage: USAGE,
            toolCalls: [
              { id: 'a1', name: 'remove_item', arguments: { name: 'bomb' } },
              { id: 'a2', name: 'add_exit', arguments: { direction: 'down', to: 'r9' } }, // r9: no such room
            ],
          };
        }
        return { text: 'Nothing works.', finishReason: 'stop', usage: USAGE };
      }),
      resolveAdapter: noPassthrough(),
    };
    const { state } = await runTurn(
      makeAdapter(delegate), 'throw my bomb down the hole', JSON.stringify({ room: 'f1:r1' }), [{ role: 'assistant', content: F1_BLOB }],
    );
    const transcript = JSON.stringify(calls[calls.length - 1]!.messages);
    expect(transcript).toContain('not carried: bomb');
    expect(transcript).toContain('rejected');
    expect(state.inventory['bomb']).toBeUndefined();
  });

  it('combat is served from canned lines with zero delegate calls', async () => {
    const delegate = neverDelegate();
    const start = {
      room: 'f1:r2',
      combat: { name: 'Crypt Rat', hp: 3, maxHp: 3, atk: 1, reward: 5,
        lines: { intro: 'It lunges.', hit: 'The rat sinks its teeth in.', death: 'The rat twitches and is still.' } },
    };
    const { text, state } = await runTurn(
      makeAdapter(delegate), 'attack', JSON.stringify(start), [{ role: 'assistant', content: F1_BLOB }],
    );
    expect(text).toContain('The rat twitches and is still.');
    expect(text).toContain('(+5 gold)');
    expect(state.combat).toBeUndefined();
    expect(state.gold).toBe(5);
    expect(vi.mocked(delegate.generate).mock.calls).toHaveLength(0);
  });

  it('combat is a MODE: movement and interactables are gated, only attack/flee verbs and buttons', async () => {
    const start = {
      room: 'f1:r2',
      combat: { name: 'Crypt Rat', hp: 30, maxHp: 30, atk: 1, reward: 5,
        lines: { intro: 'It lunges.', hit: 'The rat sinks its teeth in.', death: 'The rat twitches and is still.' } },
    };
    // You cannot just walk away mid-fight.
    const t1 = await runTurn(makeAdapter(neverDelegate()), 'go south', JSON.stringify(start),
      [{ role: 'assistant', content: F1_BLOB }]);
    expect(t1.text).toContain('between you and everything else');
    expect(t1.state.room).toBe('f1:r2'); // no move happened
    expect(t1.state.combat?.name).toBe('Crypt Rat');
    // The button row matches the mode: Attack and Flee, no exits.
    expect(t1.text).toContain('data-post-response="/flee"');
    expect(t1.text).not.toContain('data-post-response="/go');
    // Interactables are gated too.
    const t2 = await runTurn(makeAdapter(neverDelegate()), 'open the crate', t1.scriptState,
      [{ role: 'assistant', content: F1_BLOB }]);
    expect(t2.text).toContain('between you and everything else');
    expect(t2.state.gold).toBe(0);
  });

  it('flee: failure costs a hit, success returns you to the entrance', async () => {
    const start = {
      room: 'f1:r2',
      combat: { name: 'Crypt Rat', hp: 30, maxHp: 30, atk: 2, reward: 5,
        lines: { intro: 'It lunges.', hit: 'The rat sinks its teeth in.', death: 'The rat twitches and is still.' } },
    };
    const history = [{ role: 'assistant', content: F1_BLOB }];

    // Always-fail: the knob flipped so the roll can never make the DC.
    const luaNoEscape = luaSource.replace('local FLEE_DC = 8', 'local FLEE_DC = 100');
    expect(luaNoEscape).not.toBe(luaSource);
    const t1 = await runTurn(makeAdapter(neverDelegate(), luaNoEscape), 'flee', JSON.stringify(start), history);
    expect(t1.text).toContain('no escape');
    expect(t1.state.hp).toBeLessThan(t1.state.maxHp); // failure stings
    expect(t1.state.combat?.name).toBe('Crypt Rat'); // still in the fight
    expect(t1.state.room).toBe('f1:r2');

    // Always-succeed: combat clears and you're back at the floor entrance.
    const luaFreeExit = luaSource.replace('local FLEE_DC = 8', 'local FLEE_DC = -100');
    const t2 = await runTurn(makeAdapter(neverDelegate(), luaFreeExit), 'flee', JSON.stringify(start), history);
    expect(t2.text).toContain('scramble back');
    expect(t2.state.combat).toBeUndefined();
    expect(t2.state.room).toBe('f1:r1'); // the entrance
  });

  it('the ledger: a debt escalates to DUE NOW in the DM prompt, resolves, and leaves', async () => {
    const calls: Prompt[] = [];
    const delegate: CustomBackendDelegate = {
      generate: vi.fn(async (_configId: string | null, prompt: Prompt): Promise<DelegatedGenerateResult> => {
        calls.push(JSON.parse(JSON.stringify(prompt)) as Prompt);
        const transcript = JSON.stringify(prompt.messages);
        if (transcript.includes('DUE NOW') && !transcript.includes('"resolve_promise"')) {
          return {
            text: '', finishReason: 'stop', usage: USAGE,
            toolCalls: [{ id: 'r1', name: 'resolve_promise', arguments: { id: 'rising_water' } }],
          };
        }
        return { text: 'The water sloshes higher.', finishReason: 'stop', usage: USAGE };
      }),
      resolveAdapter: noPassthrough(),
    };
    const adapter = makeAdapter(delegate);
    const start = { room: 'f1:r1', turn: 4, promises: [{ id: 'rising_water', what: 'The water keeps rising', turn: 5 }] };

    // state.turn hits 5 during this escalation → the debt is due in the DM prompt.
    const t1 = await runTurn(adapter, 'wait a moment', JSON.stringify(start), [{ role: 'assistant', content: F1_BLOB }]);
    expect(t1.state.escalations).toBe(1);
    const duePrompt = calls.map((c) => c.messages[0]!).find((m) =>
      typeof m.content === 'string' && m.content.includes('DUE NOW'));
    expect(duePrompt).toBeDefined();
    expect(duePrompt!.content).toContain('The water keeps rising');
    expect(t1.state.promises![0]!.status).toBe('kept');

    // Next escalation: the resolved debt no longer rides in the DM prompt.
    await runTurn(adapter, 'wait again', t1.scriptState, [{ role: 'assistant', content: F1_BLOB }]);
    const lastPrompt = calls[calls.length - 1]!.messages[0]!;
    expect(lastPrompt.content).not.toContain('rising_water');
  });

  it('the ledger rejects vague due dates', async () => {
    const calls: Prompt[] = [];
    const delegate: CustomBackendDelegate = {
      generate: vi.fn(async (_configId: string | null, prompt: Prompt): Promise<DelegatedGenerateResult> => {
        calls.push(JSON.parse(JSON.stringify(prompt)) as Prompt);
        const transcript = JSON.stringify(prompt.messages);
        if (!transcript.includes('"promise"')) {
          return {
            text: '', finishReason: 'stop', usage: USAGE,
            toolCalls: [{ id: 'p1', name: 'promise', arguments: { id: 'vague', what: 'something later' } }],
          };
        }
        return { text: 'Noted.', finishReason: 'stop', usage: USAGE };
      }),
      resolveAdapter: noPassthrough(),
    };
    const { state } = await runTurn(
      makeAdapter(delegate), 'do something odd', JSON.stringify({ room: 'f1:r1' }), [{ role: 'assistant', content: F1_BLOB }],
    );
    expect(Object.keys(state.promises ?? {}).length).toBe(0);
    expect(JSON.stringify(calls[calls.length - 1]!.messages)).toContain('rejected');
  });

  it('recall returns verbatim text from the full branch', async () => {
    const VERBATIM = 'the goblin ambush at the gate went badly — you barely crawled out';
    const history = [
      { role: 'user', content: 'we head into the crypt' },
      { role: 'assistant', content: VERBATIM },
      { role: 'assistant', content: F1_BLOB },
      ...Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `filler ${i}` })),
    ];
    const calls: Prompt[] = [];
    let round = 0;
    const delegate: CustomBackendDelegate = {
      generate: vi.fn(async (_configId: string | null, prompt: Prompt): Promise<DelegatedGenerateResult> => {
        calls.push(JSON.parse(JSON.stringify(prompt)) as Prompt);
        round++;
        if (round === 1) {
          return {
            text: '', finishReason: 'stop', usage: USAGE,
            toolCalls: [{ id: 'c1', name: 'recall', arguments: { query: 'goblin ambush' } }],
          };
        }
        return { text: 'You remember it vividly.', finishReason: 'stop', usage: USAGE };
      }),
      resolveAdapter: noPassthrough(),
    };
    await runTurn(makeAdapter(delegate), 'remind me how that went', JSON.stringify({ room: 'f1:r1' }), history);
    const continuation = JSON.stringify(calls[calls.length - 1]!.messages);
    expect(continuation).toContain(VERBATIM);
  });

  describe('collapseBlocks in the DM transcript', () => {
    function plainDelegate() {
      const calls: Prompt[] = [];
      const delegate: CustomBackendDelegate = {
        generate: vi.fn(async (_configId: string | null, prompt: Prompt): Promise<DelegatedGenerateResult> => {
          calls.push(JSON.parse(JSON.stringify(prompt)) as Prompt);
          return { text: ' adjudicated. ', finishReason: 'stop', usage: USAGE };
        }),
        resolveAdapter: noPassthrough(),
      };
      return { delegate, calls };
    }

    const dmView = (calls: Prompt[]) => JSON.stringify(calls[0]!.messages);

    it('pair visible: the pack blob collapses to its summary', async () => {
      const { delegate, calls } = plainDelegate();
      await runTurn(makeAdapter(delegate), 'something novel', JSON.stringify({ room: 'f1:r1' }),
        [{ role: 'assistant', content: F1_BLOB }], 'normal', [{ role: 'assistant', content: F1_BLOB }]);
      const seen = dmView(calls);
      expect(seen).toContain('Designed The Upper Halls');
      expect(seen).not.toContain('[/pack f1'); // the raw blob tag never reaches the DM
    });

    it('orphan close: the visible prefix is the block tail and collapses with it', async () => {
      const { delegate, calls } = plainDelegate();
      await runTurn(makeAdapter(delegate), 'something novel', JSON.stringify({ room: 'f1:r1' }),
        [{ role: 'assistant', content: F1_BLOB }], 'normal', [
          { role: 'assistant', content: 'The battle rages on.' },
          { role: 'assistant', content: 'You limp onward. [/pack f1 summary="Designed the Halls."]' },
        ]);
      const seen = dmView(calls);
      expect(seen).toContain('Designed the Halls.');
      expect(seen).not.toContain('battle rages');
    });

    it('orphan open: still open on this branch — text stays verbatim', async () => {
      const { delegate, calls } = plainDelegate();
      await runTurn(makeAdapter(delegate), 'something novel', JSON.stringify({ room: 'f1:r1' }),
        [{ role: 'assistant', content: F1_BLOB }], 'normal', [{ role: 'assistant', content: '[pack f1]\npartial draft text' }]);
      const seen = dmView(calls);
      expect(seen).toContain('[pack f1]\\npartial draft text');
    });

    it('the ack-hiding display rule never mangles button payloads', async () => {
      const DISPLAY_RULE = /\s*\[sys\].*?\[\/sys\]\s*/gis;
      // A normal turn carries bare-command buttons — the rule must leave them alone.
      const calls: Prompt[] = [];
      const t1 = await runTurn(makeAdapter(planningDelegate(calls)), 'look', undefined);
      expect(t1.text).toContain('data-post-response="/go north"');
      expect(t1.text.replace(DISPLAY_RULE, '\n\n')).toContain('data-post-response="/go north"');

      // An ack with buttons riding along: the ack hides, the payload survives.
      const ack = '[sys]Nothing here fights back.[/sys]\n<button data-post-response="/go north">Go north</button>';
      const renderedAck = ack.replace(DISPLAY_RULE, '\n\n');
      expect(renderedAck).not.toContain('[sys]');
      expect(renderedAck).toContain('data-post-response="/go north"');
    });
  });
});
