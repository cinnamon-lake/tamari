import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@solidjs/testing-library';
import { GroupChatPanel } from './GroupChatPanel.js';
import { setState } from '../stores/serverStore.js';
import { bus } from '../bus/WebSocketBus.js';
import * as popupStore from '../stores/popupStore.js';

describe('GroupChatPanel', () => {
  const chatId = 'group-chat-1';

  beforeEach(() => {
    vi.restoreAllMocks();
    setState('chatMembers', {});
    setState('characters', []);
    setState('activeChat', null);
  });

  function makeMember(chatId: string, charId: string, enabled = true, talkativeness = 1.0, name?: string) {
    return {
      chatId,
      characterId: charId,
      enabled,
      talkativeness,
      depthPrompt: '',
      depthPromptDepth: 0,
      characterName: name ?? charId,
      characterAvatarUrl: null,
      characterThumbnailUrl: null,
    };
  }

  function makeChar(id: string, name: string) {
    return { id, name, tags: [], avatarPath: null, avatarThumbnailPath: null, avatarUrl: `/api/characters/${id}/avatar`, thumbnailUrl: undefined, firstMes: '', alternateGreetings: [], createdAt: Date.now(), updatedAt: Date.now() };
  }

  it('renders empty state when no members', () => {
    setState('chatMembers', { [chatId]: [] });
    render(() => <GroupChatPanel chatId={chatId} onClose={() => {}} />);
    expect(screen.getByText('No members in this group yet.')).toBeInTheDocument();
  });

  it('renders member list with character info', () => {
    setState('chatMembers', {
      [chatId]: [{ ...makeMember('m1', 'char-1', true, 1.0, 'Alice'), characterThumbnailUrl: '/files/char1-thumb.png' }],
    });
    render(() => <GroupChatPanel chatId={chatId} onClose={() => {}} />);

    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeInTheDocument();
  });

  it('renders characterName from member data directly', () => {
    setState('chatMembers', { [chatId]: [makeMember('m1', 'char-99', true, 1.0, 'Unknown Hero')] });
    render(() => <GroupChatPanel chatId={chatId} onClose={() => {}} />);
    expect(screen.getByText('Unknown Hero')).toBeInTheDocument();
  });

  it('toggles member enabled state', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    setState('chatMembers', { [chatId]: [makeMember('m1', 'char-1', true)] });
    setState('characters', [makeChar('char-1', 'Alice')]);
    render(() => <GroupChatPanel chatId={chatId} onClose={() => {}} />);

    const checkbox = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
    checkbox.click();

    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'group.member.update',
      chatId,
      characterId: 'char-1',
      patch: { enabled: false },
    }));
  });

  it('updates talkativeness', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    setState('chatMembers', { [chatId]: [makeMember('m1', 'char-1', true, 1.5)] });
    setState('characters', [makeChar('char-1', 'Alice')]);
    render(() => <GroupChatPanel chatId={chatId} onClose={() => {}} />);

    const range = document.querySelector('input[type="range"]') as HTMLInputElement;
    fireEvent.change(range, { target: { value: '2.5' } });

    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'group.member.update',
      chatId,
      characterId: 'char-1',
      patch: { talkativeness: 2.5 },
    }));
  });

  it('removes member when confirmed', async () => {
    vi.spyOn(popupStore, 'confirmPopup').mockResolvedValue(true);
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    setState('chatMembers', { [chatId]: [makeMember('m1', 'char-1')] });
    setState('characters', [makeChar('char-1', 'Alice')]);
    render(() => <GroupChatPanel chatId={chatId} onClose={() => {}} />);

    screen.getByTitle('Remove member').click();
    await new Promise((r) => setTimeout(r, 10));

    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'group.member.remove',
      chatId,
      characterId: 'char-1',
    }));
  });

  it('does not remove member when cancelled', async () => {
    vi.spyOn(popupStore, 'confirmPopup').mockResolvedValue(false);
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    setState('chatMembers', { [chatId]: [makeMember('m1', 'char-1')] });
    setState('characters', [makeChar('char-1', 'Alice')]);
    render(() => <GroupChatPanel chatId={chatId} onClose={() => {}} />);

    screen.getByTitle('Remove member').click();
    await new Promise((r) => setTimeout(r, 10));

    expect(sendSpy).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'group.member.remove' }));
  });

  it('sends group.member.add when selecting character', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    setState('chatMembers', { [chatId]: [] });
    setState('characters', [makeChar('char-1', 'Alice')]);
    render(() => <GroupChatPanel chatId={chatId} onClose={() => {}} />);

    screen.getByText('Add Member').click();
    const addSelect = document.querySelector('option[value=""]')!.closest('select')!;
    addSelect.value = 'char-1';
    fireEvent.change(addSelect, { target: { value: 'char-1' } });

    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'group.member.add',
      chatId,
      characterId: 'char-1',
    }));
  });

  it('updates activation strategy', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    setState('activeChat', {
      id: chatId,
      metadata: { groupChatSettings: { activationStrategy: 'NATURAL' } },
    } as any);
    render(() => <GroupChatPanel chatId={chatId} onClose={() => {}} />);

    const selects = document.querySelectorAll('select');
    const strategySelect = Array.from(selects).find((s) =>
      s.querySelector('option[value="NATURAL"]')
    ) as HTMLSelectElement;

    fireEvent.change(strategySelect, { target: { value: 'MANUAL' } });

    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'chat.update',
      chatId,
      patch: expect.objectContaining({
        metadata: expect.objectContaining({
          groupChatSettings: expect.objectContaining({ activationStrategy: 'MANUAL' }),
        }),
      }),
    }));
  });

  it('calls onClose when close button clicked', () => {
    const onClose = vi.fn();
    render(() => <GroupChatPanel chatId={chatId} onClose={onClose} />);
    screen.getByLabelText('Close').click();
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onClose when overlay clicked', () => {
    const onClose = vi.fn();
    const { container } = render(() => <GroupChatPanel chatId={chatId} onClose={onClose} />);
    const overlay = container.querySelector('.group-panel-overlay')!;
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalled();
  });
});
