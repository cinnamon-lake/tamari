import { For, Show } from 'solid-js';
import type { Component } from 'solid-js';
import type { ToolResultProps } from './index.js';
import { bus } from '../../bus/WebSocketBus.js';
import { state } from '../../stores/serverStore.js';
import { useI18n } from '../../i18n/index.js';
import './ChoicesResult.css';

export const ChoicesResult: Component<ToolResultProps> = (props) => {
  const { t } = useI18n();

  // Validate at render time: choices must be an array of non-empty strings.
  const choices = (): string[] | null => {
    const raw = props.extra?.choices;
    if (!Array.isArray(raw) || raw.length === 0) return null;
    if (raw.some((c) => typeof c !== 'string' || c.length === 0)) return null;
    return raw as string[];
  };

  const prompt = (): string | null => {
    const p = props.extra?.choicesPrompt;
    return typeof p === 'string' && p.length > 0 ? p : null;
  };

  const pick = (choice: string) => {
    if (props.disabled) return;
    const chatId = state.activeChat?.id;
    if (!chatId) return;
    // Same intent as MessageInput.send, minus attachments — one
    // atomic message so the pair can't be reordered server-side.
    bus.send({ type: 'action.sendAndGenerate', chatId, content: choice });
  };

  return (
    <Show
      when={choices()}
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
        <div class="choices-result">
          <Show when={prompt()}>
            <div class="choices-prompt">{prompt()}</div>
          </Show>
          <div class="choices-list" role="group" aria-label={t('tools.choices')}>
            <For each={list()}>
              {(choice) => (
                <button
                  type="button"
                  class="btn choice-btn"
                  disabled={props.disabled}
                  onClick={() => pick(choice)}
                >
                  {choice}
                </button>
              )}
            </For>
          </div>
        </div>
      )}
    </Show>
  );
};
