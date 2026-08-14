/**
 * e2e: test_card headless chat simulation (CardTestService + run verb).
 *
 * Drives the real bus/dispatcher through CardTestService with a scripted
 * TrivialBackendAdapter, asserting transcript ordering, generation ids,
 * temp-chat cleanup, debugPrompts restoration, and arg validation — plus the
 * WorkbenchTemplate run-verb wiring with a stubbed provider set.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ClientMessage } from '@tamari/types';
import { TestHarness } from '../../../server/src/testing/TestHarness.js';
import { TrivialBackendAdapter } from '../../../server/src/backends/TrivialBackendAdapter.js';
import { UnpackedCardService } from '../../../server/src/services/unpacked/UnpackedCardService.js';
import { CardTestService } from '../../../server/src/services/CardTestService.js';
import { WorkbenchTemplate } from '../../../server/src/services/templates/workbench/WorkbenchTemplate.js';
import type { WorkbenchProviders } from '../../../server/src/services/templates/workbench/router.js';

describe('e2e test_card', () => {
  let h: TestHarness;
  let cardTest: CardTestService;
  let client: ReturnType<TestHarness['connectClient']>;

  beforeEach(async () => {
    const backend = new TrivialBackendAdapter([
      [{ type: 'content', content: 'Reply one.' }],
      [{ type: 'content', content: 'Reply two.' }],
    ]);
    let unpackedCards!: UnpackedCardService;
    let innerCharacters = null as unknown as ConstructorParameters<typeof CardTestService>[0]['characters'];
    h = new TestHarness({
      backendFactory: { create: async () => backend },
      wrapRepos: (ctx) => {
        // CardTestService needs an UnpackedCardService for folderPath
        // resolution; unused for DB cards, so it is never started here.
        unpackedCards = new UnpackedCardService({
          characters: ctx.characters,
          characterAssets: ctx.characterAssets,
          quickReplies: ctx.quickReplies,
          storage: ctx.storage,
          bus: ctx.bus,
          settings: ctx.settings,
          dataDir: ctx.dataDir,
          watch: false,
        });
        innerCharacters = ctx.characters;
        return {};
      },
    });
    cardTest = new CardTestService({
      bus: h.bus,
      chats: h.deps.chats,
      characters: innerCharacters,
      settings: h.deps.settings,
      unpackedCards,
    });
    await h.initSchema();
    client = h.connectClient();

    await h.send(client, {
      type: 'persona.create',
      data: { name: 'Tester', description: 'A human user.' },
    } as ClientMessage);
    h.expectBroadcast('persona.created');

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
      type: 'character.create',
      data: { name: 'Testsubject', description: 'A test subject.' },
    } as ClientMessage);
    h.expectBroadcast('character.created');
  });

  afterEach(async () => {
    await h.teardown();
  });

  function characterId(): string {
    return h.expectBroadcast('character.created').character.id;
  }

  it('runs a scripted chat and cleans up after itself', async () => {
    const result = await cardTest.run({ characterId: characterId(), turns: ['Hello', 'Again'] });
    expect(typeof result.content).toBe('string');
    const parsed = JSON.parse(result.content as string);

    expect(parsed.characterName).toBe('Testsubject');
    expect(parsed.turns).toHaveLength(2);
    expect(parsed.turns[0]).toMatchObject({ input: 'Hello', reply: 'Reply one.', finishReason: expect.any(String) });
    expect(parsed.turns[1]).toMatchObject({ input: 'Again', reply: 'Reply two.' });
    expect(parsed.generationIds).toHaveLength(2);
    expect(parsed.turns[0].generationId).toBe(parsed.generationIds[0]);

    // Temp chat deleted: no chatId in the result, no chats left behind.
    expect(parsed.chatId).toBeUndefined();
    const remaining = await h.deps.chats.listChats({ limit: 100 });
    expect(remaining.items).toHaveLength(0);

    // debugPrompts restored to its previous value.
    expect(await h.deps.settings.get('debugPrompts')).toBeFalsy();
  });

  it('keeps the chat when keepChat is set', async () => {
    const result = await cardTest.run({ characterId: characterId(), turns: ['Hello'], keepChat: true });
    const parsed = JSON.parse(result.content as string);
    expect(typeof parsed.chatId).toBe('string');
    const chat = await h.deps.chats.getChatById(parsed.chatId);
    expect(chat).toBeDefined();
    const chain = await h.deps.chats.getMessageChain(parsed.chatId);
    expect(chain.some((m) => m.role === 'assistant' && (m.extra.parts ?? []).some((p) => p.type === 'text' && p.text === 'Reply one.'))).toBe(true);
  });

  it('rejects invalid args and unknown cards with Error content', async () => {
    const noCard = await cardTest.run({ turns: ['hi'] });
    expect(noCard.content).toMatch(/^Error: invalid arguments/);

    const missing = await cardTest.run({ characterId: 'nope', turns: ['hi'] });
    expect(missing.content).toMatch(/^Error: character not found: nope/);
  });

  it('is wired into the workbench run verbs', async () => {
    const fakeProvider = { execute: async () => ({ content: '{}' }) };
    const providers = {
      characterWorkbench: fakeProvider,
      backendWorkbench: fakeProvider,
      toolsetWorkbench: fakeProvider,
      quickReplyWorkbench: fakeProvider,
      luaToolWorkbench: fakeProvider,
      cardTest,
    } as unknown as WorkbenchProviders;
    const template = new WorkbenchTemplate(providers);

    const menu = await template.execute('run', {});
    expect(menu.content).toContain('test_card');

    const result = await template.execute('run', { verb: 'test_card', args: { characterId: characterId(), turns: ['Hello'] } });
    const parsed = JSON.parse(result.content as string);
    expect(parsed.turns[0].reply).toBe('Reply one.');
  });
});
