import { onCleanup, onMount } from 'solid-js';
import Cropper from 'cropperjs';
import { useI18n } from '../i18n/index.js';
import { Modal } from './Modal.js';

export interface CropModalProps {
  imageUrl: string;
  aspectRatio?: number;
  onConfirm: (blob: Blob) => void;
  onCancel: () => void;
}

/** Longest edge of the exported crop (v1 `getCroppedCanvas({ maxWidth, maxHeight })`). */
const MAX_OUTPUT_SIZE = 512;

export function CropModal(props: CropModalProps) {
  const { t } = useI18n();
  let imageRef: HTMLImageElement | undefined;
  let cropper: Cropper | undefined;

  onMount(() => {
    if (imageRef) {
      // Cropper v2 is configured declaratively through its template (custom
      // elements); there are no viewMode/autoCropArea/guides/background options
      // anymore — the attributes below reproduce them (no checkered background,
      // grid guides on, crop box starting at 90% coverage).
      cropper = new Cropper(imageRef, {
        template: `
          <cropper-canvas>
            <cropper-image rotatable scalable skewable translatable></cropper-image>
            <cropper-shade hidden></cropper-shade>
            <cropper-handle action="select" plain></cropper-handle>
            <cropper-selection initial-coverage="0.9" aspect-ratio="${props.aspectRatio ?? 1}" movable resizable>
              <cropper-grid role="grid" bordered covered></cropper-grid>
              <cropper-crosshair centered></cropper-crosshair>
              <cropper-handle action="move" theme-color="rgba(255, 255, 255, 0.35)"></cropper-handle>
              <cropper-handle action="n-resize"></cropper-handle>
              <cropper-handle action="e-resize"></cropper-handle>
              <cropper-handle action="s-resize"></cropper-handle>
              <cropper-handle action="w-resize"></cropper-handle>
              <cropper-handle action="ne-resize"></cropper-handle>
              <cropper-handle action="nw-resize"></cropper-handle>
              <cropper-handle action="se-resize"></cropper-handle>
              <cropper-handle action="sw-resize"></cropper-handle>
            </cropper-selection>
          </cropper-canvas>
        `,
      });
    }
  });

  onCleanup(() => {
    cropper?.destroy();
  });

  const cancel = () => {
    props.onCancel();
  };

  const handleConfirm = async () => {
    const selection = cropper?.getCropperSelection();
    if (!selection) return;
    // v2 `$toCanvas` takes exact width/height (aspect-fitted); cap at
    // MAX_OUTPUT_SIZE without upscaling, like v1's maxWidth/maxHeight.
    const scale = Math.min(1, MAX_OUTPUT_SIZE / selection.width, MAX_OUTPUT_SIZE / selection.height);
    const canvas = await selection.$toCanvas({
      width: selection.width * scale,
      height: selection.height * scale,
    });
    canvas.toBlob((blob) => {
      if (blob) {
        props.onConfirm(blob);
      }
    }, 'image/png');
  };

  return (
    <Modal title={t('crop.title')} onClose={cancel} class="modal crop-modal" titleAs="h3" titleClass="crop-modal-title">
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
    </Modal>
  );
}
