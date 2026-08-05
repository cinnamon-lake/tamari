/**
 * In-memory script blob store — the ephemeral backend for the script-facing
 * `store` global when no DB-backed repository is wired (tests, dry-runs).
 * Per adapter instance: blobs live as long as the adapter does. Applies the
 * same caps as the real repository so scripts behave identically either way.
 */

import type { IScriptBlobRepository } from '../repos/ScriptBlobRepository.js';

const MAX_NAME = 60;
const MAX_CONTENT = 64 * 1024;

export class MemoryScriptBlobRepository implements IScriptBlobRepository {
  private seq = 0;
  private readonly map = new Map<string, string>();

  async put(name: string, content: string): Promise<string> {
    if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME) {
      throw new Error(`script blob name must be 1-${MAX_NAME} chars`);
    }
    if (typeof content !== 'string' || content.length > MAX_CONTENT) {
      throw new Error(`script blob content must be a string of at most ${MAX_CONTENT} chars`);
    }
    const id = `${name}#${++this.seq}`;
    this.map.set(id, content);
    return id;
  }

  async get(id: string): Promise<string | null> {
    return this.map.get(id) ?? null;
  }

  /** Test helper: plant a blob under an explicit id (keeps seq past its suffix). */
  seed(id: string, content: string): void {
    this.map.set(id, content);
    const suffix = /#(\d+)$/.exec(id);
    if (suffix) this.seq = Math.max(this.seq, Number(suffix[1]));
  }
}
