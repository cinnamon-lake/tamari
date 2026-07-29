/**
 * CLI script to seed the database with test data.
 *
 * Usage:
 *   npx tsx server/src/db/seed.ts
 */

import { createClient } from '@libsql/client';
import { loadConfig } from '../config.js';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const config = loadConfig();
mkdirSync(dirname(config.dbPath), { recursive: true });

const client = createClient({ url: `file:${config.dbPath}` });

const characterId = 'seed-character-1';
const chatId = 'seed-chat-1';
const now = Math.floor(Date.now() / 1000);

// Insert test character
await client.execute({
  sql: `INSERT OR REPLACE INTO characters
    (id, name, description, personality, scenario, first_mes, mes_example, creator, character_version, tags, avatar_path, creator_notes, system_prompt, post_history_instructions, alternate_greetings, extensions, create_date, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  args: [
    characterId,
    'Seraphina',
    'A helpful AI assistant.',
    'Kind, patient, and knowledgeable.',
    'You are chatting with an AI in a cozy digital tavern.',
    "Hello there! I'm Seraphina. How can I help you today?",
    '<START>\n{{user}}: Hi!\n{{char}}: Hello! Nice to meet you.',
    'Seed Data',
    '1.0',
    JSON.stringify(['seed', 'assistant']),
    '',
    '',
    '',
    '',
    JSON.stringify(['Greetings, traveler!']),
    '{}',
    new Date().toISOString(),
    now,
    now,
  ],
});

// Insert test chat
await client.execute({
  sql: `INSERT OR REPLACE INTO chats (id, character_id, name, head_message_id, active_child_id, created_at, updated_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  args: [chatId, characterId, 'Test Chat with Seraphina', null, null, now, now, '{}'],
});

// Insert test messages (tree: root -> user -> assistant)
const msg1 = await client.execute({
  sql: `INSERT INTO messages (parent_id, role, name, content, extra, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  args: [null, 'user', 'User', 'Hello Seraphina!', '{}', now, now],
});
const msg1Id = (msg1.rows[0] as Record<string, unknown>).id as number;

const msg2 = await client.execute({
  sql: `INSERT INTO messages (parent_id, role, name, content, extra, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  args: [
    msg1Id,
    'assistant',
    'Seraphina',
    "Hello there! I'm Seraphina. How can I help you today?",
    '{}',
    now + 1,
    now + 1,
  ],
});
const msg2Id = (msg2.rows[0] as Record<string, unknown>).id as number;

// Insert a sibling swipe for the assistant message
const msg3 = await client.execute({
  sql: `INSERT INTO messages (parent_id, role, name, content, extra, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  args: [
    msg1Id,
    'assistant',
    'Seraphina',
    "Greetings! I'm Seraphina, your digital companion. What shall we explore today?",
    '{}',
    now + 2,
    now + 2,
  ],
});
const msg3Id = (msg3.rows[0] as Record<string, unknown>).id as number;

// Set active_child_id to the leaf (msg2) and head_message_id to its parent (msg1)
await client.execute({
  sql: `UPDATE chats SET active_child_id = ?, head_message_id = ? WHERE id = ?`,
  args: [msg2Id, msg1Id, chatId],
});

console.log(`[seed] Created character: ${characterId}`);
console.log(`[seed] Created chat: ${chatId}`);
console.log(`[seed] Created messages: ${msg1Id} (user), ${msg2Id} (assistant), ${msg3Id} (swipe)`);
console.log(`[seed] Chat active_child=${msg2Id}, head=${msg1Id}`);

client.close();
