/**
 * Dispatcher-level regression tests for two audit findings
 * (docs/quality/audits/interface-audit-2026-07-20.md, live bugs #3 and #4):
 *
 * 1. `settings.get` (dispatch/settingsHandlers.ts, 'settings.get' handler)
 *    replies with a FAKE `snapshot`
 *    whose `characters: []` / `chats: []` wholesale-replace the client's
 *    sidebar lists, wiping them. It should reply with a dedicated settings
 *    message (e.g. `settings.loaded`) — or at least never carry empty list
 *    fields. FAILS today: the fake snapshot is delivered.
 *
 * 2. `auth` (dispatch/authHandlers.ts, 'auth' handler) sets
 *    `client.authenticated = true`
 *    with no token check and hands out the full state snapshot — an
 *    authentication bypass for any client still inside the WS rejection grace
 *    period. FAILS today: the snapshot is delivered to the unauthenticated
 *    client.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ServerMessage } from '@tamari/types';
import { TestHarness } from './testing/TestHarness.js';

type SnapshotMessage = Extract<ServerMessage, { type: 'snapshot' }>;

describe('dispatcher: settings.get must not wipe client lists', () => {
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

  it('does not reply with a snapshot carrying empty characters/chats arrays', async () => {
    // Seed a character so there IS client list state to wipe.
    await h.send(client, {
      type: 'character.create',
      data: { name: 'TestBot', description: 'A test bot.', firstMes: 'Hello!' },
    });
    h.expectBroadcast('character.created');

    client.messages.length = 0;
    await h.send(client, { type: 'settings.get', keys: ['userName'] });

    // The client must receive its settings in SOME form…
    const settingsReply = client.messages.find(
      (m) => m.type === 'snapshot' || (m.type as string) === 'settings.loaded',
    );
    expect(settingsReply).toBeDefined();

    // …but if the reply is a full-state snapshot, its list fields must NOT be
    // empty arrays — the client's snapshot handler replaces `characters` and
    // `chats` wholesale, so `{ characters: [], chats: [] }` wipes the sidebar.
    const snapshot = client.messages.find((m): m is SnapshotMessage => m.type === 'snapshot');
    if (snapshot) {
      expect(snapshot.state.characters).not.toEqual([]);
      expect(snapshot.state.chats).not.toEqual([]);
    }
  });
});

describe('dispatcher: auth case must not bypass authentication', () => {
  let h: TestHarness;
  let client: ReturnType<TestHarness['connectClient']>;

  beforeEach(async () => {
    h = new TestHarness();
    await h.initSchema();
    client = h.connectClient();
    // Simulate a client whose WS token was rejected but which is still inside
    // the wsAuthRejectionMs grace window.
    client.connection.authenticated = false;
  });

  afterEach(async () => {
    await h.teardown();
  });

  it('rejects privileged messages from unauthenticated clients (control: passes)', async () => {
    await h.send(client, { type: 'worldinfo.list' });
    const error = client.messages.find((m) => m.type === 'error');
    expect(error).toBeDefined();
    expect(error?.code).toBe('UNAUTHORIZED');
  });

  it("sending { type: 'auth' } does not authenticate the client or release the snapshot (BUG)", async () => {
    await h.send(client, { type: 'auth' });

    // An unauthenticated client must not be able to self-authorize…
    expect(client.connection.authenticated).toBe(false);

    // …and must never receive the full state snapshot.
    const snapshot = client.messages.find((m) => m.type === 'snapshot');
    expect(snapshot).toBeUndefined();
  });
});
