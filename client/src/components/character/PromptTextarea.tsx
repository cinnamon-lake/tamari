import { createSignal, Show, onMount } from 'solid-js';
import { useI18n } from '../../i18n/index.js';
import { trapFocus } from '../../lib/focusUtils.js';

/**
 * Labeled, auto-growing textarea for long-form card fields (description,
 * scenario, …). Grows with content up to half the viewport, and offers an
 * expand button that opens the field in a large modal for serious editing.
 */

export interface PromptTextareaProps {
  label: string;
  value: string;
  onInput: (value: string) => void;
  /** Initial visible rows before autogrow kicks in. Default 3. */
  rows?: number;
  /** Show the expand-to-modal button. Default true. */
  expandable?: boolean;
}

/** Grow a textarea to fit its content, capped at half the viewport height. */
function autoGrow(el: HTMLTextAreaElement): void {
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.5))}px`;
}

export function PromptTextarea(props: PromptTextareaProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = createSignal(false);
  let areaRef: HTMLTextAreaElement | undefined;

  onMount(() => {
    if (areaRef) autoGrow(areaRef);
  });

  return (
    <label class="field-label prompt-textarea">
      <span class="prompt-textarea-label">
        {props.label}
        <Show when={props.expandable ?? true}>
          <button
            class="icon-btn small prompt-expand-btn"
            type="button"
            title={t('character.expandEditor')}
            aria-label={t('character.expandEditor')}
            onClick={(e) => {
              e.preventDefault();
              setExpanded(true);
            }}
          >
            <i class="bi bi-arrows-angle-expand" />
          </button>
        </Show>
      </span>
      <textarea
        class="textarea-input autogrow"
        rows={props.rows ?? 3}
        ref={areaRef}
        value={props.value}
        onInput={(e) => {
          autoGrow(e.currentTarget);
          props.onInput(e.currentTarget.value);
        }}
      />
      <Show when={expanded()}>
        <ExpandedTextModal
          label={props.label}
          value={props.value}
          onInput={props.onInput}
          onClose={() => setExpanded(false)}
        />
      </Show>
    </label>
  );
}

interface ExpandedTextModalProps {
  label: string;
  value: string;
  onInput: (value: string) => void;
  onClose: () => void;
}

function ExpandedTextModal(props: ExpandedTextModalProps) {
  const { t } = useI18n();
  let areaRef: HTMLTextAreaElement | undefined;

  onMount(() => {
    areaRef?.focus();
  });

  return (
    <div class="modal-overlay" onClick={props.onClose}>
      <div
        class="modal expanded-text-modal"
        role="dialog"
        aria-modal="true"
        aria-label={props.label}
        onKeyDown={(e) => {
          if (e.key === 'Escape') props.onClose();
          else trapFocus(e.currentTarget, e);
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div class="modal-header-row">
          <h2 class="modal-title">{props.label}</h2>
          <button class="icon-btn" onClick={props.onClose} title={t('common.close')} aria-label={t('common.close')} type="button">
            <i class="bi bi-x-lg" />
          </button>
        </div>
        <textarea
          class="textarea-input expanded-textarea"
          ref={areaRef}
          value={props.value}
          onInput={(e) => props.onInput(e.currentTarget.value)}
        />
      </div>
    </div>
  );
}
