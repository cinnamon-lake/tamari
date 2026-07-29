import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@solidjs/testing-library';
import { QuickReplyBar } from './QuickReplyBar.js';
import { setState } from '../stores/serverStore.js';
import { setActiveChatId } from '../stores/uiStore.js';
import { bus } from '../bus/WebSocketBus.js';
import type { QuickReply } from '@tamari/types';

describe('QuickReplyBar', () => {
  beforeEach(() => {
    setActiveChatId('chat-1');
    setState('settings', { showQuickReplyBar: true });
    setState('activeChat', {
      id: 'chat-1',
      characterId: 'char-1',
      personaId: null,
      name: 'Test',
      headMessageId: null,
      activeChildId: null,
      createdAt: 0,
      updatedAt: 0,
      metadata: {},
      forkedFromChatId: null,
      forkedAtMessageId: null,
    });
    setState('quickReplies', []);
  });

  it('does not render when disabled in settings', () => {
    setState('settings', { showQuickReplyBar: false });
    render(() => <QuickReplyBar />);
    expect(document.querySelector('.quick-reply-bar')).not.toBeInTheDocument();
  });

  it('renders quick reply buttons', () => {
    setState('quickReplies', [
      makeQR({ id: 'qr1', label: 'Greet', scope: 'global', scopeId: '' }),
      makeQR({ id: 'qr2', label: 'Bye', scope: 'chat', scopeId: 'chat-1' }),
    ]);
    render(() => <QuickReplyBar />);
    expect(screen.getByText('Greet')).toBeInTheDocument();
    expect(screen.getByText('Bye')).toBeInTheDocument();
  });

  it('filters by scope', () => {
    setState('quickReplies', [
      makeQR({ id: 'qr1', label: 'Global', scope: 'global', scopeId: '' }),
      makeQR({ id: 'qr2', label: 'OtherChat', scope: 'chat', scopeId: 'chat-99' }),
      makeQR({ id: 'qr3', label: 'Character', scope: 'character', scopeId: 'char-1' }),
    ]);
    render(() => <QuickReplyBar />);
    expect(screen.getByText('Global')).toBeInTheDocument();
    expect(screen.queryByText('OtherChat')).not.toBeInTheDocument();
    expect(screen.getByText('Character')).toBeInTheDocument();
  });

  it('clicking button sends quickreply.execute', () => {
    const sendSpy = vi.spyOn(bus, 'send');
    setState('quickReplies', [makeQR({ id: 'qr1', label: 'Hi', scope: 'global', scopeId: '' })]);
    render(() => <QuickReplyBar />);
    screen.getByText('Hi').click();
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'quickreply.execute',
      id: 'qr1',
      chatId: 'chat-1',
    }));
  });

  it('right-click opens editor', () => {
    setState('quickReplies', [makeQR({ id: 'qr1', label: 'Hi', scope: 'global', scopeId: '' })]);
    render(() => <QuickReplyBar />);
    const btn = screen.getByText('Hi');
    btn.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    expect(document.querySelector('.qr-modal')).toBeInTheDocument();
  });

  it('shows add button', () => {
    render(() => <QuickReplyBar />);
    expect(screen.getByTitle('Add Quick Reply')).toBeInTheDocument();
  });

  it('clicking add opens editor for new QR', () => {
    render(() => <QuickReplyBar />);
    screen.getByTitle('Add Quick Reply').click();
    expect(document.querySelector('.qr-modal')).toBeInTheDocument();
    expect(screen.getByText('New Quick Reply')).toBeInTheDocument();
  });

  it('shows legacy warning for non-lua QRs', () => {
    setState('quickReplies', [makeQR({ id: 'qr1', label: 'Old', language: 'javascript', scope: 'global', scopeId: '' })]);
    render(() => <QuickReplyBar />);
    expect(screen.getByText('⚠')).toBeInTheDocument();
  });

  function makeQR(overrides: Partial<QuickReply>): QuickReply {
    return {
      id: 'qr-1',
      scope: 'global',
      scopeId: '',
      label: 'Test',
      icon: '',
      color: '',
      script: '',
      language: 'lua',
      autoExecute: 0,
      orderIndex: 0,
      createdAt: 0,
      updatedAt: 0,
      ...overrides,
    };
  }
});
