import { For, Show, onCleanup, onMount } from 'solid-js';
import './ContextMenu.css';

export interface ContextMenuItem {
  label: string;
  icon?: string;
  onClick: () => void;
  danger?: boolean;
}

export interface ContextMenuProps {
  items: ContextMenuItem[];
  x: number;
  y: number;
  onClose: () => void;
}

export function ContextMenu(props: ContextMenuProps) {
  let menuRef: HTMLDivElement | undefined;

  onMount(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (!menuRef?.contains(e.target as Node)) {
        props.onClose();
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
    };

    document.addEventListener('click', onClickOutside);
    document.addEventListener('keydown', onKeyDown);

    onCleanup(() => {
      document.removeEventListener('click', onClickOutside);
      document.removeEventListener('keydown', onKeyDown);
    });
  });

  const handleClick = (item: ContextMenuItem) => {
    item.onClick();
    props.onClose();
  };

  // A dropdown of action buttons is a plain <div> — no role="menu", which would
  // obligate arrow-key navigation (AGENTS.md §10).
  return (
    <div
      ref={menuRef}
      class="context-menu"
      style={{ left: `${props.x}px`, top: `${props.y}px` }}
    >
      <For each={props.items}>
        {(item) => (
          <button
            type="button"
            class={`context-menu-item ${item.danger ? 'danger' : ''}`}
            onClick={() => handleClick(item)}
          >
            <Show when={item.icon}>
              <i class={`bi bi-${item.icon}`} />
            </Show>
            <span class="context-menu-item-label">{item.label}</span>
          </button>
        )}
      </For>
    </div>
  );
}
