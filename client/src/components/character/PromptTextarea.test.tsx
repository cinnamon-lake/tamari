import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@solidjs/testing-library';
import { PromptTextarea } from './PromptTextarea.js';

describe('PromptTextarea', () => {
  it('renders the label and forwards input', () => {
    const onInput = vi.fn();
    render(() => <PromptTextarea label="Description" value="hello" onInput={onInput} />);

    expect(screen.getByText('Description')).toBeInTheDocument();
    const area = screen.getByDisplayValue('hello');
    fireEvent.input(area, { target: { value: 'hello world' } });
    expect(onInput).toHaveBeenCalledWith('hello world');
  });

  it('opens the expanded modal, edits there, and closes it', () => {
    const onInput = vi.fn();
    render(() => <PromptTextarea label="Description" value="draft" onInput={onInput} />);

    // Expand
    screen.getByRole('button', { name: 'Expand editor' }).click();
    const dialog = screen.getByRole('dialog', { name: 'Description' });
    expect(dialog).toBeInTheDocument();

    // Edit inside the modal — same onInput channel
    const modalArea = dialog.querySelector('textarea')!;
    fireEvent.input(modalArea, { target: { value: 'draft v2' } });
    expect(onInput).toHaveBeenCalledWith('draft v2');

    // Close via the × button
    screen.getByRole('button', { name: 'Close' }).click();
    expect(screen.queryByRole('dialog', { name: 'Description' })).toBeNull();
  });

  it('closes the expanded modal on Escape', () => {
    render(() => <PromptTextarea label="Scenario" value="x" onInput={() => {}} />);
    screen.getByRole('button', { name: 'Expand editor' }).click();
    const dialog = screen.getByRole('dialog', { name: 'Scenario' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Scenario' })).toBeNull();
  });

  it('hides the expand button when not expandable', () => {
    render(() => <PromptTextarea label="Notes" value="" onInput={() => {}} expandable={false} />);
    expect(screen.queryByRole('button', { name: 'Expand editor' })).toBeNull();
  });
});
