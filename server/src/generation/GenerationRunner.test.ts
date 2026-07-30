/**
 * Runner-level backend-resolution failures: an unknown provider id must
 * surface as the directed NO_BACKEND error (the registry's loud throw is
 * caught in resolveBackend), not crash the run.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { TestHarness } from '../testing/TestHarness.js';
import { createBackendAdapter, buildAdapterFactoryInput } from '../backends/factory.js';

describe('GenerationRunner backend resolution', () => {
  let h: TestHarness | undefined;

  afterEach(async () => {
    await h?.teardown();
    h = undefined;
  });

  it('unknown provider id produces a directed NO_BACKEND error, not a crash', async () => {
    // Wire the REAL provider factory (the harness default returns null).
    h = new TestHarness({
      backendFactory: { create: async (s) => createBackendAdapter(buildAdapterFactoryInput(s)) },
    });
    await h.initSchema();
    const client = h.connectClient();

    await h.deps.settings.setValue('backendProvider', 'definitely-not-a-provider');
    await h.deps.settings.setValue('apiKey', 'fake-key');
    await h.deps.settings.setValue('model', 'some-model');

    await h.send(client, {
      type: 'character.create',
      data: { name: 'Bot', description: 'd', firstMes: 'hi' },
    });
    const charId = h.expectBroadcast('character.created').character.id;
    await h.send(client, { type: 'chat.create', data: { characterId: charId, name: 'Chat' } });
    const chatId = h.expectBroadcast('chat.created').chat.id;
    await h.send(client, { type: 'chat.materialize', chatId });

    await h.send(client, { type: 'action.sendAndGenerate', chatId, content: 'hello' });

    // The run must not hang or throw: the directed NO_BACKEND error is the
    // terminal signal (no generation record, no generation.done — the same
    // terminal shape as the legacy no-backend path).
    const error = client.messages.find((m) => m.type === 'error');
    expect(error).toBeDefined();
    expect(error!.type === 'error' && error!.code).toBe('NO_BACKEND');
    expect(client.messages.filter((m) => m.type === 'generation.done')).toHaveLength(0);
  });
});
