import { describe, it, expect, vi } from 'vitest';
import { QuickReplyWorkbench } from './QuickReplyWorkbench.js';
import type { IQuickReplyRepository } from '../../repos/QuickReplyRepository.js';
import type { QuickReply, QuickReplyInsert, QuickReplyUpdate } from '@tamari/types';
import type { EventBus } from '../../bus/EventBus.js';

function makeQr(overrides: Partial<QuickReply> = {}): QuickReply {
  return {
    id: 'qr1',
    scope: 'global',
    scopeId: '',
    label: 'Say hi',
    icon: '',
    color: '',
    script: 'st.send("hi")',
    language: 'lua',
    autoExecute: 0,
    orderIndex: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeTemplate(items: QuickReply[] = []) {
  const store = new Map(items.map((q) => [q.id, q]));
  const quickReplies = {
    listByScope: async (scope: QuickReply['scope'], scopeId: string) =>
      [...store.values()].filter((q) => q.scope === scope && q.scopeId === scopeId),
    listAll: async () => [...store.values()],
    getById: async (id: string) => store.get(id),
    create: async (id: string, data: QuickReplyInsert) => {
      const item: QuickReply = { id, ...data, createdAt: 1, updatedAt: 1 };
      store.set(id, item);
      return item;
    },
    update: async (id: string, patch: QuickReplyUpdate) => {
      const existing = store.get(id);
      if (!existing) throw new Error(`QuickReply not found: ${id}`);
      const updated = { ...existing, ...patch };
      store.set(id, updated);
      return updated;
    },
  } as unknown as IQuickReplyRepository;
  const bus = { broadcast: vi.fn() } as unknown as EventBus;

  const template = new QuickReplyWorkbench({ quickReplies, bus });
  return { template, bus, store };
}

function broadcastTypes(bus: EventBus): string[] {
  const broadcast = bus.broadcast as ReturnType<typeof vi.fn>;
  return broadcast.mock.calls.map((c) => (c[0] as { type: string }).type);
}

describe('QuickReplyWorkbench', () => {
  describe('quickreply_list', () => {
    it('lists global quick replies by default', async () => {
      const { template } = makeTemplate([
        makeQr(),
        makeQr({ id: 'qr2', scope: 'character', scopeId: 'char1', label: 'Char QR' }),
      ]);
      const res = await template.execute('quickreply_list', {});
      const parsed = JSON.parse(res.content as string) as QuickReply[];
      expect(parsed).toHaveLength(1);
      expect(parsed[0]?.id).toBe('qr1');
    });

    it('lists a character scope when asked', async () => {
      const { template } = makeTemplate([
        makeQr(),
        makeQr({ id: 'qr2', scope: 'character', scopeId: 'char1', label: 'Char QR' }),
      ]);
      const res = await template.execute('quickreply_list', { scope: 'character', scopeId: 'char1' });
      const parsed = JSON.parse(res.content as string) as QuickReply[];
      expect(parsed).toHaveLength(1);
      expect(parsed[0]?.id).toBe('qr2');
    });

    it('rejects an invalid scope', async () => {
      const { template } = makeTemplate();
      const res = await template.execute('quickreply_list', { scope: 'bogus' });
      expect(res.content).toBe('Error: invalid arguments');
    });
  });

  describe('quickreply_create', () => {
    it('creates a quick reply and broadcasts quickreply.created', async () => {
      const { template, bus, store } = makeTemplate();
      const res = await template.execute('quickreply_create', {
        scope: 'global',
        scopeId: '',
        label: 'Wave',
        script: 'st.send("o/")',
      });
      const parsed = JSON.parse(res.content as string) as QuickReply;
      expect(parsed.id).toBeTruthy();
      expect(parsed.label).toBe('Wave');
      // Schema defaults are applied
      expect(parsed.language).toBe('lua');
      expect(parsed.autoExecute).toBe(0);
      expect(store.size).toBe(1);
      expect(broadcastTypes(bus)).toEqual(['quickreply.created', 'quickreply.listed']);
    });

    it('rejects invalid arguments', async () => {
      const { template } = makeTemplate();
      const res = await template.execute('quickreply_create', { label: 'No scope' });
      expect(res.content).toBe('Error: invalid arguments');
    });
  });

  describe('quickreply_update', () => {
    it('patches fields and broadcasts quickreply.updated', async () => {
      const { template, bus, store } = makeTemplate([makeQr()]);
      const res = await template.execute('quickreply_update', {
        id: 'qr1',
        patch: { label: 'Say hello', orderIndex: 3 },
      });
      const parsed = JSON.parse(res.content as string) as QuickReply;
      expect(parsed.label).toBe('Say hello');
      expect(parsed.orderIndex).toBe(3);
      expect(parsed.script).toBe('st.send("hi")');
      expect(store.get('qr1')?.label).toBe('Say hello');
      expect(broadcastTypes(bus)).toEqual(['quickreply.updated', 'quickreply.listed']);
    });

    it('returns the repo error for an unknown id', async () => {
      const { template } = makeTemplate();
      const res = await template.execute('quickreply_update', { id: 'nope', patch: { label: 'x' } });
      expect(res.content).toBe('Error: QuickReply not found: nope');
    });
  });
});
