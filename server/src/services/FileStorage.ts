/**
 * Filesystem storage for avatars, attachments, and other binary assets.
 *
 * Layout (relative to dataDir):
 *   files/avatars/{id}.png
 *   files/personas/{id}.png
 *   files/attachments/{id}
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';

function assertSafePath(name: string): void {
  if (name.includes('..') || name.includes('/') || name.includes('\\')) {
    throw new Error('Invalid path: directory traversal detected');
  }
}

function assertSafeRelPath(relPath: string): void {
  if (relPath.includes('..')) {
    throw new Error('Invalid path: directory traversal detected');
  }
}

export class FileStorage {
  private dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    mkdirSync(join(dataDir, 'files', 'avatars'), { recursive: true });
    mkdirSync(join(dataDir, 'files', 'personas'), { recursive: true });
    mkdirSync(join(dataDir, 'files', 'attachments'), { recursive: true });
    mkdirSync(join(dataDir, 'files', 'character_assets'), { recursive: true });
  }

  /** Write data and return the relative path (e.g. "files/avatars/abc.png"). */
  write(sub: string, name: string, data: Uint8Array): string {
    assertSafePath(name);
    const dir = join(this.dataDir, 'files', sub);
    mkdirSync(dir, { recursive: true });
    const fullPath = join(dir, name);
    writeFileSync(fullPath, Buffer.from(data));
    return `files/${sub}/${name}`;
  }

  /** Read a file by its dataDir-relative path. */
  read(relPath: string): Buffer {
    assertSafeRelPath(relPath);
    const target = resolvePath(join(this.dataDir, relPath));
    const root = resolvePath(this.dataDir);
    if (!target.startsWith(root)) {
      throw new Error('Invalid path: escapes data directory');
    }
    return readFileSync(target);
  }

  /** Check if a dataDir-relative path exists. */
  exists(relPath: string): boolean {
    assertSafeRelPath(relPath);
    const target = resolvePath(join(this.dataDir, relPath));
    const root = resolvePath(this.dataDir);
    if (!target.startsWith(root)) {
      throw new Error('Invalid path: escapes data directory');
    }
    return existsSync(target);
  }

  /** Delete a file by its dataDir-relative path. */
  delete(relPath: string): void {
    assertSafeRelPath(relPath);
    const target = resolvePath(join(this.dataDir, relPath));
    const root = resolvePath(this.dataDir);
    if (!target.startsWith(root)) {
      throw new Error('Invalid path: escapes data directory');
    }
    if (existsSync(target)) {
      unlinkSync(target);
    }
  }

  /** Get absolute path for a dataDir-relative path. */
  resolve(relPath: string): string {
    assertSafeRelPath(relPath);
    const target = resolvePath(join(this.dataDir, relPath));
    const root = resolvePath(this.dataDir);
    if (!target.startsWith(root)) {
      throw new Error('Invalid path: escapes data directory');
    }
    return target;
  }
}
