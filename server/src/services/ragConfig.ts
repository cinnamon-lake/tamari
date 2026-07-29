import type { RAGConfig } from '@tamari/types';
import { str } from '../lib/coerce.js';

/**
 * Build the RAG service config from the settings blob (`rag.*` keys).
 * Shared by boot-time construction (main.ts) and runtime reconfiguration
 * (dispatcher `settings.set`) so both paths agree on defaults.
 */
export function getRAGConfig(settingsMap: Record<string, unknown>): RAGConfig {
  return {
    enabled: Boolean(settingsMap['rag.enabled'] ?? false),
    apiUrl: str(settingsMap['rag.api_url'], 'http://localhost:5000/v1'),
    apiKey: str(settingsMap['rag.api_key']),
    model: str(settingsMap['rag.model'], 'text-embedding-3-small'),
    topK: Number(settingsMap['rag.top_k'] ?? 5),
    threshold: Number(settingsMap['rag.threshold'] ?? 0.7),
    chunkSize: Number(settingsMap['rag.chunkSize'] ?? 0),
  };
}
