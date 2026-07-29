/**
 * Simple OpenAI-compatible embedding client.
 */

export interface EmbeddingClientConfig {
  apiUrl: string;
  apiKey: string;
  model: string;
}

export class EmbeddingClient {
  constructor(private config: EmbeddingClientConfig) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const url = new URL('/embeddings', this.config.apiUrl).toString();
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.config.model,
        input: texts,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Embedding API error ${res.status}: ${body}`);
    }

    const data = (await res.json()) as {
      data?: Array<{ embedding: number[]; index: number }>;
    };

    const embeddings = data.data ?? [];
    embeddings.sort((a, b) => a.index - b.index);
    return embeddings.map((d) => d.embedding);
  }

  async embedOne(text: string): Promise<number[]> {
    const [vec] = await this.embed([text]);
    return vec!;
  }
}
