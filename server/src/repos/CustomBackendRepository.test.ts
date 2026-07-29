import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestHarness } from '../testing/TestHarness.js';
import { CustomBackendRepository } from './CustomBackendRepository.js';

describe('CustomBackendRepository', () => {
  let h: TestHarness;
  let repo: CustomBackendRepository;

  beforeEach(async () => {
    h = new TestHarness();
    await h.initSchema();
    repo = new CustomBackendRepository(h.db);
  });

  afterEach(async () => {
    await h.teardown();
  });

  it('creates and reads back a custom backend', async () => {
    const created = await repo.create('cb-1', {
      name: 'Rewrite Agent',
      description: 'Wraps another backend',
      luaSource: 'function generate(prompt, ctx) return "hi" end',
    });
    expect(created.id).toBe('cb-1');
    expect(created.luaSource).toContain('generate');
    expect(created.createdAt).toBeGreaterThan(0);

    const fetched = await repo.getById('cb-1');
    expect(fetched).toEqual(created);
  });

  it('lists ordered by name', async () => {
    await repo.create('cb-b', { name: 'Beta', description: '', luaSource: '' });
    await repo.create('cb-a', { name: 'Alpha', description: '', luaSource: '' });
    const list = await repo.list();
    expect(list.map((c) => c.name)).toEqual(['Alpha', 'Beta']);
  });

  it('updates fields and bumps updatedAt', async () => {
    const created = await repo.create('cb-2', { name: 'Old', description: '', luaSource: '' });
    const updated = await repo.update('cb-2', { name: 'New', luaSource: 'return 1' });
    expect(updated.name).toBe('New');
    expect(updated.luaSource).toBe('return 1');
    expect(updated.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
  });

  it('throws when updating a missing row', async () => {
    await expect(repo.update('nope', { name: 'x' })).rejects.toThrow('not found');
  });

  it('deletes', async () => {
    await repo.create('cb-3', { name: 'Gone', description: '', luaSource: '' });
    await repo.delete('cb-3');
    expect(await repo.getById('cb-3')).toBeUndefined();
  });
});
