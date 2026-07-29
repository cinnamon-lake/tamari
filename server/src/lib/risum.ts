/**
 * .risum (RisuAI module) container decoder.
 *
 * Format (verified against RisuAI source `src/ts/process/modules.ts` and real files):
 *   byte 0      : magic number 111 (0x6f)
 *   byte 1      : version (only 0 exists)
 *   bytes 2..5  : uint32 LE length of the main block
 *   main block  : RPack-encoded UTF-8 JSON `{ type: 'risuModule', module: RisuModule }`
 *   then N asset blocks: byte 0x01, uint32 LE length, RPack-encoded payload
 *   final byte  : 0x00 (EOF)
 *
 * RPack ("Risu Pack") is not compression or encryption — it is a fixed 256-byte
 * substitution permutation applied to every byte. The 512-byte map (encode half,
 * then decode half) ships in the RisuAI repo as `src/ts/rpack/rpack_map.bin`,
 * dual-licensed MIT/AGPL; embedded here under the MIT terms with attribution:
 *   Copyright (c) kwaroran (RisuAI) — https://github.com/kwaroran/RisuAI
 */

// 512 bytes: bytes 0..255 = encode map, bytes 256..511 = decode map (inverse permutation).
const RPACK_MAP_B64 =
  'xA0eC70rP1X8RW71ZlNPGuC7MJSGumu/QVBvm+/etxBhFyDfMomonW2ryZAADF2v0sFW5RZkkYJldJfKI9ZS0f+0oOgvilg4WmAZlknb18g7PkNLpWNHqmop' +
  'kvQVz2I0eNMdPOIFjipXDhvNTC3yQCwleUgPsnq1p2w35px7VH7+h9yaAuQzouuxLgPdmaaw59WIGIN89r7hXJ/DIUYfCE7QdhJf7v2PROqjXosoCTWeacwK' +
  'x4UHrUrzd+ln1NqEgJO2TXP6JyZ/BMb78XI5UcI2qWis+O3FucvOdaQ9gdlCcByVEbzYjJj5WaET9xR9s+xxwOON8AGuWzEGJCI6uCz3hIvJZfu2n66zAy0B' +
  'aXQf5KPs7lw0IZNKD2riYgKeIpz9PPxxx8atWWcFcG2KRBL6JIZfr9F6R87+UGPdUQZvGOBSqAmdVnNMuFNsw6AOGc8+DX4HMmhG6kj5mS6rpEkgXlU1OAy8' +
  '07FYFnkoChrh8s3EOduiumBydn2V73/IwN43lL+1FIGSJUWs5/Vmpys2WsET40s66I2DG3wnsJpC64eq3FSOeCbSVynUt/gvj4l18EF3wh7/2BUR5QSXF/Mx' +
  '0JsA18q0Tyo72bJr2l2hPzBhvZE9Tubfvk2CjB0jEJhk9IUze5BDu6mI8dalHPbMbrlbC5bt1enFywimgEA=';

const RPACK_MAP = Buffer.from(RPACK_MAP_B64, 'base64');
const ENCODE_MAP = RPACK_MAP.subarray(0, 256);
const DECODE_MAP = RPACK_MAP.subarray(256, 512);

const MAGIC = 111;
const VERSION = 0;
const ASSET_MARK = 1;
const EOF_MARK = 0;

export function decodeRPack(data: Buffer): Buffer {
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) out[i] = DECODE_MAP[data[i]!]!;
  return out;
}

export function encodeRPack(data: Buffer): Buffer {
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) out[i] = ENCODE_MAP[data[i]!]!;
  return out;
}

/** A RisuAI lorebook entry (native format — comma-joined `key` string, not CCv3 `keys[]`). */
export interface RisuLorebookEntry {
  key: string;
  secondkey?: string;
  selective?: boolean;
  content: string;
  comment?: string;
  insertorder?: number;
  alwaysActive?: boolean;
  mode?: string;
  useRegex?: boolean;
  bookVersion?: number;
  [k: string]: unknown;
}

/** A RisuAI regex script (customscript). */
export interface RisuRegexScript {
  comment?: string;
  in: string;
  out: string;
  type?: string;
  ableFlag?: boolean;
  flag?: string;
  [k: string]: unknown;
}

/** A RisuAI triggerscript (V1/V2 effects, or a single `triggerlua`/`triggercode` raw-code effect). */
export interface RisuTriggerScript {
  comment: string;
  type: 'start' | 'manual' | 'output' | 'input' | 'display' | 'request';
  conditions?: unknown[];
  effect?: Array<{ type: string; code?: string; indent?: number; [k: string]: unknown }>;
  lowLevelAccess?: boolean;
  [k: string]: unknown;
}

export interface RisuModuleData {
  name: string;
  description?: string;
  id?: string;
  namespace?: string;
  lorebook?: RisuLorebookEntry[];
  regex?: RisuRegexScript[];
  trigger?: RisuTriggerScript[];
  /** Asset metadata triplets: [name, datapath, ext]. Datapath is blank inside .risum files. */
  assets?: [string, string, string][];
  customModuleToggle?: string;
  lowLevelAccess?: boolean;
  hideIcon?: boolean;
  backgroundEmbedding?: string;
  icon?: string;
  mcp?: { url: string };
  [k: string]: unknown;
}

export interface RisuAssetPayload {
  index: number;
  data: Buffer;
}

export interface RisumParseResult {
  module: RisuModuleData;
  /** Raw (RPack-decoded) asset payloads, in file order. Indexes align with module.assets. */
  assets: RisuAssetPayload[];
}

export class RisumParseError extends Error {}

/**
 * Parse a .risum container. Throws RisumParseError on structural problems.
 * Asset payloads are returned decoded but otherwise untouched (they may be large —
 * callers that only need the module JSON should pass `skipAssetPayloads`).
 */
export function parseRisum(
  buffer: Buffer,
  options: { skipAssetPayloads?: boolean } = {},
): RisumParseResult {
  if (buffer.length < 6) {
    throw new RisumParseError('Not a .risum file: too short for header');
  }
  if (buffer[0] !== MAGIC) {
    throw new RisumParseError(`Not a .risum file: bad magic byte ${buffer[0]} (expected ${MAGIC})`);
  }
  if (buffer[1] !== VERSION) {
    throw new RisumParseError(`Unsupported .risum version ${buffer[1]} (expected ${VERSION})`);
  }

  const mainLen = buffer.readUInt32LE(2);
  if (6 + mainLen > buffer.length) {
    throw new RisumParseError(`Corrupt .risum: main block length ${mainLen} exceeds file size`);
  }
  const mainRaw = decodeRPack(buffer.subarray(6, 6 + mainLen));

  let main: { type?: unknown; module?: unknown };
  try {
    main = JSON.parse(mainRaw.toString('utf-8')) as { type?: unknown; module?: unknown };
  } catch {
    throw new RisumParseError('Corrupt .risum: main block is not valid JSON after RPack decode');
  }
  // `main` is unvalidated JSON.parse output — it can be `null` at runtime
  // despite the declared type, so the optional chain is load-bearing.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (main?.type !== 'risuModule' || !main.module || typeof main.module !== 'object') {
    throw new RisumParseError('Not a RisuAI module: main block is not tagged type="risuModule"');
  }

  const assets: RisuAssetPayload[] = [];
  let pos = 6 + mainLen;
  let index = 0;
  while (pos < buffer.length) {
    const mark = buffer[pos];
    pos += 1;
    if (mark === EOF_MARK) break;
    if (mark !== ASSET_MARK) {
      throw new RisumParseError(`Corrupt .risum: unexpected block mark ${mark} at offset ${pos - 1}`);
    }
    if (pos + 4 > buffer.length) {
      throw new RisumParseError('Corrupt .risum: truncated asset block length');
    }
    const len = buffer.readUInt32LE(pos);
    pos += 4;
    if (pos + len > buffer.length) {
      throw new RisumParseError(`Corrupt .risum: asset block ${index} length ${len} exceeds file size`);
    }
    assets.push({
      index,
      data: options.skipAssetPayloads ? Buffer.alloc(0) : decodeRPack(buffer.subarray(pos, pos + len)),
    });
    pos += len;
    index += 1;
  }

  return { module: main.module as RisuModuleData, assets };
}

/** Encode a module back into a .risum container. Used by tests; kept for parity with the decoder. */
export function buildRisum(
  module: RisuModuleData,
  assetPayloads: Buffer[] = [],
): Buffer {
  const mainJson = Buffer.from(JSON.stringify({ module, type: 'risuModule' }), 'utf-8');
  const mainEncoded = encodeRPack(mainJson);

  const parts: Buffer[] = [];
  const header = Buffer.alloc(6);
  header[0] = MAGIC;
  header[1] = VERSION;
  header.writeUInt32LE(mainEncoded.length, 2);
  parts.push(header, mainEncoded);

  for (const payload of assetPayloads) {
    const encoded = encodeRPack(payload);
    const blockHeader = Buffer.alloc(5);
    blockHeader[0] = ASSET_MARK;
    blockHeader.writeUInt32LE(encoded.length, 1);
    parts.push(blockHeader, encoded);
  }

  parts.push(Buffer.from([EOF_MARK]));
  return Buffer.concat(parts);
}
