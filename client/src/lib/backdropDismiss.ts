export interface BackdropDismissHandlers {
  onMouseDown: (e: MouseEvent) => void;
  onClick: (e: MouseEvent) => void;
}

/**
 * Overlay handlers for "click outside to close" that tolerate selection drags.
 *
 * A plain `onClick={close}` on the overlay also fires when a press that *started
 * inside the dialog* is released over the backdrop (text selection dragging past
 * the edge): the browser dispatches the click on the nearest common ancestor,
 * which is the overlay itself. Tracking where the mousedown originated avoids
 * that, while `detail === 0` keeps programmatic `.click()` dismissal working —
 * e.g. the app-wide Escape handler, and keyboard-driven activation clicks, which
 * all report a zero click count.
 */
export function createBackdropDismiss(onDismiss: () => void): BackdropDismissHandlers {
  let pressStartedOnBackdrop = false;

  return {
    onMouseDown: (e) => {
      pressStartedOnBackdrop = e.target === e.currentTarget;
    },
    onClick: (e) => {
      if (e.target === e.currentTarget && (pressStartedOnBackdrop || e.detail === 0)) {
        onDismiss();
      }
      pressStartedOnBackdrop = false;
    },
  };
}
