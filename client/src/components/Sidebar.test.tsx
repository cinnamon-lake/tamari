import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@solidjs/testing-library';
import { Sidebar } from './Sidebar.js';
import { setState } from '../stores/serverStore.js';
import { bus } from '../bus/WebSocketBus.js';
import {
  setActiveChatId,
  setSelectedCharacterId,
  selectedCharacterId,
} from '../stores/uiStore.js';
import * as popupStore from '../stores/popupStore.js';

describe('Sidebar', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        totalCharacters: 0,
        totalChats: 0,
        totalMessages: 0,
        totalGenerations: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        chats: [],
        characters: [],
      }),
    }));
    setState('characters', []);
    setState('chats', []);
    setState('activeChat', null);
    setState('settings', {});
    setActiveChatId(null);
    setSelectedCharacterId(null);
  });

  function makeChar(id: string, name: string, tags: string[] = []) {
    return { id, name, tags, avatarPath: null, avatarThumbnailPath: null, avatarUrl: `/api/characters/${id}/avatar`, firstMes: '', alternateGreetings: [], updatedAt: Date.now(), createdAt: Date.now() };
  }

  function makeChat(id: string, name: string, characterId: string | null, updatedAt = Date.now()) {
    return { id, name, characterId: characterId, personaId: null, headMessageId: null, activeChildId: null, createdAt: updatedAt, updatedAt: updatedAt, metadata: {}, forkedFromChatId: null, forkedAtMessageId: null };
  }

  it('renders logo', () => {
    render(() => <Sidebar />);
    expect(screen.getByText('tamari')).toBeInTheDocument();
  });

  it('renders character list', () => {
    setState('characters', [makeChar('c1', 'Alice'), makeChar('c2', 'Bob')]);
    render(() => <Sidebar />);
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  it('filters characters by search', () => {
    setState('characters', [makeChar('c1', 'Alice'), makeChar('c2', 'Bob')]);
    render(() => <Sidebar />);
    const search = screen.getByPlaceholderText('Search characters...');
    fireEvent.input(search, { target: { value: 'ali' } });
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.queryByText('Bob')).not.toBeInTheDocument();
  });

  it('filters characters by tag', () => {
    setState('characters', [
      makeChar('c1', 'Alice', ['magic']),
      makeChar('c2', 'Bob', ['tech']),
    ]);
    render(() => <Sidebar />);
    screen.getByText('magic').click();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.queryByText('Bob')).not.toBeInTheDocument();
  });

  it('clears tag filters', () => {
    setState('characters', [
      makeChar('c1', 'Alice', ['magic']),
      makeChar('c2', 'Bob', ['tech']),
    ]);
    render(() => <Sidebar />);
    screen.getByText('magic').click();
    expect(screen.queryByText('Bob')).not.toBeInTheDocument();
    screen.getByText('Clear').click();
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  it('sorts characters by name', () => {
    setState('characters', [makeChar('c1', 'Zebra'), makeChar('c2', 'Alice')]);
    render(() => <Sidebar />);
    const select = document.querySelector('select') as HTMLSelectElement;
    select.value = 'name';
    fireEvent.change(select, { target: { value: 'name' } });
    const names = Array.from(document.querySelectorAll('.character-name')).map((n) => n.textContent);
    expect(names).toEqual(['Alice', 'Zebra']);
  });

  it('paginates characters', () => {
    const chars = Array.from({ length: 15 }, (_, i) => makeChar(`c${i}`, `Char ${i}`));
    setState('characters', chars);
    render(() => <Sidebar />);
    expect(screen.getByText('1 / 2')).toBeInTheDocument();
    screen.getByLabelText('Next page').click();
    expect(screen.getByText('2 / 2')).toBeInTheDocument();
  });

  it('selects character and shows character chats', () => {
    vi.spyOn(bus, 'send').mockImplementation(() => {});
    setState('characters', [makeChar('c1', 'Alice')]);
    setState('chats', [makeChat('ch1', 'Chat 1', 'c1')]);
    render(() => <Sidebar />);
    screen.getByText('Alice').click();
    expect(selectedCharacterId()).toBe('c1');
    expect(screen.getByText('Chat 1')).toBeInTheDocument();
  });

  it('shows recent chats when no character selected', () => {
    setState('chats', [
      makeChat('ch1', 'Recent 1', 'c1', Date.now()),
      makeChat('ch2', 'Recent 2', 'c2', Date.now() - 1000),
    ]);
    render(() => <Sidebar />);
    expect(screen.getByText('Recent 1')).toBeInTheDocument();
    expect(screen.getByText('Recent 2')).toBeInTheDocument();
  });

  it('filters chats by search', () => {
    setState('characters', [makeChar('c1', 'Alice')]);
    setState('chats', [makeChat('ch1', 'Morning chat', 'c1'), makeChat('ch2', 'Evening chat', 'c1')]);
    render(() => <Sidebar />);
    screen.getByText('Alice').click();
    const search = screen.getByPlaceholderText('Search chats...');
    fireEvent.input(search, { target: { value: 'morning' } });
    expect(screen.getByText('Morning chat')).toBeInTheDocument();
    expect(screen.queryByText('Evening chat')).not.toBeInTheDocument();
  });

  it('selects chat', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    setState('chats', [makeChat('ch1', 'Chat 1', 'c1')]);
    render(() => <Sidebar />);
    screen.getByText('Chat 1').click();
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'chat.select' }));
  });

  it('sends character.create when create button clicked', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    render(() => <Sidebar />);
    screen.getByTitle('Create character').click();
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'character.create' }));
  });

  it('opens mobile menu', () => {
    render(() => <Sidebar />);
    screen.getByLabelText('Open menu').click();
    expect(document.querySelector('.sidebar.open')).toBeInTheDocument();
  });

  it('closes mobile menu', () => {
    render(() => <Sidebar />);
    screen.getByLabelText('Open menu').click();
    screen.getByLabelText('Close menu').click();
    expect(document.querySelector('.sidebar.open')).not.toBeInTheDocument();
  });

  it('opens persona manager', () => {
    render(() => <Sidebar />);
    const btn = document.querySelector('.sidebar-footer button:first-child') as HTMLButtonElement;
    btn.click();
    expect(document.querySelector('.persona-modal')).toBeInTheDocument();
  });

  it('opens world info editor', () => {
    render(() => <Sidebar />);
    const btns = document.querySelectorAll('.sidebar-footer button');
    (btns[1] as HTMLButtonElement).click();
    expect(document.querySelector('.worldinfo-modal')).toBeInTheDocument();
  });

  it('opens stats modal', () => {
    render(() => <Sidebar />);
    screen.getByText('Stats').click();
    expect(screen.getByText('Statistics')).toBeInTheDocument();
  });

  it('opens backend config modal', () => {
    render(() => <Sidebar />);
    screen.getByText('Backend Config').click();
    expect(document.querySelector('.settings-modal')).toBeInTheDocument();
  });

  it('opens prompt list modal', () => {
    render(() => <Sidebar />);
    screen.getByText('Prompt List').click();
    expect(document.querySelector('.settings-modal')).toBeInTheDocument();
  });

  it('opens settings modal', () => {
    render(() => <Sidebar />);
    screen.getByText('Settings').click();
    expect(document.querySelector('.settings-modal')).toBeInTheDocument();
  });

  it('deletes chat when confirmed', async () => {
    vi.spyOn(popupStore, 'confirmPopup').mockResolvedValue(true);
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    setState('characters', [makeChar('c1', 'Alice')]);
    setState('chats', [makeChat('ch1', 'Chat 1', 'c1')]);
    render(() => <Sidebar />);
    screen.getByText('Alice').click();
    screen.getByTitle('Delete').click();
    await new Promise((r) => setTimeout(r, 10));
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'chat.delete',
      chatId: 'ch1',
    }));
  });

  it('renames chat on enter', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    setState('characters', [makeChar('c1', 'Alice')]);
    setState('chats', [makeChat('ch1', 'Chat 1', 'c1')]);
    render(() => <Sidebar />);
    screen.getByText('Alice').click();
    screen.getByTitle('Rename').click();
    const renameInput = document.querySelector('.chat-rename-input') as HTMLInputElement;
    fireEvent.input(renameInput, { target: { value: 'New Name' } });
    fireEvent.keyDown(renameInput, { key: 'Enter' });
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'chat.update',
      chatId: 'ch1',
      patch: { name: 'New Name' },
    }));
  });

  it('creates group chat', async () => {
    vi.spyOn(popupStore, 'promptPopup').mockResolvedValue('Group Chat');
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    render(() => <Sidebar />);
    screen.getByTitle('New group chat').click();
    await new Promise((r) => setTimeout(r, 10));
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'chat.create',
      data: expect.objectContaining({ characterId: null, name: 'Group Chat' }),
    }));
  });

  it('opens character context menu on right-click', () => {
    setState('characters', [makeChar('c1', 'Alice')]);
    render(() => <Sidebar />);

    const card = screen.getByText('Alice').closest('.character-item') as HTMLElement;
    fireEvent.contextMenu(card);

    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument();
  });
});
