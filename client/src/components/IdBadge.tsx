/**
 * IdBadge — shows an entity's full UUID in small monospace; click to copy.
 * Exists so users can reference entities by id in chat ("fix backend abloob…").
 *
 * `iconOnly` renders just the copy icon (id moves to the tooltip) — for dense
 * spots like card headers where a full badge would crowd the layout.
 */
import { createSignal } from 'solid-js';
import { useI18n } from '../i18n/index.js';
import './IdBadge.css';

export function IdBadge(props: { id: string; iconOnly?: boolean }) {
  const { t } = useI18n();
  const [copied, setCopied] = createSignal(false);

  const copy = async (e: MouseEvent) => {
    // Never trigger a surrounding clickable region (e.g. an expandable header).
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(props.id);
    } catch {
      // Clipboard API unavailable (insecure context, permissions) — fall back.
      const ta = document.createElement('textarea');
      ta.value = props.id;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const label = () => (props.iconOnly ? `${t('common.copyId')}: ${props.id}` : t('common.copyId'));

  return (
    <button
      type="button"
      class={`id-badge${copied() ? ' copied' : ''}${props.iconOnly ? ' icon-only' : ''}`}
      onClick={copy}
      title={label()}
      aria-label={label()}
    >
      <i class={`bi ${copied() ? 'bi-check-lg' : 'bi-clipboard'}`} />
      {!props.iconOnly && <span class="id-badge-value">{copied() ? t('common.copied') : props.id}</span>}
    </button>
  );
}
