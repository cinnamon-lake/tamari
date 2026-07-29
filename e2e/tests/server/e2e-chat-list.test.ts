import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestHarness } from '../../../server/src/testing/TestHarness.js';
import type { ClientMessage } from '@tamari/types';

describe('chat.list', () => {
  let h: TestHarness;
  let client: ReturnType<TestHarness['connectClient']>;

  beforeEach(async () => {
    h = new TestHarness();
    await h.initSchema();
    client = h.connectClient();
  });

  afterEach(async () => {
    await h.teardown();
  });

  it('responds with chat.listed for a character', async () => {
    await h.send(client, {
      type: 'character.create',
      data: { name: 'Alice', description: 'Test' },
    } as ClientMessage);
    const charBroadcast = h.expectBroadcast('character.created');
    const charId = charBroadcast.character.id;

    await h.send(client, {
      type: 'chat.create',
      data: { characterId: charId, name: 'Chat 1' },
    } as ClientMessage);
    h.expectBroadcast('chat.created');

    await h.send(client, {
      type: 'chat.list',
      characterId: charId,
    } as ClientMessage);

    // Check the raw mock WebSocket messages
    const ws = client.connection.ws as any;
    console.log('WS SENT MESSAGES:', JSON.stringify(ws.sentMessages.map((s: string) => JSON.parse(s).type)));
    console.log('CLIENT MESSAGES:', JSON.stringify(client.messages.map(m => m.type)));

    const listed = client.messages.find((m) => m.type === 'chat.listed');
    expect(listed).toBeDefined();
    expect((listed as any).total).toBe(1);
  });
});
