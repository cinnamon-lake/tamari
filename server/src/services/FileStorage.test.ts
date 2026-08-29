import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { FileStorage } from './FileStorage.js';

let tmpDir: string;
let storage: FileStorage;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'st-filestorage-'));
  storage = new FileStorage(tmpDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('FileStorage round-trips', () => {
  it('constructor creates the standard subdirectories', () => {
    for (const sub of ['avatars', 'personas', 'attachments', 'character_assets']) {
      expect(existsSync(join(tmpDir, 'files', sub))).toBe(true);
    }
  });

  it('write returns the dataDir-relative path and read round-trips the bytes', () => {
    const data = new Uint8Array([0, 1, 2, 250, 255]);
    const rel = storage.write('avatars', 'abc.png', data);

    expect(rel).toBe('files/avatars/abc.png');
    expect(storage.read(rel)).toEqual(Buffer.from(data));
  });

  it('write creates nested sub directories on demand', () => {
    const rel = storage.write('character_assets/char-1', 'asset.webp', new Uint8Array([1]));
    expect(rel).toBe('files/character_assets/char-1/asset.webp');
    expect(storage.read(rel)).toEqual(Buffer.from([1]));
  });

  it('write uses the caller-provided name verbatim (no UUID renaming)', () => {
    const rel = storage.write('attachments', 'my file (1).bin', new Uint8Array([7]));
    expect(rel).toBe('files/attachments/my file (1).bin');
    expect(storage.exists(rel)).toBe(true);
  });

  it('write overwrites an existing file with the same name', () => {
    storage.write('avatars', 'a.png', new Uint8Array([1]));
    storage.write('avatars', 'a.png', new Uint8Array([2]));
    expect(storage.read('files/avatars/a.png')).toEqual(Buffer.from([2]));
  });

  it('exists reports presence/absence', () => {
    expect(storage.exists('files/avatars/nope.png')).toBe(false);
    storage.write('avatars', 'yes.png', new Uint8Array([1]));
    expect(storage.exists('files/avatars/yes.png')).toBe(true);
  });

  it('delete removes a file; deleting a missing file is a no-op', () => {
    storage.write('avatars', 'd.png', new Uint8Array([1]));
    storage.delete('files/avatars/d.png');
    expect(storage.exists('files/avatars/d.png')).toBe(false);

    expect(() => storage.delete('files/avatars/never-existed.png')).not.toThrow();
  });

  it('resolve returns an absolute path inside dataDir', () => {
    const abs = storage.resolve('files/avatars/x.png');
    expect(abs).toBe(join(tmpDir, 'files', 'avatars', 'x.png'));
  });
});

describe('FileStorage path guards (AUDIT.md item 8 hardening)', () => {
  it('write rejects names containing traversal or separators', () => {
    for (const name of ['../evil', '..', 'a/b', 'a\\b']) {
      expect(() => storage.write('avatars', name, new Uint8Array([1])), `name=${name}`).toThrow(/directory traversal/);
    }
  });

  it('write rejects sub paths with empty, dot, dot-dot, or backslash segments', () => {
    const badSubs = [
      'a/../b', // traversal segment
      '..', // bare traversal
      'a//b', // empty segment
      '/abs', // leading separator → empty first segment
      'a/', // trailing separator → empty last segment
      '.', // dot segment
      'a/./b', // dot segment in the middle
      'a\\b', // backslash (Windows separator)
      'character_assets/..\\x', // backslash inside a segment
    ];
    for (const sub of badSubs) {
      expect(() => storage.write(sub, 'f.png', new Uint8Array([1])), `sub=${sub}`).toThrow(
        /unsafe directory segment|directory traversal/,
      );
    }
  });

  it('write accepts multi-segment sub paths built from safe ids', () => {
    expect(() => storage.write('character_assets/char-1/sub', 'f.png', new Uint8Array([1]))).not.toThrow();
  });

  it('read/exists/delete/resolve reject relPaths containing ..', () => {
    for (const rel of ['../escape.txt', 'files/../../escape.txt', '..']) {
      expect(() => storage.read(rel), `read ${rel}`).toThrow(/directory traversal/);
      expect(() => storage.exists(rel), `exists ${rel}`).toThrow(/directory traversal/);
      expect(() => storage.delete(rel), `delete ${rel}`).toThrow(/directory traversal/);
      expect(() => storage.resolve(rel), `resolve ${rel}`).toThrow(/directory traversal/);
    }
  });

  it('cannot reach a sibling directory whose name starts with the dataDir name', () => {
    // The trailing-separator containment check (root + sep) exists so
    // `data-evil` next to `data` can never satisfy a bare prefix compare.
    const sibling = `${tmpDir}-evil`;
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, 'secret.txt'), 'nope');
    try {
      expect(() => storage.read(`../${basename(sibling)}/secret.txt`)).toThrow(/Invalid path/);
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });
});
