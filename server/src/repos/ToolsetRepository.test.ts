import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { ToolsetRepository } from './ToolsetRepository.js';
import type { ToolsetCreateInput } from '@tamari/types';

let client: Client;
let repo: ToolsetRepository;

async function initSchema() {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS toolsets (
      id TEXT PRIMARY KEY,
      template_id TEXT NOT NULL,
      name TEXT NOT NULL,
      config TEXT NOT NULL DEFAULT '{}',
      tool_overrides TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      agent_visible INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    )
  `);
}

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  await initSchema();
  repo = new ToolsetRepository(client);
});

afterAll(async () => {
  // libsql client doesn't have a close method in all versions
});

beforeEach(async () => {
  await client.execute('DELETE FROM toolsets');
});

function input(overrides?: Partial<ToolsetCreateInput>): ToolsetCreateInput {
  return {
    templateId: 'tpl',
    name: 'Toolset',
    config: {},
    toolOverrides: {},
    enabled: true,
    agentVisible: false,
    ...overrides,
  };
}

describe('ToolsetRepository agent_visible', () => {
  it('round-trips agentVisible and defaults it off', async () => {
    const created = await repo.create('ts-1', input());
    expect(created.agentVisible).toBe(false);

    const flagged = await repo.create('ts-2', input({ agentVisible: true }));
    expect(flagged.agentVisible).toBe(true);
  });

  it('updates agentVisible', async () => {
    await repo.create('ts-1', input());
    const updated = await repo.update('ts-1', { agentVisible: true });
    expect(updated.agentVisible).toBe(true);
    const reverted = await repo.update('ts-1', { agentVisible: false });
    expect(reverted.agentVisible).toBe(false);
  });

  it('listAgentVisible returns only enabled + flagged toolsets', async () => {
    await repo.create('ts-plain', input());
    await repo.create('ts-visible', input({ agentVisible: true }));
    await repo.create('ts-disabled', input({ agentVisible: true, enabled: false }));

    const visible = await repo.listAgentVisible();
    expect(visible.map((t) => t.id)).toEqual(['ts-visible']);
  });
});
