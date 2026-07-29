import { describe, it, expect, beforeEach } from 'vitest';
import { render } from '@solidjs/testing-library';
import { SafeImage } from './SafeImage.js';
import { clearAuthToken, setAuthToken } from '../lib/auth.js';

function getImg(): HTMLImageElement {
  return document.querySelector('img') as HTMLImageElement;
}

describe('SafeImage', () => {
  beforeEach(() => {
    clearAuthToken();
  });

  it('renders img with src', () => {
    render(() => <SafeImage src="http://example.com/img.png" alt="Test" />);
    const img = getImg();
    expect(img.src).toBe('http://example.com/img.png');
    expect(img.alt).toBe('Test');
  });

  it('does not render when src is undefined', () => {
    render(() => <SafeImage src={undefined} />);
    expect(document.querySelector('img')).not.toBeInTheDocument();
  });

  it('applies custom class', () => {
    render(() => <SafeImage src="/img.png" class="my-class" />);
    expect(getImg()).toHaveClass('my-class');
  });

  it('sets loading attribute', () => {
    render(() => <SafeImage src="/img.png" loading="lazy" />);
    expect(getImg()).toHaveAttribute('loading', 'lazy');
  });

  it('authenticates /api/ URLs with token', () => {
    setAuthToken('abc123');
    render(() => <SafeImage src="/api/characters/1/avatar" />);
    expect(getImg().src).toContain('token=abc123');
  });

  it('authenticates /files/ URLs with token', () => {
    setAuthToken('abc123');
    render(() => <SafeImage src="/files/image.png" />);
    expect(getImg().src).toContain('token=abc123');
  });

  it('does not modify external URLs', () => {
    setAuthToken('abc123');
    render(() => <SafeImage src="http://example.com/img.png" />);
    expect(getImg().src).toBe('http://example.com/img.png');
  });

  it('hides image on error', () => {
    render(() => <SafeImage src="/broken.png" />);
    getImg().dispatchEvent(new Event('error'));
    expect(document.querySelector('img')).not.toBeInTheDocument();
  });
});
