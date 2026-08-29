/**
 * EventBus unit tests — the WebSocket fan-out core.
 *
 * Uses the MockWebSocket fake (same subset of the `ws` interface the bus
 * touches: readyState / send / close) rather than real socket pairs — fan-out
 * logic only needs readyState gating and send capture, and this matches the
 * existing TestHarness convention.
 */

import { describe, it, expect, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { FullState, ServerMessage } from '@tamari/types';
import { EventBus, type ClientConnection } from './EventBus.js';
import { MockWebSocket } from '../testing/MockWebSocket.js';

function makeClient(
  bus: EventBus,
  opts?: { authenticated?: boolean },
): {
  connection: ClientConnection;
  ws: MockWebSocket;
} {
  const ws = new MockWebSocket();
  const connection = bus.addClient(ws as unknown as WebSocket);
  connection.authenticated = opts?.authenticated ?? true;
  return { connection, ws };
}

function sentTo(ws: MockWebSocket): ServerMessage[] {
  return ws.sentMessages.map((m) => JSON.parse(m) as ServerMessage);
}

describe('EventBus client lifecycle', () => {
  it('assigns incrementing ids and starts clients unauthenticated', () => {
    const bus = new EventBus();
    const a = makeClient(bus);
    const b = makeClient(bus);
    expect(a.connection.id).toBe('c:1');
    expect(b.connection.id).toBe('c:2');
    // Default of a raw addClient is unauthenticated — main.ts flips the flag
    // only after token validation.
    const raw = new EventBus();
    expect(raw.addClient(new MockWebSocket() as unknown as WebSocket).authenticated).toBe(false);
  });

  it('tracks connection count across add/remove', () => {
    const bus = new EventBus();
    const a = makeClient(bus);
    const b = makeClient(bus);
    expect(bus.getConnectionCount()).toBe(2);
    bus.removeClient(a.connection.id);
    expect(bus.getConnectionCount()).toBe(1);
    bus.removeClient(b.connection.id);
    expect(bus.getConnectionCount()).toBe(0);
  });

  it('removeClient on an unknown id is a no-op', () => {
    const bus = new EventBus();
    makeClient(bus);
    bus.removeClient('c:999');
    expect(bus.getConnectionCount()).toBe(1);
  });
});

describe('EventBus dispatch', () => {
  it('invokes registered handlers in registration order with client and message', async () => {
    const bus = new EventBus();
    const { connection } = makeClient(bus);
    const calls: string[] = [];
    bus.registerHandler('chat.list', () => {
      calls.push('first');
    });
    bus.registerHandler('chat.list', () => {
      calls.push('second');
    });
    await bus.dispatch(connection, { type: 'chat.list' });
    expect(calls).toEqual(['first', 'second']);
  });

  it('does nothing for a message type with no registered handlers', async () => {
    const bus = new EventBus();
    const { connection, ws } = makeClient(bus);
    await bus.dispatch(connection, { type: 'chat.list' });
    expect(ws.sentMessages).toEqual([]);
  });

  it('awaits async handlers before resolving', async () => {
    const bus = new EventBus();
    const { connection } = makeClient(bus);
    let done = false;
    bus.registerHandler('chat.list', async () => {
      await new Promise((r) => setTimeout(r, 10));
      done = true;
    });
    await bus.dispatch(connection, { type: 'chat.list' });
    expect(done).toBe(true);
  });

  it('sends an error reply when a handler throws an Error with a code', async () => {
    const bus = new EventBus();
    const { connection, ws } = makeClient(bus);
    bus.registerHandler('chat.list', () => {
      throw Object.assign(new Error('Chat not found'), { code: 'NOT_FOUND' });
    });
    await bus.dispatch(connection, { type: 'chat.list' });
    expect(sentTo(ws)).toEqual([{ type: 'error', message: 'Chat not found', code: 'NOT_FOUND' }]);
  });

  it('maps a codeless Error to INTERNAL_ERROR and a non-Error to a generic message', async () => {
    const bus = new EventBus();
    const { connection, ws } = makeClient(bus);
    bus.registerHandler('chat.list', () => {
      throw new Error('plain boom');
    });
    bus.registerHandler('worldinfo.list', () => {
      // Throw a non-Error value — dispatch must fall back to a generic reply.
      throw 'string failure' as unknown as Error;
    });
    await bus.dispatch(connection, { type: 'chat.list' });
    await bus.dispatch(connection, { type: 'worldinfo.list' });
    expect(sentTo(ws)).toEqual([
      { type: 'error', message: 'plain boom', code: 'INTERNAL_ERROR' },
      { type: 'error', message: 'Internal error', code: 'INTERNAL_ERROR' },
    ]);
  });

  it('a throwing handler does not prevent later handlers for the same type', async () => {
    const bus = new EventBus();
    const { connection } = makeClient(bus);
    const second = vi.fn();
    bus.registerHandler('chat.list', () => {
      throw new Error('first fails');
    });
    bus.registerHandler('chat.list', second);
    await bus.dispatch(connection, { type: 'chat.list' });
    expect(second).toHaveBeenCalledOnce();
  });
});

describe('EventBus broadcast', () => {
  it('sends to every authenticated OPEN client', () => {
    const bus = new EventBus();
    const a = makeClient(bus);
    const b = makeClient(bus);
    bus.broadcast({ type: 'chat.listed', chats: [], total: 0 });
    expect(sentTo(a.ws)).toEqual([{ type: 'chat.listed', chats: [], total: 0 }]);
    expect(sentTo(b.ws)).toEqual([{ type: 'chat.listed', chats: [], total: 0 }]);
  });

  it('skips unauthenticated clients (defense-in-depth behind main.ts token gate)', () => {
    const bus = new EventBus();
    const anon = makeClient(bus, { authenticated: false });
    const authed = makeClient(bus);
    bus.broadcast({ type: 'chat.listed', chats: [], total: 0 });
    expect(anon.ws.sentMessages).toEqual([]);
    expect(authed.ws.sentMessages).toHaveLength(1);
  });

  it('skips clients whose socket is not OPEN', () => {
    const bus = new EventBus();
    const closed = makeClient(bus);
    closed.ws.readyState = 3; // CLOSED
    const open = makeClient(bus);
    bus.broadcast({ type: 'chat.listed', chats: [], total: 0 });
    expect(closed.ws.sentMessages).toEqual([]);
    expect(open.ws.sentMessages).toHaveLength(1);
  });

  it('enriches the message with the originator clientId', () => {
    const bus = new EventBus();
    const { connection, ws } = makeClient(bus);
    bus.broadcast({ type: 'chat.listed', chats: [], total: 0 }, connection.id);
    expect(sentTo(ws)).toEqual([{ type: 'chat.listed', chats: [], total: 0, clientId: connection.id }]);
  });

  it('never attaches clientId to auth.error, even with an originator', () => {
    const bus = new EventBus();
    const { connection, ws } = makeClient(bus);
    bus.broadcast({ type: 'auth.error', message: 'bad token' }, connection.id);
    expect(sentTo(ws)).toEqual([{ type: 'auth.error', message: 'bad token' }]);
  });

  it('aborts the whole broadcast when JSON.stringify throws (no partial fan-out)', () => {
    const bus = new EventBus();
    const a = makeClient(bus);
    const b = makeClient(bus);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    bus.broadcast({ type: 'chat.listed', chats: [], total: 0, evil: circular } as unknown as ServerMessage);
    expect(a.ws.sentMessages).toEqual([]);
    expect(b.ws.sentMessages).toEqual([]);
  });

  it('a throwing ws.send for one client does not stop delivery to others', () => {
    const bus = new EventBus();
    const bad = makeClient(bus);
    bad.ws.send = () => {
      throw new Error('socket exploded');
    };
    const good = makeClient(bus);
    bus.broadcast({ type: 'chat.listed', chats: [], total: 0 });
    expect(good.ws.sentMessages).toHaveLength(1);
  });
});

describe('EventBus sendTo / sendDirect / sendSnapshot', () => {
  it('sendTo delivers only to the addressed client', () => {
    const bus = new EventBus();
    const a = makeClient(bus);
    const b = makeClient(bus);
    bus.sendTo(a.connection.id, { type: 'client.assigned', clientId: a.connection.id });
    expect(a.ws.sentMessages).toHaveLength(1);
    expect(b.ws.sentMessages).toEqual([]);
  });

  it('sendTo to an unknown id is a no-op', () => {
    const bus = new EventBus();
    expect(() => bus.sendTo('c:nope', { type: 'pong' } as unknown as ServerMessage)).not.toThrow();
  });

  it('sendTo skips a non-OPEN socket', () => {
    const bus = new EventBus();
    const { connection, ws } = makeClient(bus);
    ws.readyState = 2; // CLOSING
    bus.sendTo(connection.id, { type: 'client.assigned', clientId: connection.id });
    expect(ws.sentMessages).toEqual([]);
  });

  it('sendTo swallows a throwing ws.send', () => {
    const bus = new EventBus();
    const { connection, ws } = makeClient(bus);
    ws.send = () => {
      throw new Error('boom');
    };
    expect(() => bus.sendTo(connection.id, { type: 'client.assigned', clientId: connection.id })).not.toThrow();
  });

  it('sendTo does not check the authenticated flag (pre-auth error replies need it)', () => {
    const bus = new EventBus();
    const { connection, ws } = makeClient(bus, { authenticated: false });
    bus.sendTo(connection.id, { type: 'error', message: 'Not authenticated', code: 'UNAUTHORIZED' });
    expect(sentTo(ws)).toEqual([{ type: 'error', message: 'Not authenticated', code: 'UNAUTHORIZED' }]);
  });

  it('sendDirect reaches a raw socket that is not in the clients map', () => {
    const bus = new EventBus();
    const ws = new MockWebSocket();
    bus.sendDirect(ws as unknown as WebSocket, { type: 'auth.error', message: 'bad token' });
    expect(sentTo(ws)).toEqual([{ type: 'auth.error', message: 'bad token' }]);
    expect(bus.getConnectionCount()).toBe(0);
  });

  it('sendDirect skips a non-OPEN socket', () => {
    const bus = new EventBus();
    const ws = new MockWebSocket();
    ws.readyState = 3;
    bus.sendDirect(ws as unknown as WebSocket, { type: 'auth.error', message: 'bad token' });
    expect(ws.sentMessages).toEqual([]);
  });

  it('sendSnapshot wraps state in a snapshot message to one client', () => {
    const bus = new EventBus();
    const { connection, ws } = makeClient(bus);
    const state = { characters: [], chats: [], settings: {} } as unknown as FullState;
    bus.sendSnapshot(connection.id, state);
    expect(sentTo(ws)).toEqual([{ type: 'snapshot', state }]);
  });
});

describe('EventBus closeAll', () => {
  it('closes OPEN and CONNECTING sockets and clears the client map', () => {
    const bus = new EventBus();
    const open = makeClient(bus);
    const connecting = makeClient(bus);
    connecting.ws.readyState = 0; // CONNECTING
    const alreadyClosed = makeClient(bus);
    alreadyClosed.ws.readyState = 3; // CLOSED
    const closeSpy = vi.spyOn(alreadyClosed.ws, 'close');

    bus.closeAll();

    expect(open.ws.readyState).toBe(3);
    expect(connecting.ws.readyState).toBe(3);
    // Already-closed sockets are left alone.
    expect(closeSpy).not.toHaveBeenCalled();
    expect(bus.getConnectionCount()).toBe(0);
  });
});
