/**
 * PromptManager — manages the ordered collection of prompts for chat completion.
 *
 * Mirrors the old client's prompt manager but without DOM/UI concerns.
 * Each prompt has an identifier, content, role, and toggle state.
 * The order determines how prompts are stacked into the final context.
 */

import { DEFAULT_MEMORY_SUMMARY_PROMPT } from '@tamari/types';

export type PromptRole = 'system' | 'user' | 'assistant';

/** Fallback impersonation instruction — the builtin `impersonation` utility
 *  prompt's default content (moved here from GenerationService). */
export const DEFAULT_IMPERSONATION_PROMPT =
  "[Write your next reply from the point of view of {{user}}, using the chat history so far as a guideline for the writing style of {{user}}. Don't write as {{char}} or system. Don't describe actions of {{char}}.]";

export interface PromptDef {
  identifier: string;
  name: string;
  content: string;
  role: PromptRole;
  enabled: boolean;
  systemPrompt?: boolean;
  marker?: boolean;
  injectionPosition?: 'relative' | 'absolute';
  injectionDepth?: number;
  injectionOrder?: number;
  forbidOverrides?: boolean;
}

export interface PromptOrderEntry {
  identifier: string;
  enabled: boolean;
}

export const DEFAULT_PROMPTS: PromptDef[] = [
  {
    identifier: 'main',
    name: 'Main Prompt',
    content: "Write {{char}}'s next reply in a fictional chat between {{charIfNotGroup}} and {{user}}.",
    role: 'system',
    enabled: true,
    systemPrompt: true,
    marker: false,
  },
  {
    identifier: 'nsfw',
    name: 'Auxiliary Prompt',
    content: '',
    role: 'system',
    enabled: true,
    systemPrompt: true,
    marker: false,
  },
  {
    identifier: 'jailbreak',
    name: 'Post-History Instructions',
    content: '',
    role: 'system',
    enabled: true,
    systemPrompt: true,
    marker: false,
  },
  {
    identifier: 'enhanceDefinitions',
    name: 'Enhance Definitions',
    content:
      "If you have more knowledge of {{char}}, add to the character's lore and personality to enhance them but keep the Character Sheet's definitions absolute.",
    role: 'system',
    enabled: false,
    systemPrompt: true,
    marker: false,
  },
  {
    identifier: 'dialogueExamples',
    name: 'Chat Examples',
    content: '',
    role: 'system',
    enabled: true,
    systemPrompt: true,
    marker: true,
  },
  {
    identifier: 'chatHistory',
    name: 'Chat History',
    content: '',
    role: 'system',
    enabled: true,
    systemPrompt: true,
    marker: true,
  },
  {
    identifier: 'worldInfoBefore',
    name: 'World Info (before)',
    content: '',
    role: 'system',
    enabled: true,
    systemPrompt: true,
    marker: true,
  },
  {
    identifier: 'worldInfoAfter',
    name: 'World Info (after)',
    content: '',
    role: 'system',
    enabled: true,
    systemPrompt: true,
    marker: true,
  },
  {
    identifier: 'charDescription',
    name: 'Char Description',
    content: '',
    role: 'system',
    enabled: true,
    systemPrompt: true,
    marker: true,
  },
  {
    identifier: 'charPersonality',
    name: 'Char Personality',
    content: '',
    role: 'system',
    enabled: true,
    systemPrompt: true,
    marker: true,
  },
  {
    identifier: 'scenario',
    name: 'Scenario',
    content: '',
    role: 'system',
    enabled: true,
    systemPrompt: true,
    marker: true,
  },
  {
    identifier: 'personaDescription',
    name: 'Persona Description',
    content: '',
    role: 'system',
    enabled: true,
    systemPrompt: true,
    marker: true,
  },
  // Utility prompts: present in every list's `prompts` array (editable per
  // list) but deliberately absent from DEFAULT_ORDER — they are never
  // injected into chat assembly, only read directly by their consumers
  // (impersonate drafts, memory summarization).
  {
    identifier: 'impersonation',
    name: 'Impersonation Prompt',
    content: DEFAULT_IMPERSONATION_PROMPT,
    role: 'system',
    enabled: true,
    systemPrompt: true,
    marker: false,
  },
  {
    identifier: 'memorySummary',
    name: 'Memory Summary Prompt',
    content: DEFAULT_MEMORY_SUMMARY_PROMPT,
    role: 'system',
    enabled: true,
    systemPrompt: true,
    marker: false,
  },
];

/** Identifiers of the builtin utility prompts (in `prompts`, never in `promptOrder`). */
export const UTILITY_PROMPT_IDENTIFIERS = new Set(['impersonation', 'memorySummary']);

/** Append any missing builtin utility prompts to a prompt list's prompt defs.
 *  Used when seeding/migrating lists so every stored list carries them. */
export function ensureUtilityPrompts(prompts: PromptDef[]): PromptDef[] {
  const present = new Set(prompts.map((p) => p.identifier));
  const missing = DEFAULT_PROMPTS.filter((p) => UTILITY_PROMPT_IDENTIFIERS.has(p.identifier) && !present.has(p.identifier));
  return missing.length === 0 ? prompts : [...prompts, ...missing.map((p) => ({ ...p }))];
}

export const DEFAULT_ORDER: PromptOrderEntry[] = [
  { identifier: 'main', enabled: true },
  { identifier: 'worldInfoBefore', enabled: true },
  { identifier: 'personaDescription', enabled: true },
  { identifier: 'charDescription', enabled: true },
  { identifier: 'charPersonality', enabled: true },
  { identifier: 'scenario', enabled: true },
  { identifier: 'enhanceDefinitions', enabled: false },
  { identifier: 'nsfw', enabled: true },
  { identifier: 'worldInfoAfter', enabled: true },
  { identifier: 'dialogueExamples', enabled: true },
  { identifier: 'chatHistory', enabled: true },
  { identifier: 'jailbreak', enabled: true },
];

export class PromptManager {
  private prompts = new Map<string, PromptDef>();
  private order: PromptOrderEntry[];

  constructor(prompts?: PromptDef[], order?: PromptOrderEntry[]) {
    const usePrompts = prompts && prompts.length > 0 ? prompts : DEFAULT_PROMPTS;
    for (const p of usePrompts) {
      this.prompts.set(p.identifier, { ...p });
    }
    this.order = order && order.length > 0 ? order.map((o) => ({ ...o })) : DEFAULT_ORDER.map((o) => ({ ...o }));
  }

  getPrompt(identifier: string): PromptDef | undefined {
    return this.prompts.get(identifier);
  }

  setPrompt(identifier: string, patch: Partial<Omit<PromptDef, 'identifier'>>): void {
    const existing = this.prompts.get(identifier);
    if (!existing) return;
    this.prompts.set(identifier, { ...existing, ...patch });
  }

  /** Override content for overridable prompts (main, jailbreak) from character cards. */
  applyOverride(identifier: string, content: string): void {
    const prompt = this.prompts.get(identifier);
    if (!prompt) return;
    if (prompt.forbidOverrides) return;
    this.prompts.set(identifier, { ...prompt, content });
  }

  /** Set the active order (can be loaded from settings / character presets). */
  setOrder(order: PromptOrderEntry[]): void {
    this.order = order.map((o) => ({ ...o }));
  }

  /** Get the current order entries. */
  getOrder(): PromptOrderEntry[] {
    return this.order.map((o) => ({ ...o }));
  }

  /** Get prompts in their configured order, skipping disabled ones. */
  getOrderedPrompts(): PromptDef[] {
    const result: PromptDef[] = [];
    for (const entry of this.order) {
      const prompt = this.prompts.get(entry.identifier);
      if (!prompt) continue;
      if (!entry.enabled) continue;
      result.push({ ...prompt, enabled: entry.enabled });
    }
    return result;
  }

  /** Insert a dynamic prompt (e.g. world info, bias) into the collection. */
  injectPrompt(prompt: PromptDef): void {
    this.prompts.set(prompt.identifier, prompt);
    if (!this.order.find((o) => o.identifier === prompt.identifier)) {
      this.order.push({ identifier: prompt.identifier, enabled: true });
    }
  }

  /** Get the raw prompt map (for inspection). */
  getAllPrompts(): Map<string, PromptDef> {
    return new Map(this.prompts);
  }

  /** Serialize to JSON for storage in settings. */
  serialize(): { prompts: PromptDef[]; order: PromptOrderEntry[] } {
    return {
      prompts: Array.from(this.prompts.values()),
      order: this.order,
    };
  }
}
