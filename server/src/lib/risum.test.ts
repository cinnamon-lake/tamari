import { describe, expect, it } from 'vitest';
import { buildRisum, decodeRPack, encodeRPack, parseRisum, RisumParseError, type RisuModuleData } from './risum.js';

function sampleModule(): RisuModuleData {
  return {
    name: 'Test Module',
    description: 'A module for tests',
    id: 'dd4769dc-caa2-4c84-9fff-675585abd1d3',
    namespace: 'testns',
    lorebook: [
      { key: 'reimu, hakurei', secondkey: '', selective: false, content: 'Shrine maiden.', insertorder: 50, alwaysActive: false, mode: 'normal' },
    ],
    regex: [{ comment: 'fix typo', in: 'teh', out: 'the', type: 'edittrans', ableFlag: false }],
    trigger: [
      {
        comment: '',
        type: 'start',
        conditions: [],
        effect: [{ type: 'triggerlua', code: 'print("hello from lua")' }],
      },
      {
        comment: 'Toggle',
        type: 'manual',
        conditions: [],
        effect: [
          { type: 'v2If', indent: 0 },
          { type: 'v2SetVar', indent: 1 },
          { type: 'v2EndIndent', indent: 0 },
        ],
      },
    ],
    assets: [
      ['song', '', 'mp3'],
      ['sprite', '', 'png'],
    ],
    customModuleToggle: '=test=group',
  };
}

describe('RPack', () => {
  it('encode and decode are exact inverses across all byte values', () => {
    const all = Buffer.alloc(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    expect(decodeRPack(encodeRPack(all))).toEqual(all);
  });
});

describe('parseRisum', () => {
  it('round-trips a module with triggers, regex, lorebook, and asset blocks', () => {
    const payloadA = Buffer.from('ID3-fake-mp3-data');
    const payloadB = Buffer.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3]); // RIFF...
    const buf = buildRisum(sampleModule(), [payloadA, payloadB]);

    const result = parseRisum(buf);
    expect(result.module.name).toBe('Test Module');
    expect(result.module.namespace).toBe('testns');
    expect(result.module.lorebook).toHaveLength(1);
    expect(result.module.regex).toHaveLength(1);
    expect(result.module.trigger).toHaveLength(2);
    expect(result.module.trigger![0]!.effect![0]!.code).toBe('print("hello from lua")');
    expect(result.module.assets).toHaveLength(2);

    expect(result.assets).toHaveLength(2);
    expect(result.assets[0]!.index).toBe(0);
    expect(result.assets[0]!.data).toEqual(payloadA);
    expect(result.assets[1]!.data).toEqual(payloadB);
  });

  it('handles a module with no asset blocks (EOF right after main)', () => {
    const buf = buildRisum(sampleModule());
    const result = parseRisum(buf);
    expect(result.module.name).toBe('Test Module');
    expect(result.assets).toEqual([]);
  });

  it('can skip asset payload decoding', () => {
    const buf = buildRisum(sampleModule(), [Buffer.alloc(1024, 7)]);
    const result = parseRisum(buf, { skipAssetPayloads: true });
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]!.data.length).toBe(0);
  });

  it('rejects a bad magic byte', () => {
    const buf = buildRisum(sampleModule());
    buf[0] = 42;
    expect(() => parseRisum(buf)).toThrow(RisumParseError);
  });

  it('rejects an unsupported version', () => {
    const buf = buildRisum(sampleModule());
    buf[1] = 9;
    expect(() => parseRisum(buf)).toThrow(/version/);
  });

  it('rejects a truncated main block', () => {
    const buf = buildRisum(sampleModule());
    expect(() => parseRisum(buf.subarray(0, 20))).toThrow(RisumParseError);
  });

  it('rejects a non-risuModule JSON payload', () => {
    const json = encodeRPack(Buffer.from(JSON.stringify({ type: 'somethingElse', module: {} })));
    const buf = Buffer.alloc(6 + json.length + 1);
    buf[0] = 111;
    buf[1] = 0;
    buf.writeUInt32LE(json.length, 2);
    json.copy(buf, 6);
    buf[buf.length - 1] = 0;
    expect(() => parseRisum(buf)).toThrow(/risuModule/);
  });

  it('rejects a corrupt asset block mark', () => {
    const buf = buildRisum(sampleModule(), [Buffer.from('x')]);
    // Overwrite the asset mark (first byte after the main block) with 0x7f.
    const mainLen = buf.readUInt32LE(2);
    buf[6 + mainLen] = 0x7f;
    expect(() => parseRisum(buf)).toThrow(/block mark/);
  });

  it('rejects a truncated asset block', () => {
    const buf = buildRisum(sampleModule(), [Buffer.alloc(500, 3)]);
    // Lie about the asset length: inflate it beyond the file size.
    const mainLen = buf.readUInt32LE(2);
    buf.writeUInt32LE(999999, 6 + mainLen + 1);
    expect(() => parseRisum(buf)).toThrow(/exceeds file size/);
  });
});
