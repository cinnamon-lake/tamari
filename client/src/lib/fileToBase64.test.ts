import { describe, it, expect, vi } from 'vitest';
import { fileToBase64 } from './fileToBase64.js';

function makeFile(content: Uint8Array): File {
  const file = new File([content as unknown as BlobPart], 'test.bin');
  Object.defineProperty(file, 'arrayBuffer', {
    value: vi.fn().mockResolvedValue(content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength)),
    configurable: true,
    writable: true,
  });
  return file;
}

describe('fileToBase64', () => {
  it('encodes a simple string', async () => {
    const file = makeFile(new TextEncoder().encode('hello'));
    expect(await fileToBase64(file)).toBe(btoa('hello'));
  });

  it('encodes an empty file', async () => {
    const file = makeFile(new Uint8Array(0));
    expect(await fileToBase64(file)).toBe('');
  });

  it('encodes binary bytes round-trippably', async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    const result = await fileToBase64(makeFile(bytes));
    expect(atob(result)).toBe(String.fromCharCode(...bytes));
  });

  it('handles files larger than the 32KB chunk size', async () => {
    // 100KB of cycling bytes exercises the chunked String.fromCharCode path.
    const bytes = new Uint8Array(100 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    const result = await fileToBase64(makeFile(bytes));

    const decoded = atob(result);
    expect(decoded.length).toBe(bytes.length);
    expect(decoded.charCodeAt(0)).toBe(0);
    expect(decoded.charCodeAt(0x8000)).toBe(0); // chunk boundary
    expect(decoded.charCodeAt(bytes.length - 1)).toBe((bytes.length - 1) % 256);
  });
});
