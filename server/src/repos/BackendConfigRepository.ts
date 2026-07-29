/**
 * BackendConfig repository — generation backend configuration storage.
 *
 * Each backend config embeds provider selection, model, API credentials,
 * sampling params, and provider-specific extras.
 */

import { safeParseJson } from '../lib/safeJson.js';
import { str } from '../lib/coerce.js';
import type { Client, InValue } from '@libsql/client';
import type { BackendConfig, BackendConfigInsert, BackendConfigUpdate } from '@tamari/types';
import { BackendConfigSchema, BackendConfigRowSchema, sanitizeProviderParams } from '@tamari/types';
import { NotFoundError } from '../errors.js';
import { mapRowsLenient } from './rows.js';
import { z } from 'zod';

export interface IBackendConfigRepository {
  list(): Promise<BackendConfig[]>;
  listSummaries(): Promise<Array<Pick<BackendConfig, 'id' | 'name'>>>;
  getById(id: string): Promise<BackendConfig | undefined>;
  create(id: string, data: BackendConfigInsert): Promise<BackendConfig>;
  update(id: string, patch: BackendConfigUpdate): Promise<BackendConfig>;
  delete(id: string): Promise<void>;
  count(): Promise<number>;
}

function rowToBackendConfig(row: unknown): BackendConfig {
  const r = BackendConfigRowSchema.parse(row);
  return BackendConfigSchema.parse({
    id: r.id,
    name: r.name,
    description: r.description,
    backendProvider: r.backend_provider,
    generationMode: r.generation_mode,
    model: r.model,
    temperature: r.temperature,
    maxTokens: r.max_tokens,
    topP: r.top_p,
    topK: r.top_k,
    minP: r.min_p,
    topA: r.top_a,
    repetitionPenalty: r.repetition_penalty,
    frequencyPenalty: r.frequency_penalty,
    presencePenalty: r.presence_penalty,
    instructTemplate: r.instruct_template,
    contextLength: r.context_length,
    promptHistoryLimit: r.prompt_history_limit,
    providerParams: safeParseJson(r.provider_params_json, z.record(z.string(), z.unknown()), {}),
    stopStrings: safeParseJson(r.stop_strings_json, z.array(z.string()), []),
    openrouterProvider: r.openrouter_provider,
    apiUrl: r.api_url,
    apiKey: r.api_key,
    logitBias: safeParseJson(r.logit_bias_json, z.record(z.string(), z.number()).nullable(), null),
    supportsImages: Boolean(r.supports_images),
    supportsAudio: Boolean(r.supports_audio),
    supportsVideo: Boolean(r.supports_video),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
}

export class BackendConfigRepository implements IBackendConfigRepository {
  constructor(private client: Client) {}

  async list(): Promise<BackendConfig[]> {
    const rs = await this.client.execute('SELECT * FROM backend_configs ORDER BY name, id');
    return mapRowsLenient(rs.rows, rowToBackendConfig, 'BackendConfigRepository.list');
  }

  async listSummaries(): Promise<Array<Pick<BackendConfig, 'id' | 'name'>>> {
    const rs = await this.client.execute('SELECT id, name FROM backend_configs ORDER BY name, id');
    return rs.rows.map((r) => ({
      id: str(r.id),
      name: str(r.name),
    }));
  }

  async getById(id: string): Promise<BackendConfig | undefined> {
    const rs = await this.client.execute({ sql: 'SELECT * FROM backend_configs WHERE id = ?', args: [id] });
    if (rs.rows.length === 0) return undefined;
    return rowToBackendConfig(rs.rows[0]);
  }

  async create(id: string, data: BackendConfigInsert): Promise<BackendConfig> {
    const now = Math.floor(Date.now() / 1000);
    await this.client.execute({
      sql: `INSERT INTO backend_configs (
        id, name, description, backend_provider, generation_mode, model,
        api_url, api_key,
        temperature, max_tokens, top_p, top_k, min_p, top_a,
        repetition_penalty, frequency_penalty, presence_penalty,
        instruct_template, context_length, prompt_history_limit,
        provider_params_json, stop_strings_json, openrouter_provider, logit_bias_json,
        supports_images, supports_audio, supports_video,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      /* eslint-disable @typescript-eslint/no-unnecessary-condition -- defensive fallbacks for unvalidated API input */
      args: [
        id,
        data.name,
        data.description ?? '',
        data.backendProvider ?? 'openai',
        data.generationMode ?? 'chat',
        data.model ?? '',
        data.apiUrl ?? null,
        data.apiKey ?? null,
        data.temperature ?? null,
        data.maxTokens ?? null,
        data.topP ?? null,
        data.topK ?? null,
        data.minP ?? null,
        data.topA ?? null,
        data.repetitionPenalty ?? null,
        data.frequencyPenalty ?? null,
        data.presencePenalty ?? null,
        data.instructTemplate ?? '',
        data.contextLength ?? null,
        data.promptHistoryLimit ?? null,
        JSON.stringify(sanitizeProviderParams(data.providerParams)),
        JSON.stringify(data.stopStrings ?? []),
        data.openrouterProvider ?? null,
        data.logitBias ? JSON.stringify(data.logitBias) : null,
        data.supportsImages !== false ? 1 : 0,
        data.supportsAudio !== false ? 1 : 0,
        data.supportsVideo !== false ? 1 : 0,
        now,
        now,
      ],
      /* eslint-enable @typescript-eslint/no-unnecessary-condition */
    });
    const created = await this.getById(id);
    if (!created) throw new Error(`Failed to retrieve created backend config: ${id}`);
    return created;
  }

  async update(id: string, patch: BackendConfigUpdate): Promise<BackendConfig> {
    const existing = await this.getById(id);
    if (!existing) throw new Error(`Backend config not found: ${id}`);

    const sets: string[] = [];
    const values: InValue[] = [];

    const add = (col: string, val: InValue) => {
      sets.push(`${col} = ?`);
      values.push(val);
    };

    if (patch.name !== undefined) add('name', patch.name);
    if (patch.description !== undefined) add('description', patch.description);
    if (patch.backendProvider !== undefined) add('backend_provider', patch.backendProvider);
    if (patch.generationMode !== undefined) add('generation_mode', patch.generationMode);
    if (patch.model !== undefined) add('model', patch.model);
    if (patch.apiUrl !== undefined) add('api_url', patch.apiUrl);
    if (patch.apiKey !== undefined) add('api_key', patch.apiKey);
    if (patch.temperature !== undefined) add('temperature', patch.temperature);
    if (patch.maxTokens !== undefined) add('max_tokens', patch.maxTokens);
    if (patch.topP !== undefined) add('top_p', patch.topP);
    if (patch.topK !== undefined) add('top_k', patch.topK);
    if (patch.minP !== undefined) add('min_p', patch.minP);
    if (patch.topA !== undefined) add('top_a', patch.topA);
    if (patch.repetitionPenalty !== undefined) add('repetition_penalty', patch.repetitionPenalty);
    if (patch.frequencyPenalty !== undefined) add('frequency_penalty', patch.frequencyPenalty);
    if (patch.presencePenalty !== undefined) add('presence_penalty', patch.presencePenalty);
    if (patch.instructTemplate !== undefined) add('instruct_template', patch.instructTemplate);
    if (patch.contextLength !== undefined) add('context_length', patch.contextLength);
    if (patch.promptHistoryLimit !== undefined) add('prompt_history_limit', patch.promptHistoryLimit);
    if (patch.providerParams !== undefined) add('provider_params_json', JSON.stringify(sanitizeProviderParams(patch.providerParams)));
    if (patch.stopStrings !== undefined) add('stop_strings_json', JSON.stringify(patch.stopStrings));
    if (patch.openrouterProvider !== undefined) add('openrouter_provider', patch.openrouterProvider);
    if (patch.logitBias !== undefined)
      add('logit_bias_json', patch.logitBias ? JSON.stringify(patch.logitBias) : null);
    if (patch.supportsImages !== undefined) add('supports_images', patch.supportsImages ? 1 : 0);
    if (patch.supportsAudio !== undefined) add('supports_audio', patch.supportsAudio ? 1 : 0);
    if (patch.supportsVideo !== undefined) add('supports_video', patch.supportsVideo ? 1 : 0);

    const now = Math.floor(Date.now() / 1000);
    sets.push('updated_at = ?');
    values.push(now);
    values.push(id);

    await this.client.execute({
      sql: `UPDATE backend_configs SET ${sets.join(', ')} WHERE id = ?`,
      args: values,
    });

    const updated = await this.getById(id);
    if (!updated) throw new Error(`Failed to retrieve updated backend config: ${id}`);
    return updated;
  }

  async delete(id: string): Promise<void> {
    const rs = await this.client.execute({ sql: 'DELETE FROM backend_configs WHERE id = ?', args: [id] });
    if (rs.rowsAffected === 0) throw new NotFoundError('BackendConfig', id);
  }

  async count(): Promise<number> {
    const rs = await this.client.execute('SELECT COUNT(*) as count FROM backend_configs');
    return Number(rs.rows[0]?.count ?? 0);
  }
}
