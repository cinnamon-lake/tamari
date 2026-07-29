/**
 * Regression tests for the send/generate ordering race and the quick-reply
 * lock defects fixed alongside the atomic `action.sendAndGenerate` message:
 *
 *   Race A — separate action.send + action.generate frames were dispatched
 *            fire-and-forget and raced at the chat mutex (generate could win
 *            and build a prompt without the new user message; group members
 *            each re-locked, allowing interleaving between members).
 *   Race B — USER_MESSAGE quick replies raced generation for the lock and
 *            were silently skipped.
 *   Race C — BEFORE_GENERATION / AI_MESSAGE triggers ran inside the
 *            generation's lock tenure and could never acquire it.
 *   Issue D — an empty client injections array wiped Lua st.inject state.
 *   Issue E — st.genraw / st.ask deadlocked against the script's own lock
 *            (missing lockHolder pass-through).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestHarness } from '../testing/TestHarness.js';
import { TrivialBackendAdapter } from '../backends/TrivialBackendAdapter.js';
import type { Prompt } from '../backends/BackendAdapter.js';
import { QuickReplyAutoExecute } from '@tamari/types';

/** Trivial backend that also records every prompt it receives. */
class RecordingBackend extends TrivialBackendAdapter {
  readonly prompts: Prompt[] = [];

  override async *stream(prompt: Prompt, signal: AbortSignal) {
    this.prompts.push(prompt);
    // `yield*` evaluates to the inner generator's RETURN value — it must be
    // re-returned or runQuietGeneration sees `result === undefined`.
    return yield* super.stream(prompt, signal);
  }
}

describe('send/generate ordering (race fixes)', () => {
  let h: TestHarness;
  let client: ReturnType<TestHarness['connectClient']>;
  let backend: RecordingBackend;

  beforeEach(async () => {
    backend = new RecordingBackend([
      [{ type: 'content', content: 'Reply one.' }],
      [{ type: 'content', content: 'Reply two.' }],
      [{ type: 'content', content: 'Reply three.' }],
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

  async function createCharacter(name: string): Promise<string> {
    await h.send(client, {
      type: 'character.create',
      data: { name, description: `${name} description.`, firstMes: `${name} greeting.` },
    });
    const created = h.expectBroadcast('character.created');
    // The broadcast list grows across calls within a test; pick by name.
    const all = client.messages.filter((m) => m.type === 'character.created');
    const mine = all.reverse().find((m) => m.type === 'character.created' && m.character.name === name);
    return mine && mine.type === 'character.created' ? mine.character.id : created.character.id;
  }

  async function createChat(characterId: string | null): Promise<string> {
    await h.send(client, { type: 'chat.create', data: { characterId, name: 'Test Chat' } });
    const created = h.expectBroadcast('chat.created');
    return created.chat.id;
  }

  /** All message `extra` JSON blobs for a chat, for token searches. */
  async function messageExtras(chatId: string): Promise<string> {
    const msgs = await h.deps.chats.getActiveBranch(chatId);
    return msgs.map((m) => JSON.stringify(m.extra)).join('\n');
  }

  it('action.sendAndGenerate appends the user message and includes it in the prompt', async () => {
    const charId = await createCharacter('RaceBot');
    const chatId = await createChat(charId);
    await h.send(client, { type: 'chat.materialize', chatId });

    await h.send(client, { type: 'action.sendAndGenerate', chatId, content: 'hello UNIQUE_USER_TURN' });

    h.expectBroadcast('generation.done');
    expect(backend.prompts).toHaveLength(1);
    // The generation prompt must contain the just-sent user message — the
    // race let generate run on the pre-send state instead.
    expect(JSON.stringify(backend.prompts[0]!.messages)).toContain('UNIQUE_USER_TURN');

    // And the branch order is user → assistant (not assistant → user).
    const branch = await h.deps.chats.getActiveBranch(chatId);
    const roles = branch.map((m) => m.role);
    expect(roles.indexOf('user')).toBeLessThan(roles.lastIndexOf('assistant'));
  });

  it('USER_MESSAGE quick reply runs deterministically between append and generate', async () => {
    const charId = await createCharacter('QrBot');
    const chatId = await createChat(charId);
    await h.send(client, { type: 'chat.materialize', chatId });

    await h.send(client, {
      type: 'quickreply.create',
      data: {
        scope: 'chat',
        scopeId: chatId,
        label: 'UM marker',
        script: "st.send_narrator('QR_UM_FIRED'):await()",
        language: 'lua',
        autoExecute: QuickReplyAutoExecute.USER_MESSAGE,
      },
    });

    await h.send(client, { type: 'action.sendAndGenerate', chatId, content: 'trigger the qr' });
    h.expectBroadcast('generation.done');

    // Previously the QR raced generation for the chat lock and was silently
    // skipped; in the single coroutine it always runs.
    expect(await messageExtras(chatId)).toContain('QR_UM_FIRED');
  });

  it('BEFORE_GENERATION and AI_MESSAGE quick replies actually fire', async () => {
    const charId = await createCharacter('LifecycleBot');
    const chatId = await createChat(charId);
    await h.send(client, { type: 'chat.materialize', chatId });

    await h.send(client, {
      type: 'quickreply.create',
      data: {
        scope: 'chat',
        scopeId: chatId,
        label: 'before marker',
        script: "st.send_narrator('QR_BEFORE_FIRED'):await()",
        language: 'lua',
        autoExecute: QuickReplyAutoExecute.BEFORE_GENERATION,
      },
    });
    await h.send(client, {
      type: 'quickreply.create',
      data: {
        scope: 'chat',
        scopeId: chatId,
        label: 'after marker',
        script: "st.send_narrator('QR_AFTER_FIRED'):await()",
        language: 'lua',
        autoExecute: QuickReplyAutoExecute.AI_MESSAGE,
      },
    });

    await h.send(client, { type: 'action.sendAndGenerate', chatId, content: 'go' });
    h.expectBroadcast('generation.done');

    // Both used to be structurally unable to run (fired inside the
    // generation's own lock tenure; QR tryLock always failed).
    const extras = await messageExtras(chatId);
    expect(extras).toContain('QR_BEFORE_FIRED');
    expect(extras).toContain('QR_AFTER_FIRED');
  });

  it('an empty client injections array does not wipe Lua st.inject state', async () => {
    const charId = await createCharacter('InjectBot');
    const chatId = await createChat(charId);
    await h.send(client, { type: 'chat.materialize', chatId });

    h.deps.generationService.setPendingInjection(chatId, 'LUA_INJECT_TOKEN');

    // The client always sends an injections array — possibly empty.
    await h.send(client, { type: 'action.sendAndGenerate', chatId, content: 'go', injections: [] });
    h.expectBroadcast('generation.done');

    expect(JSON.stringify(backend.prompts[0]!.messages)).toContain('LUA_INJECT_TOKEN');
  });

  it('st.genraw from a quick reply completes without the 10s lock stall', async () => {
    const charId = await createCharacter('GenrawBot');
    const chatId = await createChat(charId);
    await h.send(client, { type: 'chat.materialize', chatId });

    await h.send(client, {
      type: 'quickreply.create',
      data: {
        scope: 'chat',
        scopeId: chatId,
        label: 'genraw',
        script: "st.genraw('raw prompt'):await()",
        language: 'lua',
      },
    });
    const created = client.messages.filter((m) => m.type === 'quickreply.created').at(-1);
    const qrId = created && created.type === 'quickreply.created' ? created.item.id : '';

    const start = Date.now();
    await h.send(client, { type: 'quickreply.execute', id: qrId, chatId });
    const elapsed = Date.now() - start;

    // The old missing-lockHolder path deadlocked until the QR's 10s teardown
    // cap released the lock; the fix makes it immediate.
    expect(elapsed).toBeLessThan(8000);
    expect(await messageExtras(chatId)).toContain('Reply one.');
  });

  it('st.ask from a quick reply completes without the 10s lock stall', async () => {
    const charId = await createCharacter('AskBot');
    const chatId = await createChat(charId);
    await h.send(client, { type: 'chat.materialize', chatId });

    await h.send(client, {
      type: 'quickreply.create',
      data: {
        scope: 'chat',
        scopeId: chatId,
        label: 'ask',
        script: "st.ask('AskBot', 'hello there'):await()",
        language: 'lua',
      },
    });
    const created = client.messages.filter((m) => m.type === 'quickreply.created').at(-1);
    const qrId = created && created.type === 'quickreply.created' ? created.item.id : '';

    const start = Date.now();
    await h.send(client, { type: 'quickreply.execute', id: qrId, chatId });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(8000);
    expect(await messageExtras(chatId)).toContain('Reply one.');
  });

  it('group chat generation runs the whole member sequence under one tenure', async () => {
    const charA = await createCharacter('GroupA');
    const charB = await createCharacter('GroupB');
    const chatId = await createChat(null);
    await h.send(client, { type: 'group.member.add', chatId, characterId: charA });
    await h.send(client, { type: 'group.member.add', chatId, characterId: charB });
    await h.send(client, { type: 'chat.materialize', chatId });

    await h.send(client, { type: 'action.sendAndGenerate', chatId, content: 'hello group GROUP_TURN' });
    h.expectBroadcast('generation.done');

    // Both activated members reply, and both prompts include the user turn.
    expect(backend.prompts.length).toBe(2);
    for (const prompt of backend.prompts) {
      expect(JSON.stringify(prompt.messages)).toContain('GROUP_TURN');
    }
    const branch = await h.deps.chats.getActiveBranch(chatId);
    expect(branch.filter((m) => m.role === 'assistant')).toHaveLength(2);
  });
});
