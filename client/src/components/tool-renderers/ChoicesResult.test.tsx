import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@solidjs/testing-library';
import { ChoicesResult } from './ChoicesResult.js';
import { setState } from '../../stores/serverStore.js';
import { bus } from '../../bus/WebSocketBus.js';

describe('ChoicesResult', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setState('activeChat', null);
  });

  const validExtra = {
    renderType: 'choices',
    choicesPrompt: 'What do you do?',
    choices: ['Open the door', 'Sneak around', 'Turn back'],
  };

  it('renders the prompt and one button per choice', () => {
    render(() => <ChoicesResult content="Presented 3 choices" extra={validExtra} />);
    expect(screen.getByText('What do you do?')).toBeInTheDocument();
    const buttons = document.querySelectorAll('.choice-btn');
    expect(buttons).toHaveLength(3);
    expect(screen.getByText('Open the door')).toBeInTheDocument();
    expect(screen.getByText('Sneak around')).toBeInTheDocument();
    expect(screen.getByText('Turn back')).toBeInTheDocument();
  });

  it('renders without a prompt when choicesPrompt is empty', () => {
    render(() => (
      <ChoicesResult content="Presented 2 choices" extra={{ renderType: 'choices', choicesPrompt: '', choices: ['Left', 'Right'] }} />
    ));
    expect(document.querySelector('.choices-prompt')).not.toBeInTheDocument();
    expect(document.querySelectorAll('.choice-btn')).toHaveLength(2);
  });

  it('sends one atomic action.sendAndGenerate with the choice on click', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    setState('activeChat', { id: 'chat-1' } as any);
    render(() => <ChoicesResult content="Presented 3 choices" extra={validExtra} />);

    fireEvent.click(screen.getByText('Sneak around'));

    expect(sendSpy).toHaveBeenNthCalledWith(1, {
      type: 'action.sendAndGenerate',
      chatId: 'chat-1',
      content: 'Sneak around',
    });
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('does not send when disabled', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    setState('activeChat', { id: 'chat-1' } as any);
    render(() => <ChoicesResult content="Presented 3 choices" extra={validExtra} disabled />);

    const btn = screen.getByText('Open the door');
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('does not send without an active chat', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    render(() => <ChoicesResult content="Presented 3 choices" extra={validExtra} />);

    fireEvent.click(screen.getByText('Open the door'));
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('falls back to plain content when choices are malformed', () => {
    render(() => (
      <ChoicesResult content="Presented 2 choices: Left, Right" extra={{ renderType: 'choices', choices: ['Left', ''] }} />
    ));
    expect(document.querySelectorAll('.choice-btn')).toHaveLength(0);
    expect(screen.getByText('Presented 2 choices: Left, Right')).toBeInTheDocument();
  });

  it('falls back to plain content when choices is not an array', () => {
    render(() => <ChoicesResult content="some content" extra={{ renderType: 'choices', choices: 'nope' }} />);
    expect(document.querySelectorAll('.choice-btn')).toHaveLength(0);
    expect(screen.getByText('some content')).toBeInTheDocument();
  });
});
