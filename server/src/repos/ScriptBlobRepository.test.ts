import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestHarness } from '../testing/TestHarness.js';
import { ScriptBlobRepository } from './ScriptBlobRepository.js';

describe('ScriptBlobRepository', () => {
  let h: TestHarness;
  let repo: ScriptBlobRepository;

  beforeEach(async () => {
    h = new TestHarness();
    await h.initSchema();
    repo = new ScriptBlobRepository(h.db);
  });

  afterEach(async () => {
    await h.teardown();
  });

  it('put appends and get reads back by exact id', async () => {
    const id = await repo.put('pack:f1', '{"rooms":{}}');
    expect(id).toBe('pack:f1#1');
    expect(await repo.get(id)).toBe('{"rooms":{}}');
  });

  it('assigns a global monotonic seq across names (no per-name reuse)', async () => {
    const a = await repo.put('pack:f1', 'one');
    const b = await repo.put('pack:f1', 'two');
    const c = await repo.put('other', 'three');
    expect(a).toBe('pack:f1#1');
    expect(b).toBe('pack:f1#2'); // a "mutation" is a new id, never an edit
    expect(c).toBe('other#3');
    expect(await repo.get(a)).toBe('one'); // the old version is still there
    expect(await repo.get(b)).toBe('two');
  });

  it('get of a missing id returns null', async () => {
    expect(await repo.get('pack:f9#99')).toBeNull();
  });

  it('rejects over-cap names and content loudly', async () => {
    await expect(repo.put('', 'x')).rejects.toThrow(/name/);
    await expect(repo.put('n'.repeat(61), 'x')).rejects.toThrow(/name/);
    await expect(repo.put('ok', 'x'.repeat(64 * 1024 + 1))).rejects.toThrow(/content/);
  });
});
