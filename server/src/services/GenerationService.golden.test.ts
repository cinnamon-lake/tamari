/**
 * Golden-prompt tests — pin the exact prompt the backend receives for each
 * generation command kind (send, continue, regenerate, impersonate, genraw).
 *
 * These are the safety net for prompt-shape regressions: they run at the WS
 * level through the TestHarness, so they are implementation-agnostic. Snapshots
 * are byte-exact — never regenerate with `vitest -u` unless a prompt-shape
 * delta is explicitly intended, and review the diff when you do.
 *
 * The impersonate snapshot reflects the generation-runner design: the
 * impersonation instruction is trailing seed content on the target (a system
 * message appended after history), not a prompt-list slot.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestHarness } from '../testing/TestHarness.js';
import { TrivialBackendAdapter } from '../backends/TrivialBackendAdapter.js';
import type { Prompt } from '../backends/BackendAdapter.js';

/** Trivial backend that records every prompt it receives. */
class RecordingBackend extends TrivialBackendAdapter {
  readonly prompts: Prompt[] = [];

  override async *stream(prompt: Prompt, signal: AbortSignal) {
    this.prompts.push(prompt);
    // `yield*` evaluates to the inner generator's RETURN value — re-return it.
    return yield* super.stream(prompt, signal);
  }
}

/** Stable, snapshot-friendly view of a prompt (drops derived token counts). */
function golden(prompt: Prompt) {
  return {
    messages: prompt.messages,
    text: prompt.text,
    params: prompt.params,
    cacheDepth: prompt.cacheDepth,
  };
}

describe('generation golden prompts', () => {
  let h: TestHarness;
  let client: ReturnType<TestHarness['connectClient']>;
  let backend: RecordingBackend;

  beforeEach(async () => {
    backend = new RecordingBackend([
      [{ type: 'content', content: 'Reply one.' }],
      [{ type: 'content', content: ' continued.' }],
      [{ type: 'content', content: 'Reply regenerated.' }],
      [{ type: 'content', content: 'Impersonated user text.' }],
    ]);
    h = new TestHarness({ backendFactory: { create: async () => backend } });
    await h.initSchema();
    client = h.connectClient();

    await h.deps.settings.setValue('model', 'trivial-model');
    await h.deps.settings.setValue('apiKey', 'fake-key');
    await h.deps.settings.setValue('backendProvider', 'openai');
    await h.deps.settings.setValue('contextLength', 4096);
    await h.deps.settings.setValue('maxResponseTokens', 100);
  });

  afterEach(async () => {
    await h.teardown();
  });

  async function createCardChat(): Promise<string> {
    await h.send(client, {
      type: 'character.create',
      data: {
        name: 'Goldie',
        description: 'Goldie is a golden retriever scholar.',
        personality: 'Erudite, warm',
        scenario: 'A library by the sea.',
        firstMes: 'Woof. Shall we begin?',
        mesExample: '{{user}}: Hi\n{{char}}: Woof, hello.',
      },
    });
    const created = h.expectBroadcast('character.created');
    const chat = await (async () => {
      await h.send(client, {
        type: 'chat.create',
        data: { characterId: created.character.id, name: 'Golden Chat' },
      });
      return h.expectBroadcast('chat.created').chat.id;
    })();
    await h.send(client, { type: 'chat.materialize', chatId: chat });
    return chat;
  }

  it('send: full prompt assembly for a character card chat', async () => {
    const chatId = await createCardChat();

    await h.send(client, { type: 'action.sendAndGenerate', chatId, content: 'Tell me about tides.' });
    h.expectBroadcast('generation.done');

    expect(backend.prompts).toHaveLength(1);
    expect(golden(backend.prompts[0]!)).toMatchSnapshot();
  });

  it('continue: prompt carries the partial assistant message as its tail', async () => {
    const chatId = await createCardChat();
    await h.send(client, { type: 'action.sendAndGenerate', chatId, content: 'Tell me about tides.' });
    h.expectBroadcast('generation.done');

    await h.send(client, { type: 'action.continue', chatId });

    expect(backend.prompts).toHaveLength(2);
    expect(golden(backend.prompts[1]!)).toMatchSnapshot();
  });

  it('regenerate: prompt is rebuilt from the same history as the original send', async () => {
    const chatId = await createCardChat();
    await h.send(client, { type: 'action.sendAndGenerate', chatId, content: 'Tell me about tides.' });
    h.expectBroadcast('generation.done');

    await h.send(client, { type: 'action.regenerate', chatId });
    h.expectBroadcast('generation.done');

    expect(backend.prompts).toHaveLength(2);
    // NOTE: the legacy bulk-read path makes this prompt differ subtly from
    // the original send's (message-set quirk). The golden captures current
    // behavior as-is; the generation-runner migration must reproduce it
    // exactly (branch-up-to-parent + empty target tail).
    expect(golden(backend.prompts[1]!)).toMatchSnapshot();
  });

  it('impersonate: prompt includes the impersonation instruction; no message is persisted', async () => {
    const chatId = await createCardChat();
    const branchBefore = (await h.deps.chats.getActiveBranch(chatId)).length;

    await h.send(client, { type: 'action.impersonate', chatId });

    expect(backend.prompts).toHaveLength(1);
    // Draft semantics: the branch is untouched by an impersonation.
    expect((await h.deps.chats.getActiveBranch(chatId)).length).toBe(branchBefore);
    expect(golden(backend.prompts[0]!)).toMatchSnapshot();
  });

  it('genraw: raw prompt reaches the backend with no pipeline assembly', async () => {
    const chatId = await createCardChat();

    await h.send(client, {
      type: 'quickreply.create',
      data: {
        scope: 'chat',
        scopeId: chatId,
        label: 'genraw',
        script: "st.genraw('UNIQUE_RAW_PROMPT'):await()",
        language: 'lua',
      },
    });
    const created = client.messages.filter((m) => m.type === 'quickreply.created').at(-1);
    const qrId = created && created.type === 'quickreply.created' ? created.item.id : '';

    await h.send(client, { type: 'quickreply.execute', id: qrId, chatId });

    expect(backend.prompts).toHaveLength(1);
    expect(JSON.stringify(backend.prompts[0])).toContain('UNIQUE_RAW_PROMPT');
    expect(golden(backend.prompts[0]!)).toMatchSnapshot();
  });
});
