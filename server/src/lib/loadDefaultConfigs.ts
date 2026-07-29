/**
 * Load built-in default backend config and prompt list from `default/presets/`.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BackendConfigInsert, PromptListInsert, PresetPromptDef, PresetPromptOrderEntry } from '@tamari/types';
import { DEFAULT_PROMPTS, DEFAULT_ORDER } from '../pipeline/PromptManager.js';

const PRESETS_DIR = join(process.cwd(), 'default', 'presets');

interface OldPreset {
  chat_completion_source?: string;
  openai_model?: string;
  claude_model?: string;
  openrouter_model?: string;
  google_model?: string;
  vertexai_model?: string;
  mistralai_model?: string;
  chutes_model?: string;
  electronhub_model?: string;
  ai21_model?: string;
  custom_model?: string;
  temperature?: number;
  openai_maxTokens?: number;
  topP?: number;
  topK?: number;
  topA?: number;
  minP?: number;
  repetitionPenalty?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  openai_max_context?: number;
  prompts?: Array<{
    identifier?: string;
    name?: string;
    content?: string;
    role?: string;
    systemPrompt?: boolean;
    marker?: boolean;
  }>;
  promptOrder?: Array<{
    characterId?: number;
    order?: Array<{ identifier?: string; enabled?: boolean }>;
  }>;
  [key: string]: unknown;
}

function modelForSource(source: string, data: OldPreset): string {
  switch (source) {
    case 'openai':
      return data.openai_model ?? '';
    case 'claude':
      return data.claude_model ?? '';
    case 'openrouter':
      return data.openrouter_model ?? '';
    case 'makersuite':
    case 'gemini':
      return data.google_model ?? '';
    case 'mistralai':
      return data.mistralai_model ?? '';
    case 'custom':
      return data.custom_model ?? '';
    default:
      return '';
  }
}

function mapPrompts(data: OldPreset): {
  prompts: PresetPromptDef[];
  order: PresetPromptOrderEntry[];
} {
  if (!data.prompts || data.prompts.length === 0) {
    return {
      prompts: DEFAULT_PROMPTS.map((p) => ({ ...p })),
      order: DEFAULT_ORDER.map((o) => ({ ...o })),
    };
  }

  const enabledSet = new Set<string>();
  const firstGroup = data.promptOrder?.[0];
  if (firstGroup?.order) {
    for (const entry of firstGroup.order) {
      if (entry.enabled && entry.identifier) {
        enabledSet.add(entry.identifier);
      }
    }
  }

  const prompts: PresetPromptDef[] = data.prompts.map((p) => ({
    identifier: p.identifier ?? 'unknown',
    name: p.name ?? '',
    content: p.content ?? '',
    role: (p.role as 'system' | 'user' | 'assistant' | undefined) ?? 'system',
    enabled: enabledSet.has(p.identifier ?? ''),
    systemPrompt: p.systemPrompt ?? false,
    marker: p.marker ?? false,
  }));

  const order: PresetPromptOrderEntry[] =
    firstGroup?.order
      ?.filter((o) => o.identifier)
      .map((o) => ({
        identifier: o.identifier ?? '',
        enabled: o.enabled ?? true,
      })) ?? DEFAULT_ORDER.map((o) => ({ ...o }));

  return { prompts, order };
}

export interface DefaultConfigs {
  backendConfig: BackendConfigInsert;
  promptList: PromptListInsert;
}

export function loadDefaultConfigs(): DefaultConfigs[] {
  let files: string[] = [];
  try {
    files = readdirSync(PRESETS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }

  return files.map((file) => {
    const raw = JSON.parse(readFileSync(join(PRESETS_DIR, file), 'utf-8')) as OldPreset;
    const { prompts, order } = mapPrompts(raw);
    const source = raw.chat_completion_source ?? 'openai';

    const coreKeys = new Set([
      'chat_completion_source',
      'openai_model',
      'claude_model',
      'openrouter_model',
      'google_model',
      'vertexai_model',
      'mistralai_model',
      'chutes_model',
      'electronhub_model',
      'ai21_model',
      'custom_model',
      'temperature',
      'openai_maxTokens',
      'topP',
      'topK',
      'topA',
      'minP',
      'repetitionPenalty',
      'frequencyPenalty',
      'presencePenalty',
      'openai_max_context',
      'prompts',
      'promptOrder',
    ]);
    const providerParams: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!coreKeys.has(k)) {
        providerParams[k] = v;
      }
    }

    const backendConfig: BackendConfigInsert = {
      name: file.replace(/\.json$/, ''),
      description: '',
      backendProvider: source,
      generationMode: 'chat' as const,
      model: modelForSource(source, raw),
      temperature: raw.temperature ?? null,
      maxTokens: raw.openai_maxTokens ?? null,
      topP: raw.topP ?? null,
      topK: raw.topK ?? null,
      minP: raw.minP ?? null,
      topA: raw.topA ?? null,
      repetitionPenalty: raw.repetitionPenalty ?? null,
      frequencyPenalty: raw.frequencyPenalty ?? null,
      presencePenalty: raw.presencePenalty ?? null,
      instructTemplate: '',
      contextLength: raw.openai_max_context ?? null,
      promptHistoryLimit: 50,
      providerParams,
      stopStrings: [],
      openrouterProvider: null,
      logitBias: null,
    };

    const promptList: PromptListInsert = {
      name: file.replace(/\.json$/, ''),
      description: '',
      prompts,
      promptOrder: order,
    };

    return { backendConfig, promptList };
  });
}
