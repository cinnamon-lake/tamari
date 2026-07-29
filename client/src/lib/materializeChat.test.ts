import { describe, it, expect, vi, beforeEach } from 'vitest';
import { materializeChat } from './materializeChat.js';
import { bus } from '../bus/WebSocketBus.js';
import * as serverStoreModule from '../stores/serverStore.js';

describe('materializeChat', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves immediately if there is no active chat', async () => {
    vi.spyOn(serverStoreModule, 'state', 'get').mockReturnValue({ activeChat: null } as unknown as typeof serverStoreModule.state);
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    await materializeChat('chat-1');
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('resolves immediately if chat ID does not match', async () => {
    vi.spyOn(serverStoreModule, 'state', 'get').mockReturnValue({
      activeChat: { id: 'chat-2', materialized: false, characterId: 'char-1' },
    } as unknown as typeof serverStoreModule.state);
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    await materializeChat('chat-1');
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('resolves immediately if chat is already materialized', async () => {
    vi.spyOn(serverStoreModule, 'state', 'get').mockReturnValue({
      activeChat: { id: 'chat-1', materialized: true, characterId: 'char-1' },
    } as unknown as typeof serverStoreModule.state);
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    await materializeChat('chat-1');
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('resolves immediately if chat has no character', async () => {
    vi.spyOn(serverStoreModule, 'state', 'get').mockReturnValue({
      activeChat: { id: 'chat-1', materialized: false, characterId: null },
    } as unknown as typeof serverStoreModule.state);
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    await materializeChat('chat-1');
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('sends chat.materialize with default greeting index 0', async () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    const handlers = new Map<string, Set<(m: unknown) => void>>();
    const onSpy = vi.spyOn(bus, 'on').mockImplementation((event: any, handler: any) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
      return () => handlers.get(event)!.delete(handler);
    });

    vi.spyOn(serverStoreModule, 'state', 'get').mockReturnValue({
      activeChat: { id: 'chat-1', materialized: false, characterId: 'char-1', metadata: {} },
    } as unknown as typeof serverStoreModule.state);

    const promise = materializeChat('chat-1');

    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'chat.materialize',
      chatId: 'chat-1',
      selectedIndex: 0,
    }));

    // Simulate server responding with snapshot
    const chatSnapshotHandlers = handlers.get('chat.snapshot') ?? new Set();
    chatSnapshotHandlers.forEach((h) => h({ chat: { id: 'chat-1' } }));

    await expect(promise).resolves.toBeUndefined();
    expect(onSpy).toHaveBeenCalledWith('chat.snapshot', expect.any(Function));
  });

  it('sends chat.materialize with selected greeting index from metadata', async () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    const handlers = new Map<string, Set<(m: unknown) => void>>();
    vi.spyOn(bus, 'on').mockImplementation((event: any, handler: any) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
      return () => handlers.get(event)!.delete(handler);
    });

    vi.spyOn(serverStoreModule, 'state', 'get').mockReturnValue({
      activeChat: { id: 'chat-1', materialized: false, characterId: 'char-1', metadata: { selectedGreetingIndex: 2 } },
    } as unknown as typeof serverStoreModule.state);

    const promise = materializeChat('chat-1');

    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'chat.materialize',
      selectedIndex: 2,
    }));

    const chatSnapshotHandlers = handlers.get('chat.snapshot') ?? new Set();
    chatSnapshotHandlers.forEach((h) => h({ chat: { id: 'chat-1' } }));

    await expect(promise).resolves.toBeUndefined();
  });

  it('ignores chat.snapshot for different chat IDs', async () => {
    vi.spyOn(bus, 'send').mockImplementation(() => {});
    const handlers = new Map<string, Set<(m: unknown) => void>>();
    vi.spyOn(bus, 'on').mockImplementation((event: any, handler: any) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
      return () => handlers.get(event)!.delete(handler);
    });

    vi.spyOn(serverStoreModule, 'state', 'get').mockReturnValue({
      activeChat: { id: 'chat-1', materialized: false, characterId: 'char-1', metadata: {} },
    } as unknown as typeof serverStoreModule.state);

    const promise = materializeChat('chat-1');

    // Simulate snapshot for a different chat
    const chatSnapshotHandlers = handlers.get('chat.snapshot') ?? new Set();
    chatSnapshotHandlers.forEach((h) => h({ chat: { id: 'chat-2' } }));

    // Promise should still be pending
    const result = await Promise.race([
      promise.then(() => 'resolved'),
      new Promise((r) => setTimeout(r, 50)).then(() => 'pending'),
    ]);
    expect(result).toBe('pending');
  });
});
