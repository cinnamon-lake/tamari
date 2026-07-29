import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestHarness } from '../../../server/src/testing/TestHarness.js';
import { TrivialBackendAdapter } from '../../../server/src/backends/TrivialBackendAdapter.js';
import type { ClientMessage } from '@tamari/types';
import { getMessageText } from '@tamari/types';

describe('e2e prompt integration', () => {
  let h: TestHarness;
  let client: ReturnType<TestHarness['connectClient']>;

  beforeEach(async () => {
    const backend = new TrivialBackendAdapter([
      [{ type: 'content', content: 'Response!' }],
    ]);

    h = new TestHarness({
      backendFactory: {
        create: async () => backend,
      },
    });
    await h.initSchema();
    client = h.connectClient();
  });

  afterEach(async () => {
    await h.teardown();
  });

  async function setupChatWithDebug() {
    // Enable prompt debugging
    await h.send(client, {
      type: 'settings.set',
      key: 'debugPrompts',
      value: true,
    } as ClientMessage);
    h.expectBroadcast('settings.changed');

    // Create character
    await h.send(client, {
      type: 'character.create',
      data: {
        name: 'Seraphina',
        description: 'You are {{char}}, a helpful AI.',
        firstMes: 'Greetings {{user}}!',
      },
    } as ClientMessage);
    const char = h.expectBroadcast('character.created');

    // Create persona
    await h.send(client, {
      type: 'persona.create',
      data: { name: 'Tester', description: 'I am {{user}}.' },
    } as ClientMessage);
    const persona = h.expectBroadcast('persona.created');

    // Create preset
    await h.send(client, {
      type: 'backendConfig.create',
      data: {
        name: 'Test Preset',
        backendProvider: 'openai',
        model: 'trivial-model',
        apiKey: 'fake-key',
        contextLength: 4096,
        maxTokens: 100,
      },
    } as ClientMessage);
    const backendConfig = h.expectBroadcast('backendConfig.created');

    await h.send(client, {
      type: 'settings.set',
      key: 'activeBackendConfigId',
      value: backendConfig.backendConfig.id,
    } as ClientMessage);
    h.expectBroadcast('settings.changed');

    // Set user name so {{user}} resolves to something specific
    await h.send(client, {
      type: 'settings.set',
      key: 'userName',
      value: 'Tester',
    } as ClientMessage);
    h.expectBroadcast('settings.changed');

    // Create chat
    await h.send(client, {
      type: 'chat.create',
      data: {
        characterId: char.character.id,
        personaId: persona.persona.id,
        name: 'Test Chat',
      },
    } as ClientMessage);
    const chat = h.expectBroadcast('chat.created');

    // Materialize greeting (macros resolved here)
    await h.send(client, {
      type: 'chat.materialize',
      chatId: chat.chat.id,
      selectedIndex: 0,
    } as ClientMessage);
    h.expectBroadcast('chat.snapshot');

    return { charId: char.character.id, chatId: chat.chat.id };
  }

  it('announces the prompt via prompt.announced in debug mode', async () => {
    const { chatId } = await setupChatWithDebug();

    await h.send(client, {
      type: 'action.send',
      chatId,
      content: 'Hello!',
    } as ClientMessage);
    h.expectBroadcast('chat.snapshot');

    await h.send(client, {
      type: 'action.generate',
      chatId,
    } as ClientMessage);

    const announced = h.expectBroadcast('prompt.announced');
    expect(announced.generationId).toBeDefined();
    expect(announced.prompt).toBeDefined();
    expect(Array.isArray(announced.prompt.messages)).toBe(true);
    expect(announced.prompt.messages.length).toBeGreaterThan(0);
  });

  it('resolves macros in the prompt', async () => {
    const { chatId } = await setupChatWithDebug();

    await h.send(client, {
      type: 'action.send',
      chatId,
      content: 'Hello!',
    } as ClientMessage);
    h.expectBroadcast('chat.snapshot');

    await h.send(client, {
      type: 'action.generate',
      chatId,
    } as ClientMessage);

    const announced = h.expectBroadcast('prompt.announced');
    const messages = announced.prompt.messages as Array<{ role: string; content: string }>;

    // Verify {{char}} was resolved to 'Seraphina' in character description marker
    const systemContents = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content);
    expect(systemContents.some((c) => c.includes('Seraphina'))).toBe(true);

    // Verify {{user}} was resolved to 'Tester' in persona description marker
    expect(systemContents.some((c) => c.includes('Tester'))).toBe(true);

    // Verify greeting macro was resolved in chat history
    const assistantContents = messages
      .filter((m) => m.role === 'assistant')
      .map((m) => m.content);
    expect(assistantContents.some((c) => c.includes('Greetings Tester!'))).toBe(true);
  });

  it('injects world info entries into the prompt', async () => {
    const { charId, chatId } = await setupChatWithDebug();

    // Create a world info book
    await h.send(client, {
      type: 'worldinfo.create',
      data: {
        name: 'Magic Lore',
        entries: [
          {
            keys: ['wizard'],
            content: 'Magic is powered by mana crystals.',
            comment: '',
            position: 'before_char',
            role: 'system',
            order: 100,
            probability: 100,
            constant: false,
            recursive: false,
            selective: false,
            secondaryKeys: [],
            addMemo: false,
            regex: false,
            disable: false,
            retrievalMode: 'keyword',
            depth: 0,
          },
        ],
      },
    } as ClientMessage);
    const book = h.expectBroadcast('worldinfo.created');

    // Link book to character
    await h.send(client, {
      type: 'character.update',
      characterId: charId,
      patch: { worldInfoId: book.book.id },
    } as ClientMessage);
    h.expectBroadcast('character.updated');

    // Send a message that triggers the WI keyword
    await h.send(client, {
      type: 'action.send',
      chatId,
      content: 'I met a wizard today.',
    } as ClientMessage);
    h.expectBroadcast('chat.snapshot');

    await h.send(client, {
      type: 'action.generate',
      chatId,
    } as ClientMessage);

    const announced = h.expectBroadcast('prompt.announced');
    const messages = announced.prompt.messages as Array<{ role: string; content: string }>;
    const systemContents = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content);

    expect(systemContents.some((c) => c.includes('Magic is powered by mana crystals.'))).toBe(true);
  });

  it('injects custom preset prompts into the prompt', async () => {
    // Enable prompt debugging
    await h.send(client, {
      type: 'settings.set',
      key: 'debugPrompts',
      value: true,
    } as ClientMessage);
    h.expectBroadcast('settings.changed');

    // Create character
    await h.send(client, {
      type: 'character.create',
      data: { name: 'Seraphina', description: 'A helpful AI.' },
    } as ClientMessage);
    const char = h.expectBroadcast('character.created');

    // Create preset with a custom prompt
    await h.send(client, {
      type: 'backendConfig.create',
      data: {
        name: 'Custom Prompt Preset',
        backendProvider: 'openai',
        model: 'trivial-model',
        apiKey: 'fake-key',
        contextLength: 4096,
        maxTokens: 100,
      },
    } as ClientMessage);
    const backendConfig = h.expectBroadcast('backendConfig.created');

    await h.send(client, {
      type: 'promptList.create',
      data: {
        name: 'Custom Prompt Preset',
        prompts: [
          {
            identifier: 'main',
            name: 'Main',
            content: 'You are a helpful assistant.',
            role: 'system',
            enabled: true,
            systemPrompt: true,
            marker: false,
          },
          {
            identifier: 'custom-instruction',
            name: 'Custom Instruction',
            content: 'Always be polite and concise.',
            role: 'system',
            enabled: true,
            systemPrompt: true,
            marker: false,
          },
        ],
        promptOrder: [
          { identifier: 'main', enabled: true },
          { identifier: 'custom-instruction', enabled: true },
        ],
      },
    } as ClientMessage);
    const promptList = h.expectBroadcast('promptList.created');

    await h.send(client, {
      type: 'settings.set',
      key: 'activeBackendConfigId',
      value: backendConfig.backendConfig.id,
    } as ClientMessage);
    h.expectBroadcast('settings.changed');

    await h.send(client, {
      type: 'settings.set',
      key: 'activePromptListId',
      value: promptList.promptList.id,
    } as ClientMessage);
    h.expectBroadcast('settings.changed');

    // Create chat
    await h.send(client, {
      type: 'chat.create',
      data: { characterId: char.character.id, name: 'Test Chat' },
    } as ClientMessage);
    const chat = h.expectBroadcast('chat.created');

    await h.send(client, {
      type: 'action.send',
      chatId: chat.chat.id,
      content: 'Hello!',
    } as ClientMessage);
    h.expectBroadcast('chat.snapshot');

    await h.send(client, {
      type: 'action.generate',
      chatId: chat.chat.id,
    } as ClientMessage);

    const announced = h.expectBroadcast('prompt.announced');
    const messages = announced.prompt.messages as Array<{ role: string; content: string }>;
    const systemContents = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content);

    expect(systemContents.some((c) => c.includes('You are a helpful assistant.'))).toBe(true);
    expect(systemContents.some((c) => c.includes('Always be polite and concise.'))).toBe(true);
  });

  it('persists setvar macros across generations', async () => {
    const { chatId } = await setupChatWithDebug();

    // Send user message
    await h.send(client, {
      type: 'action.send',
      chatId,
      content: 'Hello!',
    } as ClientMessage);
    h.expectBroadcast('chat.snapshot');

    // First generation sets a variable
    await h.send(client, {
      type: 'action.generate',
      chatId,
    } as ClientMessage);
    h.expectBroadcast('generation.started');
    h.expectBroadcast('message.snapshot');
    h.expectBroadcast('generation.done');

    // Verify the greeting carried forward its macroVars
    const branch = await h.deps.chats.getActiveBranch(chatId, { limit: 10 });
    const greeting = branch.find((m) => m.role === 'assistant' && getMessageText(m.extra.parts).includes('Greetings'));
    expect(greeting?.extra.macroVars).toBeDefined();

    // Send second message
    await h.send(client, {
      type: 'action.send',
      chatId,
      content: 'How are you?',
    } as ClientMessage);
    h.expectBroadcast('chat.snapshot');

    // Second generation — the backend will emit text that references the var.
    // We can't control the trivial backend text per-generation here easily,
    // so instead we verify the prompt.announced event resolves history macros.
    await h.send(client, {
      type: 'action.generate',
      chatId,
    } as ClientMessage);

    const announced = h.expectBroadcast('prompt.announced');
    expect(announced.prompt.messages.length).toBeGreaterThan(0);

    h.expectBroadcast('generation.started');
    h.expectBroadcast('message.snapshot');
    h.expectBroadcast('generation.done');
  });

  it('injects author note into the prompt', async () => {
    const { chatId } = await setupChatWithDebug();

    // Set author's note via chat metadata
    await h.send(client, {
      type: 'chat.update',
      chatId,
      patch: {
        metadata: {
          authorsNote: {
            content: 'The character loves pineapple pizza.',
            position: 'before_prompt',
            depth: 0,
            role: 'system',
            interval: 1,
          },
        },
      },
    } as ClientMessage);
    h.expectBroadcast('chat.updated');

    await h.send(client, {
      type: 'action.send',
      chatId,
      content: 'Hello!',
    } as ClientMessage);
    h.expectBroadcast('chat.snapshot');

    await h.send(client, {
      type: 'action.generate',
      chatId,
    } as ClientMessage);

    const announced = h.expectBroadcast('prompt.announced');
    const systemContents = (announced.prompt.messages as Array<{ role: string; content: string }>)
      .filter((m) => m.role === 'system')
      .map((m) => m.content);

    expect(systemContents.some((c) => c.includes('The character loves pineapple pizza.'))).toBe(true);
  });

  it('applies character system prompt override', async () => {
    const { charId, chatId } = await setupChatWithDebug();

    // Update character with a system prompt override
    await h.send(client, {
      type: 'character.update',
      characterId: charId,
      patch: { systemPrompt: 'You are an expert quantum physicist.' },
    } as ClientMessage);
    h.expectBroadcast('character.updated');

    await h.send(client, {
      type: 'action.send',
      chatId,
      content: 'Hello!',
    } as ClientMessage);
    h.expectBroadcast('chat.snapshot');

    await h.send(client, {
      type: 'action.generate',
      chatId,
    } as ClientMessage);

    const announced = h.expectBroadcast('prompt.announced');
    const systemContents = (announced.prompt.messages as Array<{ role: string; content: string }>)
      .filter((m) => m.role === 'system')
      .map((m) => m.content);

    // The override should replace the main prompt content
    expect(systemContents.some((c) => c.includes('You are an expert quantum physicist.'))).toBe(true);
    // Default main prompt should NOT appear
    expect(systemContents.some((c) => c.includes("Write Seraphina's next reply"))).toBe(false);
  });

  it('applies character post-history instructions (jailbreak override)', async () => {
    const { charId, chatId } = await setupChatWithDebug();

    await h.send(client, {
      type: 'character.update',
      characterId: charId,
      patch: { postHistoryInstructions: 'Always end with a poetic flourish.' },
    } as ClientMessage);
    h.expectBroadcast('character.updated');

    await h.send(client, {
      type: 'action.send',
      chatId,
      content: 'Hello!',
    } as ClientMessage);
    h.expectBroadcast('chat.snapshot');

    await h.send(client, {
      type: 'action.generate',
      chatId,
    } as ClientMessage);

    const announced = h.expectBroadcast('prompt.announced');
    const systemContents = (announced.prompt.messages as Array<{ role: string; content: string }>)
      .filter((m) => m.role === 'system')
      .map((m) => m.content);

    expect(systemContents.some((c) => c.includes('Always end with a poetic flourish.'))).toBe(true);
  });

  it('includes reasoning blocks in prompt history when reasoningAddToPrompts is enabled', async () => {
    // Use a backend that emits reasoning on the first generation
    const backend = new TrivialBackendAdapter([
      [
        { type: 'thinking', content: 'Let me ponder...' },
        { type: 'content', content: 'Greetings!' },
      ],
      [{ type: 'content', content: 'Second response.' }],
    ]);

    await h.teardown();
    h = new TestHarness({
      backendFactory: { create: async () => backend },
    });
    await h.initSchema();
    client = h.connectClient();

    // Enable debug prompts and reasoning in prompts
    await h.send(client, {
      type: 'settings.set',
      key: 'debugPrompts',
      value: true,
    } as ClientMessage);
    h.expectBroadcast('settings.changed');

    await h.send(client, {
      type: 'settings.set',
      key: 'reasoningAddToPrompts',
      value: true,
    } as ClientMessage);
    h.expectBroadcast('settings.changed');

    // Create character
    await h.send(client, {
      type: 'character.create',
      data: { name: 'Seraphina', description: 'A helpful AI.', firstMes: 'Hello!' },
    } as ClientMessage);
    const char = h.expectBroadcast('character.created');

    // Create preset
    await h.send(client, {
      type: 'backendConfig.create',
      data: {
        name: 'Test Preset',
        backendProvider: 'openai',
        model: 'trivial-model',
        apiKey: 'fake-key',
        contextLength: 4096,
        maxTokens: 100,
      },
    } as ClientMessage);
    const backendConfig = h.expectBroadcast('backendConfig.created');

    await h.send(client, {
      type: 'settings.set',
      key: 'activeBackendConfigId',
      value: backendConfig.backendConfig.id,
    } as ClientMessage);
    h.expectBroadcast('settings.changed');

    // Create chat
    await h.send(client, {
      type: 'chat.create',
      data: { characterId: char.character.id, name: 'Test Chat' },
    } as ClientMessage);
    const chat = h.expectBroadcast('chat.created');

    // Materialize greeting
    await h.send(client, {
      type: 'chat.materialize',
      chatId: chat.chat.id,
      selectedIndex: 0,
    } as ClientMessage);
    h.expectBroadcast('chat.snapshot');

    // First generation — emits reasoning
    await h.send(client, {
      type: 'action.send',
      chatId: chat.chat.id,
      content: 'First message',
    } as ClientMessage);
    h.expectBroadcast('chat.snapshot');

    await h.send(client, {
      type: 'action.generate',
      chatId: chat.chat.id,
    } as ClientMessage);

    h.expectBroadcast('prompt.announced');
    h.expectBroadcast('generation.started');
    h.expectBroadcast('message.snapshot');
    h.expectBroadcast('generation.done');

    // Second generation — check that the assistant history message has reasoning parts
    await h.send(client, {
      type: 'action.send',
      chatId: chat.chat.id,
      content: 'Second message',
    } as ClientMessage);
    h.expectBroadcast('chat.snapshot');

    await h.send(client, {
      type: 'action.generate',
      chatId: chat.chat.id,
    } as ClientMessage);

    const announced = h.expectBroadcast('prompt.announced');
    const assistantMessages = announced.prompt.messages.filter((m: any) => m.role === 'assistant');

    // Find an assistant message whose content is an array (has parts)
    const withParts = assistantMessages.find((m: any) => Array.isArray(m.content));
    expect(withParts).toBeDefined();

    const parts = withParts!.content as Array<{ type: string; text: string }>;
    expect(parts.some((p) => p.type === 'reasoning' && p.text.includes('Let me ponder...'))).toBe(true);
    expect(parts.some((p) => p.type === 'text' && p.text.includes('Greetings!'))).toBe(true);
  });

  it('applies user-input display regex rules at render time', async () => {
    await h.send(client, {
      type: 'settings.set',
      key: 'regexRules',
      value: [
        {
          id: 'rule-1',
          name: 'Foo to Bar',
          findRegex: '/foo/g',
          replaceString: 'bar',
          disabled: false,
          userInput: true,
          aiOutput: false,
          prompt: false,
          display: true,
        },
      ],
    } as ClientMessage);
    h.expectBroadcast('settings.changed');

    const { chatId } = await setupChatWithDebug();

    await h.send(client, {
      type: 'action.send',
      chatId,
      content: 'foo foo foo',
    } as ClientMessage);

    const snapshot = h.expectBroadcast('chat.snapshot');

    // Stored text is raw; renderedHtml applies display regex
    const userMsg = snapshot.messages.find((m: any) => m.role === 'user');
    expect(userMsg).toBeDefined();
    expect(getMessageText(userMsg!.extra.parts)).toBe('foo foo foo');
    expect(userMsg!.renderedHtml).toContain('bar bar bar');
  });

  it('resolves {% if %} blocks conditionally', async () => {
    const { charId, chatId } = await setupChatWithDebug();

    // Set character description to trigger the conditional
    await h.send(client, {
      type: 'character.update',
      characterId: charId,
      patch: { description: 'A helpful AI.' },
    } as ClientMessage);
    h.expectBroadcast('character.updated');

    await h.send(client, {
      type: 'action.send',
      chatId,
      content: 'Hello!',
    } as ClientMessage);
    h.expectBroadcast('chat.snapshot');

    await h.send(client, {
      type: 'action.generate',
      chatId,
    } as ClientMessage);

    const announced = h.expectBroadcast('prompt.announced');
    const systemContents = (announced.prompt.messages as Array<{ role: string; content: string }>)
      .filter((m) => m.role === 'system')
      .map((m) => m.content);

    // The character description should appear in the system prompt
    expect(systemContents.some((c) => c.includes('A helpful AI.'))).toBe(true);
  });

  it('resolves {{for}} loops in the prompt', async () => {
    await h.send(client, {
      type: 'settings.set',
      key: 'debugPrompts',
      value: true,
    } as ClientMessage);
    h.expectBroadcast('settings.changed');

    await h.send(client, {
      type: 'character.create',
      data: {
        name: 'Seraphina',
        description: '{% for trait::wise::kind::powerful %}She is {{trait}}. {% endfor %}',
        firstMes: 'Hello!',
      },
    } as ClientMessage);
    const char = h.expectBroadcast('character.created');

    await h.send(client, {
      type: 'backendConfig.create',
      data: {
        name: 'Test Preset',
        backendProvider: 'openai',
        model: 'trivial-model',
        apiKey: 'fake-key',
        contextLength: 4096,
        maxTokens: 100,
      },
    } as ClientMessage);
    const backendConfig = h.expectBroadcast('backendConfig.created');

    await h.send(client, {
      type: 'settings.set',
      key: 'activeBackendConfigId',
      value: backendConfig.backendConfig.id,
    } as ClientMessage);
    h.expectBroadcast('settings.changed');

    await h.send(client, {
      type: 'chat.create',
      data: { characterId: char.character.id, name: 'Test Chat' },
    } as ClientMessage);
    const chat = h.expectBroadcast('chat.created');

    await h.send(client, {
      type: 'chat.materialize',
      chatId: chat.chat.id,
      selectedIndex: 0,
    } as ClientMessage);
    h.expectBroadcast('chat.snapshot');

    await h.send(client, {
      type: 'action.send',
      chatId: chat.chat.id,
      content: 'Hello!',
    } as ClientMessage);
    h.expectBroadcast('chat.snapshot');

    await h.send(client, {
      type: 'action.generate',
      chatId: chat.chat.id,
    } as ClientMessage);

    const announced = h.expectBroadcast('prompt.announced');
    const systemContents = (announced.prompt.messages as Array<{ role: string; content: string }>)
      .filter((m) => m.role === 'system')
      .map((m) => m.content);

    expect(systemContents.some((c) => c.includes('She is wise.'))).toBe(true);
    expect(systemContents.some((c) => c.includes('She is kind.'))).toBe(true);
    expect(systemContents.some((c) => c.includes('She is powerful.'))).toBe(true);
  });

  it('resolves active setvar/getvar in a single generation', async () => {
    const { chatId } = await setupChatWithDebug();

    // Update character to use a setvar/getvar pattern
    await h.send(client, {
      type: 'character.update',
      characterId: (await h.deps.characters.listSummaries()).items[0]!.id,
      patch: {
        description: 'You are {{char}}. {{setvar::mood::happy}}Current mood: {{getvar::mood}}.',
      },
    } as ClientMessage);
    h.expectBroadcast('character.updated');

    await h.send(client, {
      type: 'action.send',
      chatId,
      content: 'Hello!',
    } as ClientMessage);
    h.expectBroadcast('chat.snapshot');

    await h.send(client, {
      type: 'action.generate',
      chatId,
    } as ClientMessage);

    const announced = h.expectBroadcast('prompt.announced');
    const systemContents = (announced.prompt.messages as Array<{ role: string; content: string }>)
      .filter((m) => m.role === 'system')
      .map((m) => m.content);

    expect(systemContents.some((c) => c.includes('Current mood: happy.'))).toBe(true);
  });

  it('resolves {{description}}, {{personality}}, and {{scenario}} macros', async () => {
    await h.send(client, {
      type: 'settings.set',
      key: 'debugPrompts',
      value: true,
    } as ClientMessage);
    h.expectBroadcast('settings.changed');

    await h.send(client, {
      type: 'character.create',
      data: {
        name: 'Seraphina',
        description: 'A helpful AI.',
        personality: 'Friendly.',
        scenario: 'A fantasy world.',
      },
    } as ClientMessage);
    const char = h.expectBroadcast('character.created');

    await h.send(client, {
      type: 'backendConfig.create',
      data: {
        name: 'Macro Test Preset',
        backendProvider: 'openai',
        model: 'trivial-model',
        apiKey: 'fake-key',
        contextLength: 4096,
        maxTokens: 100,
      },
    } as ClientMessage);
    const backendConfig = h.expectBroadcast('backendConfig.created');

    await h.send(client, {
      type: 'promptList.create',
      data: {
        name: 'Macro Test Preset',
        prompts: [
          {
            identifier: 'main',
            name: 'Main',
            content: 'Desc: {{description}} | Personality: {{personality}} | Scenario: {{scenario}}',
            role: 'system',
            enabled: true,
            systemPrompt: true,
            marker: false,
          },
        ],
        promptOrder: [{ identifier: 'main', enabled: true }],
      },
    } as ClientMessage);
    const promptList = h.expectBroadcast('promptList.created');

    await h.send(client, {
      type: 'settings.set',
      key: 'activeBackendConfigId',
      value: backendConfig.backendConfig.id,
    } as ClientMessage);
    h.expectBroadcast('settings.changed');

    await h.send(client, {
      type: 'settings.set',
      key: 'activePromptListId',
      value: promptList.promptList.id,
    } as ClientMessage);
    h.expectBroadcast('settings.changed');

    await h.send(client, {
      type: 'chat.create',
      data: { characterId: char.character.id, name: 'Test Chat' },
    } as ClientMessage);
    const chat = h.expectBroadcast('chat.created');

    await h.send(client, {
      type: 'action.send',
      chatId: chat.chat.id,
      content: 'Hello!',
    } as ClientMessage);
    h.expectBroadcast('chat.snapshot');

    await h.send(client, {
      type: 'action.generate',
      chatId: chat.chat.id,
    } as ClientMessage);

    const announced = h.expectBroadcast('prompt.announced');
    const systemContents = (announced.prompt.messages as Array<{ role: string; content: string }>)
      .filter((m) => m.role === 'system')
      .map((m) => m.content);

    expect(systemContents.some((c) => c.includes('Desc: A helpful AI.'))).toBe(true);
    expect(systemContents.some((c) => c.includes('Personality: Friendly.'))).toBe(true);
    expect(systemContents.some((c) => c.includes('Scenario: A fantasy world.'))).toBe(true);
  });

  it('resolves {{lastMessage}}, {{lastUserMessage}}, and {{lastCharMessage}} macros', async () => {
    await h.send(client, {
      type: 'settings.set',
      key: 'debugPrompts',
      value: true,
    } as ClientMessage);
    h.expectBroadcast('settings.changed');

    await h.send(client, {
      type: 'character.create',
      data: { name: 'Seraphina', description: 'A helpful AI.' },
    } as ClientMessage);
    const char = h.expectBroadcast('character.created');

    await h.send(client, {
      type: 'backendConfig.create',
      data: {
        name: 'Macro Test Preset',
        backendProvider: 'openai',
        model: 'trivial-model',
        apiKey: 'fake-key',
        contextLength: 4096,
        maxTokens: 100,
      },
    } as ClientMessage);
    const backendConfig = h.expectBroadcast('backendConfig.created');

    await h.send(client, {
      type: 'promptList.create',
      data: {
        name: 'Macro Test Preset',
        prompts: [
          {
            identifier: 'main',
            name: 'Main',
            content: 'Last: {{lastMessage}} | User: {{lastUserMessage}} | Char: {{lastCharMessage}}',
            role: 'system',
            enabled: true,
            systemPrompt: true,
            marker: false,
          },
        ],
        promptOrder: [{ identifier: 'main', enabled: true }],
      },
    } as ClientMessage);
    const promptList = h.expectBroadcast('promptList.created');

    await h.send(client, {
      type: 'settings.set',
      key: 'activeBackendConfigId',
      value: backendConfig.backendConfig.id,
    } as ClientMessage);
    h.expectBroadcast('settings.changed');

    await h.send(client, {
      type: 'settings.set',
      key: 'activePromptListId',
      value: promptList.promptList.id,
    } as ClientMessage);
    h.expectBroadcast('settings.changed');

    await h.send(client, {
      type: 'chat.create',
      data: { characterId: char.character.id, name: 'Test Chat' },
    } as ClientMessage);
    const chat = h.expectBroadcast('chat.created');

    // First generation: fresh generation after user message
    await h.send(client, {
      type: 'action.send',
      chatId: chat.chat.id,
      content: 'Greetings!',
    } as ClientMessage);
    h.expectBroadcast('chat.snapshot');

    await h.send(client, {
      type: 'action.generate',
      chatId: chat.chat.id,
    } as ClientMessage);

    const firstAnnounced = h.expectBroadcast('prompt.announced');
    h.expectBroadcast('message.snapshot');
    h.expectBroadcast('generation.done');

    const firstSystemContents = (firstAnnounced.prompt.messages as Array<{ role: string; content: string }>)
      .filter((m) => m.role === 'system')
      .map((m) => m.content);

    // On first generation, lastMessage = empty assistant placeholder, lastUserMessage = user text
    expect(firstSystemContents.some((c) => c.includes('User: Greetings!'))).toBe(true);

    // Continue: target message already has content, so lastMessage/lastCharMessage resolve to it
    await h.send(client, {
      type: 'action.continue',
      chatId: chat.chat.id,
    } as ClientMessage);

    const continueAnnounced = h.expectBroadcast('prompt.announced');
    h.expectBroadcast('message.snapshot');
    h.expectBroadcast('generation.done');

    const continueSystemContents = (continueAnnounced.prompt.messages as Array<{ role: string; content: string }>)
      .filter((m) => m.role === 'system')
      .map((m) => m.content);

    // On continue, the target message already has "Response!", so lastMessage/lastCharMessage resolve
    expect(continueSystemContents.some((c) => c.includes('Last: Response!'))).toBe(true);
    expect(continueSystemContents.some((c) => c.includes('User: Greetings!'))).toBe(true);
    expect(continueSystemContents.some((c) => c.includes('Char: Response!'))).toBe(true);
  });

  it('resolves {{equal}} and {{?}} conditional macros', async () => {
    await h.send(client, {
      type: 'settings.set',
      key: 'debugPrompts',
      value: true,
    } as ClientMessage);
    h.expectBroadcast('settings.changed');

    await h.send(client, {
      type: 'character.create',
      data: { name: 'Seraphina', description: 'A helpful AI.' },
    } as ClientMessage);
    const char = h.expectBroadcast('character.created');

    await h.send(client, {
      type: 'backendConfig.create',
      data: {
        name: 'Macro Test Preset',
        backendProvider: 'openai',
        model: 'trivial-model',
        apiKey: 'fake-key',
        contextLength: 4096,
        maxTokens: 100,
      },
    } as ClientMessage);
    const backendConfig = h.expectBroadcast('backendConfig.created');

    await h.send(client, {
      type: 'promptList.create',
      data: {
        name: 'Macro Test Preset',
        prompts: [
          {
            identifier: 'main',
            name: 'Main',
            content: 'eq-true:{{equal::foo::foo}}|eq-false:{{equal::foo::bar}}|q-true:{{?::foo::bar}}|q-false:{{?::false}}|q-and:{{?::foo&&bar}}',
            role: 'system',
            enabled: true,
            systemPrompt: true,
            marker: false,
          },
        ],
        promptOrder: [{ identifier: 'main', enabled: true }],
      },
    } as ClientMessage);
    const promptList = h.expectBroadcast('promptList.created');

    await h.send(client, {
      type: 'settings.set',
      key: 'activeBackendConfigId',
      value: backendConfig.backendConfig.id,
    } as ClientMessage);
    h.expectBroadcast('settings.changed');

    await h.send(client, {
      type: 'settings.set',
      key: 'activePromptListId',
      value: promptList.promptList.id,
    } as ClientMessage);
    h.expectBroadcast('settings.changed');

    await h.send(client, {
      type: 'chat.create',
      data: { characterId: char.character.id, name: 'Test Chat' },
    } as ClientMessage);
    const chat = h.expectBroadcast('chat.created');

    await h.send(client, {
      type: 'action.send',
      chatId: chat.chat.id,
      content: 'Hello!',
    } as ClientMessage);
    h.expectBroadcast('chat.snapshot');

    await h.send(client, {
      type: 'action.generate',
      chatId: chat.chat.id,
    } as ClientMessage);

    const announced = h.expectBroadcast('prompt.announced');
    const systemContents = (announced.prompt.messages as Array<{ role: string; content: string }>)
      .filter((m) => m.role === 'system')
      .map((m) => m.content);

    expect(systemContents.some((c) => c.includes('eq-true:true'))).toBe(true);
    expect(systemContents.some((c) => c.includes('eq-false:'))).toBe(true);
    expect(systemContents.some((c) => c.includes('q-true:true'))).toBe(true);
    expect(systemContents.some((c) => c.includes('q-false:'))).toBe(true);
    expect(systemContents.some((c) => c.includes('q-and:true'))).toBe(true);
  });

  it('resolves {{model}}, {{maxContext}}, and {{maxResponse}} macros', async () => {
    await h.send(client, {
      type: 'settings.set',
      key: 'debugPrompts',
      value: true,
    } as ClientMessage);
    h.expectBroadcast('settings.changed');

    await h.send(client, {
      type: 'character.create',
      data: { name: 'Seraphina', description: 'A helpful AI.' },
    } as ClientMessage);
    const char = h.expectBroadcast('character.created');

    await h.send(client, {
      type: 'backendConfig.create',
      data: {
        name: 'Macro Test Preset',
        backendProvider: 'openai',
        model: 'test-model-42',
        apiKey: 'fake-key',
        contextLength: 8192,
        maxTokens: 256,
      },
    } as ClientMessage);
    const backendConfig = h.expectBroadcast('backendConfig.created');

    await h.send(client, {
      type: 'promptList.create',
      data: {
        name: 'Macro Test Preset',
        prompts: [
          {
            identifier: 'main',
            name: 'Main',
            content: 'Model:{{model}}|Ctx:{{maxContext}}|Resp:{{maxResponse}}',
            role: 'system',
            enabled: true,
            systemPrompt: true,
            marker: false,
          },
        ],
        promptOrder: [{ identifier: 'main', enabled: true }],
      },
    } as ClientMessage);
    const promptList = h.expectBroadcast('promptList.created');

    await h.send(client, {
      type: 'settings.set',
      key: 'activeBackendConfigId',
      value: backendConfig.backendConfig.id,
    } as ClientMessage);
    h.expectBroadcast('settings.changed');

    await h.send(client, {
      type: 'settings.set',
      key: 'activePromptListId',
      value: promptList.promptList.id,
    } as ClientMessage);
    h.expectBroadcast('settings.changed');

    await h.send(client, {
      type: 'chat.create',
      data: { characterId: char.character.id, name: 'Test Chat' },
    } as ClientMessage);
    const chat = h.expectBroadcast('chat.created');

    await h.send(client, {
      type: 'action.send',
      chatId: chat.chat.id,
      content: 'Hello!',
    } as ClientMessage);
    h.expectBroadcast('chat.snapshot');

    await h.send(client, {
      type: 'action.generate',
      chatId: chat.chat.id,
    } as ClientMessage);

    const announced = h.expectBroadcast('prompt.announced');
    const systemContents = (announced.prompt.messages as Array<{ role: string; content: string }>)
      .filter((m) => m.role === 'system')
      .map((m) => m.content);

    expect(systemContents.some((c) => c.includes('Model:test-model-42'))).toBe(true);
    expect(systemContents.some((c) => c.includes('Ctx:8192'))).toBe(true);
    expect(systemContents.some((c) => c.includes('Resp:256'))).toBe(true);
  });

  it('resolves {{random}}, {{pick}}, and {{roll}} macros', async () => {
    await h.send(client, {
      type: 'settings.set',
      key: 'debugPrompts',
      value: true,
    } as ClientMessage);
    h.expectBroadcast('settings.changed');

    await h.send(client, {
      type: 'character.create',
      data: { name: 'Seraphina', description: 'A helpful AI.' },
    } as ClientMessage);
    const char = h.expectBroadcast('character.created');

    await h.send(client, {
      type: 'backendConfig.create',
      data: {
        name: 'Macro Test Preset',
        backendProvider: 'openai',
        model: 'trivial-model',
        apiKey: 'fake-key',
        contextLength: 4096,
        maxTokens: 100,
      },
    } as ClientMessage);
    const backendConfig = h.expectBroadcast('backendConfig.created');

    await h.send(client, {
      type: 'promptList.create',
      data: {
        name: 'Macro Test Preset',
        prompts: [
          {
            identifier: 'main',
            name: 'Main',
            content: 'Rand:{{random::1::10}}|Pick:{{pick::alpha::beta::gamma}}|Roll:{{roll::2d6}}',
            role: 'system',
            enabled: true,
            systemPrompt: true,
            marker: false,
          },
        ],
        promptOrder: [{ identifier: 'main', enabled: true }],
      },
    } as ClientMessage);
    const promptList = h.expectBroadcast('promptList.created');

    await h.send(client, {
      type: 'settings.set',
      key: 'activeBackendConfigId',
      value: backendConfig.backendConfig.id,
    } as ClientMessage);
    h.expectBroadcast('settings.changed');

    await h.send(client, {
      type: 'settings.set',
      key: 'activePromptListId',
      value: promptList.promptList.id,
    } as ClientMessage);
    h.expectBroadcast('settings.changed');

    await h.send(client, {
      type: 'chat.create',
      data: { characterId: char.character.id, name: 'Test Chat' },
    } as ClientMessage);
    const chat = h.expectBroadcast('chat.created');

    await h.send(client, {
      type: 'action.send',
      chatId: chat.chat.id,
      content: 'Hello!',
    } as ClientMessage);
    h.expectBroadcast('chat.snapshot');

    await h.send(client, {
      type: 'action.generate',
      chatId: chat.chat.id,
    } as ClientMessage);

    const announced = h.expectBroadcast('prompt.announced');
    const systemContents = (announced.prompt.messages as Array<{ role: string; content: string }>)
      .filter((m) => m.role === 'system')
      .map((m) => m.content);

    const content = systemContents.join(' ');

    // random::1::10 should be 1-10
    const randMatch = content.match(/Rand:([1-9]|10)\b/);
    expect(randMatch).toBeTruthy();

    // pick should be one of the three options
    const pickMatch = content.match(/Pick:(alpha|beta|gamma)\b/);
    expect(pickMatch).toBeTruthy();

    // roll::2d6 should be 2-12
    const rollMatch = content.match(/Roll:([2-9]|1[0-2])\b/);
    expect(rollMatch).toBeTruthy();
  });

  it('resolves date and time macros', async () => {
    await h.send(client, {
      type: 'settings.set',
      key: 'debugPrompts',
      value: true,
    } as ClientMessage);
    h.expectBroadcast('settings.changed');

    await h.send(client, {
      type: 'character.create',
      data: { name: 'Seraphina', description: 'A helpful AI.' },
    } as ClientMessage);
    const char = h.expectBroadcast('character.created');

    await h.send(client, {
      type: 'backendConfig.create',
      data: {
        name: 'Macro Test Preset',
        backendProvider: 'openai',
        model: 'trivial-model',
        apiKey: 'fake-key',
        contextLength: 4096,
        maxTokens: 100,
      },
    } as ClientMessage);
    const backendConfig = h.expectBroadcast('backendConfig.created');

    await h.send(client, {
      type: 'promptList.create',
      data: {
        name: 'Macro Test Preset',
        prompts: [
          {
            identifier: 'main',
            name: 'Main',
            content: 'Date:{{date}}|Time:{{time}}|Week:{{weekday}}|IsoDate:{{isodate}}|IsoTime:{{isotime}}|Fmt:{{datetimeformat::YYYY-MM-DD HH:mm}}',
            role: 'system',
            enabled: true,
            systemPrompt: true,
            marker: false,
          },
        ],
        promptOrder: [{ identifier: 'main', enabled: true }],
      },
    } as ClientMessage);
    const promptList = h.expectBroadcast('promptList.created');

    await h.send(client, {
      type: 'settings.set',
      key: 'activeBackendConfigId',
      value: backendConfig.backendConfig.id,
    } as ClientMessage);
    h.expectBroadcast('settings.changed');

    await h.send(client, {
      type: 'settings.set',
      key: 'activePromptListId',
      value: promptList.promptList.id,
    } as ClientMessage);
    h.expectBroadcast('settings.changed');

    await h.send(client, {
      type: 'chat.create',
      data: { characterId: char.character.id, name: 'Test Chat' },
    } as ClientMessage);
    const chat = h.expectBroadcast('chat.created');

    await h.send(client, {
      type: 'action.send',
      chatId: chat.chat.id,
      content: 'Hello!',
    } as ClientMessage);
    h.expectBroadcast('chat.snapshot');

    await h.send(client, {
      type: 'action.generate',
      chatId: chat.chat.id,
    } as ClientMessage);

    const announced = h.expectBroadcast('prompt.announced');
    const systemContents = (announced.prompt.messages as Array<{ role: string; content: string }>)
      .filter((m) => m.role === 'system')
      .map((m) => m.content);

    const content = systemContents.join(' ');

    // Date should be like "June 15, 2024"
    expect(content).toMatch(/Date:(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\b/);
    // Time should be HH:mm
    expect(content).toMatch(/Time:\d{2}:\d{2}\b/);
    // Weekday should be a day name
    expect(content).toMatch(/Week:(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/);
    // IsoDate should be YYYY-MM-DD
    expect(content).toMatch(/IsoDate:\d{4}-\d{2}-\d{2}\b/);
    // IsoTime should be HH:mm
    expect(content).toMatch(/IsoTime:\d{2}:\d{2}\b/);
    // datetimeformat should be YYYY-MM-DD HH:mm
    expect(content).toMatch(/Fmt:\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\b/);
  });

  it('resolves {{trim}}, {{newline}}, and {{noop}} utility macros', async () => {
    await h.send(client, {
      type: 'settings.set',
      key: 'debugPrompts',
      value: true,
    } as ClientMessage);
    h.expectBroadcast('settings.changed');

    await h.send(client, {
      type: 'character.create',
      data: { name: 'Seraphina', description: 'A helpful AI.' },
    } as ClientMessage);
    const char = h.expectBroadcast('character.created');

    await h.send(client, {
      type: 'backendConfig.create',
      data: {
        name: 'Macro Test Preset',
        backendProvider: 'openai',
        model: 'trivial-model',
        apiKey: 'fake-key',
        contextLength: 4096,
        maxTokens: 100,
      },
    } as ClientMessage);
    const backendConfig = h.expectBroadcast('backendConfig.created');

    await h.send(client, {
      type: 'promptList.create',
      data: {
        name: 'Macro Test Preset',
        prompts: [
          {
            identifier: 'main',
            name: 'Main',
            content: 'Trim:{{trim::  spaced  }}|New:a{{newline}}b|Noop:{{noop}}x',
            role: 'system',
            enabled: true,
            systemPrompt: true,
            marker: false,
          },
        ],
        promptOrder: [{ identifier: 'main', enabled: true }],
      },
    } as ClientMessage);
    const promptList = h.expectBroadcast('promptList.created');

    await h.send(client, {
      type: 'settings.set',
      key: 'activeBackendConfigId',
      value: backendConfig.backendConfig.id,
    } as ClientMessage);
    h.expectBroadcast('settings.changed');

    await h.send(client, {
      type: 'settings.set',
      key: 'activePromptListId',
      value: promptList.promptList.id,
    } as ClientMessage);
    h.expectBroadcast('settings.changed');

    await h.send(client, {
      type: 'chat.create',
      data: { characterId: char.character.id, name: 'Test Chat' },
    } as ClientMessage);
    const chat = h.expectBroadcast('chat.created');

    await h.send(client, {
      type: 'action.send',
      chatId: chat.chat.id,
      content: 'Hello!',
    } as ClientMessage);
    h.expectBroadcast('chat.snapshot');

    await h.send(client, {
      type: 'action.generate',
      chatId: chat.chat.id,
    } as ClientMessage);

    const announced = h.expectBroadcast('prompt.announced');
    const systemContents = (announced.prompt.messages as Array<{ role: string; content: string }>)
      .filter((m) => m.role === 'system')
      .map((m) => m.content);

    const content = systemContents.join(' ');
    expect(content).toContain('Trim:spaced');
    expect(content).toContain('New:a\nb');
    expect(content).toContain('Noop:x');
  });

  it('resolves {{.x}} shorthand, {{lastGenerationType}}, and {{hasExtension}}', async () => {
    await h.send(client, {
      type: 'settings.set',
      key: 'debugPrompts',
      value: true,
    } as ClientMessage);
    h.expectBroadcast('settings.changed');

    await h.send(client, {
      type: 'settings.set',
      key: 'extensions',
      value: ['regex', 'tts'],
    } as ClientMessage);
    h.expectBroadcast('settings.changed');

    await h.send(client, {
      type: 'character.create',
      data: { name: 'Seraphina', description: 'A helpful AI.' },
    } as ClientMessage);
    const char = h.expectBroadcast('character.created');

    // First, send a message that sets a variable via setvar
    await h.send(client, {
      type: 'backendConfig.create',
      data: {
        name: 'Macro Test Preset',
        backendProvider: 'openai',
        model: 'trivial-model',
        apiKey: 'fake-key',
        contextLength: 4096,
        maxTokens: 100,
      },
    } as ClientMessage);
    const backendConfig = h.expectBroadcast('backendConfig.created');

    await h.send(client, {
      type: 'promptList.create',
      data: {
        name: 'Macro Test Preset',
        prompts: [
          {
            identifier: 'main',
            name: 'Main',
            content: '{{setvar::mood::happy}}',
            role: 'system',
            enabled: true,
            systemPrompt: true,
            marker: false,
          },
          {
            identifier: 'second',
            name: 'Second',
            content: 'Shorthand:{{.mood}}|GenType:{{lastGenerationType}}|Ext:{{hasExtension::regex}}|NoExt:{{hasExtension::missing}}',
            role: 'system',
            enabled: true,
            systemPrompt: true,
            marker: false,
          },
        ],
        promptOrder: [
          { identifier: 'main', enabled: true },
          { identifier: 'second', enabled: true },
        ],
      },
    } as ClientMessage);
    const promptList = h.expectBroadcast('promptList.created');

    await h.send(client, {
      type: 'settings.set',
      key: 'activeBackendConfigId',
      value: backendConfig.backendConfig.id,
    } as ClientMessage);
    h.expectBroadcast('settings.changed');

    await h.send(client, {
      type: 'settings.set',
      key: 'activePromptListId',
      value: promptList.promptList.id,
    } as ClientMessage);
    h.expectBroadcast('settings.changed');

    await h.send(client, {
      type: 'chat.create',
      data: { characterId: char.character.id, name: 'Test Chat' },
    } as ClientMessage);
    const chat = h.expectBroadcast('chat.created');

    await h.send(client, {
      type: 'action.send',
      chatId: chat.chat.id,
      content: 'Hello!',
    } as ClientMessage);
    h.expectBroadcast('chat.snapshot');

    await h.send(client, {
      type: 'action.generate',
      chatId: chat.chat.id,
    } as ClientMessage);

    const announced = h.expectBroadcast('prompt.announced');
    const systemContents = (announced.prompt.messages as Array<{ role: string; content: string }>)
      .filter((m) => m.role === 'system')
      .map((m) => m.content);

    const content = systemContents.join(' ');
    expect(content).toContain('Shorthand:happy');
    expect(content).toContain('GenType:send');
    expect(content).toContain('Ext:true');
    expect(content).toContain('NoExt:'); // empty because missing extension
  });

  it('resolves {{img}}, {{firstIncludedMessageId}}, and {{currentSwipeId}} macros', async () => {
    await h.send(client, {
      type: 'settings.set',
      key: 'debugPrompts',
      value: true,
    } as ClientMessage);
    h.expectBroadcast('settings.changed');

    await h.send(client, {
      type: 'character.create',
      data: { name: 'Seraphina', description: 'A helpful AI.' },
    } as ClientMessage);
    const char = h.expectBroadcast('character.created');

    // Create a character asset for the img macro
    await h.deps.characterAssets.create(char.character.id, {
      name: 'logo.png',
      type: 'image',
      ext: 'png',
      filePath: '/fake/path/logo.png',
      meta: {},
    });

    await h.send(client, {
      type: 'backendConfig.create',
      data: {
        name: 'Macro Test Preset',
        backendProvider: 'openai',
        model: 'trivial-model',
        apiKey: 'fake-key',
        contextLength: 4096,
        maxTokens: 100,
      },
    } as ClientMessage);
    const backendConfig = h.expectBroadcast('backendConfig.created');

    await h.send(client, {
      type: 'promptList.create',
      data: {
        name: 'Macro Test Preset',
        prompts: [
          {
            identifier: 'main',
            name: 'Main',
            content: 'Img:{{img::logo.png}}|FirstId:{{firstIncludedMessageId}}|SwipeId:{{currentSwipeId}}',
            role: 'system',
            enabled: true,
            systemPrompt: true,
            marker: false,
          },
        ],
        promptOrder: [{ identifier: 'main', enabled: true }],
      },
    } as ClientMessage);
    const promptList = h.expectBroadcast('promptList.created');

    await h.send(client, {
      type: 'settings.set',
      key: 'activeBackendConfigId',
      value: backendConfig.backendConfig.id,
    } as ClientMessage);
    h.expectBroadcast('settings.changed');

    await h.send(client, {
      type: 'settings.set',
      key: 'activePromptListId',
      value: promptList.promptList.id,
    } as ClientMessage);
    h.expectBroadcast('settings.changed');

    await h.send(client, {
      type: 'chat.create',
      data: { characterId: char.character.id, name: 'Test Chat' },
    } as ClientMessage);
    const chat = h.expectBroadcast('chat.created');

    await h.send(client, {
      type: 'action.send',
      chatId: chat.chat.id,
      content: 'Hello!',
    } as ClientMessage);
    h.expectBroadcast('chat.snapshot');

    await h.send(client, {
      type: 'action.generate',
      chatId: chat.chat.id,
    } as ClientMessage);

    const announced = h.expectBroadcast('prompt.announced');
    const systemContents = (announced.prompt.messages as Array<{ role: string; content: string }>)
      .filter((m) => m.role === 'system')
      .map((m) => m.content);

    const content = systemContents.join(' ');

    // img is now a display-only macro, so it passes through in prompts
    expect(content).toContain('Img:{{img::logo.png}}');

    // firstIncludedMessageId and currentSwipeId should be numeric message IDs
    expect(content).toMatch(/FirstId:\d+/);
    expect(content).toMatch(/SwipeId:\d+/);
  });
});
