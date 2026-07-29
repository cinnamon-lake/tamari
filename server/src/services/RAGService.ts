/**
 * RAG service — per-book World Info vector indices via vectra (semantic WI retrieval).
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import vectra from 'vectra';
import type { EmbeddingsModel, EmbeddingsResponse } from 'vectra';
import type { RAGConfig } from '@tamari/types';
import { EmbeddingClient } from './EmbeddingClient.js';

class VectraEmbeddingAdapter implements EmbeddingsModel {
  readonly maxTokens = 8192;
  constructor(private client: EmbeddingClient) {}

  async createEmbeddings(inputs: string | string[]): Promise<EmbeddingsResponse> {
    try {
      const texts = Array.isArray(inputs) ? inputs : [inputs];
      const output = await this.client.embed(texts);
      return { status: 'success', output };
    } catch (err) {
      return { status: 'error', message: String(err) };
    }
  }
}

export class RAGService {
  private client: EmbeddingClient;
  private adapter: VectraEmbeddingAdapter;
  private indices = new Map<string, vectra.LocalDocumentIndex>();

  constructor(
    private config: RAGConfig,
    private dataDir: string,
  ) {
    this.client = new EmbeddingClient({
      apiUrl: config.apiUrl,
      apiKey: config.apiKey,
      model: config.model,
    });
    this.adapter = new VectraEmbeddingAdapter(this.client);
  }

  /**
   * Reconfigure at runtime (e.g. after a `rag.*` settings change). Rebuilds
   * the embedding client and drops cached indices so the next lookup uses the
   * new adapter. Vectra data on disk is left intact; entries re-index on use.
   */
  configure(config: RAGConfig): void {
    this.config = config;
    this.client = new EmbeddingClient({
      apiUrl: config.apiUrl,
      apiKey: config.apiKey,
      model: config.model,
    });
    this.adapter = new VectraEmbeddingAdapter(this.client);
    this.indices.clear();
  }

  // ---------- World Info ----------

  private wiIndexPath(bookId: string): string {
    return join(this.dataDir, 'vectors', 'wi', bookId);
  }

  private async getWIIndex(bookId: string): Promise<vectra.LocalDocumentIndex> {
    let idx = this.indices.get(`wi:${bookId}`);
    if (idx) return idx;

    const path = this.wiIndexPath(bookId);
    mkdirSync(path, { recursive: true });

    idx = new vectra.LocalDocumentIndex({
      folderPath: path,
      embeddings: this.adapter,
    });

    if (!(await idx.isCatalogCreated())) {
      await idx.createIndex();
    }

    this.indices.set(`wi:${bookId}`, idx);
    return idx;
  }

  async indexWorldInfoEntries(
    bookId: string,
    entries: Array<{ id: string; content: string; retrievalMode?: string }>,
  ): Promise<void> {
    if (!this.config.enabled) return;

    const semanticEntries = entries.filter((e) => e.retrievalMode === 'semantic');
    if (semanticEntries.length === 0) return;

    const idx = await this.getWIIndex(bookId);
    for (const entry of semanticEntries) {
      if (!entry.content.trim()) continue;
      await idx.upsertDocument(`entry:${entry.id}`, entry.content, undefined, { entryId: entry.id });
    }
  }

  async queryWorldInfo(bookId: string, query: string, topK?: number, threshold?: number): Promise<string[]> {
    if (!this.config.enabled) return [];

    const idx = await this.getWIIndex(bookId);
    const results = await idx.queryDocuments(query, {
      maxDocuments: topK ?? this.config.topK,
    });

    const minScore = threshold ?? this.config.threshold;
    const out: string[] = [];
    for (const r of results) {
      if (r.score < minScore) continue;
      const metadata = await r.loadMetadata();
      if (metadata.entryId) {
        out.push(String(metadata.entryId));
      }
    }
    return out;
  }

  async deleteWorldInfoIndex(bookId: string): Promise<void> {
    this.indices.delete(`wi:${bookId}`);
  }
}
