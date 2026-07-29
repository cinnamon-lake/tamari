/**
 * settings.set dedup: a value equal to the stored one must not hit SQLite or
 * run the change-keyed side effects (RAG reconfigure, greeting rebroadcast) —
 * but the settings.changed echo is still sent, because clients (e2e helpers,
 * external WS consumers) treat it as the ack for a settings.set.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestHarness, type TestClient } from '../testing/TestHarness.js';

describe('settings.set handler', () => {
  let h: TestHarness;
  let client: TestClient;

  const changedCount = () => client.messages.filter((m) => m.type === 'settings.changed').length;

  beforeEach(async () => {
    h = new TestHarness();
    await h.initSchema();
    client = h.connectClient();
  });

  afterEach(async () => {
    await h.teardown();
  });

  it('persists and broadcasts settings.changed for a changed value', async () => {
    await h.send(client, { type: 'settings.set', key: 'userName', value: 'Alice' });
    expect(changedCount()).toBe(1);
    expect(await h.deps.settings.get('userName')).toBe('Alice');
  });

  it('skips the write but still echoes settings.changed when the value is unchanged', async () => {
    await h.send(client, { type: 'settings.set', key: 'userName', value: 'Alice' });
    expect(changedCount()).toBe(1);

    const writeSpy = vi.spyOn(h.deps.settings, 'setValue');
    await h.send(client, { type: 'settings.set', key: 'userName', value: 'Alice' });
    // No DB write for a no-op set...
    expect(writeSpy).not.toHaveBeenCalled();
    // ...but the echo still goes out — it is the ack contract for settings.set.
    expect(changedCount()).toBe(2);
  });

  it('treats structurally equal (but not identical) values as unchanged', async () => {
    await h.send(client, { type: 'settings.set', key: 'customList', value: [1, 2, { a: 'x' }] });
    expect(changedCount()).toBe(1);

    const writeSpy = vi.spyOn(h.deps.settings, 'setValue');
    await h.send(client, { type: 'settings.set', key: 'customList', value: [1, 2, { a: 'x' }] });
    expect(writeSpy).not.toHaveBeenCalled();
    expect(changedCount()).toBe(2);
  });

  it('writes again once the value actually differs', async () => {
    await h.send(client, { type: 'settings.set', key: 'userName', value: 'Alice' });
    await h.send(client, { type: 'settings.set', key: 'userName', value: 'Alice' });

    const writeSpy = vi.spyOn(h.deps.settings, 'setValue');
    await h.send(client, { type: 'settings.set', key: 'userName', value: 'Bob' });
    expect(writeSpy).toHaveBeenCalledWith('userName', 'Bob');
    expect(changedCount()).toBe(3);
  });

  it('skips the write but still echoes when the value equals the schema default', async () => {
    // reasoningAddToPrompts defaults to false — persisting false explicitly
    // would be a no-op write, but the ack echo must still go out.
    const writeSpy = vi.spyOn(h.deps.settings, 'setValue');
    await h.send(client, { type: 'settings.set', key: 'reasoningAddToPrompts', value: false });
    expect(writeSpy).not.toHaveBeenCalled();
    expect(changedCount()).toBe(1);
  });
});
