import { Index } from 'solid-js';
import { useI18n } from '../../i18n/index.js';

/**
 * Shared list editor for greeting variants (alternate greetings, group-only
 * greetings): one auto-sized textarea per entry, remove per row, add at the
 * bottom. Used twice by the character editor — keep the two call sites
 * identical.
 */

export interface GreetingsEditorProps {
  label: string;
  items: string[];
  onChange: (next: string[]) => void;
}

export function GreetingsEditor(props: GreetingsEditorProps) {
  const { t } = useI18n();

  const setItem = (idx: number, value: string) => {
    const next = [...props.items];
    next[idx] = value;
    props.onChange(next);
  };

  const removeItem = (idx: number) => {
    props.onChange(props.items.filter((_, i) => i !== idx));
  };

  return (
    <div class="greetings-editor">
      <span class="tag-label">{props.label}</span>
      <Index each={props.items}>
        {(greeting, idx) => (
          <div class="greeting-row">
            <textarea
              class="greeting-textarea"
              rows={2}
              value={greeting()}
              onInput={(e) => setItem(idx, e.currentTarget.value)}
            />
            <button
              class="icon-btn small"
              onClick={() => removeItem(idx)}
              title={t('character.removeGreeting')}
              aria-label={t('character.removeGreeting')}
              type="button"
            >
              <i class="bi bi-x" />
            </button>
          </div>
        )}
      </Index>
      <button class="text-btn" onClick={() => props.onChange([...props.items, ''])} type="button">
        <i class="bi bi-plus-lg" /> {t('character.addGreeting')}
      </button>
    </div>
  );
}
