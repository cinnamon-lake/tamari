import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@solidjs/testing-library';
import { GreetingsEditor } from './GreetingsEditor.js';

describe('GreetingsEditor', () => {
  it('renders the label and one textarea per item', () => {
    render(() => <GreetingsEditor label="Alternate greetings" items={['Hello', 'Hi there']} onChange={() => {}} />);
    expect(screen.getByText('Alternate greetings')).toBeInTheDocument();
    const textareas = document.querySelectorAll<HTMLTextAreaElement>('.greeting-textarea');
    expect(textareas).toHaveLength(2);
    expect(textareas[0]!.value).toBe('Hello');
    expect(textareas[1]!.value).toBe('Hi there');
  });

  it('renders no rows for an empty list, but keeps the add button', () => {
    render(() => <GreetingsEditor label="Greetings" items={[]} onChange={() => {}} />);
    expect(document.querySelectorAll('.greeting-row')).toHaveLength(0);
    expect(screen.getByText('Add greeting')).toBeInTheDocument();
  });

  it('editing a textarea calls onChange with the updated array', () => {
    const onChange = vi.fn();
    render(() => <GreetingsEditor label="Greetings" items={['one', 'two']} onChange={onChange} />);

    const textareas = document.querySelectorAll<HTMLTextAreaElement>('.greeting-textarea');
    fireEvent.input(textareas[1]!, { target: { value: 'two edited' } });

    expect(onChange).toHaveBeenCalledWith(['one', 'two edited']);
  });

  it('remove button calls onChange without the removed item', () => {
    const onChange = vi.fn();
    render(() => <GreetingsEditor label="Greetings" items={['a', 'b', 'c']} onChange={onChange} />);

    const removeButtons = screen.getAllByRole('button', { name: 'Remove' });
    expect(removeButtons).toHaveLength(3);
    fireEvent.click(removeButtons[1]!);

    expect(onChange).toHaveBeenCalledWith(['a', 'c']);
  });

  it('add button appends an empty greeting', () => {
    const onChange = vi.fn();
    render(() => <GreetingsEditor label="Greetings" items={['a']} onChange={onChange} />);

    fireEvent.click(screen.getByText('Add greeting'));

    expect(onChange).toHaveBeenCalledWith(['a', '']);
  });
});
