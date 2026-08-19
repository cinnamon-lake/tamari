/**
 * Multi-turn coverage of the Guildhall card's newer behaviors that
 * guildhall.example.test.ts does not exercise: the leak hunt (no summary
 * content in user-role messages or served replies), case-insensitive verbs,
 * the shop economy (buy_item), the outcome-only attempt result, close_event
 * idempotence/fallback, the deterministic compass refusal, and the climb-out
 * delve ending. Reads the CANONICAL sources (docs/design/examples — the
 * unpacked card these were developed against was backported; game-lib is
 * canonical again). Same pattern as the example suite: real
 * LuaBackendAdapter, scripted delegates, scriptState + shared blob heap
 * threaded between turns.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { LuaRuntime } from '../scripting/LuaRuntime.js';
import {
  LuaBackendAdapter,
  type CustomBackendDelegate,
  type DelegatedGenerateResult,
} from './LuaBackendAdapter.js';
import { MemoryScriptBlobRepository } from './MemoryScriptBlobRepository.js';
import type { GenerationType } from './BackendAdapter.js';
import type { MessageRole } from '@tamari/types';
import { consumeStream, type BackendStreamItem, type Prompt } from './BackendAdapter.js';

const luaSource = readFileSync(new URL('../../../docs/design/examples/guildhall/main.lua', import.meta.url), 'utf8');
const LIB_FILES: Record<string, string> = Object.fromEntries(
  ['loop', 'sanitize', 'chrome', 'ledger', 'toolset', 'todo', 'registry', 'summarize', 'maptag', 'events', 'rolling', 'layout'].map((m) => [
    `lib/${m}.lua`,
    readFileSync(new URL(`../../../docs/design/examples/game-lib/${m}.lua`, import.meta.url), 'utf8'),
  ]),
);

const USAGE = { promptTokens: 1, completionTokens: 1 };

let blobs: MemoryScriptBlobRepository;
let prompts: Prompt[] = [];

const noPassthrough = () =>
  vi.fn(async () => {
    throw new Error('passthrough not expected');
  });

/** Clone of the prompt log for assertions. */
const capture = (p: Prompt) => {
  prompts.push(JSON.parse(JSON.stringify(p)) as Prompt);
};

function adapter(delegate: CustomBackendDelegate): LuaBackendAdapter {
  return new LuaBackendAdapter({
    id: 'custom:guildhall-leak',
    name: 'The Guildhall',
    luaSource,
    runtime: new LuaRuntime(),
    delegate,
    vfsFiles: LIB_FILES,
    blobs,
  });
}

const sysOf = (p: Prompt): string => (typeof p.messages[0]?.content === 'string' ? (p.messages[0].content as string) : '');
// loop.lua rebuilds rounds as assistant messages with typed tool_use/tool_result blocks.
const hasToolResult = (p: Prompt): boolean =>
  p.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => typeof b === 'object' && b !== null && (b as { type?: string }).type === 'tool_result'));

/**
 * Behavior-scripted delegate. Matches on system-prompt content:
 *  - planner: themes the fixed layout via tool calls, then writes the intro
 *  - onboarder: scene-runner that registers the player and closes
 *  - dm: dungeon DM issuing scripted mutations (add_exit/spawn_enemy/remove_item)
 *  - eventDm: opens an event; scene closes it on the next scene round
 *  - default: plain text (narration / gist / finalize)
 */
type Behavior = 'planner' | 'onboarder' | 'dm' | 'eventDm' | 'calmFinalizer';
function delegate(behavior: Behavior = 'planner', dmScript: string[] = []): CustomBackendDelegate {
  let dmRound = 0;
  let sceneRound = 0;
  let finishCalled = false;
  return {
    generate: vi.fn(async (_cfg: string | null, p: Prompt): Promise<DelegatedGenerateResult> => {
      capture(p);
      const sys = sysOf(p);
      const tc = (calls: Array<{ name: string; arguments: Record<string, unknown> }>): DelegatedGenerateResult => ({
        text: '',
        finishReason: 'stop',
        usage: USAGE,
        toolCalls: calls.map((c, i) => ({ id: `c${i}`, name: c.name, arguments: c.arguments })),
      });

      if (sys.includes('content designer')) {
        if (hasToolResult(p)) {
          if (!finishCalled) {
            finishCalled = true;
            return tc([{ name: 'finish_floor', arguments: { intro: 'The stair spits you into dust and dark.' } }]);
          }
          // Leak bait: the planner's raw final text must NEVER be served.
          return { text: 'FULL DESIGN DUMP: r6 dead end hides Greenblade + 20g; roster is Crypt Rat; ledger debt filed.', finishReason: 'stop', usage: USAGE };
        }
        const sysText = sys;
        const rooms = [...new Set([...sysText.matchAll(/\br(\d+)\b/g)].map((m) => `r${m[1]}`))];
        const sections = [...new Set([...sysText.matchAll(/^\s*([A-D]): /gm)].map((m) => m[1]))];
        const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [
          { name: 'add_description', arguments: { text: 'Dust and old bones, galleries collapsing inward.' } },
        ];
        for (const s of sections)
          calls.push({ name: 'theme_section', arguments: { section: s, name: `Wing ${s}`, vibe: 'Old stone, older dust.' } });
        calls.push({
          name: 'furnish_rooms',
          arguments: {
            rooms: rooms.map((r, i) => ({ room: r, name: `Furnished ${i + 1}`, desc: `Room ${r} description.` })),
          },
        });
        calls.push({
          name: 'add_encounter',
          arguments: {
            name: 'Crypt Rat',
            hp: 99,
            atk: 99,
            reward: 99,
            lines: { intro: 'It lunges from the dark.', hit: 'The rat sinks its teeth in.', death: 'The rat twitches and is still.' },
          },
        });
        calls.push({
          name: 'add_interactable',
          arguments: { room: rooms[0], name: 'crate', responses: ['Inside: a few coins.', 'Just dust now.'], effect: { gold: 5 } },
        });
        calls.push({ name: 'add_ambient', arguments: { lines: ['Water drips below.'] } });
        return tc(calls);
      }

      // NOTE: the DM prompts themselves say "casting is the scene-runner's job" —
      // match 'dungeon master' FIRST.
      if (sys.includes('dungeon master')) {
        const want = dmScript[dmRound++];
        if (!want) return { text: 'Nothing more comes of it.', finishReason: 'stop', usage: USAGE };
        if (want === 'open_event')
          return tc([{ name: 'open_event', arguments: { kind: 'communion', context: 'The player whispers to the bones; something answers.' } }]);
        const sp = want.indexOf(' ');
        const name = sp === -1 ? want : want.slice(0, sp);
        const args = sp === -1 ? {} : JSON.parse(want.slice(sp + 1));
        return tc([{ name, arguments: args }]);
      }

      if (sys.includes('scene-runner')) {
        sceneRound++;
        if (behavior === 'onboarder') {
          if (sceneRound === 1) return tc([{ name: 'register_player', arguments: { name: 'Alda' } }]);
          if (sceneRound === 2) return tc([{ name: 'close_event', arguments: { gist: 'Alda registered at the guildhall.' } }]);
          return { text: 'She stamps the form. "Alda. Welcome to the Guildhall."', finishReason: 'stop', usage: USAGE };
        }
        // eventDm scenes: reply, then close, then a final plain-text line.
        if (sceneRound === 1) return { text: 'The bones stir and listen.', finishReason: 'stop', usage: USAGE };
        if (sceneRound === 2) return tc([{ name: 'close_event', arguments: { gist: 'The bones are appeased.' } }]);
        return { text: 'The bones settle.', finishReason: 'stop', usage: USAGE };
      }

      // /leave finalizer. Default: OVER-EAGER — re-calls close_event every
      // round even after the close landed (the brick regression from the
      // audit). 'calmFinalizer': plain text, never closes (fallback gist).
      if (sys.includes('walked out of this event')) {
        if (behavior === 'calmFinalizer') return { text: 'They walked out.', finishReason: 'stop', usage: USAGE };
        return tc([{ name: 'close_event', arguments: { gist: 'They walked out mid-scene.' } }]);
      }

      return { text: 'A blur of dust and teeth.', finishReason: 'stop', usage: USAGE };
    }),
    resolveAdapter: noPassthrough(),
  };
}

function throwingDelegate(msg: string): CustomBackendDelegate {
  return {
    generate: vi.fn(async (): Promise<DelegatedGenerateResult> => {
      throw new Error(msg);
    }),
    resolveAdapter: noPassthrough(),
  };
}

async function runTurnRaw(
  d: CustomBackendDelegate,
  userText: string,
  scriptState: string | undefined,
  history: Array<{ role: MessageRole; content: string }>,
  generationType: GenerationType = 'send',
) {
  const prompt: Prompt = {
    messages: [
      { role: 'system', content: 'Base system prompt.' },
      ...history.map((h) => ({ role: h.role, content: h.content })),
      { role: 'user', content: userText },
    ],
    tokenUsage: { prompt: 0, completion: 0 },
  };
  return consumeStream(
    adapter(d).stream(prompt, new AbortController().signal, {
      chatId: 'guild-chat',
      generationType,
      scriptState,
      branchHistory: async () => history.map((h, i) => ({ id: `h-${i + 1}`, role: h.role, content: h.content })),
    }),
  );
}

interface Dun {
  maxHp: number;
  hp: number;
  atk: number;
  inventory: Record<string, number>;
  room: string;
  combat?: { name: string; hp: number; maxHp: number; atk: number; lines: { intro: string; hit: string; death: string }; reward: number };
  seen: Record<string, true>;
  escalations: number;
  fightName?: string;
  fightLog?: Array<{ role: string; content: string }>;
  delveOver?: 'dead' | 'won' | null;
}
interface St {
  mode: string;
  gold: number;
  flags: Record<string, unknown>;
  turn: number;
  dun: Dun;
  onboarded?: boolean;
  playerName?: string;
  packIds?: Record<string, string>;
  bricked?: string;
  story?: { kv: Record<string, string>; ids: string[] | Record<string, unknown> };
  event?: { kind: string } & Record<string, unknown>;
}

async function turn(
  d: CustomBackendDelegate,
  userText: string,
  scriptState: string | undefined,
  history: Array<{ role: MessageRole; content: string }>,
): Promise<{ text: string; st: St; raw: string }> {
  const { items, result } = await runTurnRaw(d, userText, scriptState, history);
  const text = items
    .filter((i): i is Extract<BackendStreamItem, { type: 'text' }> => i.type === 'text')
    .map((i) => i.token)
    .join('');
  expect(result.error).toBeUndefined();
  expect(result.scriptState).toBeDefined();
  return { text, st: JSON.parse(result.scriptState!) as St, raw: result.scriptState! };
}

// ── the seeded f1 pack (grid geometry, one dead end, one annex for add_exit) ──
interface PackBlob {
  floors: Array<{ id: string; floor: string; name: string; description: string; entrance: string; stairsDown: string; ambient: string[] }>;
  rooms: Array<{ id: string; floor: string; name: string; desc: string; x: number; y: number; section: string; exits: Record<string, string> }>;
  enemies: Array<{ id: string; floor: string; name: string; hp: number; maxHp: number; atk: number; reward: number; lines: Record<string, string> }>;
  interactables: Array<{ id: string; key: string; floor: string; responses: string[]; effect?: Record<string, unknown> }>;
}
function packBlob(relic = false): PackBlob {
  return {
    floors: [{ id: 'f1', floor: 'f1', name: 'The Upper Halls', description: 'Dust and old bones.', entrance: 'r1', stairsDown: 'r3', ambient: ['Water drips below.'] }],
    rooms: [
      { id: 'r1', floor: 'f1', name: 'Collapsed Nave', desc: 'Dust and old bones.', x: 0, y: 1, section: 'A', exits: { north: 'r2', south: 'r4' } },
      { id: 'r2', floor: 'f1', name: 'Ossuary', desc: 'Stacked femurs like cordwood.', x: 0, y: 0, section: 'A', exits: { south: 'r1', east: 'r3' } },
      { id: 'r3', floor: 'f1', name: 'Silent Choir', desc: 'Stone seats in rows.', x: 1, y: 0, section: 'B', exits: { west: 'r2', down: 'down' } },
      { id: 'r4', floor: 'f1', name: 'Bone Pit', desc: 'A shallow pit of bones.', x: 0, y: 2, section: 'B', exits: { north: 'r1' } },
      { id: 'r5', floor: 'f1', name: 'Sealed Annex', desc: 'A sealed annex.', x: 1, y: 1, section: 'B', exits: {} },
    ],
    // empty roster: deterministic exploration (no random encounters roll)
    enemies: [],
    interactables: relic
      ? [{ id: 'r1-relic', key: 'r1:relic', floor: 'f1', responses: ['You take the relic. It hums.'], effect: { item: 'relic' } }]
      : [{ id: 'r4-crate', key: 'r4:crate', floor: 'f1', responses: ['Inside: a few coins.', 'Just dust now.'], effect: { gold: 5 } }],
  };
}

const RAT = { name: 'Crypt Rat', hp: 3, maxHp: 3, atk: 1, reward: 5, lines: { intro: 'It lunges.', hit: 'The rat bites.', death: 'The rat is still.' } };

async function seedPack(relic = false): Promise<string> {
  return blobs.put('pack', JSON.stringify(packBlob(relic)));
}

function dungeonState(packId: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    mode: 'dungeon',
    gold: 30,
    flags: {},
    turn: 4,
    onboarded: true,
    playerName: 'Tester',
    packIds: { f1: packId },
    story: { kv: { player: 'Tester' }, ids: [] },
    dun: { maxHp: 20, hp: 20, atk: 4, inventory: {}, room: 'f1:r1', seen: { 'f1:r1': true }, escalations: 0 },
    ...extra,
  });
}

function hallState(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    mode: 'hall',
    gold: 30,
    flags: {},
    turn: 1,
    onboarded: true,
    playerName: 'Tester',
    story: { kv: { player: 'Tester' }, ids: [] },
    dun: { maxHp: 20, hp: 20, atk: 4, inventory: {}, room: 'f1', seen: {}, escalations: 0 },
    ...extra,
  });
}

async function readPack(pointer: string): Promise<PackBlob> {
  return JSON.parse((await blobs.get(pointer))!) as PackBlob;
}

const hist = (h: Array<{ role: MessageRole; content: string }>, user: string, assistant: string) => {
  h.push({ role: 'user', content: user }, { role: 'assistant', content: assistant });
};

beforeEach(() => {
  blobs = new MemoryScriptBlobRepository();
  prompts = [];
});

describe('Guildhall card — extended coverage (leaks, verbs, economy)', () => {
  it('onboarding: register_player + close_event hands the player into the hall', async () => {
    const d = delegate('onboarder');
    const h: Array<{ role: MessageRole; content: string }> = [];
    const { text, st } = await turn(d, 'Alda, carpenter.', undefined, h);
    expect(st.onboarded).toBe(true);
    expect(st.playerName).toBe('Alda');
    expect(st.dun.maxHp).toBeGreaterThanOrEqual(16);
    expect(st.dun.maxHp).toBeLessThanOrEqual(24);
    expect(st.gold).toBeGreaterThanOrEqual(20);
    expect(st.gold).toBeLessThanOrEqual(40);
    expect(st.story?.kv.player).toBe('Alda');
    expect(st.event).toBeUndefined();
    // the gist lives in the STORY entry, not re-appended after the closing prose
    expect(text).toContain('She stamps the form.');
    expect(text).not.toContain('Alda signs the guild register.');
    const ids = st.story?.ids as string[];
    const lastEntry = JSON.parse((await blobs.get(ids[ids.length - 1]!))!) as { gist: string };
    expect(lastEntry.gist).toBe('Alda signs the guild register.');
    expect(text).toContain('(Type help anytime — it lists the commands.)');
    expect(text).toContain('Delve into the dungeon');
    expect(text).toContain('[HUD|name=Alda|where=The Hall');
    // the registration result is stat-free: hp/atk/gold never reach the delegate
    const regResult = prompts
      .flatMap((p) => p.messages)
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .find((b) => typeof b === 'object' && b !== null && (b as { type?: string }).type === 'tool_result'
        && String((b as { content?: unknown }).content).includes('"registered"'));
    expect(regResult).toBeDefined();
    expect(String((regResult as { content: unknown }).content)).not.toMatch(/"hp"|"atk"|"gold"/);
  });

  it('delve: planning delegate themes the fixed layout; pack commits; intro served with HUD+MAP', async () => {
    const d = delegate('planner');
    const h: Array<{ role: MessageRole; content: string }> = [];
    const { text, st } = await turn(d, 'delve', hallState(), h);
    expect(st.mode).toBe('dungeon');
    const p = st.packIds?.f1;
    expect(p).toBeDefined();
    const blob = await readPack(p!);
    expect(blob.floors[0]!.name).toBe('The Upper Halls');
    expect(blob.rooms.length).toBeGreaterThanOrEqual(4);
    for (const r of blob.rooms) {
      expect(r.name.length).toBeGreaterThan(0);
      expect(r.name).not.toMatch(/\(r\d+\)$/); // no fallback names — all furnished
      expect(r.desc.length).toBeGreaterThan(0);
    }
    expect(blob.rooms.every((r) => Number.isInteger(r.x) && Number.isInteger(r.y))).toBe(true);
    // depth-1 clamps: hp<=10, atk<=2, reward<=5
    const rat = blob.enemies.find((e) => e.name === 'Crypt Rat');
    expect(rat).toBeDefined();
    expect(rat!.hp).toBe(10);
    expect(rat!.atk).toBe(2);
    expect(rat!.reward).toBe(5);
    expect(blob.interactables.length).toBe(1);
    expect(blob.floors[0]!.ambient.length).toBe(1);
    expect(text).toContain('The stair spits you into dust and dark.');
    // the planner's raw final text (design notes) is NEVER served
    expect(text).not.toContain('FULL DESIGN DUMP');
    expect(text).not.toContain('Greenblade');
    expect(text).toContain('[HUD|name=Tester|where=The Upper Halls');
    expect(text).toContain('[MAP|');
    expect(st.dun.room).toMatch(/^f1:r\d+$/);
    expect(Object.keys(st.dun.seen)).toEqual([st.dun.room]);
    // the planner saw the fixed skeleton (rooms pre-exist; no add-room tool exists)
    const plan = prompts.find((p) => sysOf(p).includes('content designer'))!;
    expect(sysOf(plan)).toContain('has ALREADY been laid out');
    expect(sysOf(plan)).not.toContain('"add_rooms"');
  });

  it('exploration: movement, look, ambient, interactable first/repeat use, climb-out ends the delve', async () => {
    const p = await seedPack();
    const d = delegate('planner');
    const h: Array<{ role: MessageRole; content: string }> = [];
    let st = dungeonState(p);

    let r = await turn(d, 'go north', st, h); hist(h, 'go north', r.text); st = r.raw;
    expect(r.st.dun.room).toBe('f1:r2');
    expect(r.text).toContain('Stacked femurs like cordwood.');
    expect(r.text).toMatch(/\[MAP\|[^\]]*Ossuary/);

    r = await turn(d, 'look', st, h); hist(h, 'look', r.text); st = r.raw;
    expect(r.text).toContain('Stacked femurs like cordwood.');

    r = await turn(d, 'go south', st, h); hist(h, 'go south', r.text); st = r.raw;
    r = await turn(d, 'go south', st, h); hist(h, 'go south', r.text); st = r.raw;
    expect(r.st.dun.room).toBe('f1:r4');

    r = await turn(d, 'search the crate', st, h); hist(h, 'search the crate', r.text); st = r.raw;
    expect(r.text).toContain('Inside: a few coins.');
    expect(r.st.gold).toBe(35);
    expect(r.st.flags['used:f1:r4:crate']).toBe(true);

    r = await turn(d, 'search the crate', st, h); hist(h, 'search the crate', r.text); st = r.raw;
    expect(r.text).toContain('Just dust now.');
    expect(r.st.gold).toBe(35);

    // "fleece"/word-boundary check: "attack" out of combat, no monster word-catch
    r = await turn(d, 'I attack nothing here', st, h); hist(h, 'I attack nothing here', r.text); st = r.raw;
    expect(r.text).toContain('Nothing here fights back.');

    // "up" on the top floor climbs OUT: the delve ends by choice, back in the hall.
    r = await turn(d, 'up', st, h);
    expect(r.text).toContain('You climb back toward the light');
    expect(r.st.mode).toBe('hall');
    expect(r.st.dun.delveOver).toBeUndefined();
    expect(r.text).toContain('Delve into the dungeon');
  });

  it('combat: attack kills the rat — reward, quiet flag, story gist; monster gates verbs mid-fight', async () => {
    const p = await seedPack();
    const d = delegate('planner');
    const h: Array<{ role: MessageRole; content: string }> = [];
    const st = dungeonState(p, {
      turn: 4,
      dun: { maxHp: 20, hp: 20, atk: 4, inventory: {}, room: 'f1:r2', seen: { 'f1:r1': true, 'f1:r2': true }, escalations: 0,
        combat: { ...RAT }, fightName: 'fight Crypt Rat', fightLog: [] },
    });
    // while the monster lives, movement is gated
    let r = await turn(d, 'go south', st, h);
    expect(r.text).toContain('between you and everything else');
    expect(r.st.dun.room).toBe('f1:r2');

    r = await turn(d, 'attack', r.raw, h);
    expect(r.text).toContain('The rat is still.');
    expect(r.text).toContain('+5 gold');
    expect(r.st.dun.combat).toBeUndefined();
    expect(r.st.gold).toBe(35);
    expect(typeof r.st.flags['quiet:f1:r2']).toBe('number');
    // rolling assigns auto ids (roll#N); the fight's gist line is served in the reply
    expect(r.text).toContain('A blur of dust and teeth.');
  });

  it('event mid-combat: DM opens it same-turn, verbs gate, close resumes the fight', async () => {
    const p = await seedPack();
    const d = delegate('eventDm', ['open_event']);
    const h: Array<{ role: MessageRole; content: string }> = [];
    let st = dungeonState(p, {
      dun: { maxHp: 20, hp: 20, atk: 4, inventory: {}, room: 'f1:r2', seen: { 'f1:r1': true, 'f1:r2': true }, escalations: 0,
        combat: { ...RAT, hp: 2 }, fightName: 'fight Crypt Rat', fightLog: [] },
    });

    let r = await turn(d, 'I whisper to the bones', st, h); hist(h, 'w', r.text); st = r.raw;
    expect(r.st.event?.kind).toBe('communion');
    expect(r.st.dun.combat?.name).toBe('Crypt Rat'); // combat persisted through the scene open
    expect(r.st.dun.escalations).toBe(1);
    expect(r.text).toContain('The bones stir and listen.'); // the scene line wins over DM prose
    expect(prompts.some((pp) => sysOf(pp).includes('dungeon master') && JSON.stringify(pp).includes('IN COMBAT with Crypt Rat'))).toBe(true);

    r = await turn(d, 'attack', st, h); hist(h, 'attack', r.text); st = r.raw;
    expect(r.text).toContain('Finish your business here first.');

    r = await turn(d, 'the bones demand a name', st, h); hist(h, 'name', r.text); st = r.raw;
    expect(r.st.event).toBeUndefined();
    // the closing prose is served once; the gist is NOT re-appended after it
    expect(r.text).toContain('The bones settle.');
    expect(r.text).not.toContain('The bones are appeased.');
    const ids2 = r.st.story?.ids as string[];
    const closeEntry = JSON.parse((await blobs.get(ids2[ids2.length - 1]!))!) as { gist: string };
    expect(closeEntry.gist).toBe('The bones are appeased.');
    expect(r.text).toContain('The way on opens up again.');
    expect(r.st.dun.combat?.hp).toBe(2); // fight state intact

    r = await turn(d, 'attack', st, h);
    expect(r.st.dun.combat).toBeUndefined();
    expect(r.text).toContain('+5 gold');
  });

  it('death ends the delve, not the game: crawl back to the hall healed', async () => {
    const p = await seedPack();
    const d = delegate('planner');
    const h: Array<{ role: MessageRole; content: string }> = [];
    const st = dungeonState(p, {
      dun: { maxHp: 20, hp: 1, atk: 4, inventory: {}, room: 'f1:r1', seen: { 'f1:r1': true }, escalations: 0,
        combat: { ...RAT, hp: 50, atk: 9 }, fightName: 'fight Crypt Rat', fightLog: [] },
    });
    let r = await turn(d, 'attack', st, h);
    expect(r.text).toContain('THE DARK KEEPS YOU');
    expect(r.st.dun.delveOver).toBe('dead');
    expect(r.text).toContain('Return to the hall');

    r = await turn(d, 'anything', r.raw, h);
    expect(r.st.mode).toBe('hall');
    expect(r.st.dun.hp).toBe(r.st.dun.maxHp);
    expect(r.st.dun.delveOver).toBeUndefined();
    expect(r.text).toContain('You find your way back');
  });

  it('the relic ends the delve as a WIN: back to the hall carrying it', async () => {
    const p = await seedPack(true);
    const d = delegate('planner');
    const h: Array<{ role: MessageRole; content: string }> = [];
    const st = dungeonState(p, {
      dun: { maxHp: 20, hp: 20, atk: 4, inventory: {}, room: 'f1:r1', seen: { 'f1:r1': true }, escalations: 0 },
    });
    let r = await turn(d, 'take the relic', st, h);
    expect(r.text).toContain('You take the relic. It hums.');
    expect(r.st.dun.delveOver).toBe('won');
    expect(r.st.flags.relic).toBe(true);
    expect(r.st.dun.inventory.relic).toBe(1);

    r = await turn(d, 'go back', r.raw, h);
    expect(r.st.mode).toBe('hall');
    expect(r.text).toContain('You find your way back');

    // the hall DM briefing knows the player carries the relic
    const d2 = delegate('planner');
    const r2 = await turn(d2, 'I brag about the relic', r.raw, h);
    expect(r2.st.mode).toBe('hall');
    expect(prompts.some((pp) => sysOf(pp).includes('carries the relic'))).toBe(true);
  });

  it('stairs: descend plans f2 in one sub-gen; climb up returns to the stairs you came down', async () => {
    const p = await seedPack();
    const d = delegate('planner');
    const h: Array<{ role: MessageRole; content: string }> = [];
    let st = dungeonState(p, {
      dun: { maxHp: 20, hp: 20, atk: 4, inventory: {}, room: 'f1:r1', seen: { 'f1:r1': true }, escalations: 0 },
    });
    for (const cmd of ['go north', 'go east']) {
      const r = await turn(d, cmd, st, h); hist(h, cmd, r.text); st = r.raw;
    }
    const r = await turn(d, 'go down', st, h); hist(h, 'go down', r.text);
    expect(r.st.packIds?.f2).toBeDefined();
    expect(r.st.dun.room).toMatch(/^f2:r\d+$/);
    expect(r.text).toContain('The stair spits you into dust and dark.');
    expect(r.text).toContain('[MAP|');

    const r2 = await turn(d, 'up', r.raw, h);
    expect(r2.st.dun.room).toBe('f1:r3'); // the stairs room, not the entrance
    expect(r2.st.mode).toBe('dungeon');
  });

  it('dungeon DM mutations: add_exit (grid-derived, symmetric, new pack blob), spawn_enemy (clamped), remove_item', async () => {
    const p = await seedPack();
    const d = delegate('dm', [
      'add_exit {"to":"r5","via":"blown wall"}',
      'spawn_enemy {"name":"Bone Hound","hp":99,"atk":99}',
      'remove_item {"name":"torch"}',
    ]);
    const h: Array<{ role: MessageRole; content: string }> = [];
    const st = dungeonState(p, {
      dun: { maxHp: 20, hp: 20, atk: 4, inventory: { torch: 1 }, room: 'f1:r1', seen: { 'f1:r1': true }, escalations: 0 },
    });
    const r = await turn(d, 'I blow open the annex wall with the torch, and whatever comes through, I fight', st, h);
    expect(r.st.dun.escalations).toBe(1);
    // add_exit: symmetric, compass from geometry (r1(0,1) -> r5(1,1) = east)
    expect(r.st.packIds?.f1).not.toBe(p); // new pack blob committed
    const oldBlob = await readPack(p);
    const newBlob = await readPack(r.st.packIds!.f1!);
    expect(oldBlob.rooms.find((x) => x.id === 'r1')!.exits.east).toBeUndefined(); // branch immutability
    expect(newBlob.rooms.find((x) => x.id === 'r1')!.exits.east).toBe('r5');
    expect(newBlob.rooms.find((x) => x.id === 'r5')!.exits.west).toBe('r1');
    // spawn_enemy: depth-1 clamps 6+4*1 / 1+1, and it joins the roster
    expect(r.st.dun.combat?.name).toBe('Bone Hound');
    expect(r.st.dun.combat?.hp).toBe(10);
    expect(r.st.dun.combat?.atk).toBe(2);
    expect(newBlob.enemies.length).toBe(1);
    // remove_item: torch consumed
    expect(r.st.dun.inventory.torch).toBeUndefined();
  });

  it('delegate failure bricks the branch; recovery is the refusal text', async () => {
    const p = await seedPack();
    const h: Array<{ role: MessageRole; content: string }> = [];
    const r1 = await turn(throwingDelegate('boom'), 'I do something novel', dungeonState(p), h);
    expect(r1.text).toContain('Something broke this turn: boom');
    expect(r1.st.bricked).toBe('boom');

    const r2 = await turn(throwingDelegate('boom'), 'look', r1.raw, h);
    expect(r2.text).toContain('This branch hit an unrecoverable error');
    expect(r2.st.bricked).toBe('boom');
  });

  it('continue/impersonate are refused before any state work', async () => {
    const p = await seedPack();
    const { result } = await runTurnRaw(throwingDelegate('unused'), 'more', dungeonState(p), [], 'continue');
    expect(result.error ?? result.finishReason).toContain('continue');
  });

  it("LEAK HUNT: no summary content in user-role messages or served replies", async () => {
    await seedPack();
    // 7 story entries → crosses RECENT+BACKLOG (6) → next briefing folds
    const storyIds: string[] = [];
    for (let i = 1; i <= 7; i++) {
      storyIds.push(await blobs.put("roll", JSON.stringify({ label: "episode " + i, gist: "Episode " + i + " happened thus." })));
    }
    const d = delegate("dm", []);
    const d2 = delegate("dm", ["open_event"]);
    const h: Array<{ role: MessageRole; content: string }> = [];
    let st = hallState({ turn: 9, story: { kv: { player: "Tester" }, ids: storyIds } });

    // hall DM turn: briefing folds (sub-gen), DM narrates
    let r = await turn(d, "I chat with the quartermaster", st, h); hist(h, "q", r.text); st = r.raw;
    expect(r.st.mode).toBe("hall");

    // open an event from the hall, one scene turn, close it
    r = await turn(d2, "I corner the old knight by the hearth", st, h); hist(h, "k", r.text); st = r.raw;
    expect(r.st.event?.kind).toBe("communion");
    r = await turn(d2, "we talk about the war", st, h); hist(h, "w", r.text);
    expect(r.st.event).toBeUndefined();

    // ── the scan ──
    // Briefing blocks (STORY SO FAR, FACTS, ledger) legitimately ride SYSTEM
    // prompts — that is their channel. And the fold/gist sub-gens (system:
    // "Compress these…" / "Summarize what happened…") carry summaries AS
    // their payload — also by design. A leak is that content reaching any
    // other prompt's user/assistant messages, or a served reply.
    const MARKERS = ["STORY SO FAR", "FACTS:", "roll#", "PLOT LEDGER", "Episode ", "episode ", "happened thus", "Compress these", "Summarize what happened", "digest", "dossier", "older_takes"];
    const hits: string[] = [];
    for (let i = 0; i < prompts.length; i++) {
      const pp = prompts[i]!;
      const sys = sysOf(pp);
      if (sys.startsWith("Compress these") || sys.startsWith("Summarize what happened")) continue; // internal payload
      for (let mi = 0; mi < pp.messages.length; mi++) {
        const m = pp.messages[mi]!;
        if (m.role === "system") continue; // the briefing channel itself
        const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        for (const mk of MARKERS) {
          if (content.includes(mk)) {
            hits.push(`prompt[${i}] msg[${mi}] role=${m.role} marker="${mk}"`);
          }
        }
      }
    }
    for (const m of h) {
      if (m.role !== "assistant") continue;
      for (const mk of MARKERS) {
        if (m.content.includes(mk)) hits.push(`reply marker="${mk}" text=${m.content.slice(0, 60)}`);
      }
    }
    const unique = [...new Set(hits)];
    if (unique.length > 0) console.log("LEAK HITS:\n" + unique.join("\n"));
    expect(unique).toEqual([]);
  });

  it('invalid direction is a free deterministic refusal, never a paid DM turn', async () => {
    const p = await seedPack();
    const d = delegate('planner');
    const h: Array<{ role: MessageRole; content: string }> = [];
    let st = dungeonState(p); // at f1:r1 — exits north/south only

    let r = await turn(d, 'go east', st, h); hist(h, 'go east', r.text); st = r.raw;
    expect(r.text).toContain('No passage east from here.');
    expect(r.st.dun.room).toBe('f1:r1');
    expect(r.st.dun.escalations).toBe(0);

    r = await turn(d, 'west', st, h); hist(h, 'west', r.text); st = r.raw;
    expect(r.text).toContain('No passage west from here.');

    r = await turn(d, 'go down', st, h); hist(h, 'go down', r.text);
    expect(r.text).toContain('No passage down from here.'); // stairs down are at r3

    // no delegate call happened at all — zero model spend
    expect(prompts.length).toBe(0);
  });

  it('verbs are case-insensitive: "Delve" delves, "Shop" shops, "Go North" moves', async () => {
    const p = await seedPack();
    const d = delegate('planner');
    const h: Array<{ role: MessageRole; content: string }> = [];

    let r = await turn(d, 'Shop', hallState(), h); hist(h, 'Shop', r.text);
    expect(r.text).toContain('quartermaster');
    expect(r.st.mode).toBe('hall');

    r = await turn(d, 'Delve', r.raw, h); hist(h, 'Delve', r.text);
    expect(r.st.mode).toBe('dungeon');
    expect(r.text).toContain('The stair spits you into dust and dark.');

    // case-insensitive movement on the seeded pack (r1 exits: north/south)
    const r2 = await turn(d, 'Go North', dungeonState(p), h);
    expect(r2.st.dun.room).toBe('f1:r2');
  });

  it('shop economy: buy_item moves real gold and grants the item; unaffordable is refused', async () => {
    const h: Array<{ role: MessageRole; content: string }> = [];
    let d = delegate('dm', ['buy_item {"item":"rope","price":5}']);
    let r = await turn(d, 'I buy a length of rope', hallState(), h); hist(h, 'buy', r.text);
    expect(r.st.gold).toBe(25);
    expect(r.st.dun.inventory.rope).toBe(1);

    d = delegate('dm', ['buy_item {"item":"plate armor","price":99}']);
    r = await turn(d, 'I buy plate armor', r.raw, h);
    expect(r.st.gold).toBe(25); // unchanged — the engine refused
    expect(r.st.dun.inventory['plate armor']).toBeUndefined();
    const refused = prompts
      .flatMap((p) => p.messages)
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b) => typeof b === 'object' && b !== null && (b as { type?: string }).type === 'tool_result')
      .map((b) => String((b as { content?: unknown }).content));
    expect(refused.some((c) => c.includes('"bought":false'))).toBe(true);
  });

  it('attempt returns ONLY the outcome — no roll/total/difficulty for the DM to quote', async () => {
    const p = await seedPack();
    const d = delegate('dm', ['attempt {"action":"pry the gate","difficulty":10}']);
    const h: Array<{ role: MessageRole; content: string }> = [];
    const r = await turn(d, 'I pry the rusted gate open', dungeonState(p), h);
    expect(r.st.dun.escalations).toBe(1);
    const attemptResult = prompts
      .flatMap((pp) => pp.messages)
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .find((b) => typeof b === 'object' && b !== null && (b as { type?: string }).type === 'tool_result'
        && (b as { name?: string }).name === 'attempt');
    expect(attemptResult).toBeDefined();
    const content = String((attemptResult as { content: unknown }).content);
    expect(content).toContain('"outcome"');
    expect(content).not.toMatch(/"roll"|"total"|"difficulty"/);
  });

  it('/leave: an over-eager finalizer (re-calling close_event) cannot brick the branch', async () => {
    const d = delegate('dm'); // finalizer re-calls close_event every round
    const h: Array<{ role: MessageRole; content: string }> = [];
    const st = hallState({
      eventSeq: 1,
      event: { id: 'e1', kind: 'gossip', context: 'Hearth gossip with the regulars.', participants: [] },
    });
    const r = await turn(d, 'leave', st, h); hist(h, 'leave', r.text);
    expect(r.st.event).toBeUndefined();
    expect(r.st.bricked).toBeUndefined();
    expect(r.text).toContain('They walked out mid-scene.');
    expect(r.text).toContain('You step away; the moment ends.');

    // the branch still plays
    const r2 = await turn(d, 'shop', r.raw, h);
    expect(r2.text).toContain('quartermaster');
    expect(r2.st.bricked).toBeUndefined();
  });

  it('/leave: a finalizer that never calls close_event still closes (fallback gist)', async () => {
    const d = delegate('calmFinalizer');
    const h: Array<{ role: MessageRole; content: string }> = [];
    const st = hallState({
      eventSeq: 1,
      event: { id: 'e1', kind: 'gossip', context: 'Hearth gossip with the regulars.', participants: [] },
    });
    const r = await turn(d, 'leave', st, h);
    expect(r.st.event).toBeUndefined();
    expect(r.st.bricked).toBeUndefined();
    expect(r.text).toContain('The gossip breaks off.');
    expect(r.text).toContain('You step away; the moment ends.');
  });

});
