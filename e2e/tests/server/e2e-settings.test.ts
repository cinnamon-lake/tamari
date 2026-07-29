import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestHarness } from '../../../server/src/testing/TestHarness.js';
import type { ClientMessage } from '@tamari/types';

describe('e2e settings', () => {
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

  it('sets and gets a string setting', async () => {
    await h.send(client, {
      type: 'settings.set',
      key: 'userName',
      value: 'TestUser',
    } as ClientMessage);
    const broadcast = h.expectBroadcast('settings.changed');
    expect(broadcast.key).toBe('userName');
    expect(broadcast.value).toBe('TestUser');
  });

  it('sets and gets a number setting', async () => {
    await h.send(client, {
      type: 'settings.set',
      key: 'fontScale',
      value: 1.5,
    } as ClientMessage);
    const broadcast = h.expectBroadcast('settings.changed');
    expect(broadcast.key).toBe('fontScale');
    expect(broadcast.value).toBe(1.5);
  });

  it('sets and gets a boolean setting', async () => {
    await h.send(client, {
      type: 'settings.set',
      key: 'showHiddenMessages',
      value: true,
    } as ClientMessage);
    const broadcast = h.expectBroadcast('settings.changed');
    expect(broadcast.key).toBe('showHiddenMessages');
    expect(broadcast.value).toBe(true);
  });

  it('sets and gets an object setting', async () => {
    const value = { theme: 'dark', accent: 'blue' };
    await h.send(client, {
      type: 'settings.set',
      key: 'customTheme',
      value,
    } as ClientMessage);
    const broadcast = h.expectBroadcast('settings.changed');
    expect(broadcast.key).toBe('customTheme');
    expect(broadcast.value).toEqual(value);
  });

  it('sets and gets an array setting', async () => {
    const value = ['tag1', 'tag2', 'tag3'];
    await h.send(client, {
      type: 'settings.set',
      key: 'favoriteTags',
      value,
    } as ClientMessage);
    const broadcast = h.expectBroadcast('settings.changed');
    expect(broadcast.key).toBe('favoriteTags');
    expect(broadcast.value).toEqual(value);
  });

  it('overwrites an existing setting', async () => {
    await h.send(client, {
      type: 'settings.set',
      key: 'userName',
      value: 'First',
    } as ClientMessage);
    h.expectBroadcast('settings.changed');

    await h.send(client, {
      type: 'settings.set',
      key: 'userName',
      value: 'Second',
    } as ClientMessage);
    const broadcast = h.expectBroadcast('settings.changed');
    expect(broadcast.value).toBe('Second');

    // Verify persistence
    const settings = await h.deps.settings.list();
    expect(settings['userName']).toBe('Second');
  });

  it('handles null setting values', async () => {
    await h.send(client, {
      type: 'settings.set',
      key: 'apiUrl',
      value: 'http://example.com/api',
    } as ClientMessage);
    h.expectBroadcast('settings.changed');

    await h.send(client, {
      type: 'settings.set',
      key: 'apiUrl',
      value: null,
    } as ClientMessage);
    const broadcast = h.expectBroadcast('settings.changed');
    expect(broadcast.value).toBeNull();
  });

  it('snapshot includes settings on connect', async () => {
    await h.send(client, {
      type: 'settings.set',
      key: 'userName',
      value: 'SnapshotUser',
    } as ClientMessage);
    h.expectBroadcast('settings.changed');

    // New client should receive snapshot with settings
    const client2 = h.connectClient();
    await h.send(client2, { type: 'auth' } as ClientMessage);
    const snapshot = client2.messages.find((m: any) => m.type === 'snapshot');
    expect(snapshot).toBeDefined();
    expect((snapshot as any).state.settings['userName']).toBe('SnapshotUser');
  });
});
