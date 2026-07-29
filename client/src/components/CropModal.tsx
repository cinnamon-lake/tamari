import { onCleanup, onMount } from 'solid-js';
import Cropper from 'cropperjs';
import 'cropperjs/dist/cropper.css';
import { useI18n } from '../i18n/index.js';
import { trapFocus, saveFocus, restoreFocus } from '../lib/focusUtils.js';

export interface CropModalProps {
  imageUrl: string;
  aspectRatio?: number;
  onConfirm: (blob: Blob) => void;
  onCancel: () => void;
}

export function CropModal(props: CropModalProps) {
  const { t } = useI18n();
  let imageRef: HTMLImageElement | undefined;
  let cropper: Cropper | undefined;

  onMount(() => {
    saveFocus();
    if (imageRef) {
      cropper = new Cropper(imageRef, {
        aspectRatio: props.aspectRatio ?? 1,
        viewMode: 1,
        autoCropArea: 0.9,
        responsive: true,
        guides: true,
        background: false,
      });
    }
  });

  onCleanup(() => {
    cropper?.destroy();
  });

  const cancel = () => {
    restoreFocus();
    props.onCancel();
  };

  const handleConfirm = () => {
    if (!cropper) return;
    const canvas = cropper.getCroppedCanvas({
      maxWidth: 512,
      maxHeight: 512,
    });
    canvas.toBlob((blob) => {
      if (blob) {
        restoreFocus();
        props.onConfirm(blob);
      }
    }, 'image/png');
  };

  return (
    <div class="modal-overlay" onClick={cancel}>
      <div class="modal crop-modal" role="dialog" aria-modal="true" onKeyDown={(e) => trapFocus(e.currentTarget, e)} onClick={(e) => e.stopPropagation()}>
        <h3 class="crop-modal-title">{t('crop.title')}</h3>
        <div class="crop-container">
          <img ref={imageRef} src={props.imageUrl} alt={t('crop.previewAlt')} class="cropper-preview" />
        </div>
        <div class="modal-actions">
          <button class="crop-modal-cancel-btn" onClick={cancel} type="button">
            {t('common.cancel')}
          </button>
          <button onClick={handleConfirm} type="button" class="primary">
            {t('crop.apply')}
          </button>
        </div>
      </div>
    </div>
  );
}
