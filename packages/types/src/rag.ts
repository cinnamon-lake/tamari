/**
 * RAG (Retrieval-Augmented Generation) types.
 */

export interface RAGConfig {
  /** Master switch. */
  enabled: boolean;
  /** OpenAI-compatible embedding API base URL. */
  apiUrl: string;
  /** API key for the embedding endpoint. */
  apiKey: string;
  /** Embedding model name. */
  model: string;
  /** Number of relevant messages to retrieve. */
  topK: number;
  /** Minimum similarity score (0-1). */
  threshold: number;
  /** Max tokens per chunk (0 = no chunking). */
  chunkSize: number;
}

export const defaultRAGConfig: RAGConfig = {
  enabled: false,
  apiUrl: 'http://localhost:5000/v1',
  apiKey: '',
  model: 'text-embedding-3-small',
  topK: 5,
  threshold: 0.7,
  chunkSize: 0,
};
