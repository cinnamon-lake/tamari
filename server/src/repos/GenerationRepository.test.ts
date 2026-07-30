import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { GenerationRepository } from './GenerationRepository.js';
import type { GenerationInsert } from '@tamari/types';

let client: Client;
let repo: GenerationRepository;

async function initSchema() {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS generations (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      message_id INTEGER,
      status TEXT NOT NULL CHECK(status IN ('pending', 'streaming', 'complete', 'error', 'aborted')),
      backend TEXT NOT NULL,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      error_message TEXT,
      kind TEXT NOT NULL DEFAULT 'send',
      parent_id TEXT,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    )
  `);
}

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  await initSchema();
  repo = new GenerationRepository(client);
});

afterAll(async () => {
  // libsql client doesn't have a close method in all versions
});

beforeEach(async () => {
  await client.execute('DELETE FROM generations');
});

describe('GenerationRepository', () => {
  it('creates and retrieves a generation', async () => {
    const insert: Omit<GenerationInsert, 'id'> = {
      chatId: 'chat-1',
      messageId: null,
      status: 'pending',
      backend: 'openai',
      promptTokens: 100,
      completionTokens: null,
      errorMessage: null,
    };

    const created = await repo.create('gen-1', insert);
    expect(created.id).toBe('gen-1');
    expect(created.status).toBe('pending');

    const fetched = await repo.getById('gen-1');
    expect(fetched).toBeDefined();
    expect(fetched!.chatId).toBe('chat-1');
    expect(fetched!.backend).toBe('openai');
  });

  it('updates a generation', async () => {
    await repo.create('gen-2', {
      chatId: 'chat-1',
      messageId: null,
      status: 'pending',
      backend: 'openai',
      promptTokens: 50,
      completionTokens: null,
      errorMessage: null,
    });

    const updated = await repo.update('gen-2', { status: 'complete', completionTokens: 20 });
    expect(updated.status).toBe('complete');
    expect(updated.completionTokens).toBe(20);
    expect(updated.updatedAt).toBeGreaterThanOrEqual(updated.createdAt);
  });

  it('lists generations by chat', async () => {
    await repo.create('gen-3', {
      chatId: 'chat-a',
      messageId: null,
      status: 'pending',
      backend: 'openai',
      promptTokens: 10,
      completionTokens: null,
      errorMessage: null,
    });
    await repo.create('gen-4', {
      chatId: 'chat-a',
      messageId: null,
      status: 'complete',
      backend: 'openai',
      promptTokens: 20,
      completionTokens: 5,
      errorMessage: null,
    });
    await repo.create('gen-5', {
      chatId: 'chat-b',
      messageId: null,
      status: 'pending',
      backend: 'claude',
      promptTokens: 30,
      completionTokens: null,
      errorMessage: null,
    });

    const list = await repo.listByChat('chat-a');
    expect(list).toHaveLength(2);
    expect(list.map((g) => g.id)).toContain('gen-3');
    expect(list.map((g) => g.id)).toContain('gen-4');
  });

  it('deletes a generation', async () => {
    await repo.create('gen-6', {
      chatId: 'chat-1',
      messageId: null,
      status: 'pending',
      backend: 'openai',
      promptTokens: 0,
      completionTokens: null,
      errorMessage: null,
    });

    await repo.delete('gen-6');
    const fetched = await repo.getById('gen-6');
    expect(fetched).toBeUndefined();
  });
});
