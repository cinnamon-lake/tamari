import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { SettingsRepository } from './SettingsRepository.js';

let client: Client;
let repo: SettingsRepository;

async function initSchema() {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 0),
      blob TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER DEFAULT (unixepoch())
    )
  `);
}

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  await initSchema();
  repo = new SettingsRepository(client);
});

beforeEach(async () => {
  await client.execute('DELETE FROM settings');
});

describe('SettingsRepository', () => {
  it('sets and gets a string value', async () => {
    await repo.setValue('model', 'gpt-4');
    const all = await repo.list();
    expect(all.model).toBe('gpt-4');
  });

  it('sets and gets a dotted key', async () => {
    await repo.setValue('tts.fishaudio.voiceId', 'fish-123');
    const all = await repo.list();
    expect((all as Record<string, unknown>)['tts.fishaudio.voiceId']).toBe('fish-123');
  });

  it('persists across reloads', async () => {
    await repo.setValue('backendProvider', 'claude');
    const reloaded = new SettingsRepository(client);
    const all = await reloaded.list();
    expect(all.backendProvider).toBe('claude');
  });

  it('merges multiple keys', async () => {
    await repo.setValue('model', 'gpt-4');
    await repo.setValue('apiUrl', 'http://localhost');
    const all = await repo.list();
    expect(all.model).toBe('gpt-4');
    expect((all as Record<string, unknown>)['apiUrl']).toBe('http://localhost');
  });

  it('sets and gets an array value', async () => {
    await repo.setValue('customStoppingStrings', ['stop1', 'stop2']);
    const all = await repo.list();
    expect((all as Record<string, unknown>)['customStoppingStrings']).toEqual(['stop1', 'stop2']);
  });

  it('sets and gets a nested dotted key', async () => {
    await repo.setValue('openrouter.providerOrder', ['openai', 'anthropic']);
    const all = await repo.list();
    expect((all as Record<string, unknown>)['openrouter.providerOrder']).toEqual(['openai', 'anthropic']);
  });
});
