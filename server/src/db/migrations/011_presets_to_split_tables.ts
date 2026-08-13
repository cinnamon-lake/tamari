/**
 * 011 — split the legacy `presets` table into `backend_configs` and
 * `prompt_lists`, and remap the `activePresetId` setting.
 *
 * Moved from main.ts, where it ran as an ad-hoc boot-time migration.
 * Idempotent: no-ops when the `presets` table is absent (already migrated
 * or never existed), and skips rows whose target records already exist.
 */

import { randomUUID } from 'node:crypto';
import type { PresetPromptDef, PresetPromptOrderEntry } from '@tamari/types';
import { str } from '../../lib/coerce.js';
import { getLogger } from '../../lib/logger.js';
import { BackendConfigRepository } from '../../repos/BackendConfigRepository.js';
import { PromptListRepository } from '../../repos/PromptListRepository.js';
import { SettingsRepository } from '../../repos/SettingsRepository.js';
import type { Migration } from '../runMigrations.js';

const log = getLogger('db');

const migration: Migration = {
  async up({ db }) {
    const tableCheck = await db.execute({
      sql: "SELECT name FROM sqlite_master WHERE type='table' AND name='presets'",
    });
    if (tableCheck.rows.length === 0) return;

    const backendConfigs = new BackendConfigRepository(db);
    const promptLists = new PromptListRepository(db);
    const settings = new SettingsRepository(db);

    const presets = await db.execute('SELECT * FROM presets');
    for (const row of presets.rows) {
      const r = row as Record<string, unknown>;
      const id = str(r.id) || randomUUID();

      const backendConfigExists = await backendConfigs.getById(id);
      if (!backendConfigExists) {
        await backendConfigs.create(id, {
          name: str(r.name, 'Migrated Preset'),
          description: str(r.description),
          backendProvider: str(r.backend_provider, 'openai'),
          generationMode: str(r.generation_mode, 'chat') as 'chat' | 'text',
          model: str(r.model),
          temperature: r.temperature != null ? Number(r.temperature) : null,
          maxTokens: r.max_tokens != null ? Number(r.max_tokens) : null,
          topP: r.top_p != null ? Number(r.top_p) : null,
          topK: r.top_k != null ? Number(r.top_k) : null,
          minP: r.min_p != null ? Number(r.min_p) : null,
          topA: r.top_a != null ? Number(r.top_a) : null,
          repetitionPenalty: r.repetition_penalty != null ? Number(r.repetition_penalty) : null,
          frequencyPenalty: r.frequency_penalty != null ? Number(r.frequency_penalty) : null,
          presencePenalty: r.presence_penalty != null ? Number(r.presence_penalty) : null,
          instructTemplate: str(r.instruct_template),
          contextLength: r.context_length != null ? Number(r.context_length) : null,
          promptHistoryLimit: r.prompt_history_limit != null ? Number(r.prompt_history_limit) : null,
          providerParams: r.provider_params_json ? (JSON.parse(str(r.provider_params_json)) as Record<string, unknown>) : {},
          stopStrings: r.stop_strings_json ? (JSON.parse(str(r.stop_strings_json)) as string[]) : [],
          openrouterProvider: r.openrouter_provider ? str(r.openrouter_provider) : null,
          apiUrl: r.api_url ? str(r.api_url) : null,
          apiKey: r.api_key ? str(r.api_key) : null,
          logitBias: r.logit_bias_json ? (JSON.parse(str(r.logit_bias_json)) as Record<string, number>) : null,
        });
      }

      const promptListExists = await promptLists.getById(id);
      if (!promptListExists) {
        await promptLists.create(id, {
          name: str(r.name, 'Migrated Preset'),
          description: str(r.description),
          prompts: r.prompts_json ? (JSON.parse(str(r.prompts_json)) as PresetPromptDef[]) : [],
          promptOrder: r.prompt_order_json ? (JSON.parse(str(r.prompt_order_json)) as PresetPromptOrderEntry[]) : [],
        });
      }
    }

    const allSettings = await settings.list();
    const activePresetId = allSettings['activePresetId'];
    if (activePresetId) {
      const presetId = str(activePresetId);
      await settings.setValue('activeBackendConfigId', presetId);
      await settings.setValue('activePromptListId', presetId);
    }

    await db.execute('DROP TABLE presets');
    log.info('migrated presets table to backend_configs and prompt_lists');

    await settings.delete('activePresetId');
  },
};

export default migration;
