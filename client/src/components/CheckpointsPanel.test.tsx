import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen } from '@solidjs/testing-library';
import { CheckpointsPanel } from './CheckpointsPanel.js';
import { setState } from '../stores/serverStore.js';
import { bus } from '../bus/WebSocketBus.js';
import * as popupStore from '../stores/popupStore.js';

describe('CheckpointsPanel', () => {
  beforeEach(() => {
    setState('activeChat', {
      id: 'chat-1',
      characterId: 'char-1',
      personaId: null,
      name: 'Main Chat',
      headMessageId: 5,
      activeChildId: null,
      createdAt: 1000,
      updatedAt: 1000,
      metadata: {},
      forkedFromChatId: null,
      forkedAtMessageId: null,
    });
    setState('chats', []);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not render when closed', () => {
    render(() => <CheckpointsPanel open={false} onClose={() => {}} />);
    expect(screen.queryByText('Checkpoints')).not.toBeInTheDocument();
  });

  it('renders when open', () => {
    render(() => <CheckpointsPanel open={true} onClose={() => {}} />);
    expect(screen.getByText('Checkpoints')).toBeInTheDocument();
  });

  it('shows empty state when no checkpoints', () => {
    render(() => <CheckpointsPanel open={true} onClose={() => {}} />);
    expect(screen.getByText('No checkpoints for this chat.')).toBeInTheDocument();
  });

  it('lists checkpoints for active chat', () => {
    setState('chats', [
      makeChat({ id: 'cp-1', name: 'Checkpoint A', forkedFromChatId: 'chat-1', forkedAtMessageId: 3, createdAt: 2000 }),
      makeChat({ id: 'cp-2', name: 'Checkpoint B', forkedFromChatId: 'chat-1', forkedAtMessageId: 5, createdAt: 3000 }),
    ]);
    render(() => <CheckpointsPanel open={true} onClose={() => {}} />);
    expect(screen.getByText('Checkpoint A')).toBeInTheDocument();
    expect(screen.getByText('Checkpoint B')).toBeInTheDocument();
  });

  it('create checkpoint sends chat.softFork', () => {
    const sendSpy = vi.spyOn(bus, 'send');
    render(() => <CheckpointsPanel open={true} onClose={() => {}} />);
    screen.getByText('Create Checkpoint').click();
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'chat.softFork',
      chatId: 'chat-1',
      messageId: 5,
      name: 'Main Chat (checkpoint)',
    }));
  });

  it('restore checkpoint sends chat.select', () => {
    const sendSpy = vi.spyOn(bus, 'send');
    const onClose = vi.fn();
    setState('chats', [
      makeChat({ id: 'cp-1', name: 'Checkpoint A', forkedFromChatId: 'chat-1', forkedAtMessageId: 3 }),
    ]);
    render(() => <CheckpointsPanel open={true} onClose={onClose} />);
    screen.getByTitle('Restore').click();
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'chat.select',
      chatId: 'cp-1',
      limit: 30,
    }));
    expect(onClose).toHaveBeenCalled();
  });

  it('delete checkpoint sends chat.delete', async () => {
    vi.spyOn(popupStore, 'confirmPopup').mockResolvedValue(true);
    const sendSpy = vi.spyOn(bus, 'send');
    setState('chats', [
      makeChat({ id: 'cp-1', name: 'Checkpoint A', forkedFromChatId: 'chat-1', forkedAtMessageId: 3 }),
    ]);
    render(() => <CheckpointsPanel open={true} onClose={() => {}} />);
    screen.getByTitle('Delete').click();
    // Wait for async confirmPopup mock
    await new Promise((r) => setTimeout(r, 10));
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'chat.delete',
      chatId: 'cp-1',
    }));
  });

  it('calls onClose when close button clicked', () => {
    const onClose = vi.fn();
    render(() => <CheckpointsPanel open={true} onClose={onClose} />);
    screen.getByText('Close').click();
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onClose when backdrop clicked', () => {
    const onClose = vi.fn();
    render(() => <CheckpointsPanel open={true} onClose={onClose} />);
    const overlay = document.querySelector('.modal-overlay');
    overlay?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onClose).toHaveBeenCalled();
  });

  function makeChat(overrides: Partial<import('@tamari/types').Chat> = {}): import('@tamari/types').Chat {
    return {
      id: 'chat-1',
      characterId: null,
      personaId: null,
      name: 'Test',
      headMessageId: null,
      activeChildId: null,
      materialized: false,
      createdAt: 0,
      updatedAt: 0,
      metadata: {},
      forkedFromChatId: null,
      forkedAtMessageId: null,
      ...overrides,
    };
  }
});
