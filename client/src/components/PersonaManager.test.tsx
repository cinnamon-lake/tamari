import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@solidjs/testing-library';
import { PersonaManager } from './PersonaManager.js';
import { setState } from '../stores/serverStore.js';
import { bus } from '../bus/WebSocketBus.js';
import * as popupStore from '../stores/popupStore.js';
import { vi as vitest } from 'vitest';

function makePersona() {
  return {
    id: 'p1',
    name: 'Alice',
    description: 'Test desc',
    avatarPath: null,
    avatarThumbnailPath: null,
    avatarUrl: null,
    thumbnailUrl: null,
    avatarUploadUrl: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

function simulateSnapshot() {
  setState('activePersona', makePersona());
}

describe('PersonaManager', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setState('personas', []);
    setState('activeChat', null);
    setState('activePersona', null);
  });

  it('sends persona.list on mount', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    render(() => <PersonaManager onClose={() => {}} />);
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'persona.list' }));
  });

  it('renders persona list', () => {
    setState('personas', [
      { id: 'p1', name: 'Alice', description: 'Friendly AI' },
      { id: 'p2', name: 'Bob', description: 'Grumpy AI' },
    ]);
    render(() => <PersonaManager onClose={() => {}} />);
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  it('shows selected indicator for current chat persona', () => {
    setState('activeChat', { id: 'chat-1', personaId: 'p1' } as any);
    setState('personas', [{ id: 'p1', name: 'Alice', description: '' }]);
    render(() => <PersonaManager onClose={() => {}} />);
    // The check icon should be present
    expect(document.querySelector('.bi-check-circle-fill')).toBeInTheDocument();
  });

  it('selects persona for chat', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    setState('activeChat', { id: 'chat-1' } as any);
    setState('personas', [{ id: 'p1', name: 'Alice', description: '' }]);
    render(() => <PersonaManager onClose={() => {}} />);
    screen.getByText('Alice').click();
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'chat.update',
      chatId: 'chat-1',
      patch: { personaId: 'p1' },
    }));
  });

  it('does not select persona when no active chat', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    setState('personas', [{ id: 'p1', name: 'Alice', description: '' }]);
    render(() => <PersonaManager onClose={() => {}} />);
    screen.getByText('Alice').click();
    expect(sendSpy).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'chat.update' }));
  });

  it('creates new persona', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    render(() => <PersonaManager onClose={() => {}} />);
    screen.getByText('New Persona').click();
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'persona.create',
      data: { name: 'New Persona', description: '' },
    }));
  });

  it('opens editor when edit clicked', () => {
    setState('personas', [{ id: 'p1', name: 'Alice', description: 'Test desc' }]);
    render(() => <PersonaManager onClose={() => {}} />);
    screen.getByTitle('Edit').click();
    simulateSnapshot();
    expect(screen.getByDisplayValue('Alice')).toBeInTheDocument();
  });

  it('calls onClose when overlay clicked', () => {
    const onClose = vi.fn();
    const { container } = render(() => <PersonaManager onClose={onClose} />);
    const overlay = container.querySelector('.modal-overlay')!;
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalled();
  });

  describe('PersonaEditor', () => {
    beforeEach(() => {
      setState('personas', [{ id: 'p1', name: 'Alice', description: 'Test desc' }]);
    });

    it('renders name and description inputs', () => {
      render(() => <PersonaManager onClose={() => {}} />);
      screen.getByTitle('Edit').click();
      simulateSnapshot();
      expect(screen.getByDisplayValue('Alice')).toBeInTheDocument();
      expect(screen.getByDisplayValue('Test desc')).toBeInTheDocument();
    });

    it('auto-saves after debounce', async () => {
      vi.useFakeTimers();
      const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
      render(() => <PersonaManager onClose={() => {}} />);
      screen.getByTitle('Edit').click();
      simulateSnapshot();

      const nameInput = screen.getByDisplayValue('Alice');
      fireEvent.input(nameInput, { target: { value: 'Alicia' } });

      expect(sendSpy).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'persona.update' }));

      vitest.advanceTimersByTime(700);

      expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
        type: 'persona.update',
        personaId: 'p1',
        patch: { name: 'Alicia', description: 'Test desc' },
      }));
      vi.useRealTimers();
    });

    it('shows saved indicator after save', async () => {
      vi.useFakeTimers();
      vi.spyOn(bus, 'send').mockImplementation(() => {});
      render(() => <PersonaManager onClose={() => {}} />);
      screen.getByTitle('Edit').click();
      simulateSnapshot();

      const nameInput = screen.getByDisplayValue('Alice');
      fireEvent.input(nameInput, { target: { value: 'Alicia' } });
      vitest.advanceTimersByTime(700);

      expect(screen.getByText('Saved')).toBeInTheDocument();
      vi.useRealTimers();
    });

    it('goes back to list', () => {
      render(() => <PersonaManager onClose={() => {}} />);
      screen.getByTitle('Edit').click();
      simulateSnapshot();
      screen.getByText('Back').click();
      expect(screen.getByText('Personas')).toBeInTheDocument();
    });

    it('deletes persona when confirmed', async () => {
      vi.spyOn(popupStore, 'confirmPopup').mockResolvedValue(true);
      const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
      render(() => <PersonaManager onClose={() => {}} />);
      screen.getByTitle('Edit').click();
      simulateSnapshot();
      screen.getByText('Delete').click();
      await new Promise((r) => setTimeout(r, 10));
      expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
        type: 'persona.delete',
        personaId: 'p1',
      }));
    });
  });
});
