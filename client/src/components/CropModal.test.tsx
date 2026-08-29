import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@solidjs/testing-library';
import { CropModal } from './CropModal.js';
import Cropper from 'cropperjs';

vi.mock('cropperjs', () => ({
  __esModule: true,
  default: vi.fn(),
}));

describe('CropModal', () => {
  let mockCanvas: { toBlob: ReturnType<typeof vi.fn> };
  let mockSelection: { width: number; height: number; $toCanvas: ReturnType<typeof vi.fn> };
  let mockInstance: { destroy: ReturnType<typeof vi.fn>; getCropperSelection: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockCanvas = {
      toBlob: vi.fn((cb: (blob: Blob | null) => void) => {
        cb(new Blob(['cropped'], { type: 'image/png' }));
      }),
    };
    mockSelection = {
      width: 1000,
      height: 500,
      $toCanvas: vi.fn().mockResolvedValue(mockCanvas),
    };
    mockInstance = {
      destroy: vi.fn(),
      getCropperSelection: vi.fn().mockReturnValue(mockSelection),
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
    expect(call[1].template).toContain('initial-coverage="0.9"');
    expect(call[1].template).toContain('aspect-ratio="1"');
  });

  it('uses custom aspect ratio', () => {
    render(() => (
      <CropModal imageUrl="http://example.com/img.png" aspectRatio={16 / 9} onConfirm={() => {}} onCancel={() => {}} />
    ));
    const call = (Cropper as any).mock.calls[0];
    expect(call[1].template).toContain(`aspect-ratio="${16 / 9}"`);
  });

  it('calls onCancel when cancel button clicked', () => {
    const onCancel = vi.fn();
    render(() => <CropModal imageUrl="http://example.com/img.png" onConfirm={() => {}} onCancel={onCancel} />);
    screen.getByText('Cancel').click();
    expect(onCancel).toHaveBeenCalled();
  });

  it('calls onCancel when overlay clicked', () => {
    const onCancel = vi.fn();
    const { container } = render(() => (
      <CropModal imageUrl="http://example.com/img.png" onConfirm={() => {}} onCancel={onCancel} />
    ));
    const overlay = container.querySelector('.modal-overlay')!;
    fireEvent.click(overlay);
    expect(onCancel).toHaveBeenCalled();
  });

  it('calls onConfirm with cropped blob when apply clicked', async () => {
    const onConfirm = vi.fn();
    render(() => <CropModal imageUrl="http://example.com/img.png" onConfirm={onConfirm} onCancel={() => {}} />);
    screen.getByText('Apply').click();

    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    expect(mockSelection.$toCanvas).toHaveBeenCalledWith({
      width: 512,
      height: 256,
    });
    const blob = onConfirm.mock.calls[0]![0] as Blob;
    expect(blob.type).toBe('image/png');
  });

  it('does not upscale small selections', async () => {
    mockSelection.width = 200;
    mockSelection.height = 100;
    const onConfirm = vi.fn();
    render(() => <CropModal imageUrl="http://example.com/img.png" onConfirm={onConfirm} onCancel={() => {}} />);
    screen.getByText('Apply').click();

    await waitFor(() => expect(mockSelection.$toCanvas).toHaveBeenCalled());
    expect(mockSelection.$toCanvas).toHaveBeenCalledWith({
      width: 200,
      height: 100,
    });
  });

  it('does not call onConfirm if toBlob returns null', async () => {
    mockCanvas.toBlob.mockImplementation((cb: (blob: Blob | null) => void) => cb(null));
    const onConfirm = vi.fn();
    render(() => <CropModal imageUrl="http://example.com/img.png" onConfirm={onConfirm} onCancel={() => {}} />);
    screen.getByText('Apply').click();

    await waitFor(() => expect(mockSelection.$toCanvas).toHaveBeenCalled());
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
