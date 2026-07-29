import { For, Show, createMemo } from 'solid-js';
import { state } from '../stores/serverStore.js';
import { setActiveCharacterId, setSelectedCharacterId } from '../stores/uiStore.js';
import { SafeImage } from './SafeImage.js';
import './HotswapBar.css';
import { useI18n } from '../i18n/index.js';

const MAX_RECENT = 8;

export function HotswapBar() {
  const { t } = useI18n();
  const recentCharacters = createMemo(() => {
    if (!state.settings['showHotswapBar']) return [];

    const chatByCharacter = new Map<string, number>();
    for (const chat of state.chats) {
      if (!chat.characterId) continue;
      const current = chatByCharacter.get(chat.characterId) ?? 0;
      if (chat.updatedAt > current) {
        chatByCharacter.set(chat.characterId, chat.updatedAt);
      }
    }

    return state.characters
      .filter((c) => chatByCharacter.has(c.id))
      .map((c) => ({ character: c, updatedAt: chatByCharacter.get(c.id) ?? 0 }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_RECENT)
      .map((entry) => entry.character);
  });

  const selectCharacter = (characterId: string) => {
    setActiveCharacterId(characterId);
    setSelectedCharacterId(characterId);
  };

  return (
    <Show when={recentCharacters().length > 0}>
      <div class="hotswap-bar" role="toolbar" aria-label={t('hotswap.toolbarLabel')}>
        <For each={recentCharacters()}>
          {(char) => (
            <button
              type="button"
              class="hotswap-item"
              onClick={() => selectCharacter(char.id)}
              title={char.name}
              aria-label={t('hotswap.openCharacter', { name: char.name })}
            >
              <SafeImage
                class="hotswap-avatar"
                src={(char.thumbnailUrl ?? char.avatarUrl) ?? undefined}
                alt=""
                loading="lazy"
              />
              <span class="hotswap-name">{char.name}</span>
            </button>
          )}
        </For>
      </div>
    </Show>
  );
}
