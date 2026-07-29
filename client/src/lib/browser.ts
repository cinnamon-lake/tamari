/**
 * Browser-specific detection and patches ported from the legacy UI.
 */

export function isFirefox(): boolean {
  return /firefox/i.test(navigator.userAgent);
}

export function isMobileSafari(): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigator.platform) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

export function isDesktopSafari(): boolean {
  return navigator.vendor === 'Apple Computer, Inc.' && !/Mobile/.test(navigator.userAgent);
}

export function isSafari(): boolean {
  return isMobileSafari() || isDesktopSafari();
}

export function isMobile(): boolean {
  const coarsePointer = typeof window.matchMedia === 'function'
    ? window.matchMedia('(pointer: coarse)').matches
    : false;
  return (
    coarsePointer ||
    /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
  );
}

function processNode(node: Node): Node {
  if (node.nodeType === Node.ELEMENT_NODE && node.nodeName.toLowerCase() === 'q') {
    const span = document.createElement('span');
    node.childNodes.forEach((child) => {
      span.appendChild(processNode(child));
    });
    return span;
  }
  return node.cloneNode(true);
}

function sanitizeInlineQuotationOnCopy(): void {
  // STRG+C on Firefox leads to duplicate double quotes when inline quotation elements are copied.
  // Transform <q> to <span> before calling toString() on the selection.
  document.addEventListener('copy', (event) => {
    if (
      document.activeElement instanceof HTMLInputElement ||
      document.activeElement instanceof HTMLTextAreaElement
    ) {
      return;
    }

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;

    const anchorNode = selection.anchorNode;
    const anchorEl =
      anchorNode instanceof Element ? anchorNode : anchorNode?.parentElement;
    if (!anchorEl?.closest('.message-content')) return;

    const range = selection.getRangeAt(0).cloneContents();
    const tempDOM = document.createDocumentFragment();

    range.childNodes.forEach((child) => {
      tempDOM.appendChild(processNode(child));
    });

    const newRange = document.createRange();
    newRange.selectNodeContents(tempDOM);

    event.preventDefault();
    event.clipboardData?.setData('text/plain', newRange.toString());
  });
}

function addSafariClass(): void {
  if (isSafari()) {
    document.body.classList.add('safari');
  }
}

function applyMobileViewportFix(): void {
  const fixFunkyPositioning = () => {
    if (isFirefox()) {
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
        // The positioning hack below breaks GBoard candidate replacement
        // in Firefox Mobile on Android.
        return;
      }
    }

    document.documentElement.style.position = 'fixed';
    requestAnimationFrame(() => {
      document.documentElement.style.position = '';
    });
  };

  window.addEventListener('resize', fixFunkyPositioning);
  window.addEventListener('orientationchange', fixFunkyPositioning);
}

/** Apply all browser-specific fixes. Safe to call multiple times. */
export function applyBrowserFixes(): void {
  if (isFirefox()) {
    sanitizeInlineQuotationOnCopy();
  }

  if (isMobile()) {
    applyMobileViewportFix();
  }

  addSafariClass();
}
