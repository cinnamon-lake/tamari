import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@solidjs/testing-library';
import { CropModal } from './CropModal.js';
import Cropper from 'cropperjs';

vi.mock('cropperjs', () => ({
  __esModule: true,
  default: vi.fn(),
}));

describe('CropModal', () => {
  let mockInstance: { destroy: ReturnType<typeof vi.fn>; getCroppedCanvas: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockInstance = {
      destroy: vi.fn(),
      getCroppedCanvas: vi.fn().mockReturnValue({
        toBlob: vi.fn((cb: (blob: Blob | null) => void) => {
          cb(new Blob(['cropped'], { type: 'image/png' }));
        }),
      }),
    };
    (Cropper as any).mockImplementation(function () {
      return mockInstance;
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders crop preview image', () => {
    render(() => <CropModal imageUrl="http://example.com/img.png" onConfirm={() => {}} onCancel={() => {}} />);
    const img = document.querySelector('img') as HTMLImageElement;
    expect(img).toBeInTheDocument();
    expect(img.src).toBe('http://example.com/img.png');
    expect(img.alt).toBe('Crop preview');
  });

  it('initializes Cropper on mount', () => {
    render(() => <CropModal imageUrl="http://example.com/img.png" onConfirm={() => {}} onCancel={() => {}} />);
    expect(Cropper).toHaveBeenCalled();
    const call = (Cropper as any).mock.calls[0];
    expect(call[1]).toMatchObject({
      aspectRatio: 1,
      viewMode: 1,
      autoCropArea: 0.9,
    });
  });

  it('uses custom aspect ratio', () => {
    render(() => (
      <CropModal imageUrl="http://example.com/img.png" aspectRatio={16 / 9} onConfirm={() => {}} onCancel={() => {}} />
    ));
    const call = (Cropper as any).mock.calls[0];
    expect(call[1].aspectRatio).toBe(16 / 9);
  });

  it('calls onCancel when cancel button clicked', () => {
    const onCancel = vi.fn();
    render(() => <CropModal imageUrl="http://example.com/img.png" onConfirm={() => {}} onCancel={onCancel} />);
    screen.getByText('Cancel').click();
    expect(onCancel).toHaveBeenCalled();
  });

  it('calls onCancel when overlay clicked', () => {
    const onCancel = vi.fn();
    const { container } = render(() => <CropModal imageUrl="http://example.com/img.png" onConfirm={() => {}} onCancel={onCancel} />);
    const overlay = container.querySelector('.modal-overlay')!;
    fireEvent.click(overlay);
    expect(onCancel).toHaveBeenCalled();
  });

  it('calls onConfirm with cropped blob when apply clicked', () => {
    const onConfirm = vi.fn();
    render(() => <CropModal imageUrl="http://example.com/img.png" onConfirm={onConfirm} onCancel={() => {}} />);
    screen.getByText('Apply').click();

    expect(mockInstance.getCroppedCanvas).toHaveBeenCalledWith({
      maxWidth: 512,
      maxHeight: 512,
    });
    expect(onConfirm).toHaveBeenCalled();
    const blob = onConfirm.mock.calls[0]![0] as Blob;
    expect(blob.type).toBe('image/png');
  });

  it('does not call onConfirm if toBlob returns null', () => {
    mockInstance.getCroppedCanvas.mockReturnValue({
      toBlob: vi.fn((cb: (blob: Blob | null) => void) => cb(null)),
    });
    const onConfirm = vi.fn();
    render(() => <CropModal imageUrl="http://example.com/img.png" onConfirm={onConfirm} onCancel={() => {}} />);
    screen.getByText('Apply').click();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
