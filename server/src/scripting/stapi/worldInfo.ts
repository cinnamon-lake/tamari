/**
 * st-api domain: world info — CRUD on the lorebook linked to the current
 * chat's character.
 */

import type { StApiContext } from './context.js';
import type { StApi } from './types.js';

export type WorldInfoApi = Pick<StApi, 'wi_list' | 'wi_get' | 'wi_add' | 'wi_remove'>;

export function createWorldInfo(c: StApiContext): WorldInfoApi {
  const { chats, characters, worldInfo, bus } = c.deps;
  const { chatId, checkAbort } = c;

  async function getCharacterBookId(): Promise<string | null> {
    const chat = await chats.getChatById(chatId);
    if (!chat || !chat.characterId) return null;
    const character = await characters.getById(chat.characterId);
    return character?.worldInfoId ?? null;
  }

  return {
    wi_list: async () => {
      checkAbort();
      const bookId = await getCharacterBookId();
      if (!bookId) return [];
      const book = await worldInfo.getById(bookId);
      return book?.entries ?? [];
    },

    wi_get: async (key: string) => {
      checkAbort();
      if (typeof key !== 'string') throw new Error('wi_get: expected string');
      const bookId = await getCharacterBookId();
      if (!bookId) return null;
      const book = await worldInfo.getById(bookId);
      if (!book) return null;
      const entry = book.entries.find((e) => e.keys.some((k) => k.toLowerCase() === key.toLowerCase()));
      return entry ?? null;
    },

    wi_add: async (keys: string, content: string) => {
      checkAbort();
      if (typeof keys !== 'string' || typeof content !== 'string') {
        throw new Error('wi_add: expected (string, string)');
      }
      const bookId = await getCharacterBookId();
      if (!bookId) throw new Error('wi_add: no lorebook linked to this chat');
      const book = await worldInfo.getById(bookId);
      if (!book) throw new Error('wi_add: lorebook not found');

      const keyList = keys
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean);
      if (keyList.length === 0) throw new Error('wi_add: at least one key required');

      const newEntry = {
        id: crypto.randomUUID(),
        keys: keyList,
        content,
        comment: '',
        position: 'before_char' as const,
        order: 0,
        probability: 100,
        constant: false,
        selective: false,
        secondaryKeys: [] as string[],
        addMemo: false,
        disable: false,
        regex: false,
        recursive: false,
        depth: 0,
        role: 'system' as const,
        retrievalMode: 'keyword' as const,
      };

      const updated = await worldInfo.update(bookId, { entries: [...book.entries, newEntry] });
      bus.broadcast({ type: 'worldinfo.updated', book: updated });
      return newEntry.id;
    },

    wi_remove: async (key: string) => {
      checkAbort();
      if (typeof key !== 'string') throw new Error('wi_remove: expected string');
      const bookId = await getCharacterBookId();
      if (!bookId) throw new Error('wi_remove: no lorebook linked to this chat');
      const book = await worldInfo.getById(bookId);
      if (!book) throw new Error('wi_remove: lorebook not found');

      const idx = book.entries.findIndex((e) => e.keys.some((k) => k.toLowerCase() === key.toLowerCase()));
      if (idx === -1) throw new Error(`wi_remove: no entry with key "${key}"`);

      const updated = await worldInfo.update(bookId, { entries: book.entries.filter((_, i) => i !== idx) });
      bus.broadcast({ type: 'worldinfo.updated', book: updated });
      return true;
    },
  };
}
