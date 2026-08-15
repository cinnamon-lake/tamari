/**
 * Streaming-flush broadcast invariant: a throttled mid-stream flush may send
 * part.snapshot only for an index the client already has (or one past its
 * end). When several parts are created inside one throttle window (reasoning
 * then text), the flush must fall back to a full message.snapshot — a lone
 * part.snapshot for the higher index splices holes into the client's parts
 * array and crashes part rendering (MessagePartsView reads part.type).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { TestHarness } from '../testing/TestHarness.js';
import { TrivialBackendAdapter } from '../backends/TrivialBackendAdapter.js';

describe('streaming flush part.snapshot invariant', () => {
  let h: TestHarness | undefined;
  let client: ReturnType<TestHarness['connectClient']>;

  afterEach(async () => {
    await h?.teardown();
    h = undefined;
  });

  it('multi-part throttle windows broadcast a full message.snapshot, never a hole-splicing part.snapshot', async () => {
    // Reasoning finishes and text starts well inside the 1s flush window;
    // text keeps streaming past 1s so the flush fires mid-stream with both
    // parts dirty (min 0, max 1).
    const backend = new TrivialBackendAdapter([
      [{ type: 'thinking', content: 'abc' }, { type: 'content', content: 'x'.repeat(1500) }],
    ]);
    h = new TestHarness({ backendFactory: { create: async () => backend } });
    await h.initSchema();
    client = h.connectClient();
    await h.deps.settings.setValue('model', 'trivial-model');
    await h.deps.settings.setValue('apiKey', 'fake-key');
    await h.deps.settings.setValue('backendProvider', 'openai');
    await h.deps.settings.setValue('maxResponseTokens', 4000);

    await h.send(client, { type: 'character.create', data: { name: 'Bot', description: 'd', firstMes: 'hi' } });
    const charId = h.expectBroadcast('character.created').character.id;
    await h.send(client, { type: 'chat.create', data: { characterId: charId, name: 'Chat' } });
    const chatId = h.expectBroadcast('chat.created').chat.id;
    await h.send(client, { type: 'chat.materialize', chatId });

    await h.send(client, { type: 'action.sendAndGenerate', chatId, content: 'go' });
    h.expectBroadcast('generation.done');

    // Replay the wire through the client's bookkeeping: how many parts of
    // each message it knows about after each broadcast.
    const knownParts = new Map<number, number>();
    for (const msg of client.messages) {
      if (msg.type === 'message.appended' || msg.type === 'message.snapshot') {
        knownParts.set(msg.message.id, msg.message.extra?.parts?.length ?? 0);
      } else if (msg.type === 'part.snapshot') {
        const known = knownParts.get(msg.messageId) ?? 0;
        // The exact client crash: an index past the array splices a hole.
        expect(
          msg.partIndex,
          `part.snapshot index ${msg.partIndex} while the client holds ${known} part(s)`,
        ).toBeLessThanOrEqual(known);
        knownParts.set(msg.messageId, Math.max(known, msg.partIndex + 1));
      }
    }

    // The mid-stream flush must have fired (stream lasted past the 1s
    // throttle) and, with two parts dirty, reconciled via message.snapshot.
    const midStreamSnapshots = client.messages.filter(
      (m) => m.type === 'message.snapshot' && (m.message.extra?.parts?.length ?? 0) >= 2,
    );
    expect(midStreamSnapshots.length).toBeGreaterThan(0);
  });
});
