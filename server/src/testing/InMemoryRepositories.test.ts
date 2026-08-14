/**
 * InMemoryChatRepository / InMemoryGenerationRepository unit tests: pointer
 * semantics (mirroring ChatRepository.appendMessage), chain walking, bulk
 * reads with limit/beforeId, and per-session isolation.
 */
import { describe, it, expect } from 'vitest';
import { InMemoryChatRepository } from './InMemoryChatRepository.js';
import { InMemoryGenerationRepository } from './InMemoryGenerationRepository.js';

async function makeChat(repo: InMemoryChatRepository, id = 'chat-1') {
  return repo.createChat(id, {
    characterId: 'char-1',
    personaId: 'persona-1',
    name: 'Test',
    headMessageId: null,
    metadata: { selectedGreetingIndex: 0 },
  });
}

describe('InMemoryChatRepository', () => {
  it('creates, reads, and updates a chat row', async () => {
    const repo = new InMemoryChatRepository();
    const chat = await makeChat(repo);
    expect(chat.id).toBe('chat-1');
    expect(chat.personaId).toBe('persona-1');
    expect(chat.materialized).toBe(false);
    expect(chat.headMessageId).toBeNull();
    expect(chat.activeChildId).toBeNull();

    const updated = await repo.updateChat('chat-1', { materialized: true, metadata: { selectedGreetingIndex: 2 } });
    expect(updated.materialized).toBe(true);
    expect(updated.metadata.selectedGreetingIndex).toBe(2);
    await expect(repo.updateChat('nope', { name: 'x' })).rejects.toThrow();
  });

  it('first assistant message (greeting) attaches to root and becomes active child', async () => {
    const repo = new InMemoryChatRepository();
    await makeChat(repo);
    // materializeGreetings appends with an explicit parentId: null.
    const greeting = await repo.appendMessage('chat-1', {
      role: 'assistant',
      parentId: null,
      extra: { parts: [{ type: 'text', text: 'hello' }] },
    });
    const chat = (await repo.getChatById('chat-1'))!;
    expect(greeting.parentId).toBeNull();
    expect(chat.headMessageId).toBeNull();
    expect(chat.activeChildId).toBe(greeting.id);
  });

  it('user message becomes head (active_child cleared); assistant reply becomes active child of the user message', async () => {
    const repo = new InMemoryChatRepository();
    await makeChat(repo);
    const greeting = await repo.appendMessage('chat-1', { role: 'assistant', parentId: null, extra: {} });
    const user = await repo.appendMessage('chat-1', { role: 'user', extra: {} });

    let chat = (await repo.getChatById('chat-1'))!;
    expect(user.parentId).toBe(greeting.id); // attached to the leaf
    expect(chat.headMessageId).toBe(user.id);
    expect(chat.activeChildId).toBeNull();

    const reply = await repo.appendMessage('chat-1', { role: 'assistant', extra: {} });
    chat = (await repo.getChatById('chat-1'))!;
    expect(reply.parentId).toBe(user.id);
    expect(chat.headMessageId).toBe(user.id);
    expect(chat.activeChildId).toBe(reply.id);
  });

  it('walks the message chain oldest-first from the active leaf', async () => {
    const repo = new InMemoryChatRepository();
    await makeChat(repo);
    const g = await repo.appendMessage('chat-1', { role: 'assistant', parentId: null, extra: {} });
    const u = await repo.appendMessage('chat-1', { role: 'user', extra: {} });
    const a = await repo.appendMessage('chat-1', { role: 'assistant', extra: {} });

    const chain = await repo.getMessageChain('chat-1');
    expect(chain.map((m) => m.id)).toEqual([g.id, u.id, a.id]);
    // Unknown chat → empty chain.
    expect(await repo.getMessageChain('nope')).toEqual([]);
  });

  it('bulk reads exclude the active swipe and honor limit/beforeId', async () => {
    const repo = new InMemoryChatRepository();
    await makeChat(repo);
    const g = await repo.appendMessage('chat-1', { role: 'assistant', parentId: null, extra: {} });
    const u1 = await repo.appendMessage('chat-1', { role: 'user', extra: {} });
    const a1 = await repo.appendMessage('chat-1', { role: 'assistant', extra: {} });
    const u2 = await repo.appendMessage('chat-1', { role: 'user', extra: {} });
    const a2 = await repo.appendMessage('chat-1', { role: 'assistant', extra: {} });

    // Bulk = head (u2) back to root, oldest first — the active swipe (a2) is excluded.
    const bulk = await repo.getBulkOfMessages('chat-1');
    expect(bulk.map((m) => m.id)).toEqual([g.id, u1.id, a1.id, u2.id]);

    // Active branch = bulk + active swipe.
    const branch = await repo.getActiveBranch('chat-1');
    expect(branch.map((m) => m.id)).toEqual([g.id, u1.id, a1.id, u2.id, a2.id]);

    // Limit keeps the NEWEST messages (anchor side).
    const limited = await repo.getBulkOfMessages('chat-1', { limit: 2 });
    expect(limited.map((m) => m.id)).toEqual([a1.id, u2.id]);

    // beforeId paginates from that message (inclusive) toward the root.
    const paged = await repo.getBulkOfMessages('chat-1', { beforeId: a1.id, limit: 2 });
    expect(paged.map((m) => m.id)).toEqual([u1.id, a1.id]);

    // Active branch with beforeId: bulk from the anchor, active swipe appended.
    const pagedBranch = await repo.getActiveBranch('chat-1', { beforeId: u1.id });
    expect(pagedBranch.map((m) => m.id)).toEqual([g.id, u1.id, a2.id]);
  });

  it('updateMessage patches role/extra and throws for unknown ids', async () => {
    const repo = new InMemoryChatRepository();
    await makeChat(repo);
    const msg = await repo.appendMessage('chat-1', { role: 'assistant', parentId: null, extra: {} });
    const updated = await repo.updateMessage(msg.id, { extra: { parts: [{ type: 'text', text: 'done' }], tokenCount: 3 } });
    expect(updated.extra.parts?.[0]).toEqual({ type: 'text', text: 'done' });
    expect((await repo.getMessageById(msg.id))!.extra.tokenCount).toBe(3);
    await expect(repo.updateMessage(999, { extra: {} })).rejects.toThrow();
  });

  it('keeps multiple sessions isolated and drops them on deleteChat', async () => {
    const repo = new InMemoryChatRepository();
    await makeChat(repo, 'chat-a');
    await makeChat(repo, 'chat-b');
    await repo.appendMessage('chat-a', { role: 'assistant', parentId: null, extra: {} });
    await repo.appendMessage('chat-a', { role: 'user', extra: {} });
    const b1 = await repo.appendMessage('chat-b', { role: 'assistant', parentId: null, extra: {} });

    expect((await repo.getMessageChain('chat-a')).map((m) => m.role)).toEqual(['assistant', 'user']);
    expect((await repo.getMessageChain('chat-b')).map((m) => m.id)).toEqual([b1.id]);

    await repo.deleteChat('chat-a');
    expect(await repo.getChatById('chat-a')).toBeUndefined();
    expect(await repo.getMessageChain('chat-a')).toEqual([]);
    // chat-b untouched.
    expect((await repo.getMessageChain('chat-b')).map((m) => m.id)).toEqual([b1.id]);
  });

  it('throws for the out-of-scope interface methods', async () => {
    const repo = new InMemoryChatRepository();
    await expect(repo.listChats()).rejects.toThrow('not supported in test sessions');
    await expect(repo.insertMessage()).rejects.toThrow('not supported in test sessions');
    await expect(repo.cutMessages()).rejects.toThrow('not supported in test sessions');
    await expect(repo.mergeChatMetadata()).rejects.toThrow('not supported in test sessions');
  });
});

describe('InMemoryGenerationRepository', () => {
  it('creates, updates, lists by chat (newest first), and deletes', async () => {
    const repo = new InMemoryGenerationRepository();
    await repo.create('gen-1', { chatId: 'chat-1', messageId: null, status: 'pending', backend: 'mock', promptTokens: 10, completionTokens: null, errorMessage: null });
    await repo.create('gen-2', { chatId: 'chat-1', messageId: null, status: 'pending', backend: 'mock', promptTokens: 10, completionTokens: null, errorMessage: null });
    await repo.create('gen-3', { chatId: 'chat-2', messageId: null, status: 'pending', backend: 'mock', promptTokens: 10, completionTokens: null, errorMessage: null });

    const updated = await repo.update('gen-1', { status: 'complete', completionTokens: 5, meta: { layer: 'mock', rounds: 1 } });
    expect(updated.status).toBe('complete');
    expect(updated.meta?.rounds).toBe(1);
    expect(updated.kind).toBe('send'); // insert default

    const list = await repo.listByChat('chat-1');
    expect(list.map((g) => g.id)).toEqual(['gen-2', 'gen-1']);

    await repo.delete('gen-2');
    await expect(repo.getById('gen-2')).resolves.toBeUndefined();
    await expect(repo.delete('gen-2')).rejects.toThrow();

    repo.deleteByChat('chat-1');
    expect(await repo.listByChat('chat-1')).toEqual([]);
    expect((await repo.listByChat('chat-2')).map((g) => g.id)).toEqual(['gen-3']);
  });
});
