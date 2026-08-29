/**
 * Shared base for the HTTP TTS adapters.
 *
 * Every adapter under tts/ re-implemented the same prologue: trim the
 * configured base URL, build JSON + Bearer-auth headers, and optionally run
 * the Lua request script before fetch. This base owns that boilerplate;
 * adapters keep their own endpoints, payloads, and auth quirks (override
 * `headers` or skip it, as Azure / VolcEngine / ElevenLabs do).
 */

import { applyRequestScript } from '../backends/RequestScript.js';

export interface BaseTtsConfig {
  baseUrl: string;
  apiKey?: string;
  requestScript?: string;
}

export abstract class BaseTtsAdapter<C extends BaseTtsConfig = BaseTtsConfig> {
  constructor(protected config: C) {}

  /** Configured base URL with any trailing slash stripped. */
  protected get baseUrl(): string {
    return this.config.baseUrl.replace(/\/$/, '');
  }

  /** JSON headers with Bearer auth; adapters with other auth schemes override this. */
  protected get headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) h['Authorization'] = `Bearer ${this.config.apiKey}`;
    return h;
  }

  /** Run the configured request script (if any) over the outgoing request. */
  protected async applyScript(url: string, init: RequestInit): Promise<{ url: string; init: RequestInit }> {
    if (!this.config.requestScript) return { url, init };
    return applyRequestScript(url, init, this.config.requestScript);
  }
}
