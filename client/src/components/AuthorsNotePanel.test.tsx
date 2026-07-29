import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@solidjs/testing-library';
import { AuthorsNotePanel } from './AuthorsNotePanel.js';
import { setState } from '../stores/serverStore.js';
import { bus } from '../bus/WebSocketBus.js';

describe('AuthorsNotePanel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setState('activeChat', {
      id: 'chat-1',
      characterId: 'char-1',
      personaId: null,
      name: 'Test Chat',
      headMessageId: null,
      activeChildId: null,
      createdAt: 0,
      updatedAt: 0,
      metadata: {},
      forkedFromChatId: null,
      forkedAtMessageId: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not render when closed', () => {
    render(() => <AuthorsNotePanel open={false} onClose={() => {}} />);
    expect(screen.queryByText("Author's Note")).not.toBeInTheDocument();
  });

  it('renders when open', () => {
    render(() => <AuthorsNotePanel open={true} onClose={() => {}} />);
    expect(screen.getByText("Author's Note")).toBeInTheDocument();
  });

  it('populates from chat metadata', () => {
    setState('activeChat', 'metadata', {
      authorsNote: {
        content: 'Hello there',
        position: 'before_prompt',
        depth: 2,
        role: 'user',
        interval: 3,
      },
    });
    render(() => <AuthorsNotePanel open={true} onClose={() => {}} />);
    const textarea = screen.getByPlaceholderText<HTMLTextAreaElement>("Enter author's note...");
    expect(textarea.value).toBe('Hello there');
  });

  it('uses defaults when no metadata', () => {
    render(() => <AuthorsNotePanel open={true} onClose={() => {}} />);
    const textarea = screen.getByPlaceholderText<HTMLTextAreaElement>("Enter author's note...");
    expect(textarea.value).toBe('');
  });

  it('auto-saves on content change after debounce', () => {
    const sendSpy = vi.spyOn(bus, 'send');
    render(() => <AuthorsNotePanel open={true} onClose={() => {}} />);

    const textarea = screen.getByPlaceholderText<HTMLTextAreaElement>("Enter author's note...");
    fireEvent.input(textarea, { target: { value: 'New note' } });

    expect(sendSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(600);

    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'chat.update',
      chatId: 'chat-1',
      patch: expect.objectContaining({
        metadata: expect.objectContaining({
          authorsNote: expect.objectContaining({ content: 'New note' }),
        }),
      }),
    }));
  });

  it('auto-saves on position change', () => {
    const sendSpy = vi.spyOn(bus, 'send');
    render(() => <AuthorsNotePanel open={true} onClose={() => {}} />);

    const select = document.querySelector('select') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'before_prompt' } });

    vi.advanceTimersByTime(600);
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'chat.update',
      patch: expect.objectContaining({
        metadata: expect.objectContaining({
          authorsNote: expect.objectContaining({ position: 'before_prompt' }),
        }),
      }),
    }));
  });

  it('shows depth and role fields for in_chat position', () => {
    render(() => <AuthorsNotePanel open={true} onClose={() => {}} />);
    expect(screen.getByLabelText('Depth')).toBeInTheDocument();
    expect(screen.getByLabelText('Role')).toBeInTheDocument();
  });

  it('hides depth and role fields for before_prompt position', () => {
    setState('activeChat', 'metadata', {
      authorsNote: { content: '', position: 'before_prompt', depth: 4, role: 'system', interval: 1 },
    });
    render(() => <AuthorsNotePanel open={true} onClose={() => {}} />);
    expect(screen.queryByLabelText('Depth')).not.toBeInTheDocument();
  });

  it('shows saved indicator after save', () => {
    render(() => <AuthorsNotePanel open={true} onClose={() => {}} />);
    const textarea = screen.getByPlaceholderText<HTMLTextAreaElement>("Enter author's note...");
    fireEvent.input(textarea, { target: { value: 'x' } });
    vi.advanceTimersByTime(600);
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });

  it('calls onClose when close button clicked', () => {
    const onClose = vi.fn();
    render(() => <AuthorsNotePanel open={true} onClose={onClose} />);
    screen.getByText('Close').click();
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onClose when backdrop clicked', () => {
    const onClose = vi.fn();
    render(() => <AuthorsNotePanel open={true} onClose={onClose} />);
    const overlay = document.querySelector('.modal-overlay');
    overlay?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onClose).toHaveBeenCalled();
  });
});
