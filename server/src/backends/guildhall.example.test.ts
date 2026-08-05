/**
 * Validates the merged Guildhall card (hall hub + dungeon + events engine):
 * docs/design/examples/guildhall/main.lua. Real LuaBackendAdapter, scripted
 * delegates, scriptState and branch history threaded between turns like the
 * engine does. Covers the union of the former Crypt (factory) and Guildhall
 * (event-engine) behaviors plus the merge-only contracts: /delve enters the
 * dungeon, an event can open mid-combat and resume it, and death/relic end
 * the DELVE (return to hall), not the game.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { LuaRuntime } from '../scripting/LuaRuntime.js';
import {
  LuaBackendAdapter,
  type CustomBackendDelegate,
  type DelegatedGenerateResult,
} from './LuaBackendAdapter.js';
import { MemoryScriptBlobRepository } from './MemoryScriptBlobRepository.js';
import { consumeStream, type BackendStreamItem, type Prompt } from './BackendAdapter.js';

const luaSource = readFileSync(new URL('../../../docs/design/examples/guildhall/main.lua', import.meta.url), 'utf8');

// The card VFS: main.lua requires all twelve vendored game-lib modules.
const LIB_FILES: Record<string, string> = Object.fromEntries(
  ['loop', 'sanitize', 'chrome', 'ledger', 'toolset', 'todo', 'registry', 'summarize', 'maptag', 'events', 'rolling'].map((m) => [
    `lib/${m}.lua`,
    readFileSync(new URL(`../../../docs/design/examples/game-lib/${m}.lua`, import.meta.url), 'utf8'),
  ]),
);

const USAGE = { promptTokens: 1, completionTokens: 1 };

interface DunState {
  maxHp: number;
  hp: number;
  atk: number;
  inventory: Record<string, number>;
  room: string;
  combat?: { name: string; hp: number; maxHp: number; atk: number; lines: { intro: string; hit: string; death: string }; reward: number };
  seen: Record<string, true>;
  escalations: number;
  packIds?: Record<string, string>;
  fightLog?: Array<{ role: string; content: string }>;
  fightName?: string;
  delveOver?: 'dead' | 'won' | null;
}
interface MergeState {
  mode: 'hall' | 'dungeon';
  gold: number;
  flags: Record<string, unknown>;
  turn: number;
  dun: DunState;
  onboarded?: boolean;
  playerName?: string;
  promises?: Array<{ id: string; what: string; due: number; status?: string }>;
  event?: { id: string; kind: string; context: string; participants: string[]; closed?: { gist: string } };
  characters?: Array<{ id: string; name: string; role?: string; personality?: string }>;
  dossiers?: Record<string, string[]>;
  story?: string[];
}

function makeAdapter(delegate: CustomBackendDelegate, source = luaSource): LuaBackendAdapter {
  return new LuaBackendAdapter({
    id: 'custom:guildhall',
    name: 'The Guildhall',
    luaSource: source,
    runtime: new LuaRuntime(),
    delegate,
    vfsFiles: LIB_FILES,
    blobs: testBlobs,
  });
}

function noPassthrough() {
  return vi.fn(async () => {
    throw new Error('passthrough not expected');
  });
}

function neverDelegate(): CustomBackendDelegate {
  return {
    generate: vi.fn(async (): Promise<DelegatedGenerateResult> => {
      throw new Error('delegate not expected');
    }),
    resolveAdapter: noPassthrough(),
  };
}

/** Always answers plain prose, never calls a tool — exercises content-outcome paths (fallback gist). */
function textOnlyDelegate(): CustomBackendDelegate {
  return {
    generate: vi.fn(async (): Promise<DelegatedGenerateResult> => ({ text: 'She nods and turns away.', finishReason: 'stop', usage: USAGE })),
    resolveAdapter: noPassthrough(),
  };
}

async function runTurnRaw(
  adapter: LuaBackendAdapter,
  userText: string,
  scriptState: string | undefined,
  history?: Array<{ role: string; content: string }>,
  generationType: 'normal' | 'continue' = 'normal',
  extraMessages?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
) {
  const prompt: Prompt = {
    messages: [
      { role: 'system', content: 'Base system prompt.' },
      ...(extraMessages ?? []),
      ...(history ?? []).map((h) => ({ role: h.role as 'user' | 'assistant', content: h.content })),
      { role: 'user', content: userText },
    ],
    tokenUsage: { prompt: 0, completion: 0 },
  };
  return consumeStream(
    adapter.stream(prompt, new AbortController().signal, {
      chatId: 'guild-chat',
      generationType,
      scriptState,
      ...(history
        ? { branchHistory: async () => history.map((h, i) => ({ id: `h-${i + 1}`, role: h.role, content: h.content })) }
        : {}),
    }),
  );
}

async function runTurn(
  adapter: LuaBackendAdapter,
  userText: string,
  scriptState: string | undefined,
  history?: Array<{ role: string; content: string }>,
  generationType: 'normal' | 'continue' = 'normal',
  extraMessages?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
): Promise<{ text: string; state: MergeState; scriptState: string }> {
  const { items, result } = await runTurnRaw(adapter, userText, scriptState, history, generationType, extraMessages);
  expect(result.error).toBeUndefined();
  const text = items
    .filter((i): i is Extract<BackendStreamItem, { type: 'text' }> => i.type === 'text')
    .map((i) => i.token)
    .join('');
  expect(result.scriptState).toBeDefined();
  return { text, state: JSON.parse(result.scriptState!) as MergeState, scriptState: result.scriptState! };
}

const sysOf = (p: Prompt): string => (typeof p.messages[0]?.content === 'string' ? (p.messages[0].content as string) : '');
const clone = (p: Prompt): Prompt => JSON.parse(JSON.stringify(p)) as Prompt;

/** A floor pack blob: 3 rooms, one Crypt Rat, a crate with 5 gold in r1. */
/** The floor-1 pack as a bare store blob (what findPack reads via the pointer). */
const F1_PACK = `{"id":"f1","name":"The Upper Halls","description":"Dust and old bones, galleries collapsing inward.","entrance":"r1","stairsDown":"r3","rooms":{"r1":{"name":"Collapsed Nave","desc":"Dust and old bones.","exits":{"north":"r2"}},"r2":{"name":"Ossuary","desc":"Stacked femurs like cordwood.","exits":{"south":"r1","east":"r3"}},"r3":{"name":"Silent Choir","desc":"Stone seats in rows.","exits":{"west":"r2","down":"down"}}},"encounterTable":[{"name":"Crypt Rat","hp":3,"maxHp":3,"atk":1,"reward":5,"lines":{"intro":"It lunges.","hit":"The rat sinks its teeth in.","death":"The rat twitches and is still."}}],"interactables":{"r1:crate":{"responses":["Inside: a few coins and a rat nest.","Just the rat nest now."],"effect":{"gold":5}}},"ambient":["Water drips below."]}`;

/** Floor pack whose r1 interactable grants the relic (the WIN item). */
const RELIC_PACK = `{"id":"f1","name":"The Upper Halls","description":"Dust and old bones.","entrance":"r1","stairsDown":"r3","rooms":{"r1":{"name":"Collapsed Nave","desc":"Dust and old bones.","exits":{"north":"r2"}},"r2":{"name":"Ossuary","desc":"Femurs.","exits":{"south":"r1"}},"r3":{"name":"Silent Choir","desc":"Seats.","exits":{"west":"r2"}}},"encounterTable":[],"interactables":{"r1:relic":{"responses":["You take the relic. It hums in your grip."],"effect":{"item":"relic"}}},"ambient":[]}`;

/** The pointer every floor-1 test state carries (matches the beforeEach seed). */
const F1_POINTER = { f1: 'pack:f1#1' };

/** Shared per-test blob heap — seeded with floor 1 under the default pointer. */
let testBlobs: MemoryScriptBlobRepository;

const ALDRIC = { id: 'ser-aldric', name: 'Ser Aldric', role: 'old knight', personality: 'grizzled, debt-hungry, quietly honorable' };

/** Dungeon mode, standing in r1 of floor 1, full hp. */
function dungeonState(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    mode: 'dungeon',
    gold: 0,
    flags: {},
    turn: 4,
    onboarded: true,
    playerName: 'Tester',
    dun: { maxHp: 20, hp: 20, atk: 4, inventory: {}, room: 'f1:r1', seen: { 'f1:r1': true }, escalations: 0, packIds: { ...F1_POINTER } },
    ...extra,
  });
}

/** Hall mode, already onboarded (the normal post-registration state). */
function hallState(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    mode: 'hall',
    gold: 30,
    flags: {},
    turn: 1,
    onboarded: true,
    playerName: 'Tester',
    dun: { maxHp: 20, hp: 20, atk: 4, inventory: {}, room: 'f1', seen: {}, escalations: 0 },
    ...extra,
  });
}

/** Hall mode with an open recruitment event featuring Ser Aldric. */
function eventState(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    mode: 'hall',
    gold: 30,
    flags: {},
    turn: 5,
    onboarded: true,
    playerName: 'Tester',
    dun: { maxHp: 20, hp: 20, atk: 4, inventory: {}, room: 'f1', seen: {}, escalations: 0 },
    characters: [ALDRIC],
    event: { id: 'e1', kind: 'recruitment', context: 'A barbarian recruiting an old knight', participants: ['ser-aldric'] },
    ...extra,
  });
}

/** Delegate that designs floor 1 via tool calls, then writes the intro. */
function planningDelegate(): CustomBackendDelegate {
  let round = 0;
  return {
    generate: vi.fn(async (_cfg: string | null, prompt: Prompt): Promise<DelegatedGenerateResult> => {
      round++;
      if (sysOf(prompt).includes('content designer') && round === 1) {
        return {
          text: '', finishReason: 'stop', usage: USAGE,
          toolCalls: [
            { id: 'd1', name: 'add_description', arguments: { text: 'Dust and old bones, galleries collapsing inward.' } },
            { id: 'r1', name: 'add_rooms', arguments: { rooms: [
              { id: 'r1', name: 'Collapsed Nave', desc: 'Dust and old bones.', exits: { north: 'r2' } },
              { id: 'r2', name: 'Ossuary', desc: 'Stacked femurs like cordwood.', exits: { south: 'r1', east: 'r3' } },
              { id: 'r3', name: 'Silent Choir', desc: 'Stone seats in rows.', exits: { west: 'r2', down: 'DOWN' } },
            ] } },
            { id: 'e1', name: 'add_encounter', arguments: { name: 'Crypt Rat', hp: 3, atk: 1, reward: 5, lines: { intro: 'It lunges.', hit: 'The rat sinks its teeth in.', death: 'The rat twitches and is still.' } } },
            { id: 'i1', name: 'add_interactable', arguments: { room: 'r1', name: 'crate', responses: ['Inside: a few coins and a rat nest.', 'Just the rat nest now.'], effect: { gold: 5 } } },
            { id: 'a1', name: 'add_ambient', arguments: { lines: ['Water drips below.'] } },
          ],
        };
      }
      return { text: 'You stand in the Collapsed Nave.', finishReason: 'stop', usage: USAGE };
    }),
    resolveAdapter: noPassthrough(),
  };
}

/**
 * Hall route: the hall DM opens a recruitment event (no casting); the
 * scene-runner then casts Ser Aldric and writes the first reply.
 * Captures every prompt for the frozen-prefix assertion.
 */
function hallEventDelegate(prompts: Prompt[] = []): CustomBackendDelegate {
  return {
    generate: vi.fn(async (_cfg: string | null, prompt: Prompt): Promise<DelegatedGenerateResult> => {
      const sys = sysOf(prompt);
      if (sys.includes('idle hall')) {
        if (!JSON.stringify(prompt.messages).includes('"open_event"')) {
          return { text: 'You cross the hall to the quest board.', finishReason: 'stop', usage: USAGE,
            toolCalls: [{ id: 'o1', name: 'open_event', arguments: { kind: 'recruitment', context: 'A barbarian recruiting an old knight' } }] };
        }
        return { text: 'You cross the hall to the quest board.', finishReason: 'stop', usage: USAGE };
      }
      prompts.push(clone(prompt));
      const js = JSON.stringify(prompt.messages);
      if (!js.includes('ser-aldric')) {
        return { text: '', finishReason: 'stop', usage: USAGE,
          toolCalls: [
            { id: 'l1', name: 'list_characters', arguments: {} },
            { id: 'g1', name: 'register_character', arguments: { name: 'Ser Aldric', role: 'old knight' } },
            { id: 'a1', name: 'add_to_chat', arguments: { id: 'ser-aldric' } },
          ] };
      }
      return { text: '"What\'s the offer?" the knight rumbles.', finishReason: 'stop', usage: USAGE };
    }),
    resolveAdapter: noPassthrough(),
  };
}

/** Scene-runner that closes the event with a gist + one participant take. */
function closeDelegate(): CustomBackendDelegate {
  let round = 0;
  return {
    generate: vi.fn(async (_cfg: string | null, _prompt: Prompt): Promise<DelegatedGenerateResult> => {
      round++;
      if (round === 1) {
        return { text: '', finishReason: 'stop', usage: USAGE,
          toolCalls: [{ id: 'c1', name: 'close_event', arguments: {
            gist: 'Recruited Ser Aldric at the quest board.',
            takes: { 'ser-aldric': 'Hired by a barbarian who paid up front.' },
          } }] };
      }
      return { text: '"Done, then."', finishReason: 'stop', usage: USAGE };
    }),
    resolveAdapter: noPassthrough(),
  };
}

/** Dungeon DM that opens an event (the mid-combat headline). */
function dungeonDmOpensEventDelegate(): CustomBackendDelegate {
  return {
    generate: vi.fn(async (_cfg: string | null, prompt: Prompt): Promise<DelegatedGenerateResult> => {
      const sys = sysOf(prompt);
      if (sys.includes('terse dungeon crawler')) {
        // Like a real model: open the event once, then narrate — the tool
        // result is in the messages on later rounds.
        if (!JSON.stringify(prompt.messages).includes('"open_event"')) {
          return { text: 'The rat chitters, head cocked.', finishReason: 'stop', usage: USAGE,
            toolCalls: [{ id: 'o1', name: 'open_event', arguments: { kind: 'parley', context: 'A barbarian sizing up a crypt rat' } }] };
        }
        return { text: 'The rat chitters, head cocked.', finishReason: 'stop', usage: USAGE };
      }
      // scene-runner first block
      return { text: 'The rat does not blink.', finishReason: 'stop', usage: USAGE };
    }),
    resolveAdapter: noPassthrough(),
  };
}

/** Dungeon DM that exercises the cost economy (attempt + add_exit + remove_item). */
function dungeonEconomyDelegate(): CustomBackendDelegate {
  let round = 0;
  return {
    generate: vi.fn(async (_cfg: string | null, _prompt: Prompt): Promise<DelegatedGenerateResult> => {
      round++;
      if (round === 1) {
        return { text: '', finishReason: 'stop', usage: USAGE,
          toolCalls: [{ id: 'a1', name: 'attempt', arguments: { action: 'force the door', difficulty: 12 } }] };
      }
      if (round === 2) {
        return { text: '', finishReason: 'stop', usage: USAGE,
          toolCalls: [
            { id: 'r1', name: 'remove_item', arguments: { name: 'bomb' } },
            { id: 'x1', name: 'add_exit', arguments: { direction: 'east', to: 'r3', via: 'blown wall' } },
          ] };
      }
      return { text: 'The way opens.', finishReason: 'stop', usage: USAGE };
    }),
    resolveAdapter: noPassthrough(),
  };
}

describe('The Guildhall (merged card)', () => {
  beforeEach(() => {
    testBlobs = new MemoryScriptBlobRepository();
    testBlobs.seed('pack:f1#1', F1_PACK); // matches F1_POINTER in the state helpers
  });

  describe('hall hub', () => {
    it('menu /shop and /smith are free (no delegate)', async () => {
      const adapter = makeAdapter(neverDelegate());
      const t1 = await runTurn(adapter, '/shop', hallState());
      expect(t1.text).toContain('quartermaster');
      expect(t1.state.mode).toBe('hall');
      const t2 = await runTurn(adapter, '/smith', t1.scriptState);
      expect(t2.text).toContain('blacksmith');
    });

    it('hall continue is ambient, no delegate', async () => {
      const t = await runTurn(makeAdapter(neverDelegate()), '', hallState(), undefined, 'continue');
      expect(t.text).toContain('The hall murmurs on.');
    });

    it('/delve enters the dungeon: mode flips, planning designs f1, pack in the log', async () => {
      const t = await runTurn(makeAdapter(planningDelegate()), '/delve', hallState());
      expect(t.state.mode).toBe('dungeon');
      expect(t.state.dun.room).toBe('f1:r1');
      expect(t.text).toContain('Designed The Upper Halls');
      expect(t.text).toContain('Collapsed Nave');
      expect(t.text).toContain('data-post-response="/go north"');
      expect(t.text).not.toContain('data-post-response="/delve"'); // hall menu gone
    });
  });

  describe('dungeon (factory ratio)', () => {
    it('planning the deepest floor (f3) yields no stairs down — descend cannot soft-lock', async () => {
      // Regression: validateGraph used to inject a stairs-down on EVERY floor,
      // so f3 (terminal) offered a Descend button to a non-existent f4 —
      // "Nowhere to go.", no buttons, no recovery. f3 is terminal now: the
      // designed `down` exit is stripped and none is injected, so serve never
      // offers "go down" on f3 and the relic stays the only way out.
      let call = 0;
      const delegate: CustomBackendDelegate = {
        generate: vi.fn(async (_cfg: string | null, prompt: Prompt): Promise<DelegatedGenerateResult> => {
          call++;
          if (sysOf(prompt).includes('content designer') && call === 1) {
            return { text: '', finishReason: 'stop', usage: USAGE,
              toolCalls: [
                { id: 'r', name: 'add_rooms', arguments: { rooms: [
                  { id: 'r1', name: 'Entry Vault', desc: 'Sealed stone.', exits: { north: 'r2' } },
                  { id: 'r2', name: 'Relic Chamber', desc: 'A plinth.', exits: { south: 'r1', down: 'DOWN' } },
                ] } },
                { id: 'i', name: 'add_interactable', arguments: { room: 'r2', name: 'relic', responses: ['You take the relic.'], effect: { item: 'relic' } } },
              ] };
          }
          return { text: 'Sealed vaults; something glints on a plinth.', finishReason: 'stop', usage: USAGE };
        }),
        resolveAdapter: noPassthrough(),
      };
      const start = dungeonState({ dun: { maxHp: 20, hp: 20, atk: 4, inventory: {}, room: 'f3', seen: {}, escalations: 0 } });
      const t = await runTurn(makeAdapter(delegate), 'look', start);
      expect(t.text).toContain('Designed The Relic Vaults');
      // The pack blob lives in the store, not the message — assert on it.
      const blob = await testBlobs.get(t.state.dun.packIds?.f3 ?? '');
      expect(blob).not.toContain('"down":"down"'); // the designed stairs were stripped
      expect(blob).not.toContain('"stairsDown"'); // and none was injected on the terminal floor
      expect(t.text).not.toContain('data-post-response="/go down"'); // no Descend button offered
    });

    it('serve: interact then move are free (no delegate); the crate pays once', async () => {
      const adapter = makeAdapter(neverDelegate());
      const t1 = await runTurn(adapter, 'open the crate', dungeonState());
      expect(t1.text).toContain('Inside: a few coins');
      expect(t1.state.gold).toBe(5);
      const t2 = await runTurn(adapter, 'open the crate', t1.scriptState);
      expect(t2.state.gold).toBe(5); // repeat pays nothing
      const t3 = await runTurn(adapter, 'go north', t2.scriptState);
      expect(t3.state.dun.room).toBe('f1:r2');
      expect(t3.text).toContain('Ossuary');
    });

    it('combat: a kill is served from canned lines with zero delegate calls', async () => {
      const start = dungeonState({ dun: { maxHp: 20, hp: 20, atk: 4, inventory: {}, room: 'f1:r2', seen: { 'f1:r2': true }, escalations: 0, packIds: { ...F1_POINTER },
        combat: { name: 'Crypt Rat', hp: 3, maxHp: 3, atk: 1, reward: 5, lines: { intro: 'It lunges.', hit: 'The rat sinks its teeth in.', death: 'The rat twitches and is still.' } } } });
      const delegate = neverDelegate();
      const t = await runTurn(makeAdapter(delegate), 'attack', start);
      expect(t.text).toContain('The rat twitches and is still.');
      expect(t.text).toContain('(+5 gold)');
      expect(t.state.dun.combat).toBeUndefined();
      expect(t.state.gold).toBe(5);
      expect(vi.mocked(delegate.generate).mock.calls).toHaveLength(0);
    });

    it('combat is a mode: movement is gated, only attack/flee buttons', async () => {
      const start = dungeonState({ dun: { maxHp: 20, hp: 20, atk: 4, inventory: {}, room: 'f1:r2', seen: { 'f1:r2': true }, escalations: 0, packIds: { ...F1_POINTER },
        combat: { name: 'Crypt Rat', hp: 30, maxHp: 30, atk: 1, reward: 5, lines: { intro: 'It lunges.', hit: 'The rat bites.', death: 'It dies.' } } } });
      const t = await runTurn(makeAdapter(neverDelegate()), 'go south', start);
      expect(t.text).toContain('between you and everything else');
      expect(t.state.dun.room).toBe('f1:r2'); // no move
      expect(t.text).toContain('data-post-response="/flee"');
      expect(t.text).not.toContain('data-post-response="/go');
    });

    it('flee: failure costs a hit, success returns to the entrance', async () => {
      const combat = { name: 'Crypt Rat', hp: 30, maxHp: 30, atk: 2, reward: 5, lines: { intro: 'It lunges.', hit: 'The rat bites.', death: 'It dies.' } };
      const start = dungeonState({ dun: { maxHp: 20, hp: 20, atk: 4, inventory: {}, room: 'f1:r2', seen: { 'f1:r2': true }, escalations: 0, packIds: { ...F1_POINTER }, combat } });
      const noEscape = luaSource.replace('local FLEE_DC = 8', 'local FLEE_DC = 100');
      const t1 = await runTurn(makeAdapter(neverDelegate(), noEscape), 'flee', start);
      expect(t1.text).toContain('no escape');
      expect(t1.state.dun.hp).toBeLessThan(20);
      expect(t1.state.dun.combat?.name).toBe('Crypt Rat');
      const freeExit = luaSource.replace('local FLEE_DC = 8', 'local FLEE_DC = -100');
      const t2 = await runTurn(makeAdapter(neverDelegate(), freeExit), 'flee', start);
      expect(t2.text).toContain('scramble back');
      expect(t2.state.dun.combat).toBeUndefined();
      expect(t2.state.dun.room).toBe('f1:r1'); // floor entrance
    });

    it('escalation: the dungeon DM resolves novelty; costs are deducted by Lua', async () => {
      const start = dungeonState({ dun: { maxHp: 20, hp: 20, atk: 4, inventory: { bomb: 1 }, room: 'f1:r2', seen: { 'f1:r2': true }, escalations: 0, packIds: { ...F1_POINTER } } });
      const t = await runTurn(makeAdapter(dungeonEconomyDelegate()), 'I blow the door open', start);
      expect(t.state.dun.escalations).toBe(1);
      expect(t.state.dun.inventory.bomb).toBeUndefined(); // consumed by the engine
      expect(t.text).toContain('Designed The Upper Halls'); // the pack marker for the new version
      // The mutation is a NEW blob; the pointer moved to it.
      expect(t.state.dun.packIds?.f1).not.toBe('pack:f1#1');
      const blob = await testBlobs.get(t.state.dun.packIds?.f1 ?? '');
      expect(blob).toContain('"east":"r3"'); // the new exit
    });

    it('death ends the delve and returns you to the hall — not the game', async () => {
      const start = dungeonState({ dun: { maxHp: 20, hp: 1, atk: 4, inventory: {}, room: 'f1:r2', seen: { 'f1:r2': true }, escalations: 0, packIds: { ...F1_POINTER },
        combat: { name: 'Crypt Rat', hp: 30, maxHp: 30, atk: 5, reward: 5, lines: { intro: 'It lunges.', hit: 'The rat savages you.', death: 'It dies.' } } } });
      const t1 = await runTurn(makeAdapter(neverDelegate()), 'attack', start);
      expect(t1.state.dun.delveOver).toBe('dead');
      expect(t1.text).toContain('Return to the hall');
      // Any input the next turn performs the reset — the card never terminally ends.
      const t2 = await runTurn(makeAdapter(neverDelegate()), 'leave dungeon', t1.scriptState);
      expect(t2.state.mode).toBe('hall');
      expect(t2.state.dun.delveOver).toBeUndefined();
      expect(t2.state.dun.hp).toBe(t2.state.dun.maxHp);
      expect(t2.text).toContain('data-post-response="/delve"'); // hall menu is back
    });

    it('the relic wins the delve and returns you to the hall with the flag set', async () => {
      testBlobs.seed('pack:f1#1', RELIC_PACK); // the floor where r1 holds the relic
      const start = dungeonState({ flags: {}, dun: { maxHp: 20, hp: 20, atk: 4, inventory: {}, room: 'f1:r1', seen: { 'f1:r1': true }, escalations: 0, packIds: { ...F1_POINTER } } });
      const t1 = await runTurn(makeAdapter(neverDelegate()), 'take the relic', start);
      expect(t1.state.dun.delveOver).toBe('won');
      expect(t1.state.flags.relic).toBe(true);
      expect(t1.text).toContain('Return to the hall');
      const t2 = await runTurn(makeAdapter(neverDelegate()), 'leave dungeon', t1.scriptState);
      expect(t2.state.mode).toBe('hall');
    });
  });

  describe('events (event engine)', () => {
    it('the hall DM frames the event; the scene-runner casts and writes', async () => {
      const prompts: Prompt[] = [];
      const t = await runTurn(makeAdapter(hallEventDelegate(prompts)), 'I go recruit the old knight', hallState());
      expect(t.text).toContain('"What\'s the offer?"'); // the scene reply is plain text now
      expect(t.text).toContain('data-post-response="/leave"');
      expect(t.text).not.toContain('data-post-response="/delve"'); // hall menu gated by the event
      expect(t.state.event?.kind).toBe('recruitment');
      expect(t.state.characters?.map((c) => c.id)).toContain('ser-aldric');
      // Regression: the greeting seed is onboarding-only — a normal hall event
      // must NOT be seeded with the receptionist's registration greeting.
      expect(prompts.length).toBeGreaterThan(0);
      expect(JSON.stringify(prompts[0]!.messages)).not.toContain('reception desk');
    });

    it('frozen prefix: within an event, turn N is a strict prefix of turn N+1', async () => {
      // One scene-runner call per turn (no casting tool loop) so each captured
      // prompt is a distinct turn and the append-only span grows by a block.
      const chats: Prompt[] = [];
      const delegate: CustomBackendDelegate = {
        generate: vi.fn(async (_cfg: string | null, prompt: Prompt): Promise<DelegatedGenerateResult> => {
          const sys = sysOf(prompt);
          if (sys.includes('idle hall')) {
            if (!JSON.stringify(prompt.messages).includes('"open_event"')) {
              return { text: 'You cross the hall.', finishReason: 'stop', usage: USAGE,
                toolCalls: [{ id: 'o1', name: 'open_event', arguments: { kind: 'recruitment', context: 'A barbarian recruiting an old knight' } }] };
            }
            return { text: 'You cross the hall.', finishReason: 'stop', usage: USAGE };
          }
          chats.push(clone(prompt));
          return { text: 'The knight strokes his beard.', finishReason: 'stop', usage: USAGE };
        }),
        resolveAdapter: noPassthrough(),
      };
      const adapter = makeAdapter(delegate);
      const t1 = await runTurn(adapter, 'I recruit the knight', hallState());
      const t2 = await runTurn(adapter, 'What is your rate?', t1.scriptState, [
        { role: 'user', content: 'I recruit the knight' },
        { role: 'assistant', content: t1.text },
      ]);
      await runTurn(adapter, 'Twenty gold?', t2.scriptState, [
        { role: 'user', content: 'I recruit the knight' },
        { role: 'assistant', content: t1.text },
        { role: 'user', content: 'What is your rate?' },
        { role: 'assistant', content: t2.text },
      ]);
      expect(chats.length).toBeGreaterThanOrEqual(2);
      const p2 = chats[chats.length - 2]!;
      const p3 = chats[chats.length - 1]!;
      expect(sysOf(p3)).toBe(sysOf(p2)); // system block byte-identical per event
      expect(p3.messages.length).toBeGreaterThan(p2.messages.length);
      expect(p3.messages.slice(0, p2.messages.length)).toEqual(p2.messages); // strict prefix
    });

    it('close_event: the gist rides the close tag; takes file the dossiers', async () => {
      const t = await runTurn(makeAdapter(closeDelegate()), 'Great. Let\'s go.', eventState());
      expect(t.text).toContain('Recruited Ser Aldric at the quest board.'); // the memoir line
      expect(t.state.dossiers?.['ser-aldric']).toHaveLength(1); // one rolling entry id
      expect(t.state.event).toBeUndefined();
      expect(t.text).toContain('data-post-response="/delve"'); // back to idle
    });

    it('/leave closes with a script-composed fallback gist when the model never calls close_event', async () => {
      const t = await runTurn(makeAdapter(textOnlyDelegate()), '/leave', eventState());
      expect(t.text).toContain('The recruitment breaks off.'); // script-composed fallback memoir
      expect(t.state.event).toBeUndefined();
    });

    it('/leave with a dead delegate fails loudly — no snapshot, the event stays open for the retry', async () => {
      const { result } = await runTurnRaw(makeAdapter(neverDelegate()), '/leave', eventState());
      expect(result.finishReason).toBe('error');
      expect(result.error).toContain('delegate not expected');
      expect(result.scriptState).toBeUndefined(); // nothing persisted: a swipe retries from the open event
    });

    it('events are modes: hall verbs gated while an event is open', async () => {
      const t = await runTurn(makeAdapter(neverDelegate()), '/delve', eventState());
      expect(t.text).toContain('Finish your business here first');
      expect(t.state.gold).toBe(30);
      expect(t.state.event?.kind).toBe('recruitment');
    });
  });

  describe('the mechanical span (full fidelity)', () => {
    it('tool rounds persist in the tail: the scene-runner never re-issues a read', async () => {
      // Turn 1: the scene-runner casts via tool calls. Turn 2: the tool_use /
      // tool_result blocks are IN the span, so the delegate sees ser-aldric in
      // context and answers directly — no re-read. (The old log-parsed span
      // carried no tool rounds; turn 2 would have re-called.)
      const scenePrompts: Prompt[] = [];
      const toolResults: Array<DelegatedGenerateResult['toolCalls']> = [];
      const delegate: CustomBackendDelegate = {
        generate: vi.fn(async (_cfg: string | null, prompt: Prompt): Promise<DelegatedGenerateResult> => {
          const sys = sysOf(prompt);
          if (sys.includes('idle hall')) {
            if (!JSON.stringify(prompt.messages).includes('"open_event"')) {
              return { text: 'You cross the hall to the quest board.', finishReason: 'stop', usage: USAGE,
                toolCalls: [{ id: 'o1', name: 'open_event', arguments: { kind: 'recruitment', context: 'A barbarian recruiting an old knight' } }] };
            }
            return { text: 'You cross the hall.', finishReason: 'stop', usage: USAGE };
          }
          scenePrompts.push(clone(prompt));
          const js = JSON.stringify(prompt.messages);
          if (!js.includes('ser-aldric')) {
            const calls = [
              { id: 'l1', name: 'list_characters', arguments: {} },
              { id: 'g1', name: 'register_character', arguments: { name: 'Ser Aldric', role: 'old knight' } },
              { id: 'a1', name: 'add_to_chat', arguments: { id: 'ser-aldric' } },
            ];
            toolResults.push(calls);
            return { text: '', finishReason: 'stop', usage: USAGE, toolCalls: calls };
          }
          toolResults.push(undefined);
          return { text: '"What\'s the offer?" the knight rumbles.', finishReason: 'stop', usage: USAGE };
        }),
        resolveAdapter: noPassthrough(),
      };
      const adapter = makeAdapter(delegate);
      const t1 = await runTurn(adapter, 'I recruit the knight', hallState());
      await runTurn(adapter, 'And lodging?', t1.scriptState, []);
      // Turn 2's prompt carries turn 1's tool exchange verbatim…
      const p2js = JSON.stringify(scenePrompts[scenePrompts.length - 1]!.messages);
      expect(p2js).toContain('"type":"tool_use"');
      expect(p2js).toContain('"type":"tool_result"');
      expect(p2js).toContain('ser-aldric');
      // …the cast rides the newest message (from state, not a tag)…
      expect(p2js).toContain('(on stage: ser-aldric)');
      // …so turn 2's scene-runner answer needed no tool call.
      expect(toolResults[toolResults.length - 1]).toBeUndefined();
    });

    it('the span does not depend on history: a turn with an empty message window still sees the whole scene', async () => {
      const scenePrompts: Prompt[] = [];
      const delegate: CustomBackendDelegate = {
        generate: vi.fn(async (_cfg: string | null, prompt: Prompt): Promise<DelegatedGenerateResult> => {
          const sys = sysOf(prompt);
          if (sys.includes('idle hall')) {
            if (!JSON.stringify(prompt.messages).includes('"open_event"')) {
              return { text: 'You cross the hall to the quest board.', finishReason: 'stop', usage: USAGE,
                toolCalls: [{ id: 'o1', name: 'open_event', arguments: { kind: 'recruitment', context: 'A barbarian recruiting an old knight' } }] };
            }
            return { text: 'You cross the hall.', finishReason: 'stop', usage: USAGE };
          }
          scenePrompts.push(clone(prompt));
          return { text: 'The knight strokes his beard.', finishReason: 'stop', usage: USAGE };
        }),
        resolveAdapter: noPassthrough(),
      };
      const adapter = makeAdapter(delegate);
      const t1 = await runTurn(adapter, 'I recruit the knight', hallState());
      // NO history at all — the budgeted window is empty. The old log-anchored
      // span would have been blank here; the mechanical span is complete.
      await runTurn(adapter, 'What is your rate?', t1.scriptState, []);
      const p2js = JSON.stringify(scenePrompts[scenePrompts.length - 1]!.messages);
      expect(p2js).toContain('You cross the hall.'); // the DM's transition
      expect(p2js).toContain('The knight strokes his beard.'); // turn 1's reply
      expect(p2js).toContain('I recruit the knight'); // the triggering input (kept now)
    });

    it('onboarding seeds the span with the receptionist greeting', async () => {
      const scenePrompts: Prompt[] = [];
      const delegate: CustomBackendDelegate = {
        generate: vi.fn(async (_cfg: string | null, prompt: Prompt): Promise<DelegatedGenerateResult> => {
          scenePrompts.push(clone(prompt));
          return { text: '"Bruka the Bold, is it? Hold still."', finishReason: 'stop', usage: USAGE };
        }),
        resolveAdapter: noPassthrough(),
      };
      await runTurn(makeAdapter(delegate), 'Call me Bruka.', undefined, []);
      expect(JSON.stringify(scenePrompts[0]!.messages)).toContain('Name and trade, newcomer');
    });

    it('/leave files the finished scene into the story (span as zoomable content)', async () => {
      // Seed a span for the fixture event (openEvent would normally spanStart it).
      testBlobs.seed('arr#1', JSON.stringify({
        item: [
          { role: 'user', content: 'I need a knight.\n\n(on stage: ser-aldric)' },
          { role: 'assistant', content: '"State your business."' },
        ],
        prev: null,
      }));
      const start = eventState({ event: { id: 'e1', kind: 'recruitment', context: 'A barbarian recruiting an old knight', participants: ['ser-aldric'], spanId: 'arr#1' } });
      const t = await runTurn(makeAdapter(textOnlyDelegate()), '/leave', start);
      expect(t.state.event).toBeUndefined();
      const ids = t.state.story ?? [];
      expect(ids).toHaveLength(1);
      const entry = JSON.parse((await testBlobs.get(ids[0]!))!) as { gist: string; content: unknown[] };
      expect(entry.gist).toBe('The recruitment breaks off.'); // the script-composed fallback gist
      expect(JSON.stringify(entry.content)).toContain('State your business'); // the scene, zoomable
    });
  });

  describe('merge: events + dungeon coexist', () => {
    it('mid-combat free text escalates to the dungeon DM, which opens an event; combat persists', async () => {
      const start = dungeonState({ dun: { maxHp: 20, hp: 20, atk: 4, inventory: {}, room: 'f1:r2', seen: { 'f1:r2': true }, escalations: 0, packIds: { ...F1_POINTER },
        combat: { name: 'Crypt Rat', hp: 10, maxHp: 10, atk: 1, reward: 5, lines: { intro: 'It lunges.', hit: 'It bites.', death: 'It dies.' } } } });
      const t = await runTurn(makeAdapter(dungeonDmOpensEventDelegate()), 'I try to intimidate the rat', start);
      // The combat gate did NOT swallow the free text — the dungeon DM was reached.
      expect(t.state.dun.escalations).toBe(1);
      expect(t.text).toContain('The rat does not blink.'); // the scene-runner's first reply
      expect(t.state.dun.combat?.name).toBe('Crypt Rat'); // combat PERSISTS across the opened event
      expect(t.state.event?.kind).toBe('parley');
    });

    it('closing a mid-dungeon event resumes the dungeon (the next turn is a dungeon turn)', async () => {
      // Open the event this turn (scene-runner returns text, no close).
      const openDelegate: CustomBackendDelegate = {
        generate: vi.fn(async (_cfg: string | null, prompt: Prompt): Promise<DelegatedGenerateResult> => {
          if (sysOf(prompt).includes('terse dungeon crawler')) {
            if (!JSON.stringify(prompt.messages).includes('"open_event"')) {
              return { text: '', finishReason: 'stop', usage: USAGE,
                toolCalls: [{ id: 'o1', name: 'open_event', arguments: { kind: 'parley', context: 'A barbarian and a rat' } }] };
            }
            return { text: '', finishReason: 'stop', usage: USAGE };
          }
          return { text: 'The rat waits.', finishReason: 'stop', usage: USAGE };
        }),
        resolveAdapter: noPassthrough(),
      };
      const combat = { name: 'Crypt Rat', hp: 10, maxHp: 10, atk: 1, reward: 5, lines: { intro: 'It lunges.', hit: 'It bites.', death: 'It dies.' } };
      const start = dungeonState({ dun: { maxHp: 20, hp: 20, atk: 4, inventory: {}, room: 'f1:r2', seen: { 'f1:r2': true }, escalations: 0, packIds: { ...F1_POINTER }, combat } });
      const t1 = await runTurn(makeAdapter(openDelegate), 'I parley with the rat', start);
      expect(t1.state.event?.kind).toBe('parley');
      expect(t1.state.dun.combat?.name).toBe('Crypt Rat');
      // The event open is in history; /leave closes it (finalize — the model
      // never closes, so the script-composed fallback gist), then the next
      // turn is a dungeon turn again (mode still 'dungeon').
      const t2 = await runTurn(makeAdapter(textOnlyDelegate()), '/leave', t1.scriptState, [
        { role: 'assistant', content: t1.text },
      ]);
      expect(t2.state.event).toBeUndefined();
      expect(t2.state.mode).toBe('dungeon'); // resumed the dungeon
      expect(t2.state.dun.combat?.name).toBe('Crypt Rat'); // the fight is still there
      expect(t2.text).toContain('data-post-response="/attack'); // combat buttons resumed
    });
  });

  describe('the story channel (lib/rolling)', () => {
    it('a fight gist lands in the story; the next DM sees STORY SO FAR and can inspect_summary into the raw span', async () => {
      const combat = { name: 'Crypt Rat', hp: 3, maxHp: 3, atk: 1, reward: 5, lines: { intro: 'It lunges.', hit: 'The rat bites.', death: 'The rat twitches and is still.' } };
      const start = dungeonState({ dun: { maxHp: 20, hp: 20, atk: 4, inventory: {}, room: 'f1:r2', seen: { 'f1:r2': true }, escalations: 0, packIds: { ...F1_POINTER }, combat, fightName: 'fight Crypt Rat',
        fightLog: [
          { role: 'assistant', content: 'It lunges.' },
          { role: 'user', content: 'attack' },
          { role: 'assistant', content: 'The rat bites. You hit for 4; it answers for 1.' },
        ] } });
      const fightHistory = [
        { role: 'assistant', content: 'It lunges.\n[fight Crypt Rat]' },
        { role: 'user', content: 'attack' },
        { role: 'assistant', content: 'The rat bites. You hit for 4; it answers for 1.' },
      ];
      const dmPrompts: Prompt[] = [];
      let dmRound = 0;
      const dm: CustomBackendDelegate = {
        generate: vi.fn(async (_cfg: string | null, prompt: Prompt): Promise<DelegatedGenerateResult> => {
          const sys = sysOf(prompt);
          if (sys.includes('Summarize what happened')) {
            return { text: 'You stabbed the rat dead, barely winded.', finishReason: 'stop', usage: USAGE };
          }
          if (sys.includes('terse dungeon crawler')) {
            dmRound++;
            dmPrompts.push(clone(prompt));
            if (dmRound === 1) {
              return { text: '', finishReason: 'stop', usage: USAGE, toolCalls: [{ id: 'i1', name: 'inspect_summary', arguments: { id: 'roll#2' } }] };
            }
            return { text: 'Noted — the rat fight was recent.', finishReason: 'stop', usage: USAGE };
          }
          return { text: 'ok', finishReason: 'stop', usage: USAGE };
        }),
        resolveAdapter: noPassthrough(),
      };
      const adapter = makeAdapter(dm);
      // Turn 1: the killing blow ends the fight — gist sub-gen, then the story push.
      const t1 = await runTurn(adapter, 'attack', start, fightHistory);
      expect(t1.text).toContain('You stabbed the rat dead, barely winded.');
      expect(t1.state.story ?? []).toHaveLength(1);
      // Turn 2: a novel action escalates; the DM's briefing carries the story…
      await runTurn(adapter, 'i search the ossuary for trinkets', t1.scriptState, [
        ...fightHistory,
        { role: 'user', content: 'attack' },
        { role: 'assistant', content: t1.text },
      ]);
      expect(sysOf(dmPrompts[0]!)).toContain('STORY SO FAR');
      expect(sysOf(dmPrompts[0]!)).toContain('[roll#2: fight Crypt Rat] You stabbed the rat dead, barely winded.');
      // …and the inspect_summary tool result brings the raw span back to the model.
      const roundTwo = JSON.stringify(dmPrompts[1]!.messages);
      expect(roundTwo).toContain('The rat bites. You hit for 4; it answers for 1.');
    });
  });

  describe('lib invariants (restored from the former suites)', () => {
    it('a corrupted pack blob fails loudly instead of silently replanning the floor', async () => {
      testBlobs.seed('pack:f1#1', '{not json}');
      const { result } = await runTurnRaw(makeAdapter(neverDelegate()), 'look', dungeonState());
      expect(result.finishReason).toBe('error');
      expect(result.error).toContain('corrupted JSON blob');
      expect(result.scriptState).toBeUndefined();
    });

    it('a pack pointer whose blob is missing fails loudly', async () => {
      const start = dungeonState({ dun: { maxHp: 20, hp: 20, atk: 4, inventory: {}, room: 'f1:r1', seen: { 'f1:r1': true }, escalations: 0, packIds: { f1: 'pack:f1#99' } } });
      const { result } = await runTurnRaw(makeAdapter(neverDelegate()), 'look', start);
      expect(result.finishReason).toBe('error');
      expect(result.error).toContain('pack blob missing');
      expect(result.scriptState).toBeUndefined();
    });

    it('ledger: a vague due date is rejected at registration', async () => {
      const dm: CustomBackendDelegate = {
        generate: vi.fn(async (_cfg: string | null, prompt: Prompt): Promise<DelegatedGenerateResult> => {
          if (sysOf(prompt).includes('terse dungeon crawler')) {
            if (!JSON.stringify(prompt.messages).includes('"promise"')) {
              return { text: '', finishReason: 'stop', usage: USAGE, toolCalls: [{ id: 'p1', name: 'promise', arguments: { id: 'vague', what: 'something later' } }] };
            }
            return { text: 'rejected, fine.', finishReason: 'stop', usage: USAGE };
          }
          return { text: 'ok', finishReason: 'stop', usage: USAGE };
        }),
        resolveAdapter: noPassthrough(),
      };
      const t = await runTurn(makeAdapter(dm), 'i make a vague promise', dungeonState());
      expect(Object.keys(t.state.promises ?? {}).length).toBe(0); // no concrete due turn → rejected (empty table)
    });

    it('ledger: a due promise escalates to DUE NOW, resolves, and leaves the NEXT DM prompt', async () => {
      // The DM system block is built once per escalation (frozen for the tool
      // loop), so the resolution shows up in the NEXT escalation's freshly-
      // built briefing — two escalations, not two rounds of one.
      const first: Prompt[] = [];
      let r1 = 0;
      const dm1: CustomBackendDelegate = {
        generate: vi.fn(async (_cfg: string | null, prompt: Prompt): Promise<DelegatedGenerateResult> => {
          if (sysOf(prompt).includes('terse dungeon crawler')) {
            r1++;
            first.push(clone(prompt));
            if (r1 === 1) return { text: '', finishReason: 'stop', usage: USAGE, toolCalls: [{ id: 'rp', name: 'resolve_promise', arguments: { id: 'rising_water', outcome: 'kept' } }] };
            return { text: 'done', finishReason: 'stop', usage: USAGE };
          }
          return { text: 'done', finishReason: 'stop', usage: USAGE };
        }),
        resolveAdapter: noPassthrough(),
      };
      const start = dungeonState({ turn: 5, promises: [{ id: 'rising_water', what: 'The water keeps rising.', due: 5 }] });
      const t1 = await runTurn(makeAdapter(dm1), 'i deal with the water', start);
      expect(sysOf(first[0]!)).toContain('DUE NOW');
      expect(sysOf(first[0]!)).toContain('rising_water');
      expect((t1.state.promises as Array<{ id: string; status?: string }> | undefined)?.find((p) => p.id === 'rising_water')?.status).toBe('kept');

      // Second escalation: a freshly-built DM prompt no longer carries it.
      const next: Prompt[] = [];
      const dm2: CustomBackendDelegate = {
        generate: vi.fn(async (_cfg: string | null, prompt: Prompt): Promise<DelegatedGenerateResult> => {
          if (sysOf(prompt).includes('terse dungeon crawler')) next.push(clone(prompt));
          return { text: 'done', finishReason: 'stop', usage: USAGE };
        }),
        resolveAdapter: noPassthrough(),
      };
      await runTurn(makeAdapter(dm2), 'i check the walls', t1.scriptState);
      expect(sysOf(next[0]!)).not.toContain('rising_water');
    });

    const WORDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'];

    /** Seed a dossier in the rolling shape: one gist-only entry per take, ids in the array. */
    function seedTakes(charId: string, gists: string[]): Record<string, string[]> {
      const ids: string[] = [];
      gists.forEach((gist, i) => {
        const id = `roll#${i + 2}`; // #1 is the beforeEach pack seed
        testBlobs.seed(id, JSON.stringify({ label: 'recruitment', gist }));
        ids.push(id);
      });
      return { [charId]: ids };
    }
    const SEVEN_TAKES = WORDS.map((w) => `take number ${w}`);

    /** Scene-runner pulls ser-aldric's file (triggering the fold), then answers. */
    function foldDelegate(failFold: boolean, foldPrompts?: Prompt[], scenePrompts?: Prompt[]): CustomBackendDelegate {
      let sceneRound = 0;
      return {
        generate: vi.fn(async (_cfg: string | null, prompt: Prompt): Promise<DelegatedGenerateResult> => {
          const sys = sysOf(prompt);
          if (sys.includes('Compress these episode summaries')) {
            if (failFold) throw new Error('backend down');
            foldPrompts?.push(clone(prompt));
            return { text: 'A grizzled knight, debt-hungry, who remembers the barbarian.', finishReason: 'stop', usage: USAGE };
          }
          if (sys.includes('scene-runner')) {
            sceneRound++;
            scenePrompts?.push(clone(prompt));
            if (sceneRound === 1) return { text: '', finishReason: 'stop', usage: USAGE, toolCalls: [{ id: 'g1', name: 'get_character', arguments: { id: 'ser-aldric' } }] };
            return { text: '"Back again?"', finishReason: 'stop', usage: USAGE };
          }
          return { text: 'ok', finishReason: 'stop', usage: USAGE };
        }),
        resolveAdapter: noPassthrough(),
      };
    }

    it('dossier: get_character folds the oldest takes into a digest once', async () => {
      const foldPrompts: Prompt[] = [];
      const scenePrompts: Prompt[] = [];
      const start = eventState({ dossiers: seedTakes('ser-aldric', SEVEN_TAKES) });
      const t = await runTurn(makeAdapter(foldDelegate(false, foldPrompts, scenePrompts)), 'I find Ser Aldric', start);
      expect(foldPrompts).toHaveLength(1); // fold fires exactly once
      const foldJs = JSON.stringify(foldPrompts[0]!.messages);
      expect(foldJs).toContain('take number one'); // oldest folded in
      expect(foldJs).not.toContain('take number seven'); // recent stay raw
      const servedJs = JSON.stringify(scenePrompts[1]!.messages);
      expect(servedJs).toContain('grizzled'); // the digest arrived
      expect(servedJs).toContain('take number seven'); // a recent take arrived
      // The live array is now [fold id, 3 recent ids]; the fold entry's blob
      // carries the delegate digest and the descriptor list of what it folded.
      const ids = t.state.dossiers?.['ser-aldric'] ?? [];
      expect(ids).toHaveLength(4);
      const foldBlob = JSON.parse((await testBlobs.get(ids[0]!))!) as { gist: string; content: Array<{ id: string }> };
      expect(foldBlob.gist).toContain('grizzled');
      expect(foldBlob.content).toHaveLength(4); // the 4 folded takes, as descriptors
    });

    it('dossier: a failing fold fails the turn loudly — nothing persisted, the retry folds fine', async () => {
      const start = eventState({ dossiers: seedTakes('ser-aldric', SEVEN_TAKES) });
      const { result } = await runTurnRaw(makeAdapter(foldDelegate(true)), 'I find Ser Aldric', start);
      expect(result.finishReason).toBe('error');
      expect(result.error).toContain('backend down');
      // No state snapshot: the dossier id array survives untouched on the
      // rolled-back state, so a swipe retries the fold.
      expect(result.scriptState).toBeUndefined();
      const t = await runTurn(makeAdapter(foldDelegate(false)), 'I find Ser Aldric', start);
      const ids = t.state.dossiers?.['ser-aldric'] ?? [];
      expect(ids).toHaveLength(4);
      const foldBlob = JSON.parse((await testBlobs.get(ids[0]!))!) as { gist: string };
      expect(foldBlob.gist).toContain('grizzled');
    });
  });

  describe('journey: one long delve through the whole card', () => {
    it('idle → recruit → leave → delve → explore → fight → win → return → reunion', async () => {
      const luaAlways = luaSource.replace('local ENCOUNTER_CHANCE = 0.3', 'local ENCOUNTER_CHANCE = 1.0');
      expect(luaAlways).not.toBe(luaSource);
      const reunionScene: Prompt[] = [];
      let reunionRound = 0;
      const delegate: CustomBackendDelegate = {
        generate: vi.fn(async (_cfg: string | null, prompt: Prompt): Promise<DelegatedGenerateResult> => {
          const sys = sysOf(prompt);
          const js = JSON.stringify(prompt.messages);
          // planning: design floor 1 (relic in the entrance room so the player can grab it after the fight)
          if (sys.includes('content designer')) {
            if (!js.includes('"add_rooms"')) {
              return { text: '', finishReason: 'stop', usage: USAGE, toolCalls: [
                { id: 'd1', name: 'add_description', arguments: { text: 'Dust and old bones.' } },
                { id: 'rm', name: 'add_rooms', arguments: { rooms: [
                  { id: 'r1', name: 'Collapsed Nave', desc: 'Dust.', exits: { north: 'r2' } },
                  { id: 'r2', name: 'Ossuary', desc: 'Femurs.', exits: { south: 'r1', east: 'r3' } },
                  { id: 'r3', name: 'Silent Choir', desc: 'Seats.', exits: { west: 'r2' } },
                ] } },
                { id: 'e1', name: 'add_encounter', arguments: { name: 'Crypt Rat', hp: 3, atk: 1, reward: 5, lines: { intro: 'It lunges.', hit: 'It bites.', death: 'It dies.' } } },
                { id: 'i1', name: 'add_interactable', arguments: { room: 'r1', name: 'relic', responses: ['You take the relic. It hums.'], effect: { item: 'relic' } } },
              ] };
            }
            return { text: 'You stand in the Collapsed Nave.', finishReason: 'stop', usage: USAGE };
          }
          // /leave finalize: file a take for Aldric
          if (sys.includes('Close it properly') || sys.includes('walked out')) {
            if (!js.includes('"close_event"')) {
              return { text: '', finishReason: 'stop', usage: USAGE, toolCalls: [{ id: 'c1', name: 'close_event', arguments: { gist: 'Recruited Ser Aldric.', takes: { 'ser-aldric': 'Hired by a barbarian who meant business.' } } }] };
            }
            return { text: 'Safe travels.', finishReason: 'stop', usage: USAGE };
          }
          // hall DM: open recruitment, then a reunion once the relic is held
          if (sys.includes('idle hall')) {
            if (!js.includes('"open_event"')) {
              const reunion = sys.includes('relic');
              return { text: 'You cross the hall.', finishReason: 'stop', usage: USAGE, toolCalls: [{ id: 'o1', name: 'open_event', arguments: { kind: reunion ? 'reunion' : 'recruitment', context: reunion ? 'The barbarian returns with the relic' : 'A barbarian recruiting an old knight' } }] };
            }
            return { text: 'You cross the hall.', finishReason: 'stop', usage: USAGE };
          }
          // scene-runner
          if (sys.includes('scene-runner')) {
            if (sys.includes('reunion')) {
              reunionRound++;
              reunionScene.push(clone(prompt));
              if (reunionRound === 1) return { text: '', finishReason: 'stop', usage: USAGE, toolCalls: [{ id: 'g1', name: 'get_character', arguments: { id: 'ser-aldric' } }] };
              return { text: '"The crypt suits you," the knight notes.', finishReason: 'stop', usage: USAGE };
            }
            // recruitment: cast, then write a line (event stays open)
            if (!js.includes('ser-aldric')) return { text: '', finishReason: 'stop', usage: USAGE, toolCalls: [
              { id: 'l1', name: 'list_characters', arguments: {} },
              { id: 'g1', name: 'register_character', arguments: { name: 'Ser Aldric', role: 'old knight' } },
              { id: 'a1', name: 'add_to_chat', arguments: { id: 'ser-aldric' } },
            ] };
            return { text: '"What\'s the offer?"', finishReason: 'stop', usage: USAGE };
          }
          return { text: 'ok', finishReason: 'stop', usage: USAGE };
        }),
        resolveAdapter: noPassthrough(),
      };
      const adapter = makeAdapter(delegate, luaAlways);

      // The engine threads the whole branch between turns; accumulate every
      // prior turn so the floor pack (written at /delve) stays reachable to
      // findPack across the whole crawl.
      const hist: Array<{ role: 'user' | 'assistant'; content: string }> = [];
      let scriptState: string | undefined = hallState();
      const step = async (userText: string) => {
        const t = await runTurn(adapter, userText, scriptState, hist.length ? hist : undefined);
        hist.push({ role: 'user', content: userText });
        hist.push({ role: 'assistant', content: t.text });
        scriptState = t.scriptState;
        return t;
      };

      // 1. Idle hall: a free menu turn.
      const t1 = await step('/shop');
      expect(t1.state.mode).toBe('hall');
      expect(t1.text).toContain('quartermaster');

      // 2. Free text → hall DM frames a recruitment event; scene-runner casts Aldric + writes a reply.
      const t2 = await step('I go recruit the old knight');
      expect(t2.state.event?.kind).toBe('recruitment');
      expect(t2.text).toContain('"What\'s the offer?"');
      expect(t2.state.characters?.map((c) => c.id)).toContain('ser-aldric');

      // 3. /leave closes the event (finalize files Aldric's take) → back to idle.
      const t3 = await step('/leave');
      expect(t3.state.event).toBeUndefined();
      const aldricIds = t3.state.dossiers?.['ser-aldric'] ?? [];
      expect(aldricIds).toHaveLength(1);
      expect(await testBlobs.get(aldricIds[0]!)).toContain('meant business');

      // 4. /delve → planning designs floor 1 → enter the dungeon.
      const t4 = await step('/delve');
      expect(t4.state.mode).toBe('dungeon');
      expect(t4.state.dun.room).toBe('f1:r1');
      expect(t4.text).toContain('Designed The Upper Halls');

      // 5. go north → r2 → a rat rolls up (ENCOUNTER_CHANCE=1).
      const t5 = await step('go north');
      expect(t5.state.dun.room).toBe('f1:r2');
      expect(t5.state.dun.combat?.name).toBe('Crypt Rat');
      expect(t5.text).toContain('It lunges.');

      // 6. attack → kill → gold + a delegate-written fight gist.
      const t6 = await step('attack');
      expect(t6.state.dun.combat).toBeUndefined();
      expect(t6.state.gold).toBeGreaterThanOrEqual(5);
      expect(t6.state.story ?? []).toHaveLength(2); // the recruitment scene AND the fight gist

      // 7. go south → back to the entrance (no encounter there).
      const t7 = await step('go south');
      expect(t7.state.dun.room).toBe('f1:r1');

      // 8. take the relic → win the delve (not the game).
      const t8 = await step('take the relic');
      expect(t8.state.dun.delveOver).toBe('won');
      expect(t8.state.flags.relic).toBe(true);
      expect(t8.text).toContain('Return to the hall');

      // 9. Any input returns to the hall.
      const t9 = await step('leave dungeon');
      expect(t9.state.mode).toBe('hall');
      expect(t9.state.dun.delveOver).toBeUndefined();

      // 10. Back at the hall, the DM opens a reunion; the scene-runner pulls Aldric's dossier (filed at step 3).
      const t10 = await step('I show the knight the relic');
      expect(t10.state.event?.kind).toBe('reunion');
      expect(reunionScene.length).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(reunionScene[1]!.messages)).toContain('meant business'); // the dossier take survived the crawl
    });
  });

  describe('onboarding: registration event', () => {
    it('the first turn opens a registration event; answering registers the player and reaches the hall', async () => {
      // No prior state → ensureState opens the registration event with the
      // receptionist. The greeting is seeded as a prior assistant message so the
      // scene-runner sees her already on stage; it registers the newcomer,
      // closes, and the hall menu appears.
      const scenePrompts: Prompt[] = [];
      let round = 0;
      const delegate: CustomBackendDelegate = {
        generate: vi.fn(async (_cfg: string | null, prompt: Prompt): Promise<DelegatedGenerateResult> => {
          if (sysOf(prompt).includes('scene-runner')) {
            scenePrompts.push(clone(prompt));
            round++;
            if (round === 1) return { text: '', finishReason: 'stop', usage: USAGE, toolCalls: [{ id: 'rp', name: 'register_player', arguments: { name: 'Grok' } }] };
            if (round === 2) return { text: '', finishReason: 'stop', usage: USAGE, toolCalls: [{ id: 'c1', name: 'close_event', arguments: { gist: 'Registered Grok the barbarian.', takes: { receptionist: 'A brusque welcome and a donut.' } } }] };
            return { text: '"Welcome to the Guildhall, Grok."', finishReason: 'stop', usage: USAGE };
          }
          return { text: 'ok', finishReason: 'stop', usage: USAGE };
        }),
        resolveAdapter: noPassthrough(),
      };
      const t = await runTurn(makeAdapter(delegate), "I'm Grok, a barbarian.", undefined);
      // The greeting was seeded as a prior assistant message in the span —
      // the scene-runner saw the receptionist already on stage (no cold-start
      // list_characters dance), and the cast note rides the newest message.
      expect(JSON.stringify(scenePrompts[0]!.messages)).toContain('Thornwall');
      expect(JSON.stringify(scenePrompts[0]!.messages)).toContain('(on stage: receptionist)');
      expect(t.state.onboarded).toBe(true);
      expect(t.state.playerName).toBe('Grok');
      expect(t.state.event).toBeUndefined(); // registration closed
      expect(t.state.characters?.map((c) => c.id)).toContain('receptionist');
      expect(t.text).toContain('"Welcome to the Guildhall, Grok.'); // the receptionist spoke
      expect(t.text).toContain('data-post-response="/delve"'); // the hall menu is now available
    });

    it('onboarding spans multiple turns: turn 2 sees turn 1 (the [event] open anchors ev.span)', async () => {
      // Before the fix, the script-opened registration event never emitted its
      // [event] open, so ev.span was empty every turn and each turn re-seeded
      // the scene-runner from cold — turn 2 forgot turn 1's question.
      const scenePrompts: Prompt[] = [];
      let call = 0;
      const delegate: CustomBackendDelegate = {
        generate: vi.fn(async (_cfg: string | null, prompt: Prompt): Promise<DelegatedGenerateResult> => {
          if (sysOf(prompt).includes('scene-runner')) {
            scenePrompts.push(clone(prompt));
            call++;
            if (call === 1) return { text: '"Your name, traveler?"', finishReason: 'stop', usage: USAGE };
            if (call === 2) return { text: '', finishReason: 'stop', usage: USAGE,
              toolCalls: [{ id: 'rp', name: 'register_player', arguments: { name: 'Grok' } },
                { id: 'c1', name: 'close_event', arguments: { gist: 'Registered Grok.', takes: { receptionist: 'A brusque welcome.' } } }] };
            return { text: '"Welcome, Grok."', finishReason: 'stop', usage: USAGE };
          }
          return { text: 'ok', finishReason: 'stop', usage: USAGE };
        }),
        resolveAdapter: noPassthrough(),
      };
      const adapter = makeAdapter(delegate);
      const t1 = await runTurn(adapter, 'hi', undefined);
      expect(t1.text).toContain('Your name, traveler?'); // the receptionist asked
      expect(t1.state.event?.kind).toBe('registration'); // still open — turn 1 only asked
      const t2 = await runTurn(adapter, 'Grok', t1.scriptState, [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: t1.text },
      ]);
      // Turn 2's scene-runner saw turn 1's exchange via the append-only span
      // (before the fix it was re-seeded with the greeting and saw nothing of turn 1).
      expect(scenePrompts.length).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(scenePrompts[1]!.messages)).toContain('Your name, traveler?');
      expect(t2.state.onboarded).toBe(true);
    });
  });
});
