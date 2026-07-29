import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { MockWebSocket } from '../test/mocks/WebSocketMock.js';

let WebSocketBus: typeof import('./WebSocketBus.js').WebSocketBus;

describe('WebSocketBus', () => {
  beforeAll(async () => {
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:8000' });
    const module = await import('./WebSocketBus.js');
    WebSocketBus = module.WebSocketBus;
  });

  beforeEach(() => {
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:8000' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function createBus(url?: string): { bus: InstanceType<typeof WebSocketBus>; mock: MockWebSocket } {
    const bus = new WebSocketBus(url);
    bus.connect();
    const mock = (bus as unknown as { ws: MockWebSocket }).ws;
    return { bus, mock };
  }

  async function flushMicrotasks() {
    await new Promise<void>((r) => queueMicrotask(() => r()));
  }

  it('constructs with ws: protocol for http', () => {
    const { bus } = createBus();
    expect((bus as unknown as { url: string }).url).toMatch(/^ws:/);
  });

  it('constructs with wss: protocol for https', () => {
    vi.stubGlobal('location', { protocol: 'https:', host: 'localhost:8000' });
    const { bus } = createBus();
    expect((bus as unknown as { url: string }).url).toMatch(/^wss:/);
  });

  it('uses provided URL when given', () => {
    const { bus } = createBus('ws://custom/ws');
    expect((bus as unknown as { url: string }).url).toBe('ws://custom/ws');
  });

  it('connect() creates WebSocket and sets connected', async () => {
    const { bus } = createBus();
    expect(bus.connected).toBe(false);
    await flushMicrotasks();
    expect(bus.connected).toBe(true);
  });

  it('on() registers handler and returns unsubscribe', async () => {
    const { bus, mock } = createBus();
    await flushMicrotasks();
    const handler = vi.fn();
    const unsubscribe = bus.on('snapshot', handler);

    mock.simulateMessage({ type: 'snapshot', state: { characters: [], chats: [], settings: {} } });
    expect(handler).toHaveBeenCalledTimes(1);

    unsubscribe();
    mock.simulateMessage({ type: 'snapshot', state: { characters: [], chats: [], settings: {} } });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('multiple handlers for same type are both called', async () => {
    const { bus, mock } = createBus();
    await flushMicrotasks();
    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.on('snapshot', h1);
    bus.on('snapshot', h2);

    mock.simulateMessage({ type: 'snapshot', state: { characters: [], chats: [], settings: {} } });
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
  });

  it('handler for wrong type is not called', async () => {
    const { bus, mock } = createBus();
    await flushMicrotasks();
    const handler = vi.fn();
    bus.on('snapshot', handler);

    mock.simulateMessage({ type: 'client.assigned', clientId: 'c1' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('send() queues message when disconnected', () => {
    const bus = new WebSocketBus();
    const msg = { type: 'chat.select', chatId: 'c1', limit: 30 } as const;
    bus.send(msg);
    expect(bus.connected).toBe(false);
  });

  it('send() transmits message when connected', async () => {
    const { bus, mock } = createBus();
    await flushMicrotasks();

    // auth is auto-sent on connect
    expect(mock.sent).toHaveLength(1);
    expect(JSON.parse(mock.sent[0]!)).toEqual({ type: 'auth' });

    const msg = { type: 'chat.select', chatId: 'c1', limit: 30 } as const;
    bus.send(msg);
    expect(mock.sent).toHaveLength(2);
    expect(JSON.parse(mock.sent[1]!)).toEqual(msg);
  });

  it('flushes pending messages on open', async () => {
    const bus = new WebSocketBus();
    const msg = { type: 'chat.select', chatId: 'c1', limit: 30 } as const;
    bus.send(msg);

    bus.connect();
    const mock = (bus as unknown as { ws: MockWebSocket }).ws;
    await flushMicrotasks();
    // auth is auto-sent on connect, then the pending message is flushed
    expect(mock.sent).toHaveLength(2);
    expect(JSON.parse(mock.sent[0]!)).toEqual({ type: 'auth' });
    expect(JSON.parse(mock.sent[1]!)).toEqual(msg);
  });

  it('sets clientId on client.assigned message', async () => {
    const { bus, mock } = createBus();
    await flushMicrotasks();

    mock.simulateMessage({ type: 'client.assigned', clientId: 'client-1' });
    expect(bus.clientId).toBe('client-1');
  });

  it('sets authError on auth.error message', async () => {
    const { bus, mock } = createBus();
    await flushMicrotasks();

    mock.simulateMessage({ type: 'auth.error', message: 'bad token' });
    expect(bus.authError).toBe(true);
  });

  it('does not auto-reconnect after auth error', async () => {
    vi.useFakeTimers();
    const { bus, mock } = createBus();
    await flushMicrotasks();

    mock.simulateMessage({ type: 'auth.error', message: 'bad token' });
    mock.close();

    vi.advanceTimersByTime(10000);
    expect(bus.connected).toBe(false);
    vi.useRealTimers();
  });

  it('auto-reconnects after non-auth close', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { bus, mock } = createBus();
    await flushMicrotasks();
    expect(bus.connected).toBe(true);

    mock.close();
    expect(bus.connected).toBe(false);

    vi.advanceTimersByTime(3000);
    await flushMicrotasks();
    expect(bus.connected).toBe(true);

    vi.useRealTimers();
  });

  it('disconnect() prevents reconnect', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { bus } = createBus();
    await flushMicrotasks();

    bus.disconnect();
    expect(bus.connected).toBe(false);

    vi.advanceTimersByTime(10000);
    expect(bus.connected).toBe(false);
    vi.useRealTimers();
  });

  it('ignores invalid JSON messages', async () => {
    const { bus, mock } = createBus();
    await flushMicrotasks();
    const handler = vi.fn();
    bus.on('snapshot', handler);

    mock.onmessage?.(new MessageEvent('message', { data: 'not json' }));
    expect(handler).not.toHaveBeenCalled();
  });

  it('ignores messages that fail schema validation', async () => {
    const { bus, mock } = createBus();
    await flushMicrotasks();
    const handler = vi.fn();
    bus.on('snapshot', handler);

    mock.simulateMessage({ type: 'snapshot', unknownField: true });
    expect(handler).not.toHaveBeenCalled();
  });

  it('rebuilds URL with new auth token on connect()', async () => {
    const bus = new WebSocketBus();
    bus.connect();
    await flushMicrotasks();
    expect(bus.connected).toBe(true);
  });

  it('ignores a late close event from a socket replaced by forceReconnect', async () => {
    const { bus } = createBus();
    await flushMicrotasks();
    expect(bus.connected).toBe(true);

    const socketA = (bus as unknown as { ws: MockWebSocket }).ws;
    // forceReconnect swaps in socket B; in a real browser A's close event can
    // still arrive afterwards (the mock fires it synchronously inside close(),
    // so simulate the late delivery manually).
    (bus as unknown as { forceReconnect(): void }).forceReconnect();
    const socketB = (bus as unknown as { ws: MockWebSocket }).ws;
    expect(socketB).not.toBe(socketA);

    socketA.onclose?.(new CloseEvent('close'));

    // The live socket must survive the stale close event...
    expect((bus as unknown as { ws: MockWebSocket }).ws).toBe(socketB);

    // ...and flushing the pending queue on B's open must terminate and send.
    bus.send({ type: 'chat.select', chatId: 'c1', limit: 30 } as const);
    await flushMicrotasks();
    expect(bus.connected).toBe(true);
    expect(JSON.parse(socketB.sent[0]!)).toEqual({ type: 'auth' });
    expect(JSON.parse(socketB.sent[1]!)).toEqual({ type: 'chat.select', chatId: 'c1', limit: 30 });
  });
});
