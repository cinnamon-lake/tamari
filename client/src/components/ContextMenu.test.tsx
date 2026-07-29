import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@solidjs/testing-library';
import { ContextMenu } from './ContextMenu.js';

describe('ContextMenu', () => {
  it('renders menu items', () => {
    const items = [
      { label: 'Edit', onClick: vi.fn() },
      { label: 'Delete', onClick: vi.fn(), danger: true },
    ];
    const { container } = render(() => <ContextMenu x={100} y={200} items={items} onClose={vi.fn()} />);

    // Action dropdowns are plain divs of buttons — no menu/menuitem roles (AGENTS.md §10).
    expect(container.querySelector('.context-menu')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  it('calls item onClick and closes when an item is clicked', () => {
    const onClick = vi.fn();
    const onClose = vi.fn();
    const items = [{ label: 'Edit', onClick }];

    render(() => <ContextMenu x={0} y={0} items={items} onClose={onClose} />);
    screen.getByRole('button', { name: 'Edit' }).click();

    expect(onClick).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on Escape key', () => {
    const onClose = vi.fn();
    render(() => <ContextMenu x={0} y={0} items={[{ label: 'Edit', onClick: vi.fn() }]} onClose={onClose} />);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on click outside', () => {
    const onClose = vi.fn();
    render(() => <ContextMenu x={0} y={0} items={[{ label: 'Edit', onClick: vi.fn() }]} onClose={onClose} />);

    fireEvent.click(document.body);
    expect(onClose).toHaveBeenCalled();
  });

  it('does not close when clicking inside the menu', () => {
    const onClose = vi.fn();
    const { container } = render(() => <ContextMenu x={0} y={0} items={[{ label: 'Edit', onClick: vi.fn() }]} onClose={onClose} />);

    const menu = container.querySelector('.context-menu');
    expect(menu).toBeInTheDocument();
    if (menu) fireEvent.click(menu);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('applies danger styling to danger items', () => {
    render(() => (
      <ContextMenu x={0} y={0} items={[{ label: 'Delete', onClick: vi.fn(), danger: true }]} onClose={vi.fn()} />
    ));

    expect(screen.getByRole('button', { name: 'Delete' })).toHaveClass('danger');
  });
});
