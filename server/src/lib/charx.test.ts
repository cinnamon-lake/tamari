import { describe, it, expect } from 'vitest';
import { parseCharX, extractCharXAssets, buildAssetUri, sanitizeAssetName, type CharXAssetDef } from './charx.js';
import { zipSync } from 'fflate';

function makeCharXCard(options: {
  card: Record<string, unknown>;
  assets?: Record<string, Uint8Array>;
  polyglotPrefix?: Uint8Array;
}): Buffer {
  const files: Record<string, Uint8Array> = {
    'card.json': new Uint8Array(Buffer.from(JSON.stringify(options.card))),
    ...options.assets,
  };
  const zipData = zipSync(files, { level: 3 });

  if (options.polyglotPrefix) {
    const combined = new Uint8Array(options.polyglotPrefix.length + zipData.length);
    combined.set(options.polyglotPrefix, 0);
    combined.set(zipData, options.polyglotPrefix.length);
    return Buffer.from(combined);
  }

  return Buffer.from(zipData);
}

describe('parseCharX', () => {
  it('parses a standard CharX archive', () => {
    const card = {
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: {
        name: 'Test Char',
        assets: [
          { type: 'icon', name: 'main', ext: 'png', uri: 'embeded://assets/icon/image/main.png' },
        ],
      },
    };
    const buf = makeCharXCard({
      card,
      assets: {
        'assets/icon/image/main.png': new Uint8Array([1, 2, 3, 4]),
      },
    });

    const result = parseCharX(buf);
    expect((result.card as Record<string, unknown>).spec).toBe('chara_card_v3');
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]).toEqual({
      zipPath: 'assets/icon/image/main.png',
      type: 'icon',
      name: 'main',
      ext: 'png',
    });
    expect(result.avatarBuffer).toBeDefined();
    expect(Buffer.from(result.avatarBuffer!).toString('hex')).toBe('01020304');
  });

  it('parses a polyglot archive (JPEG prefix + ZIP)', () => {
    const card = {
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: {
        name: 'Polyglot Char',
        assets: [],
      },
    };
    const jpegPrefix = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const buf = makeCharXCard({
      card,
      polyglotPrefix: jpegPrefix,
    });

    const result = parseCharX(buf);
    expect((result.card as Record<string, unknown>).spec).toBe('chara_card_v3');
    expect(result.assets).toHaveLength(0);
  });

  it('handles embedded:// (correct spelling) URIs', () => {
    const card = {
      spec: 'chara_card_v3',
      data: {
        name: 'Correct Spelling',
        assets: [
          { type: 'background', name: 'bg', ext: 'jpg', uri: 'embedded://assets/background/bg.jpg' },
        ],
      },
    };
    const buf = makeCharXCard({ card });

    const result = parseCharX(buf);
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]!.zipPath).toBe('assets/background/bg.jpg');
  });

  it('handles __asset: URIs', () => {
    const card = {
      spec: 'chara_card_v3',
      data: {
        name: 'Asset Prefix',
        assets: [
          { type: 'emotion', name: 'happy', ext: 'png', uri: '__asset:expressions/happy.png' },
        ],
      },
    };
    const buf = makeCharXCard({ card });

    const result = parseCharX(buf);
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]!.zipPath).toBe('expressions/happy.png');
  });

  it('picks main icon as avatar', () => {
    const card = {
      spec: 'chara_card_v3',
      data: {
        name: 'Icon Test',
        assets: [
          { type: 'icon', name: 'alt', ext: 'png', uri: 'embeded://icon_alt.png' },
          { type: 'icon', name: 'main', ext: 'png', uri: 'embeded://icon_main.png' },
        ],
      },
    };
    const buf = makeCharXCard({
      card,
      assets: {
        'icon_alt.png': new Uint8Array([1]),
        'icon_main.png': new Uint8Array([2]),
      },
    });

    const result = parseCharX(buf);
    expect(result.avatarBuffer).toBeDefined();
    expect(Buffer.from(result.avatarBuffer!).toString('hex')).toBe('02');
  });

  it('picks first icon when no main icon exists', () => {
    const card = {
      spec: 'chara_card_v3',
      data: {
        name: 'First Icon',
        assets: [
          { type: 'icon', name: 'first', ext: 'png', uri: 'embeded://first.png' },
          { type: 'icon', name: 'second', ext: 'png', uri: 'embeded://second.png' },
        ],
      },
    };
    const buf = makeCharXCard({
      card,
      assets: {
        'first.png': new Uint8Array([10]),
        'second.png': new Uint8Array([20]),
      },
    });

    const result = parseCharX(buf);
    expect(result.avatarBuffer).toBeDefined();
    expect(Buffer.from(result.avatarBuffer!).toString('hex')).toBe('0a');
  });

  it('throws on missing ZIP signature', () => {
    expect(() => parseCharX(Buffer.from('not a zip file'))).toThrow('no ZIP signature found');
  });

  it('throws on missing card.json', () => {
    const zipData = zipSync({ 'other.txt': new Uint8Array([1]) }, { level: 3 });
    expect(() => parseCharX(Buffer.from(zipData))).toThrow('missing card.json');
  });

  it('surfaces an embedded module.risum as moduleBuffer', () => {
    const card = { spec: 'chara_card_v3', data: { name: 'Module Test' } };
    const buf = makeCharXCard({
      card,
      assets: {
        'module.risum': new Uint8Array([111, 0, 1, 2, 3]),
      },
    });

    const result = parseCharX(buf);
    expect(result.moduleBuffer).toBeDefined();
    expect(Array.from(result.moduleBuffer!)).toEqual([111, 0, 1, 2, 3]);
  });

  it('leaves moduleBuffer undefined when the archive has no module.risum', () => {
    const card = { spec: 'chara_card_v3', data: { name: 'No Module' } };
    const buf = makeCharXCard({ card });

    const result = parseCharX(buf);
    expect(result.moduleBuffer).toBeUndefined();
  });
});

describe('extractCharXAssets', () => {
  it('extracts selective files from archive', () => {
    const card = {
      spec: 'chara_card_v3',
      data: {
        name: 'Extract Test',
        assets: [
          { type: 'icon', name: 'main', ext: 'png', uri: 'embeded://icon.png' },
          { type: 'other', name: 'misc', ext: 'txt', uri: 'embeded://readme.txt' },
        ],
      },
    };
    const buf = makeCharXCard({
      card,
      assets: {
        'icon.png': new Uint8Array([1, 2, 3]),
        'readme.txt': new Uint8Array([4, 5, 6]),
        'unwanted.bin': new Uint8Array([7, 8, 9]),
      },
    });

    const defs: CharXAssetDef[] = [
      { zipPath: 'icon.png', type: 'icon', name: 'main', ext: 'png' },
    ];
    const extracted = extractCharXAssets(buf, defs);
    expect(extracted.size).toBe(1);
    expect(extracted.get('icon.png')?.toString('hex')).toBe('010203');
  });
});

describe('buildAssetUri', () => {
  it('returns embeded:// prefixed path', () => {
    expect(buildAssetUri('assets/icon/test.png')).toBe('embeded://assets/icon/test.png');
  });
});

describe('sanitizeAssetName', () => {
  it('sanitizes special characters', () => {
    expect(sanitizeAssetName('Hello World!')).toBe('Hello_World');
    expect(sanitizeAssetName('test@file#name')).toBe('test_file_name');
    expect(sanitizeAssetName('')).toBe('asset');
    expect(sanitizeAssetName('!!!')).toBe('asset');
  });
});
