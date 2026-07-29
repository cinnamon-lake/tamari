import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@solidjs/testing-library';
import { ChatHeader } from './ChatHeader.js';
import { setState } from '../stores/serverStore.js';
import { setChatSearchQuery } from '../stores/uiStore.js';
import { bus } from '../bus/WebSocketBus.js';
import * as popupStore from '../stores/popupStore.js';

describe('ChatHeader', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setState('activeChat', null);
    setState('chatCharacter', null);
    setChatSearchQuery('');
  });

  it('shows placeholder when no active chat', () => {
    render(() => <ChatHeader />);
    expect(document.querySelector('.chat-header-placeholder')).toBeInTheDocument();
  });

  it('shows chat name as title when no character', () => {
    setState('activeChat', { id: 'chat-1', name: 'My Chat' } as any);
    render(() => <ChatHeader />);
    expect(screen.getByText('My Chat')).toBeInTheDocument();
  });

  it('shows character name as title when character is present', () => {
    setState('activeChat', { id: 'chat-1', name: 'My Chat', characterId: 'char-1' } as any);
    setState('chatCharacter', { id: 'char-1', name: 'Alice' } as any);
    render(() => <ChatHeader />);
    expect(screen.getByText('Alice')).toBeInTheDocument();
  });

  it('shows chat name as subtitle when character is present', () => {
    setState('activeChat', { id: 'chat-1', name: 'My Chat', characterId: 'char-1' } as any);
    setState('chatCharacter', { id: 'char-1', name: 'Alice' } as any);
    render(() => <ChatHeader />);
    expect(screen.getByText('My Chat')).toBeInTheDocument();
  });

  it('toggles search input', () => {
    setState('activeChat', { id: 'chat-1', name: 'Chat' } as any);
    render(() => <ChatHeader />);

    const searchBtn = screen.getByTitle('Search messages');
    expect(document.querySelector('.chat-search')).not.toBeInTheDocument();

    searchBtn.click();
    expect(document.querySelector('.chat-search')).toBeInTheDocument();

    searchBtn.click();
    expect(document.querySelector('.chat-search')).not.toBeInTheDocument();
  });

  it('opens and closes menu', () => {
    setState('activeChat', { id: 'chat-1', name: 'Chat' } as any);
    render(() => <ChatHeader />);

    const menuBtn = screen.getByTitle('Menu');
    expect(document.querySelector('.dropdown-menu')).not.toBeInTheDocument();

    menuBtn.click();
    expect(document.querySelector('.dropdown-menu')).toBeInTheDocument();

    menuBtn.click();
    expect(document.querySelector('.dropdown-menu')).not.toBeInTheDocument();
  });

  it('sends chat.delete when delete is confirmed', async () => {
    vi.spyOn(popupStore, 'confirmPopup').mockResolvedValue(true);
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});

    setState('activeChat', { id: 'chat-1', name: 'Chat' } as any);
    render(() => <ChatHeader />);

    screen.getByTitle('Menu').click();
    screen.getByText('Delete chat').click();

    await new Promise((r) => setTimeout(r, 10));

    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'chat.delete',
      chatId: 'chat-1',
    }));
  });

  it('does not delete when popup is cancelled', async () => {
    vi.spyOn(popupStore, 'confirmPopup').mockResolvedValue(false);
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});

    setState('activeChat', { id: 'chat-1', name: 'Chat' } as any);
    render(() => <ChatHeader />);

    screen.getByTitle('Menu').click();
    screen.getByText('Delete chat').click();

    await new Promise((r) => setTimeout(r, 10));

    expect(sendSpy).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'chat.delete' }));
  });

  it('exports chat JSONL', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});

    setState('activeChat', {
      id: 'chat-1',
      name: 'Chat',
      jsonlExportUrl: '/api/chats/chat-1/export.jsonl',
    } as any);
    render(() => <ChatHeader />);

    screen.getByTitle('Menu').click();
    screen.getByText('Export JSONL').click();

    expect(openSpy).toHaveBeenCalled();
    sendSpy.mockRestore();
  });

  it('exports chat TXT', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

    setState('activeChat', {
      id: 'chat-1',
      name: 'Chat',
      txtExportUrl: '/api/chats/chat-1/export.txt',
    } as any);
    render(() => <ChatHeader />);

    screen.getByTitle('Menu').click();
    screen.getByText('Export TXT').click();

    expect(openSpy).toHaveBeenCalled();
  });

  it('opens Authors Note panel', () => {
    setState('activeChat', { id: 'chat-1', name: 'Chat' } as any);
    render(() => <ChatHeader />);

    screen.getByTitle('Menu').click();
    screen.getByText("Author's Note").click();

    expect(screen.getByText("Author's Note")).toBeInTheDocument();
  });

  it('opens Checkpoints panel', () => {
    setState('activeChat', { id: 'chat-1', name: 'Chat' } as any);
    render(() => <ChatHeader />);

    screen.getByTitle('Menu').click();
    screen.getByText('Checkpoints').click();

    expect(screen.getByText('Checkpoints')).toBeInTheDocument();
  });
});
