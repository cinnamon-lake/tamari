import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestHarness } from '../../../server/src/testing/TestHarness.js';
import { TrivialBackendAdapter } from '../../../server/src/backends/TrivialBackendAdapter.js';
import type { ClientMessage } from '@tamari/types';

describe('e2e multi-client consistency', () => {
  let h: TestHarness;

  beforeEach(async () => {
    const backend = new TrivialBackendAdapter([
      [{ type: 'content', content: 'Hello!' }],
    ]);

    h = new TestHarness({
      backendFactory: {
        create: async () => backend,
      },
    });
    await h.initSchema();
  });

  afterEach(async () => {
    await h.teardown();
  });

  it('broadcasts character creation to all connected clients', async () => {
    const clientA = h.connectClient();
    const clientB = h.connectClient();

    await h.send(clientA, {
      type: 'character.create',
      data: { name: 'Seraphina', description: 'A helpful AI.' },
    } as ClientMessage);

    // Both clients should see the broadcast
    const broadcastA = h.expectBroadcast('character.created', clientA);
    const broadcastB = h.expectBroadcast('character.created', clientB);

    expect(broadcastA.character.name).toBe('Seraphina');
    expect(broadcastB.character.name).toBe('Seraphina');
    expect(broadcastA.character.id).toBe(broadcastB.character.id);
  });

  it('sends direct responses only to the requesting client', async () => {
    const clientA = h.connectClient();
    const clientB = h.connectClient();

    // Client A requests its settings
    await h.send(clientA, {
      type: 'settings.get',
      keys: ['activeBackendConfigId'],
    } as ClientMessage);

    // Client A should receive the settings reply
    const loadedA = clientA.messages.filter((m) => m.type === 'settings.loaded');
    expect(loadedA.length).toBe(1);

    // Client B should NOT receive the reply
    const loadedB = clientB.messages.filter((m) => m.type === 'settings.loaded');
    expect(loadedB.length).toBe(0);
  });

  it('broadcasts settings changes to all clients', async () => {
    const clientA = h.connectClient();
    const clientB = h.connectClient();

    await h.send(clientA, {
      type: 'settings.set',
      key: 'activeBackendConfigId',
      value: 'preset-123',
    } as ClientMessage);

    const changeA = h.expectBroadcast('settings.changed', clientA);
    const changeB = h.expectBroadcast('settings.changed', clientB);

    expect(changeA.key).toBe('activeBackendConfigId');
    expect(changeA.value).toBe('preset-123');
    expect(changeB.key).toBe('activeBackendConfigId');
    expect(changeB.value).toBe('preset-123');
  });
});
