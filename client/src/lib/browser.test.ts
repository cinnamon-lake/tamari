import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isFirefox, isSafari, isMobile, applyBrowserFixes } from './browser.js';

beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
});

describe('browser detection', () => {
  let originalUA: string;
  let originalPlatform: string;
  let originalVendor: string;

  beforeEach(() => {
    originalUA = navigator.userAgent;
    originalPlatform = navigator.platform;
    originalVendor = navigator.vendor;
  });

  afterEach(() => {
    vi.stubGlobal('navigator', {
      ...navigator,
      userAgent: originalUA,
      platform: originalPlatform,
      vendor: originalVendor,
      maxTouchPoints: 0,
    });
  });

  it('detects Firefox', () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
      platform: 'Win32',
    });
    expect(isFirefox()).toBe(true);
  });

  it('does not detect Firefox in Chrome UA', () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      platform: 'Win32',
    });
    expect(isFirefox()).toBe(false);
  });

  it('detects desktop Safari', () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      platform: 'MacIntel',
      vendor: 'Apple Computer, Inc.',
    });
    expect(isSafari()).toBe(true);
  });

  it('detects mobile Safari by platform', () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      platform: 'iPhone',
    });
    expect(isSafari()).toBe(true);
  });

  it('does not detect Safari in Chrome UA', () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      platform: 'MacIntel',
      vendor: 'Google Inc.',
    });
    expect(isSafari()).toBe(false);
  });

  it('detects mobile via pointer media query', () => {
    const matchMediaSpy = vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: true,
      media: '(pointer: coarse)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } as unknown as MediaQueryList);

    expect(isMobile()).toBe(true);
    expect(matchMediaSpy).toHaveBeenCalledWith('(pointer: coarse)');

    matchMediaSpy.mockRestore();
  });
});

describe('applyBrowserFixes', () => {
  beforeEach(() => {
    document.body.className = '';
    vi.stubGlobal('navigator', {
      ...navigator,
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      platform: 'MacIntel',
      vendor: 'Apple Computer, Inc.',
      maxTouchPoints: 0,
    });
  });

  it('adds safari class to body when Safari is detected', () => {
    applyBrowserFixes();
    expect(document.body).toHaveClass('safari');
  });
});

function createCopyEvent(clipboardData?: { setData: ReturnType<typeof vi.fn>; getData: ReturnType<typeof vi.fn> }): Event {
  const event = new Event('copy', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: clipboardData,
    configurable: true,
  });
  return event;
}

describe('Firefox copy sanitization', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.stubGlobal('navigator', {
      ...navigator,
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
      platform: 'Win32',
    });
  });

  it('replaces <q> with <span> in copied text from message content', () => {
    applyBrowserFixes();

    const message = document.createElement('div');
    message.className = 'message-content';
    message.innerHTML = '<p>He said <q>hello</q> to me.</p>';
    document.body.appendChild(message);

    const selection = window.getSelection();
    if (!selection) throw new Error('No selection');
    selection.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(message);
    selection.addRange(range);

    const clipboardData = {
      setData: vi.fn(),
      getData: vi.fn(),
    };
    const copyEvent = createCopyEvent(clipboardData);
    const preventDefaultSpy = vi.spyOn(copyEvent, 'preventDefault');

    document.dispatchEvent(copyEvent);

    expect(preventDefaultSpy).toHaveBeenCalled();
    expect(clipboardData.setData).toHaveBeenCalledWith('text/plain', 'He said hello to me.');
  });

  it('does not intercept copy when selection is outside message content', () => {
    applyBrowserFixes();

    const unrelated = document.createElement('div');
    unrelated.innerHTML = '<p>He said <q>hello</q> to me.</p>';
    document.body.appendChild(unrelated);

    const selection = window.getSelection();
    if (!selection) throw new Error('No selection');
    selection.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(unrelated);
    selection.addRange(range);

    const copyEvent = createCopyEvent();
    const preventDefaultSpy = vi.spyOn(copyEvent, 'preventDefault');

    document.dispatchEvent(copyEvent);

    expect(preventDefaultSpy).not.toHaveBeenCalled();
  });
});
