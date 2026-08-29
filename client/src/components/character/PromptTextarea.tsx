import { createSignal, Show, onMount } from 'solid-js';
import { useI18n } from '../../i18n/index.js';
import { Modal } from '../Modal.js';

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
  /** Stable selector hook for e2e/user tooling, applied to the textarea. */
  testId?: string;
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
        data-testid={props.testId}
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
  let areaRef: HTMLTextAreaElement | undefined;

  onMount(() => {
    areaRef?.focus();
  });

  return (
    <Modal
      title={props.label}
      onClose={props.onClose}
      class="modal expanded-text-modal"
      ariaLabel={props.label}
      showCloseButton
    >
      <textarea
        class="textarea-input expanded-textarea"
        ref={areaRef}
        value={props.value}
        onInput={(e) => props.onInput(e.currentTarget.value)}
      />
    </Modal>
  );
}
