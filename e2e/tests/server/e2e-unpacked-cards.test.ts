/**
 * e2e: unpacked (on-disk) cards through the real bus/dispatcher.
 *
 * Wires UnpackedCardService + the read-through repository wrappers into the
 * TestHarness via the `wrapRepos` hook (mirroring main.ts: the service holds
 * the INNER repos, everything downstream gets the wrappers), then drives:
 *  1. chat.create → chat.materialize → action.sendAndGenerate with a recording
 *     backend, asserting disk-sourced content (description, first_mes greeting,
 *     lorebook entry, regex rule) reaches the backend prompt;
 *  2. WS write rejection — character.update on an unpacked id → error reply;
 *  3. read-through freshness — a folder edit + explicit rescan flows into the
 *     next generation (the fs watcher is deliberately untested).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ClientMessage, Prompt } from '@tamari/types';
import { TestHarness } from '../../../server/src/testing/TestHarness.js';
import { TrivialBackendAdapter } from '../../../server/src/backends/TrivialBackendAdapter.js';
import { UnpackedCardService } from '../../../server/src/services/unpacked/UnpackedCardService.js';
import { ReadThroughCharacterRepository } from '../../../server/src/services/unpacked/ReadThroughCharacterRepository.js';
import { ReadThroughWorldInfoRepository } from '../../../server/src/services/unpacked/ReadThroughWorldInfoRepository.js';

const CARD_ID = 'unpacked/seraphina';
const DESCRIPTION_V1 = 'DISK DESCRIPTION V1 — cartographer of lost stars';
const DESCRIPTION_V2 = 'DISK DESCRIPTION V2 — cartographer of found stars';
const GREETING = 'DISK GREETING — welcome, traveler';
const LORE = 'LOREBOOK MARKER — the atlas of embers';

/** Trivial backend that also records every prompt it receives. */
class RecordingBackend extends TrivialBackendAdapter {
  readonly prompts: Prompt[] = [];

  override async *stream(prompt: Prompt, signal: AbortSignal) {
    this.prompts.push(prompt);
    // `yield*` evaluates to the inner generator's RETURN value — re-return it.
    return yield* super.stream(prompt, signal);
  }
}

/** Flatten a prompt (system prompt + message contents) to searchable text. */
function promptText(prompt: Prompt): string {
  const parts = prompt.messages.map((m) =>
    typeof m.content === 'string'
      ? m.content
      : m.content.map((p) => (p.type === 'text' ? p.text : '')).join(''),
  );
  return [prompt.systemPrompt ?? '', ...parts].join('\n');
}

/**
 * Write the seraphina/ fixture: meta.json + description + first_mes + one
 * constant lorebook entry (always injected — no keyword fiddling) + one regex
 * rule rewriting "gamma" in prompt-bound chat history.
 */
async function writeCardFolder(rootDir: string, description: string): Promise<string> {
  const dir = join(rootDir, 'seraphina');
  const files: Record<string, string> = {
    'meta.json': JSON.stringify({ name: 'Seraphina', tags: ['disk'], alternateGreetings: ['Alt greeting'] }),
    description,
    first_mes: GREETING,
    'lorebook/atlas.json': JSON.stringify({
      keys: [],
      content: LORE,
      comment: 'always on',
      constant: true,
    }),
    'regex/gamma.json': JSON.stringify({
      findRegex: '/gamma/', // RegexEngine requires /pattern/flags delimiters; bare patterns are inert
      replaceString: 'delta-applied',
      userInput: true,
    }),
  };
  for (const [name, content] of Object.entries(files)) {
    const filePath = join(dir, name);
    mkdirSync(join(filePath, '..'), { recursive: true });
    await fs.writeFile(filePath, content);
  }
  return dir;
}

describe('e2e unpacked cards', () => {
  let h: TestHarness;
  let backend: RecordingBackend;
  let service!: UnpackedCardService; // assigned by wrapRepos during `new TestHarness`
  let client: ReturnType<TestHarness['connectClient']>;

  beforeEach(async () => {
    backend = new RecordingBackend([
      [{ type: 'content', content: 'Reply one.' }],
      [{ type: 'content', content: 'Reply two.' }],
    ]);
    h = new TestHarness({
      backendFactory: { create: async () => backend },
      wrapRepos: (ctx) => {
        service = new UnpackedCardService({
          characters: ctx.characters,
          characterAssets: ctx.characterAssets,
          quickReplies: ctx.quickReplies,
          storage: ctx.storage,
          bus: ctx.bus,
          settings: ctx.settings,
          dataDir: ctx.dataDir,
          watch: false, // scans are driven directly
        });
        return {
          characters: new ReadThroughCharacterRepository(ctx.characters, service),
          worldInfo: new ReadThroughWorldInfoRepository(ctx.worldInfo, service),
        };
      },
    });
    await h.initSchema();
    client = h.connectClient();
  });

  afterEach(async () => {
    service.stop();
    await h.teardown();
  });

  /** Write the fixture, enable the feature gate, and run the initial scan. */
  async function loadCard(description = DESCRIPTION_V1): Promise<string> {
    const dir = await writeCardFolder(service.rootDir, description);
    await h.deps.settings.setValue('unpackedCards.enabled', true);
    await service.start();
    return dir;
  }

  /** Full prerequisites for a generation against the unpacked card. Returns chatId. */
  async function setupChat(): Promise<string> {
    await h.send(client, {
      type: 'persona.create',
      data: { name: 'Tester', description: 'A human user.' },
    } as ClientMessage);
    const persona = h.expectBroadcast('persona.created');

    await h.send(client, {
      type: 'backendConfig.create',
      data: {
        name: 'Test Config',
        description: '',
        backendProvider: 'openai',
        generationMode: 'chat',
        model: 'trivial-model',
        apiKey: 'fake-key',
        contextLength: 4096,
        maxTokens: 100,
        instructTemplate: '',
        providerParams: {},
      },
    } as ClientMessage);
    const preset = h.expectBroadcast('backendConfig.created');

    await h.send(client, {
      type: 'settings.set',
      key: 'activeBackendConfigId',
      value: preset.backendConfig.id,
    } as ClientMessage);
    h.expectBroadcast('settings.changed');

    await h.send(client, {
      type: 'chat.create',
      data: { characterId: CARD_ID, personaId: persona.persona.id, name: 'Test Chat' },
    } as ClientMessage);
    const chat = h.expectBroadcast('chat.created');

    await h.send(client, {
      type: 'chat.materialize',
      chatId: chat.chat.id,
      selectedIndex: 0,
    } as ClientMessage);
    h.expectBroadcast('chat.snapshot');

    return chat.chat.id;
  }

  it('generates with disk-sourced card content end-to-end', async () => {
    await loadCard();
    const chatId = await setupChat();

    await h.send(client, {
      type: 'action.sendAndGenerate',
      chatId,
      content: 'Tell me about gamma',
    } as ClientMessage);
    h.expectBroadcast('generation.done');

    expect(backend.prompts.length).toBe(1);
    const text = promptText(backend.prompts[0]!);
    expect(text).toContain(DESCRIPTION_V1); // description read through from disk
    expect(text).toContain(GREETING); // materialized first_mes in chat history
    expect(text).toContain(LORE); // constant lorebook/ entry injected
    expect(text).toContain('delta-applied'); // regex/ rule applied to prompt-bound history
    expect(text).not.toContain('gamma');
  });

  it('rejects character.update for an unpacked card over WS', async () => {
    await loadCard();

    await h.send(client, {
      type: 'character.update',
      characterId: CARD_ID,
      patch: { description: 'mutated' },
    } as ClientMessage);

    const errors = client.messages.filter((m) => m.type === 'error');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[errors.length - 1]!.message).toContain('unpacked');

    // The overlay still serves the on-disk content, unchanged.
    const card = await h.deps.characters.getById(CARD_ID);
    expect(card?.description).toBe(DESCRIPTION_V1);
    expect(card?.external).toBe(true);
  });

  it('picks up folder edits on rescan (read-through freshness)', async () => {
    const dir = await loadCard();
    const chatId = await setupChat();

    await h.send(client, {
      type: 'action.sendAndGenerate',
      chatId,
      content: 'Hello',
    } as ClientMessage);
    h.expectBroadcast('generation.done');
    expect(backend.prompts.length).toBe(1);
    expect(promptText(backend.prompts[0]!)).toContain(DESCRIPTION_V1);

    // Edit the folder on disk and rescan (the watcher is out of scope here).
    await fs.writeFile(join(dir, 'description'), DESCRIPTION_V2);
    await service.scanFolder(dir);

    await h.send(client, {
      type: 'action.sendAndGenerate',
      chatId,
      content: 'Again',
    } as ClientMessage);
    expect(backend.prompts.length).toBe(2);
    const text = promptText(backend.prompts[1]!);
    expect(text).toContain(DESCRIPTION_V2);
    expect(text).not.toContain(DESCRIPTION_V1);
  });
});
