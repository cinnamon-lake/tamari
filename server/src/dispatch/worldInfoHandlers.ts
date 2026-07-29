/**
 * `worldinfo.*` messages — book CRUD, entry surgery, activation test.
 */

import { randomUUID } from 'node:crypto';
import { getLogger } from '../lib/logger.js';
import type { DispatcherDeps, Handlers } from './types.js';

const log = getLogger('dispatcher');

export function buildWorldInfoHandlers(
  deps: DispatcherDeps,
): Handlers<
  | 'worldinfo.select'
  | 'worldinfo.list'
  | 'worldinfo.create'
  | 'worldinfo.update'
  | 'worldinfo.delete'
  | 'worldinfo.test'
  | 'worldinfo.entry.create'
  | 'worldinfo.entry.update'
  | 'worldinfo.entry.delete'
> {
  const { bus, worldInfo, worldInfoInjector, tokenCounter } = deps;

  return {
    'worldinfo.select': async (client, msg) => {
      const book = await worldInfo.getById(msg.bookId);
      if (!book) {
        bus.sendTo(client.id, { type: 'error', message: 'World Info not found', code: 'NOT_FOUND' });
        return;
      }
      bus.broadcast({ type: 'worldinfo.snapshot', book }, client.id);
    },

    'worldinfo.list': async (client, _msg) => {
      const books = await worldInfo.list();
      bus.sendTo(client.id, { type: 'worldinfo.listed', books });
    },

    'worldinfo.create': async (client, msg) => {
      const id = randomUUID();
      const entries = (msg.data.entries ?? []).map((e) => ({ ...e, id: randomUUID() }));
      const book = await worldInfo.create(id, { name: msg.data.name, entries });
      deps.ragService?.indexWorldInfoEntries(id, book.entries).catch((err) => log.warn({ err }, 'rag index failed'));
      bus.broadcast({ type: 'worldinfo.created', book }, client.id);
      bus.broadcast({ type: 'worldinfo.snapshot', book }, client.id);
      const list = await worldInfo.list();
      bus.broadcast({ type: 'worldinfo.listed', books: list }, client.id);
    },

    'worldinfo.update': async (client, msg) => {
      const patchEntries = msg.patch.entries?.map((e) => ({ ...e, id: randomUUID() }));
      const book = await worldInfo.update(msg.bookId, { ...msg.patch, entries: patchEntries });
      deps.ragService?.indexWorldInfoEntries(msg.bookId, book.entries).catch((err) => log.warn({ err }, 'rag index failed'));
      bus.broadcast({ type: 'worldinfo.updated', book }, client.id);
      bus.broadcast({ type: 'worldinfo.snapshot', book }, client.id);
      const list = await worldInfo.list();
      bus.broadcast({ type: 'worldinfo.listed', books: list }, client.id);
    },

    'worldinfo.delete': async (client, msg) => {
      await worldInfo.delete(msg.bookId);
      deps.ragService?.deleteWorldInfoIndex(msg.bookId).catch((err) => log.warn({ err }, 'rag delete index failed'));
      bus.broadcast({ type: 'worldinfo.deleted', bookId: msg.bookId }, client.id);
      const list = await worldInfo.list();
      bus.broadcast({ type: 'worldinfo.listed', books: list }, client.id);
    },

    'worldinfo.test': async (client, msg) => {
      const result = worldInfoInjector.scan({
        entries: msg.entries,
        scanText: msg.text,
        budget: Number.MAX_SAFE_INTEGER,
        tokenCounter,
      });
      bus.sendTo(client.id, {
        type: 'worldinfo.tested',
        activated: [...result.before, ...result.after, ...result.top, ...result.bottom, ...result.atDepth],
      });
    },

    'worldinfo.entry.create': async (client, msg) => {
      const book = await worldInfo.getById(msg.bookId);
      if (!book) {
        bus.sendTo(client.id, { type: 'error', message: 'World Info not found', code: 'NOT_FOUND' });
        return;
      }
      const entry = { id: randomUUID(), ...msg.data };
      const nextEntries = [...book.entries, entry];
      const updated = await worldInfo.update(msg.bookId, { entries: nextEntries });
      deps.ragService?.indexWorldInfoEntries(msg.bookId, updated.entries).catch((err) => log.warn({ err }, 'rag index failed'));
      bus.broadcast({ type: 'worldinfo.updated', book: updated }, client.id);
      bus.broadcast({ type: 'worldinfo.snapshot', book: updated }, client.id);
      const list = await worldInfo.list();
      bus.broadcast({ type: 'worldinfo.listed', books: list }, client.id);
    },

    'worldinfo.entry.update': async (client, msg) => {
      const book = await worldInfo.getById(msg.bookId);
      if (!book) {
        bus.sendTo(client.id, { type: 'error', message: 'World Info not found', code: 'NOT_FOUND' });
        return;
      }
      const nextEntries = book.entries.map((e) =>
        e.id === msg.entryId ? { ...e, ...msg.patch } : e,
      );
      const updated = await worldInfo.update(msg.bookId, { entries: nextEntries });
      deps.ragService?.indexWorldInfoEntries(msg.bookId, updated.entries).catch((err) => log.warn({ err }, 'rag index failed'));
      bus.broadcast({ type: 'worldinfo.updated', book: updated }, client.id);
      bus.broadcast({ type: 'worldinfo.snapshot', book: updated }, client.id);
      const list = await worldInfo.list();
      bus.broadcast({ type: 'worldinfo.listed', books: list }, client.id);
    },

    'worldinfo.entry.delete': async (client, msg) => {
      const book = await worldInfo.getById(msg.bookId);
      if (!book) {
        bus.sendTo(client.id, { type: 'error', message: 'World Info not found', code: 'NOT_FOUND' });
        return;
      }
      const nextEntries = book.entries.filter((e) => e.id !== msg.entryId);
      const updated = await worldInfo.update(msg.bookId, { entries: nextEntries });
      deps.ragService?.indexWorldInfoEntries(msg.bookId, updated.entries).catch((err) => log.warn({ err }, 'rag index failed'));
      bus.broadcast({ type: 'worldinfo.updated', book: updated }, client.id);
      bus.broadcast({ type: 'worldinfo.snapshot', book: updated }, client.id);
      const list = await worldInfo.list();
      bus.broadcast({ type: 'worldinfo.listed', books: list }, client.id);
    },
  };
}
