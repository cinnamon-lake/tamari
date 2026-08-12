/**
 * Shared dry-run panel for Lua backend scripts (`custombackend.test`).
 *
 * Used by CustomBackendsModal (Type A registry scripts) and
 * CharacterBackendEditor (Type B card-coupled scripts). Sends the CURRENT,
 * possibly unsaved Lua source — explicit luaSource wins server-side. When
 * `characterId` is set the server additionally weaves that character's
 * description/first message into the sample prompt.
 *
 * The server answers with a sendTo (not broadcast) `custombackend.testResult`
 * carrying our requestId; results with any other requestId are ignored so a
 * racing client can't clobber the panel.
 */

import { createSignal, onCleanup, Show, For } from 'solid-js';
import type { CustomBackendTestOutcome } from '@tamari/types';
import { useI18n } from '../i18n/index.js';
import { bus } from '../bus/WebSocketBus.js';

export interface BackendDryRunPanelProps {
  /** Current editor content (unsaved is fine — sent verbatim). */
  luaSource: string;
  /** Type B only: character whose description/firstMes seed the sample prompt. */
  characterId?: string;
  /** Type B only: the card's module map for the sandboxed require — sent
   *  verbatim (explicit files win server-side over the stored map). */
  files?: Record<string, string>;
}

/** Shared <pre> styling for outcome blobs (wrap long Lua/JSON lines, cap height). */
const PRE_STYLE = {
  'white-space': 'pre-wrap',
  'word-break': 'break-word',
  'max-height': '16rem',
  overflow: 'auto',
  margin: 'var(--space-xs) 0 0',
} as const;

export function BackendDryRunPanel(props: BackendDryRunPanelProps) {
  const { t } = useI18n();
  const [input, setInput] = createSignal('');
  const [stateText, setStateText] = createSignal('');
  const [delegateResponse, setDelegateResponse] = createSignal('');
  const [running, setRunning] = createSignal(false);
  const [pendingRequestId, setPendingRequestId] = createSignal<string | null>(null);
  const [outcome, setOutcome] = createSignal<CustomBackendTestOutcome | null>(null);

  const unsub = bus.on('custombackend.testResult', (msg) => {
    const pending = pendingRequestId();
    if (!pending || msg.requestId !== pending) return;
    setOutcome(msg.outcome);
    setRunning(false);
    setPendingRequestId(null);
  });
  onCleanup(unsub);

  const run = () => {
    const trimmed = input().trim();
    if (!trimmed || running()) return;
    const requestId = crypto.randomUUID();
    setPendingRequestId(requestId);
    setRunning(true);
    setOutcome(null);
    bus.send({
      type: 'custombackend.test',
      luaSource: props.luaSource,
      ...(props.characterId ? { characterId: props.characterId } : {}),
      ...(props.files ? { files: props.files } : {}),
      input: trimmed,
      ...(stateText().trim() ? { state: stateText() } : {}),
      ...(delegateResponse() ? { delegateResponse: delegateResponse() } : {}),
      requestId,
    });
  };

  return (
    <div class="backend-dry-run-panel">
      <h3 class="section-heading">{t('customBackends.testHeading')}</h3>
      <label class="field-label">
        {t('customBackends.testInputLabel')}
        <textarea
          class="textarea font-mono text-sm resize-v"
          rows={2}
          value={input()}
          onInput={(e) => setInput(e.currentTarget.value)}
          placeholder={t('customBackends.testInputPlaceholder')}
        />
      </label>
      <label class="field-label">
        {t('customBackends.testStateLabel')}
        <input
          class="input font-mono"
          value={stateText()}
          onInput={(e) => setStateText(e.currentTarget.value)}
          placeholder={'{"turn": 1}'}
        />
      </label>
      <label class="field-label">
        {t('customBackends.testDelegateLabel')}
        <input
          class="input"
          value={delegateResponse()}
          onInput={(e) => setDelegateResponse(e.currentTarget.value)}
          placeholder={t('customBackends.testDelegatePlaceholder')}
        />
      </label>
      <div class="flex-row-sm mt-sm">
        <button
          class="btn btn-primary primary-btn"
          type="button"
          disabled={running() || !input().trim() || !props.luaSource.trim()}
          onClick={run}
        >
          {running() ? t('customBackends.testRunning') : t('customBackends.testRun')}
        </button>
      </div>

      <Show when={outcome()}>
        {(o) => (
          <div class="backend-dry-run-result">
            <Show when={!o().ok}>
              <p class="hint-text text-danger">{o().error ?? t('customBackends.testFailed')}</p>
            </Show>
            <Show when={o().ok && o().error}>
              <p class="hint-text text-danger">{o().error}</p>
            </Show>
            <Show when={o().text}>
              <span class="text-xs text-muted">{t('customBackends.testOutput')}</span>
              <pre class="font-mono text-sm" style={PRE_STYLE}>{o().text}</pre>
            </Show>
            <Show when={o().reasoning}>
              <span class="text-xs text-muted">{t('customBackends.testReasoning')}</span>
              <pre class="font-mono text-sm" style={PRE_STYLE}>{o().reasoning}</pre>
            </Show>
            <Show when={o().debug}>
              <span class="text-xs text-muted">{t('customBackends.testDebug')}</span>
              <pre class="font-mono text-sm" style={PRE_STYLE}>{o().debug}</pre>
            </Show>
            <p class="text-xs text-muted">
              {t('customBackends.testUsage', {
                prompt: o().usage.promptTokens,
                completion: o().usage.completionTokens,
              })}
            </p>
            <Show when={o().stateOut}>
              <span class="text-xs text-muted">{t('customBackends.testStateOut')}</span>
              <pre class="font-mono text-sm" style={PRE_STYLE}>{o().stateOut}</pre>
              {/* Multi-turn testing: feed the returned state back as the next run's input state. */}
              <button class="text-btn small" type="button" onClick={() => setStateText(o().stateOut ?? '')}>
                {t('customBackends.testFeedState')}
              </button>
            </Show>
            <Show when={o().delegations.length > 0}>
              <span class="text-xs text-muted">
                {t('customBackends.testDelegations', { count: o().delegations.length })}
              </span>
              <For each={o().delegations}>
                {(d) => (
                  <details>
                    <summary class="text-sm">
                      {d.configId ?? t('customBackends.testDelegateDefaultId')} — {d.promptPreview}
                    </summary>
                    <pre class="font-mono text-sm" style={PRE_STYLE}>{d.response}</pre>
                  </details>
                )}
              </For>
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
}
