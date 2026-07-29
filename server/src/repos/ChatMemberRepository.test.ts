import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { ChatMemberRepository } from './ChatMemberRepository.js';

let client: Client;
let repo: ChatMemberRepository;

async function initSchema() {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS chat_members (
      chat_id TEXT NOT NULL,
      character_id TEXT NOT NULL,
      talkativeness REAL DEFAULT 1.0,
      depth_prompt TEXT DEFAULT '',
      depth_prompt_depth INTEGER DEFAULT 4,
      enabled INTEGER DEFAULT 1,
      PRIMARY KEY (chat_id, character_id)
    )
  `);
}

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  await initSchema();
  repo = new ChatMemberRepository(client);
});

beforeEach(async () => {
  await client.execute('DELETE FROM chat_members');
});

describe('ChatMemberRepository', () => {
  it('adds and retrieves members', async () => {
    await repo.addMember('chat-1', 'char-1', {
      talkativeness: 1.5,
      depthPrompt: 'Be nice',
      depthPromptDepth: 2,
      enabled: true,
    });
    await repo.addMember('chat-1', 'char-2', { talkativeness: 0.5, enabled: false });

    const members = await repo.getMembers('chat-1');
    expect(members).toHaveLength(2);
    expect(members[0]!.characterId).toBe('char-1');
    expect(members[0]!.talkativeness).toBe(1.5);
    expect(members[0]!.enabled).toBe(true);
    expect(members[1]!.characterId).toBe('char-2');
    expect(members[1]!.enabled).toBe(false);
  });

  it('updates a member', async () => {
    await repo.addMember('chat-1', 'char-1');
    const updated = await repo.updateMember('chat-1', 'char-1', { talkativeness: 2.0, enabled: false });
    expect(updated.talkativeness).toBe(2.0);
    expect(updated.enabled).toBe(false);

    const members = await repo.getMembers('chat-1');
    expect(members[0]!.talkativeness).toBe(2.0);
  });

  it('removes a member', async () => {
    await repo.addMember('chat-1', 'char-1');
    await repo.removeMember('chat-1', 'char-1');
    const members = await repo.getMembers('chat-1');
    expect(members).toHaveLength(0);
  });

  it('removes all members for a chat', async () => {
    await repo.addMember('chat-1', 'char-1');
    await repo.addMember('chat-1', 'char-2');
    await repo.removeAllMembers('chat-1');
    const members = await repo.getMembers('chat-1');
    expect(members).toHaveLength(0);
  });

  it('uses defaults when adding without data', async () => {
    await repo.addMember('chat-1', 'char-1');
    const members = await repo.getMembers('chat-1');
    expect(members[0]!.talkativeness).toBe(1.0);
    expect(members[0]!.depthPrompt).toBe('');
    expect(members[0]!.depthPromptDepth).toBe(4);
    expect(members[0]!.enabled).toBe(true);
  });

  it('returns members only for the requested chat', async () => {
    await repo.addMember('chat-a', 'char-1');
    await repo.addMember('chat-b', 'char-2');

    const membersA = await repo.getMembers('chat-a');
    expect(membersA).toHaveLength(1);
    expect(membersA[0]!.characterId).toBe('char-1');

    const membersB = await repo.getMembers('chat-b');
    expect(membersB).toHaveLength(1);
    expect(membersB[0]!.characterId).toBe('char-2');
  });
});
