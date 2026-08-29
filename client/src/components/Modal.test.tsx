import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@solidjs/testing-library';
import { Modal } from './Modal.js';

describe('Modal', () => {
  it('renders the overlay and dialog with default classes', () => {
    const { container } = render(() => (
      <Modal title="Hello" ariaLabel="Hello dialog" onClose={() => {}}>
        <p>body</p>
      </Modal>
    ));
    const overlay = container.querySelector('.modal-overlay')!;
    expect(overlay).toBeInTheDocument();
    const dialog = overlay.querySelector('.modal')!;
    expect(dialog).toHaveAttribute('role', 'dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-label', 'Hello dialog');
    expect(dialog.querySelector('h2.modal-title')).toHaveTextContent('Hello');
  });

  it('uses aria-labelledby (and no aria-label) when titleId is set', () => {
    const { container } = render(() => (
      <Modal title="Labelled" titleId="my-title" onClose={() => {}}>
        <p>body</p>
      </Modal>
    ));
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog).toHaveAttribute('aria-labelledby', 'my-title');
    expect(dialog).not.toHaveAttribute('aria-label');
    expect(dialog.querySelector('#my-title')).toHaveTextContent('Labelled');
  });

  it('omits aria-label when neither titleId nor ariaLabel is given', () => {
    const { container } = render(() => (
      <Modal title="Plain" onClose={() => {}}>
        <p>body</p>
      </Modal>
    ));
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog).not.toHaveAttribute('aria-label');
    expect(dialog).not.toHaveAttribute('aria-labelledby');
  });

  it('supports class/overlayClass/titleAs/titleClass overrides', () => {
    const { container } = render(() => (
      <Modal
        title="Custom"
        onClose={() => {}}
        overlayClass="group-panel-overlay"
        class="group-panel"
        titleAs="h3"
        titleClass="panel-title"
      >
        <p>body</p>
      </Modal>
    ));
    expect(container.querySelector('.group-panel-overlay')).toBeInTheDocument();
    const dialog = container.querySelector('.group-panel')!;
    expect(dialog.querySelector('h3.panel-title')).toHaveTextContent('Custom');
  });

  it('spreads extra attributes onto the dialog element', () => {
    const { container } = render(() => (
      <Modal title="Data" onClose={() => {}} data-form-loaded="true">
        <p>body</p>
      </Modal>
    ));
    expect(container.querySelector('[role="dialog"]')).toHaveAttribute('data-form-loaded', 'true');
  });

  it('renders a header row with a working close button when showCloseButton is set', () => {
    const onClose = vi.fn();
    const { container } = render(() => (
      <Modal
        title="Closable"
        ariaLabel="Closable"
        onClose={onClose}
        showCloseButton
        headerExtras={<span class="extra">x</span>}
      >
        <p>body</p>
      </Modal>
    ));
    const header = container.querySelector('.modal-header-row')!;
    expect(header.querySelector('h2.modal-title')).toHaveTextContent('Closable');
    expect(header.querySelector('.extra')).toBeInTheDocument();
    screen.getByRole('button', { name: 'Close' }).click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on backdrop mousedown+click but not on clicks inside the dialog', () => {
    const onClose = vi.fn();
    const { container } = render(() => (
      <Modal title="Backdrop" ariaLabel="Backdrop" onClose={onClose}>
        <button type="button">inner</button>
      </Modal>
    ));
    const overlay = container.querySelector('.modal-overlay')!;
    fireEvent.click(screen.getByRole('button', { name: 'inner' }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(overlay);
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(() => (
      <Modal title="Esc" ariaLabel="Esc" onClose={onClose}>
        <p>body</p>
      </Modal>
    ));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape closes only the topmost of stacked modals', () => {
    const onCloseA = vi.fn();
    const onCloseB = vi.fn();
    render(() => (
      <>
        <Modal title="A" ariaLabel="A" onClose={onCloseA}>
          <p>a</p>
        </Modal>
        <Modal title="B" ariaLabel="B" onClose={onCloseB}>
          <p>b</p>
        </Modal>
      </>
    ));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCloseB).toHaveBeenCalledTimes(1);
    expect(onCloseA).not.toHaveBeenCalled();
  });

  it('restores focus to the pre-modal element on unmount', async () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const { unmount } = render(() => (
      <Modal title="Focus" ariaLabel="Focus" onClose={() => {}}>
        <p>body</p>
      </Modal>
    ));
    unmount();
    // restoreFocus defers to the next animation frame.
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});
