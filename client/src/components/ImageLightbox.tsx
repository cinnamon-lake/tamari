import { lightboxSrc, closeLightbox } from '../stores/lightboxStore.js';
import { Show, onCleanup, onMount } from 'solid-js';
import { useI18n } from '../i18n/index.js';

export function ImageLightbox() {
  const { t } = useI18n();
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeLightbox();
  };

  onMount(() => {
    window.addEventListener('keydown', handleKeyDown);
  });

  onCleanup(() => {
    window.removeEventListener('keydown', handleKeyDown);
  });

  return (
    <Show when={lightboxSrc()}>
      {(src) => (
        <div
          class="lightbox-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeLightbox();
          }}
        >
          <img class="lightbox-img" src={src()} alt="" />
          <button class="lightbox-close" onClick={closeLightbox} type="button" aria-label={t('common.close')}>
            <i class="bi bi-x-lg" />
          </button>
        </div>
      )}
    </Show>
  );
}
