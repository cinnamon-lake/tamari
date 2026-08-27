/**
 * Filesystem storage for avatars, attachments, and other binary assets.
 *
 * Layout (relative to dataDir):
 *   files/avatars/{id}.png
 *   files/personas/{id}.png
 *   files/attachments/{id}
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve as resolvePath, sep } from 'node:path';

function assertSafePath(name: string): void {
  if (name.includes('..') || name.includes('/') || name.includes('\\')) {
    throw new Error('Invalid path: directory traversal detected');
  }
}

/** `sub` is interpolated into the directory layout and can carry
 * caller-built ids (e.g. `character_assets/${characterId}`) — every segment
 * must be a safe single path component, same rules as `name`. */
function assertSafeSubPath(sub: string): void {
  const segments = sub.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..' || segment.includes('\\')) {
      throw new Error('Invalid path: unsafe directory segment in storage path');
    }
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
    assertSafeSubPath(sub);
    const dir = join(this.dataDir, 'files', sub);
    mkdirSync(dir, { recursive: true });
    const fullPath = join(dir, name);
    writeFileSync(fullPath, Buffer.from(data));
    return `files/${sub}/${name}`;
  }

  /** Containment check shared by every read-style operation: validates the
   * relative shape and that the resolved target stays inside dataDir. The
   * prefix compare uses a trailing separator so a sibling directory whose
   * name merely starts with the root's name cannot pass. */
  private resolveContained(relPath: string): string {
    assertSafeRelPath(relPath);
    const root = resolvePath(this.dataDir);
    const target = resolvePath(join(root, relPath));
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error('Invalid path: escapes data directory');
    }
    return target;
  }

  /** Read a file by its dataDir-relative path. */
  read(relPath: string): Buffer {
    return readFileSync(this.resolveContained(relPath));
  }

  /** Check if a dataDir-relative path exists. */
  exists(relPath: string): boolean {
    return existsSync(this.resolveContained(relPath));
  }

  /** Delete a file by its dataDir-relative path. */
  delete(relPath: string): void {
    const target = this.resolveContained(relPath);
    if (existsSync(target)) {
      unlinkSync(target);
    }
  }

  /** Get absolute path for a dataDir-relative path. */
  resolve(relPath: string): string {
    return this.resolveContained(relPath);
  }
}
