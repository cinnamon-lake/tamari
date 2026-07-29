import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Character } from '@tamari/types';
import { TestHarness } from '../testing/TestHarness.js';
import {
  CHARACTER_RISU_MODULES_EXTENSION_KEY,
  listRisuModuleMeta,
  loadRisuModule,
  removeRisuModule,
  storeRisuModule,
} from './characterRisuModules.js';
import type { RisuModuleData } from '../lib/risum.js';

function sampleModule(): RisuModuleData {
  return {
    name: 'Stored Module',
    namespace: 'stored',
    lorebook: [{ key: 'a', content: 'b' }],
    regex: [{ in: 'x', out: 'y' }],
    trigger: [
      { comment: '', type: 'start', effect: [{ type: 'triggerlua', code: 'print(1)' }] },
      { comment: 't', type: 'manual', effect: [{ type: 'v2SetVar', indent: 0 }] },
    ],
    assets: [['song', '', 'mp3']],
    customModuleToggle: '=stored=group',
  };
}

describe('characterRisuModules', () => {
  let h: TestHarness;
  let character: Character;

  beforeEach(async () => {
    h = new TestHarness();
    await h.initSchema();
    character = await h.deps.characters.create('char-risu', { name: 'Risu Test' });
  });

  afterEach(async () => {
    await h.teardown();
  });

  it('stores module JSON to disk and summarizes metadata', () => {
    const meta = storeRisuModule(h.deps.storage, character.id, sampleModule(), 'embedded');

    expect(meta.name).toBe('Stored Module');
    expect(meta.namespace).toBe('stored');
    expect(meta.source).toBe('embedded');
    expect(meta.counts).toEqual({ triggers: 2, regex: 1, lorebook: 1, assets: 1 });
    expect(meta.hasLua).toBe(true);
    expect(meta.lowLevelAccess).toBe(false);
    expect(h.deps.storage.exists(meta.filePath)).toBe(true);
  });

  it('loads back the exact module JSON', () => {
    const module = sampleModule();
    const meta = storeRisuModule(h.deps.storage, character.id, module, 'attached');
    const loaded = loadRisuModule(h.deps.storage, meta);
    expect(loaded).toEqual(module);
  });

  it('detects hasLua=false for non-lua triggers', () => {
    const module: RisuModuleData = {
      name: 'No Lua',
      trigger: [{ comment: '', type: 'manual', effect: [{ type: 'v2SetVar', indent: 0 }] }],
    };
    const meta = storeRisuModule(h.deps.storage, character.id, module, 'attached');
    expect(meta.hasLua).toBe(false);
  });

  it('parses metadata from extensions tolerantly', () => {
    const meta = storeRisuModule(h.deps.storage, character.id, sampleModule(), 'embedded');
    const withExt: Character = {
      ...character,
      extensions: { [CHARACTER_RISU_MODULES_EXTENSION_KEY]: [meta, { garbage: true }, null] },
    };
    const metas = listRisuModuleMeta(withExt);
    expect(metas).toHaveLength(1);
    expect(metas[0]!.id).toBe(meta.id);
    expect(listRisuModuleMeta(character)).toEqual([]);
    expect(listRisuModuleMeta(undefined)).toEqual([]);
  });

  it('removes the file and the metadata entry', () => {
    const a = storeRisuModule(h.deps.storage, character.id, sampleModule(), 'embedded');
    const b = storeRisuModule(h.deps.storage, character.id, { ...sampleModule(), name: 'Second' }, 'attached');
    const withExt: Character = {
      ...character,
      extensions: { [CHARACTER_RISU_MODULES_EXTENSION_KEY]: [a, b] },
    };

    const remaining = removeRisuModule(h.deps.storage, withExt, a.id);
    expect(remaining.map((m) => m.id)).toEqual([b.id]);
    expect(h.deps.storage.exists(a.filePath)).toBe(false);
    expect(h.deps.storage.exists(b.filePath)).toBe(true);
  });

  it('returns undefined when loading a module whose file is missing', () => {
    const meta = storeRisuModule(h.deps.storage, character.id, sampleModule(), 'embedded');
    h.deps.storage.delete(meta.filePath);
    expect(loadRisuModule(h.deps.storage, meta)).toBeUndefined();
  });
});
