/**
 * 016 — move the impersonation prompt and the memory summary prompt out of
 * global settings (`impersonationPrompt`, `memory.systemPrompt`) into every
 * prompt list as builtin "utility prompts" (`impersonation`, `memorySummary`):
 * present in each list's `prompts` array, editable per list, but never part of
 * `promptOrder` (never injected into chat assembly).
 *
 * Existing customizations land in EVERY list: a non-empty legacy
 * `impersonationPrompt` / a non-default legacy `memory.systemPrompt` becomes
 * the content of the appended prompt. The legacy keys are then removed from
 * the settings blob.
 *
 * The legacy values are read from the RAW settings blob: the current
 * AppSettingsSchema strips `memory.systemPrompt` on parse (the nested memory
 * object drops unknown keys), so a repository read would already have lost it.
 * Idempotent: lists already carrying the utility prompts are left untouched.
 */

import { DEFAULT_MEMORY_SUMMARY_PROMPT } from '@tamari/types';
import type { PresetPromptDef } from '@tamari/types';
import { str } from '../../lib/coerce.js';
import { getLogger } from '../../lib/logger.js';
import { DEFAULT_IMPERSONATION_PROMPT } from '../../pipeline/PromptManager.js';
import { PromptListRepository } from '../../repos/PromptListRepository.js';
import { SettingsRepository } from '../../repos/SettingsRepository.js';
import type { Migration } from '../runMigrations.js';

const log = getLogger('db');

function utilityPrompt(identifier: string, name: string, content: string): PresetPromptDef {
  return { identifier, name, content, role: 'system', enabled: true, systemPrompt: true, marker: false };
}

const migration: Migration = {
  async up({ db }) {
    const settings = new SettingsRepository(db);
    const promptLists = new PromptListRepository(db);

    const row = await db.execute('SELECT blob FROM settings WHERE id = 0');
    const raw = (
      row.rows.length > 0 ? JSON.parse(str(row.rows[0]?.blob, '{}')) : {}
    ) as Record<string, unknown>;
    const legacyImpersonation = str(raw['impersonationPrompt']);
    const legacyMemory =
      raw['memory'] && typeof raw['memory'] === 'object' ? (raw['memory'] as Record<string, unknown>) : undefined;
    const legacyMemorySystemPrompt = str(legacyMemory?.['systemPrompt']);

    const impersonationContent =
      legacyImpersonation.trim().length > 0 ? legacyImpersonation : DEFAULT_IMPERSONATION_PROMPT;
    const memorySummaryContent =
      legacyMemorySystemPrompt.trim().length > 0 && legacyMemorySystemPrompt !== DEFAULT_MEMORY_SUMMARY_PROMPT
        ? legacyMemorySystemPrompt
        : DEFAULT_MEMORY_SUMMARY_PROMPT;

    for (const list of await promptLists.list()) {
      const prompts = [...list.prompts];
      if (!prompts.some((p) => p.identifier === 'impersonation')) {
        prompts.push(utilityPrompt('impersonation', 'Impersonation Prompt', impersonationContent));
      }
      if (!prompts.some((p) => p.identifier === 'memorySummary')) {
        prompts.push(utilityPrompt('memorySummary', 'Memory Summary Prompt', memorySummaryContent));
      }
      if (prompts.length !== list.prompts.length) {
        await promptLists.update(list.id, { prompts });
      }
    }

    // Remove the legacy keys only when present — on a fresh database there is
    // no settings row, and writing one here would be pure noise.
    if ('impersonationPrompt' in raw) {
      await settings.delete('impersonationPrompt');
    }
    if (legacyMemory && 'systemPrompt' in legacyMemory) {
      const { systemPrompt: _dropped, ...rest } = legacyMemory;
      await settings.setValue('memory', rest);
    }
    log.info('moved impersonation/memory summary prompts into prompt lists');
  },
};

export default migration;
