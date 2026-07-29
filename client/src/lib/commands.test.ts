import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeSlashCommand, selectChat } from './commands.js';
import { parseCommand } from './slashCommands.js';
import { bus } from '../bus/WebSocketBus.js';
import * as serverStoreModule from '../stores/serverStore.js';
import * as toastStoreModule from '../stores/toastStore.js';
import type { CommandDeps } from './commands.js';

function makeDeps(): CommandDeps & { text: string; locked: boolean; autocomplete: boolean } {
  return {
    text: '',
    locked: false,
    autocomplete: false,
    setText(t: string) {
      this.text = t;
    },
    setShowAutocomplete(v: boolean) {
      this.autocomplete = v;
    },
    setInputLocked(v: boolean) {
      this.locked = v;
    },
  };
}

function mockState(partial: Record<string, unknown>) {
  vi.spyOn(serverStoreModule, 'state', 'get').mockReturnValue(partial as unknown as typeof serverStoreModule.state);
}

describe('executeSlashCommand', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns false for unknown command', () => {
    const deps = makeDeps();
    const parsed = parseCommand('/xyzabc')!;
    expect(executeSlashCommand(parsed, 'chat-1', deps)).toBe(false);
  });

  describe('/name', () => {
    it('sends settings.set and clears input', () => {
      const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
      const deps = makeDeps();
      const parsed = parseCommand('/name TestUser')!;
      expect(executeSlashCommand(parsed, 'chat-1', deps)).toBe(true);
      expect(sendSpy).toHaveBeenCalledWith({ type: 'settings.set', key: 'userName', value: 'TestUser' });
      expect(deps.text).toBe('');
      expect(deps.autocomplete).toBe(false);
    });

    it('does nothing when name is empty', () => {
      const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
      const deps = makeDeps();
      const parsed = parseCommand('/name')!;
      expect(executeSlashCommand(parsed, 'chat-1', deps)).toBe(true);
      expect(sendSpy).not.toHaveBeenCalled();
      expect(deps.text).toBe('');
    });
  });

  describe('/bg', () => {
    it('sends background image url', () => {
      const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
      const deps = makeDeps();
      const parsed = parseCommand('/bg https://example.com/bg.jpg')!;
      expect(executeSlashCommand(parsed, 'chat-1', deps)).toBe(true);
      expect(sendSpy).toHaveBeenCalledWith({
        type: 'settings.set',
        key: 'backgroundImageUrl',
        value: 'https://example.com/bg.jpg',
      });
      expect(deps.text).toBe('');
    });
  });

  describe('/theme', () => {
    it('applies known preset', () => {
      const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
      const deps = makeDeps();
      const parsed = parseCommand('/theme light')!;
      expect(executeSlashCommand(parsed, 'chat-1', deps)).toBe(true);
      expect(sendSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'settings.set', key: 'themeCustomCss' }),
      );
      const call = sendSpy.mock.calls[0]![0] as { value: string };
      expect(call.value).toContain('--color-bg-primary');
    });

    it('applies raw CSS for unknown preset', () => {
      const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
      const deps = makeDeps();
      const parsed = parseCommand('/theme body { color: red; }')!;
      expect(executeSlashCommand(parsed, 'chat-1', deps)).toBe(true);
      expect(sendSpy).toHaveBeenCalledWith({
        type: 'settings.set',
        key: 'themeCustomCss',
        value: 'body { color: red; }',
      });
    });
  });

  describe('/persona', () => {
    it('sends chat.update when persona is found', () => {
      mockState({
        personas: [{ id: 'p1', name: 'Alice', avatarUrl: null, thumbnailUrl: null }],
      });
      const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
      const deps = makeDeps();
      const parsed = parseCommand('/persona Alice')!;
      expect(executeSlashCommand(parsed, 'chat-1', deps)).toBe(true);
      expect(sendSpy).toHaveBeenCalledWith({
        type: 'chat.update',
        chatId: 'chat-1',
        patch: { personaId: 'p1' },
      });
    });

    it('toasts error when persona not found', () => {
      mockState({ personas: [] });
      const toastSpy = vi.spyOn(toastStoreModule, 'addToast').mockImplementation(() => {});
      const deps = makeDeps();
      const parsed = parseCommand('/persona Unknown')!;
      expect(executeSlashCommand(parsed, 'chat-1', deps)).toBe(true);
      expect(toastSpy).toHaveBeenCalledWith('Persona "Unknown" not found', 'error');
    });

    it('finds persona by partial match', () => {
      mockState({
        personas: [{ id: 'p2', name: 'BobTheBuilder', avatarUrl: null, thumbnailUrl: null }],
      });
      const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
      const deps = makeDeps();
      const parsed = parseCommand('/persona bob')!;
      expect(executeSlashCommand(parsed, 'chat-1', deps)).toBe(true);
      expect(sendSpy).toHaveBeenCalledWith(
        expect.objectContaining({ patch: { personaId: 'p2' } }),
      );
    });
  });

  describe('/char', () => {
    it('selects existing chat for character', () => {
      mockState({
        settings: {},
        characters: [{ id: 'c1', name: 'Miku', avatarUrl: null, thumbnailUrl: null, tags: [] }],
        chats: [
          { id: 'ch1', characterId: 'c1', name: 'Miku Chat', createdAt: 1000, updatedAt: 2000, headMessageId: null, activeChildId: null, materialized: false, metadata: {}, personaId: null, forkedFromChatId: null, forkedAtMessageId: null },
        ],
      });
      const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
      const deps = makeDeps();
      const parsed = parseCommand('/char Miku')!;
      expect(executeSlashCommand(parsed, 'chat-1', deps)).toBe(true);
      expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'chat.select', chatId: 'ch1' }));
    });

    it('creates chat when none exists', () => {
      const handlers = new Map<string, Set<(m: unknown) => void>>();
      mockState({
        characters: [{ id: 'c2', name: 'Kaito', avatarUrl: null, thumbnailUrl: null, tags: [] }],
        chats: [],
      });
      const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
      vi.spyOn(bus, 'on').mockImplementation((event: any, handler: any) => {
        if (!handlers.has(event)) handlers.set(event, new Set());
        handlers.get(event)!.add(handler);
        return () => handlers.get(event)!.delete(handler);
      });
      const deps = makeDeps();
      const parsed = parseCommand('/char Kaito')!;
      expect(executeSlashCommand(parsed, 'chat-1', deps)).toBe(true);
      expect(sendSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'chat.create', data: expect.objectContaining({ characterId: 'c2' }) }),
      );
    });

    it('toasts error when character not found', () => {
      mockState({ characters: [], chats: [] });
      const toastSpy = vi.spyOn(toastStoreModule, 'addToast').mockImplementation(() => {});
      const deps = makeDeps();
      const parsed = parseCommand('/char Nobody')!;
      expect(executeSlashCommand(parsed, 'chat-1', deps)).toBe(true);
      expect(toastSpy).toHaveBeenCalledWith('Character "Nobody" not found', 'error');
    });
  });

  describe('/lock and /unlock', () => {
    it('locks input', () => {
      const deps = makeDeps();
      const parsed = parseCommand('/lock')!;
      expect(executeSlashCommand(parsed, 'chat-1', deps)).toBe(true);
      expect(deps.locked).toBe(true);
      expect(deps.text).toBe('');
    });

    it('unlocks input', () => {
      const deps = makeDeps();
      deps.locked = true;
      const parsed = parseCommand('/unlock')!;
      expect(executeSlashCommand(parsed, 'chat-1', deps)).toBe(true);
      expect(deps.locked).toBe(false);
      expect(deps.text).toBe('');
    });
  });

  describe('/wi', () => {
    it('toasts when no lorebook linked', () => {
      mockState({ chatCharacter: null, worldInfo: [] });
      const toastSpy = vi.spyOn(toastStoreModule, 'addToast').mockImplementation(() => {});
      const deps = makeDeps();
      const parsed = parseCommand('/wi list')!;
      expect(executeSlashCommand(parsed, 'chat-1', deps)).toBe(true);
      expect(toastSpy).toHaveBeenCalledWith('No lorebook linked to this chat', 'error');
    });

    it('toasts when lorebook not found', () => {
      mockState({
        chatCharacter: { worldInfoId: 'book-1' },
        worldInfo: [],
      });
      const toastSpy = vi.spyOn(toastStoreModule, 'addToast').mockImplementation(() => {});
      const deps = makeDeps();
      const parsed = parseCommand('/wi list')!;
      expect(executeSlashCommand(parsed, 'chat-1', deps)).toBe(true);
      expect(toastSpy).toHaveBeenCalledWith('Lorebook not found', 'error');
    });

    it('lists entries', () => {
      mockState({
        chatCharacter: { worldInfoId: 'book-1' },
        worldInfo: [
          {
            id: 'book-1',
            name: 'Test Book',
            entries: [
              { id: 'e1', keys: ['key1'], content: 'Content one', comment: '', position: 'before_char', order: 0, probability: 100, constant: false, selective: false, secondaryKeys: [], addMemo: false, disable: false, regex: false, recursive: false, depth: 0, role: 'system', retrievalMode: 'keyword' },
            ],
          },
        ],
      });
      const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
      const deps = makeDeps();
      const parsed = parseCommand('/wi list')!;
      expect(executeSlashCommand(parsed, 'chat-1', deps)).toBe(true);
      expect(sendSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'action.system', chatId: 'chat-1', content: '1. [key1] Content one' }),
      );
    });

    it('gets entry by key', () => {
      mockState({
        chatCharacter: { worldInfoId: 'book-1' },
        worldInfo: [
          {
            id: 'book-1',
            name: 'Test Book',
            entries: [
              { id: 'e1', keys: ['magic', 'spell'], content: 'Magic is real', comment: '', position: 'before_char', order: 0, probability: 100, constant: false, selective: false, secondaryKeys: [], addMemo: false, disable: false, regex: false, recursive: false, depth: 0, role: 'system', retrievalMode: 'keyword' },
            ],
          },
        ],
      });
      const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
      const deps = makeDeps();
      const parsed = parseCommand('/wi get magic')!;
      expect(executeSlashCommand(parsed, 'chat-1', deps)).toBe(true);
      expect(sendSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'action.system', chatId: 'chat-1', content: '[magic, spell]\nMagic is real' }),
      );
    });

    it('toasts on missing get key', () => {
      mockState({
        chatCharacter: { worldInfoId: 'book-1' },
        worldInfo: [{ id: 'book-1', name: 'Test', entries: [] }],
      });
      const toastSpy = vi.spyOn(toastStoreModule, 'addToast').mockImplementation(() => {});
      const deps = makeDeps();
      const parsed = parseCommand('/wi get')!;
      expect(executeSlashCommand(parsed, 'chat-1', deps)).toBe(true);
      expect(toastSpy).toHaveBeenCalledWith('Usage: /wi get <key>', 'error');
    });

    it('adds entry', () => {
      mockState({
        chatCharacter: { worldInfoId: 'book-1' },
        worldInfo: [{ id: 'book-1', name: 'Test', entries: [] }],
      });
      const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
      const deps = makeDeps();
      const parsed = parseCommand('/wi add key1,key2 This is the content')!;
      expect(executeSlashCommand(parsed, 'chat-1', deps)).toBe(true);
      expect(sendSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'worldinfo.entry.create',
          bookId: 'book-1',
          data: expect.objectContaining({ keys: ['key1', 'key2'], content: 'This is the content' }),
        }),
      );
    });

    it('toasts on missing add args', () => {
      mockState({
        chatCharacter: { worldInfoId: 'book-1' },
        worldInfo: [{ id: 'book-1', name: 'Test', entries: [] }],
      });
      const toastSpy = vi.spyOn(toastStoreModule, 'addToast').mockImplementation(() => {});
      const deps = makeDeps();
      const parsed = parseCommand('/wi add keys-only')!;
      expect(executeSlashCommand(parsed, 'chat-1', deps)).toBe(true);
      expect(toastSpy).toHaveBeenCalledWith('Usage: /wi add <keys> <content...>', 'error');
    });

    it('deletes entry by key', () => {
      mockState({
        chatCharacter: { worldInfoId: 'book-1' },
        worldInfo: [
          {
            id: 'book-1',
            name: 'Test',
            entries: [
              { id: 'e1', keys: ['delete-me'], content: 'bye', comment: '', position: 'before_char', order: 0, probability: 100, constant: false, selective: false, secondaryKeys: [], addMemo: false, disable: false, regex: false, recursive: false, depth: 0, role: 'system', retrievalMode: 'keyword' },
            ],
          },
        ],
      });
      const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
      const deps = makeDeps();
      const parsed = parseCommand('/wi del delete-me')!;
      expect(executeSlashCommand(parsed, 'chat-1', deps)).toBe(true);
      expect(sendSpy).toHaveBeenCalledWith({ type: 'worldinfo.entry.delete', bookId: 'book-1', entryId: 'e1' });
    });

    it('toasts on unknown subcommand', () => {
      mockState({
        chatCharacter: { worldInfoId: 'book-1' },
        worldInfo: [{ id: 'book-1', name: 'Test', entries: [] }],
      });
      const toastSpy = vi.spyOn(toastStoreModule, 'addToast').mockImplementation(() => {});
      const deps = makeDeps();
      const parsed = parseCommand('/wi unknown')!;
      expect(executeSlashCommand(parsed, 'chat-1', deps)).toBe(true);
      expect(toastSpy).toHaveBeenCalledWith('Unknown /wi subcommand. Use: list, get, add, del', 'error');
    });
  });

  describe('server-side commands', () => {
    it('/send sends one atomic action.sendAndGenerate', () => {
      const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
      const deps = makeDeps();
      const parsed = parseCommand('/send hello')!;
      expect(executeSlashCommand(parsed, 'chat-1', deps)).toBe(true);
      expect(sendSpy).toHaveBeenCalledWith({ type: 'action.sendAndGenerate', chatId: 'chat-1', content: 'hello' });
      expect(sendSpy).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'action.generate' }));
      expect(deps.text).toBe('');
    });

    it('/reset sends chat.reset', () => {
      const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
      const deps = makeDeps();
      const parsed = parseCommand('/reset')!;
      expect(executeSlashCommand(parsed, 'chat-1', deps)).toBe(true);
      expect(sendSpy).toHaveBeenCalledWith({ type: 'chat.reset', chatId: 'chat-1' });
    });

    it('/continue sends action.continue without action.generate', () => {
      const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
      const deps = makeDeps();
      const parsed = parseCommand('/continue')!;
      expect(executeSlashCommand(parsed, 'chat-1', deps)).toBe(true);
      expect(sendSpy).toHaveBeenCalledWith({ type: 'action.continue', chatId: 'chat-1' });
      expect(sendSpy).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'action.generate' }));
    });
  });

  describe('selectChat', () => {
    it('sends chat.select with default limit', () => {
      mockState({ settings: { chatMessageLoadLimit: 30 } });
      const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
      selectChat('chat-99');
      expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'chat.select', chatId: 'chat-99', limit: 30 }));
    });

    it('uses custom chatMessageLoadLimit', () => {
      mockState({ settings: { chatMessageLoadLimit: 100 } });
      const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
      selectChat('chat-99');
      expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'chat.select', chatId: 'chat-99', limit: 100 }));
    });
  });
});
