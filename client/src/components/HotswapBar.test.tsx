import { describe, it, expect, beforeEach } from 'vitest';
import { reconcile } from 'solid-js/store';
import type { AppSettings } from '@tamari/types';
import { render, screen } from '@solidjs/testing-library';
import { HotswapBar } from './HotswapBar.js';
import { setState } from '../stores/serverStore.js';
import { setActiveChatId, setSelectedCharacterId } from '../stores/uiStore.js';

describe('HotswapBar', () => {
  beforeEach(() => {
    setState('characters', []);
    setState('chats', []);
    setState('settings', { showHotswapBar: true });
    setState('activeChat', null);
    setActiveChatId(null);
    setSelectedCharacterId(null);
  });

  function makeChar(id: string, name: string) {
    return {
      id,
      name,
      tags: [],
      avatarPath: null,
      avatarThumbnailPath: null,
      avatarUrl: `/api/characters/${id}/avatar`,
      firstMes: '',
      alternateGreetings: [],
      updatedAt: Date.now(),
      createdAt: Date.now(),
    };
  }

  function makeChat(id: string, characterId: string, name: string, updatedAt = Date.now()) {
    return {
      id,
      name,
      characterId,
      personaId: null,
      headMessageId: null,
      activeChildId: null,
      createdAt: updatedAt,
      updatedAt,
      metadata: {},
      forkedFromChatId: null,
      forkedAtMessageId: null,
    };
  }

  it('renders recently used characters sorted by latest chat', () => {
    const now = Date.now();
    setState('characters', [
      makeChar('c1', 'Alice'),
      makeChar('c2', 'Bob'),
      makeChar('c3', 'Charlie'),
    ]);
    setState('chats', [
      makeChat('ch1', 'c1', 'Chat 1', now - 1000),
      makeChat('ch2', 'c2', 'Chat 2', now),
    ]);

    render(() => <HotswapBar />);
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.queryByText('Charlie')).not.toBeInTheDocument();
  });

  it('renders nothing when setting is disabled', () => {
    setState('settings', { showHotswapBar: false });
    setState('characters', [makeChar('c1', 'Alice')]);
    setState('chats', [makeChat('ch1', 'c1', 'Chat 1')]);

    render(() => <HotswapBar />);
    expect(screen.queryByText('Alice')).not.toBeInTheDocument();
  });

  it('renders by default when the setting is unset', () => {
    setState('settings', reconcile({} as AppSettings));
    setState('characters', [makeChar('c1', 'Alice')]);
    setState('chats', [makeChat('ch1', 'c1', 'Chat 1')]);

    render(() => <HotswapBar />);
    expect(screen.getByText('Alice')).toBeInTheDocument();
  });

  it('selects character when clicked', () => {
    setState('characters', [makeChar('c1', 'Alice')]);
    setState('chats', [makeChat('ch1', 'c1', 'Chat 1')]);

    render(() => <HotswapBar />);
    screen.getByLabelText('Open Alice').click();

    expect(setSelectedCharacterId).toBeDefined();
  });
});
