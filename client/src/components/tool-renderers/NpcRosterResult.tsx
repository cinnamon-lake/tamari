import { For, Show } from 'solid-js';
import type { Component } from 'solid-js';
import type { ToolResultProps } from './index.js';
import { bus } from '../../bus/WebSocketBus.js';
import { state } from '../../stores/serverStore.js';
import { useI18n } from '../../i18n/index.js';
import './NpcRosterResult.css';

interface RosterNpc {
  description?: string;
  personality?: string;
  notes?: string;
}

// Validate at render time: npcs must be a plain object mapping each name to an
// object whose description/personality/notes fields, when present, are strings.
function parseNpcs(raw: unknown): Array<[string, RosterNpc]> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entries: Array<[string, RosterNpc]> = [];
  for (const [name, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const npc: RosterNpc = {};
    for (const field of ['description', 'personality', 'notes'] as const) {
      const fieldValue = record[field];
      if (fieldValue === undefined) continue;
      if (typeof fieldValue !== 'string') return null;
      npc[field] = fieldValue;
    }
    entries.push([name, npc]);
  }
  return entries;
}

export const NpcRosterResult: Component<ToolResultProps> = (props) => {
  const { t } = useI18n();

  const npcs = () => parseNpcs(props.extra?.npcs);

  const alreadyPromoted = (name: string): boolean => state.characters.some((c) => c.name === name);

  const promote = (name: string, npc: RosterNpc) => {
    if (props.disabled || alreadyPromoted(name)) return;
    bus.send({
      type: 'character.create',
      data: {
        name,
        description: npc.description ?? '',
        personality: npc.personality ?? '',
        creatorNotes: npc.notes ?? '',
        tags: ['npc'],
      },
    });
  };

  return (
    <Show
      when={npcs()}
      fallback={
        <div class={`tool-result-block${props.isError ? ' error' : ''}`}>
          <div class="tool-result-header">
            <i class={`bi ${props.isError ? 'bi-exclamation-triangle' : 'bi-check-circle'}`} />
            {props.isError ? t('tools.error') : t('tools.result')}
          </div>
          <div class="tool-result-content">{props.content}</div>
        </div>
      }
    >
      {(list) => (
        <div class="npc-roster">
          <For each={list()}>
            {([name, npc]) => (
              <div class="npc-roster-item">
                <div class="npc-roster-name">{name}</div>
                <Show when={npc.description}>
                  <div class="npc-roster-field">{npc.description}</div>
                </Show>
                <Show when={npc.personality}>
                  <div class="npc-roster-field">{npc.personality}</div>
                </Show>
                <Show when={npc.notes}>
                  <div class="npc-roster-field">{npc.notes}</div>
                </Show>
                <button
                  type="button"
                  class="btn npc-promote-btn"
                  disabled={props.disabled || alreadyPromoted(name)}
                  onClick={() => promote(name, npc)}
                >
                  {alreadyPromoted(name) ? t('tools.promoted') : t('tools.promoteToCharacter')}
                </button>
              </div>
            )}
          </For>
        </div>
      )}
    </Show>
  );
};
