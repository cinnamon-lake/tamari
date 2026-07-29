import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RAGService } from './RAGService.js';

vi.mock('./EmbeddingClient.js', () => ({
  EmbeddingClient: vi.fn(function () {
    return {
      embed: vi.fn((texts: string[]) => Promise.resolve(texts.map((t) => vectorFor(t)))),
    };
  }),
}));

function vectorFor(text: string): number[] {
  // Deterministic, comparable vectors for tests.
  if (text.includes('weather') || text.includes('sunny')) return [1, 0, 0, 0];
  if (text.includes('cooking') || text.includes('recipe')) return [0, 1, 0, 0];
  return [0, 0, 1, 0];
}

describe('RAGService', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'st-rag-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createService(enabled: boolean) {
    return new RAGService(
      {
        enabled,
        apiUrl: 'http://localhost:9999',
        apiKey: 'test-key',
        model: 'text-embedding-test',
        topK: 3,
        threshold: 0.7,
        chunkSize: 0,
      },
      tmpDir,
    );
  }

  describe('when disabled', () => {
    it('world info indexing and query are no-ops', async () => {
      const service = createService(false);
      await service.indexWorldInfoEntries('book-1', [{ id: 'e1', content: 'hello', retrievalMode: 'semantic' }]);
      const results = await service.queryWorldInfo('book-1', 'hello');
      expect(results).toEqual([]);
    });
  });

  describe('when enabled', () => {
    it('indexes and queries world info semantic entries', async () => {
      const service = createService(true);
      await service.indexWorldInfoEntries('book-1', [
        { id: 'e1', content: 'The weather is sunny today.', retrievalMode: 'semantic' },
        { id: 'e2', content: 'A cooking recipe.', retrievalMode: 'keyword' },
      ]);

      const results = await service.queryWorldInfo('book-1', 'weather');
      expect(results).toContain('e1');
      expect(results).not.toContain('e2');
    });

    it('deletes a world info index from memory', async () => {
      const service = createService(true);
      await service.indexWorldInfoEntries('book-1', [
        { id: 'e1', content: 'hello', retrievalMode: 'semantic' },
      ]);
      await service.deleteWorldInfoIndex('book-1');
      expect((service as unknown as { indices: Map<string, unknown> }).indices.has('wi:book-1')).toBe(false);
    });
  });
});
