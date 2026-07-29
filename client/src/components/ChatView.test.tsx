import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@solidjs/testing-library';
import { getVisibleMessages, ChatView } from './ChatView.js';
import { setState } from '../stores/serverStore.js';
import { setChatSearchQuery, setActiveChatId } from '../stores/uiStore.js';
import { bus } from '../bus/WebSocketBus.js';
import type { Message, Chat } from '@tamari/types';

function makeMsg(id: number, text: string, extra?: Record<string, unknown>): Message {
  return {
    id,
    parentId: null,
    role: 'assistant',
    extra: { parts: [{ type: 'text', text }], ...(extra ?? {}) },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    renderedHtml: `<p>${text}</p>`,
  };
}

function makeChat(overrides?: Partial<Chat>): Chat {
  return {
    id: 'chat-1',
    name: 'Test Chat',
    characterId: 'char-1',
    personaId: null,
    headMessageId: null,
    activeChildId: null,
    materialized: true,
    metadata: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as Chat;
}

describe('ChatView', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setState('activeChat', null);
    setState('chatCharacter', null);
    setState('activePersona', null);
    setState('messages', {});
    setState('swipes', {});
    setState('greeting', null);
    setState('greetingHtml', null);
    setState('settings', {} as any);
    setState('generation', {
      activeId: null,
      chatId: null,
      targetMessageId: null,
      streamingText: '',
      streamingReasoning: '',
      impersonationDraft: '',
      status: 'idle',
    });
    setChatSearchQuery('');
  });

  afterEach(() => {
    cleanup();
  });

  describe('getVisibleMessages', () => {
    const chat = { id: 'chat-1' } as Chat;

    beforeEach(() => {
      setState('activeChat', chat);
      setState('messages', { 'chat-1': [] });
      setState('swipes', { 'chat-1': [] });
    });

    it('returns empty array when no active chat', () => {
      setState('activeChat', null);
      expect(getVisibleMessages(null, '', true)).toEqual([]);
    });

    it('returns messages for active chat', () => {
      const msgs = [makeMsg(1, 'Hello'), makeMsg(2, 'World')];
      setState('messages', { 'chat-1': msgs });
      expect(getVisibleMessages(chat, '', true)).toEqual(msgs);
    });

    it('returns bulk messages only (swipe is rendered separately)', () => {
      const msgs = [makeMsg(1, 'Hello')];
      setState('messages', { 'chat-1': msgs });
      setState('swipes', { 'chat-1': [makeMsg(2, 'Swipe')] });
      const result = getVisibleMessages({ ...chat, activeChildId: 2 }, '', true);
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe(1);
    });

    it('filters hidden messages when showHidden is false', () => {
      const msgs = [makeMsg(1, 'Visible'), makeMsg(2, 'Hidden', { hidden: true })];
      setState('messages', { 'chat-1': msgs });
      expect(getVisibleMessages(chat, '', false)).toHaveLength(1);
      expect(getVisibleMessages(chat, '', false)[0]!.id).toBe(1);
    });

    it('shows hidden messages when showHidden is true', () => {
      const msgs = [makeMsg(1, 'Visible'), makeMsg(2, 'Hidden', { hidden: true })];
      setState('messages', { 'chat-1': msgs });
      expect(getVisibleMessages(chat, '', true)).toHaveLength(2);
    });

    it('filters by search query', () => {
      const msgs = [makeMsg(1, 'Hello world'), makeMsg(2, 'Goodbye')];
      setState('messages', { 'chat-1': msgs });
      expect(getVisibleMessages(chat, 'hello', true)).toHaveLength(1);
      expect(getVisibleMessages(chat, 'hello', true)[0]!.id).toBe(1);
    });

    it('search query is case-insensitive', () => {
      const msgs = [makeMsg(1, 'Hello World')];
      setState('messages', { 'chat-1': msgs });
      expect(getVisibleMessages(chat, 'HELLO', true)).toHaveLength(1);
    });

    it('empty search query returns all messages', () => {
      const msgs = [makeMsg(1, 'A'), makeMsg(2, 'B')];
      setState('messages', { 'chat-1': msgs });
      expect(getVisibleMessages(chat, '', true)).toHaveLength(2);
    });

    it('whitespace-only search query returns all messages', () => {
      const msgs = [makeMsg(1, 'A')];
      setState('messages', { 'chat-1': msgs });
      expect(getVisibleMessages(chat, '   ', true)).toHaveLength(1);
    });

    it('combines hidden filter and search', () => {
      const msgs = [
        makeMsg(1, 'Hello world'),
        makeMsg(2, 'Hidden hello', { hidden: true }),
        makeMsg(3, 'Goodbye'),
      ];
      setState('messages', { 'chat-1': msgs });
      expect(getVisibleMessages(chat, 'hello', false)).toHaveLength(1);
      expect(getVisibleMessages(chat, 'hello', true)).toHaveLength(2);
    });
  });

  describe('component', () => {
    it('shows empty state when no chat is active', () => {
      setState('characters', [{ id: 'char-1', name: 'Alice' } as any]);
      render(() => <ChatView />);
      expect(screen.getByText('Select a chat to start')).toBeInTheDocument();
    });

    it('shows a create-character CTA when there are no characters', () => {
      setState('characters', []);
      render(() => <ChatView />);
      expect(screen.getByText('No characters yet — create one to start chatting.')).toBeInTheDocument();
      expect(screen.getByText('Create your first character')).toBeInTheDocument();
    });

    it('shows group chat badge for group chats', () => {
      setState('activeChat', makeChat({ characterId: null, name: 'Group Chat' }));
      render(() => <ChatView />);
      expect(screen.getByText('Group Chat')).toBeInTheDocument();
      expect(screen.getByText('Manage Members')).toBeInTheDocument();
    });

    it('renders visible messages', () => {
      setState('activeChat', makeChat());
      setState('messages', {
        'chat-1': [makeMsg(1, 'First message'), makeMsg(2, 'Second message')],
      });
      setState('chatCharacter', { id: 'char-1', name: 'Alice' } as any);
      render(() => <ChatView />);
      expect(screen.getByText('First message')).toBeInTheDocument();
      expect(screen.getByText('Second message')).toBeInTheDocument();
    });

    it('renders greeting for empty unmaterialized chat', () => {
      setState('activeChat', makeChat({ id: 'chat-greeting', materialized: false }));
      setState('messages', { 'chat-greeting': [] });
      setState('greeting', 'Hello there!');
      setState('greetingHtml', '<p>Hello there!</p>');
      setState('chatCharacter', {
        id: 'char-1',
        name: 'Alice',
        firstMes: 'Hello there!',
        alternateGreetings: [],
      } as any);
      render(() => <ChatView />);
      expect(screen.getByText('Hello there!')).toBeInTheDocument();
    });

    it('shows swipe arrows on the greeting bubble when alternate greetings exist', () => {
      setState('activeChat', makeChat({ id: 'chat-greeting', materialized: false }));
      setState('messages', { 'chat-greeting': [] });
      setState('greeting', 'Hello there!');
      setState('greetingHtml', '<p>Hello there!</p>');
      setState('chatCharacter', {
        id: 'char-1',
        name: 'Alice',
        firstMes: 'Hello there!',
        alternateGreetings: ['Hi again!', 'A third hello.'],
      } as any);
      render(() => <ChatView />);
      // The virtual greeting has no swipeInfo — the arrows come from the
      // explicit greeting-cycling handlers and must not be gated away.
      expect(screen.getByTitle('Swipe left')).toBeInTheDocument();
      expect(screen.getByTitle('Swipe right')).toBeInTheDocument();
      // The counter tracks the selected greeting — display-only, no picker.
      const counter = document.querySelector('.swipe-counter');
      expect(counter).not.toBeNull();
      expect(counter?.textContent).toBe('1/3');
      expect(document.querySelector('button.swipe-counter')).toBeNull();
    });

    it('hides swipe arrows on the greeting bubble when there is only one greeting', () => {
      setState('activeChat', makeChat({ id: 'chat-greeting', materialized: false }));
      setState('messages', { 'chat-greeting': [] });
      setState('greeting', 'Hello there!');
      setState('greetingHtml', '<p>Hello there!</p>');
      setState('chatCharacter', {
        id: 'char-1',
        name: 'Alice',
        firstMes: 'Hello there!',
        alternateGreetings: [],
      } as any);
      render(() => <ChatView />);
      expect(screen.queryByTitle('Swipe left')).not.toBeInTheDocument();
      expect(screen.queryByTitle('Swipe right')).not.toBeInTheDocument();
    });

    it('shows load more button when older messages exist', () => {
      setState('activeChat', makeChat({ headMessageId: 2 }));
      setState('messages', {
        'chat-1': [{ ...makeMsg(2, 'Head'), parentId: 1, renderedHtml: '<p>Head</p>' }],
      });
      render(() => <ChatView />);
      expect(screen.getByText('Load more messages')).toBeInTheDocument();
    });

    it('filters messages by search query', () => {
      setState('activeChat', makeChat());
      setState('messages', {
        'chat-1': [makeMsg(1, 'Find me'), makeMsg(2, 'Ignore me')],
      });
      setState('chatCharacter', { id: 'char-1', name: 'Alice' } as any);
      render(() => <ChatView />);
      setChatSearchQuery('find');
      expect(screen.getByText('Find me')).toBeInTheDocument();
      expect(screen.queryByText('Ignore me')).not.toBeInTheDocument();
    });

    it('hides hidden messages by default', () => {
      setState('activeChat', makeChat());
      setState('messages', {
        'chat-1': [makeMsg(1, 'Visible'), makeMsg(2, 'Hidden', { hidden: true })],
      });
      setState('chatCharacter', { id: 'char-1', name: 'Alice' } as any);
      render(() => <ChatView />);
      expect(screen.getByText('Visible')).toBeInTheDocument();
      expect(screen.queryByText('Hidden')).not.toBeInTheDocument();
    });

    it('shows hidden messages when setting enabled', () => {
      setState('settings', { showHiddenMessages: true } as any);
      setState('activeChat', makeChat());
      setState('messages', {
        'chat-1': [makeMsg(1, 'Visible'), makeMsg(2, 'Hidden', { hidden: true })],
      });
      setState('chatCharacter', { id: 'char-1', name: 'Alice' } as any);
      render(() => <ChatView />);
      expect(screen.getByText('Visible')).toBeInTheDocument();
      expect(screen.getByText('Hidden')).toBeInTheDocument();
    });

    it('applies stream-fade-in class to the streaming target message', () => {
      setActiveChatId('chat-1');
      setState('settings', { streamFadeIn: true } as any);
      setState('activeChat', makeChat());
      setState('messages', {
        'chat-1': [makeMsg(1, 'First'), makeMsg(2, 'Streaming')],
      });
      setState('chatCharacter', { id: 'char-1', name: 'Alice' } as any);
      setState('generation', {
        activeId: 'gen-1',
        chatId: 'chat-1',
        targetMessageId: 2,
        streamingText: '',
        streamingReasoning: '',
        impersonationDraft: '',
        status: 'streaming',
      });
      render(() => <ChatView />);

      const contents = document.querySelectorAll('.message-content');
      expect(contents[0]).not.toHaveClass('stream-fade-in');
      expect(contents[1]).toHaveClass('stream-fade-in');
    });

    it('does not apply stream-fade-in class when reducedMotion is enabled', () => {
      setActiveChatId('chat-1');
      setState('settings', { streamFadeIn: true, reducedMotion: true } as any);
      setState('activeChat', makeChat());
      setState('messages', {
        'chat-1': [makeMsg(1, 'Streaming')],
      });
      setState('chatCharacter', { id: 'char-1', name: 'Alice' } as any);
      setState('generation', {
        activeId: 'gen-1',
        chatId: 'chat-1',
        targetMessageId: 1,
        streamingText: '',
        streamingReasoning: '',
        impersonationDraft: '',
        status: 'streaming',
      });
      render(() => <ChatView />);

      const contents = document.querySelectorAll('.message-content');
      expect(contents[0]).not.toHaveClass('stream-fade-in');
    });

    it('does not apply stream-fade-in class when streamFadeIn setting is disabled', () => {
      setActiveChatId('chat-1');
      setState('settings', { streamFadeIn: false } as any);
      setState('activeChat', makeChat());
      setState('messages', {
        'chat-1': [makeMsg(1, 'Streaming')],
      });
      setState('chatCharacter', { id: 'char-1', name: 'Alice' } as any);
      setState('generation', {
        activeId: 'gen-1',
        chatId: 'chat-1',
        targetMessageId: 1,
        streamingText: '',
        streamingReasoning: '',
        impersonationDraft: '',
        status: 'streaming',
      });
      render(() => <ChatView />);

      const contents = document.querySelectorAll('.message-content');
      expect(contents[0]).not.toHaveClass('stream-fade-in');
    });

    it('hides avatars when hideChatAvatars setting is enabled', () => {
      setState('settings', { hideChatAvatars: true } as any);
      setState('activeChat', makeChat());
      setState('messages', {
        'chat-1': [makeMsg(1, 'Hello')],
      });
      setState('chatCharacter', { id: 'char-1', name: 'Alice' } as any);
      render(() => <ChatView />);

      expect(document.querySelector('.message-bubble')).toHaveClass('hide-avatar');
      expect(document.querySelector('.message-avatar')).not.toBeInTheDocument();
    });

    it('shows avatars when hideChatAvatars setting is disabled', () => {
      setState('settings', { hideChatAvatars: false } as any);
      setState('activeChat', makeChat());
      setState('messages', {
        'chat-1': [makeMsg(1, 'Hello')],
      });
      setState('chatCharacter', { id: 'char-1', name: 'Alice', avatarUrl: '/avatar.png' } as any);
      render(() => <ChatView />);

      expect(document.querySelector('.message-bubble')).not.toHaveClass('hide-avatar');
      expect(document.querySelector('.message-avatar')).toBeInTheDocument();
    });

    it('hides names when hideChatNames setting is enabled', () => {
      setState('settings', { hideChatNames: true } as any);
      setState('activeChat', makeChat());
      setState('messages', {
        'chat-1': [makeMsg(1, 'Hello')],
      });
      setState('chatCharacter', { id: 'char-1', name: 'Alice' } as any);
      render(() => <ChatView />);

      expect(document.querySelector('.message-bubble')).toHaveClass('hide-name');
      expect(document.querySelector('.message-role')).not.toBeInTheDocument();
    });

    it('shows names when hideChatNames setting is disabled', () => {
      setState('settings', { hideChatNames: false } as any);
      setState('activeChat', makeChat());
      setState('messages', {
        'chat-1': [makeMsg(1, 'Hello')],
      });
      setState('chatCharacter', { id: 'char-1', name: 'Alice' } as any);
      render(() => <ChatView />);

      expect(document.querySelector('.message-bubble')).not.toHaveClass('hide-name');
      expect(document.querySelector('.message-role')).toBeInTheDocument();
    });

    it('shows swipe numbers on all messages when setting is enabled', () => {
      setState('settings', { swipeNumbersOnAllMessages: true } as any);
      setState('activeChat', makeChat());
      setState('messages', {
        'chat-1': [makeMsg(1, 'First'), makeMsg(2, 'Second')],
      });
      setState('swipes', {
        'chat-1': [makeMsg(1, 'First'), makeMsg(3, 'Swipe')],
      });
      setState('chatCharacter', { id: 'char-1', name: 'Alice' } as any);
      render(() => <ChatView />);

      const counters = document.querySelectorAll('.swipe-counter');
      expect(counters.length).toBeGreaterThan(0);
      expect(counters[0]).toHaveTextContent('1/2');
    });

    it('does not show swipe numbers on non-last messages when setting is disabled', () => {
      setState('settings', { swipeNumbersOnAllMessages: false } as any);
      setState('activeChat', makeChat());
      setState('messages', {
        'chat-1': [makeMsg(1, 'First'), makeMsg(2, 'Second')],
      });
      setState('swipes', {
        'chat-1': [makeMsg(1, 'First'), makeMsg(3, 'Swipe')],
      });
      setState('chatCharacter', { id: 'char-1', name: 'Alice' } as any);
      render(() => <ChatView />);

      const firstBubble = document.querySelectorAll('.message-bubble')[0];
      expect(firstBubble?.querySelector('.swipe-counter')).not.toBeInTheDocument();
    });

    it('shows message IDs when showMessageIds setting is enabled', () => {
      setState('settings', { showMessageIds: true } as any);
      setState('activeChat', makeChat());
      setState('messages', {
        'chat-1': [makeMsg(1, 'Hello')],
      });
      setState('chatCharacter', { id: 'char-1', name: 'Alice' } as any);
      render(() => <ChatView />);

      expect(screen.getByTitle('Message ID')).toHaveTextContent('#1');
    });

    it('does not show message IDs when showMessageIds setting is disabled', () => {
      setState('settings', { showMessageIds: false } as any);
      setState('activeChat', makeChat());
      setState('messages', {
        'chat-1': [makeMsg(1, 'Hello')],
      });
      setState('chatCharacter', { id: 'char-1', name: 'Alice' } as any);
      render(() => <ChatView />);

      expect(screen.queryByTitle('Message ID')).not.toBeInTheDocument();
    });

    it('sends action.swipe when swiping left on the active swipe message', () => {
      const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
      setActiveChatId('chat-1');
      setState('settings', {} as any);
      setState('activeChat', makeChat({ activeChildId: 2 }));
      setState('messages', {
        'chat-1': [makeMsg(1, 'Hello')],
      });
      setState('swipes', {
        'chat-1': [makeMsg(2, 'Swipe')],
      });
      setState('chatCharacter', { id: 'char-1', name: 'Alice' } as any);
      render(() => <ChatView />);

      const bubble = document.querySelector('.message-bubble.swipeable') as HTMLElement;
      expect(bubble).toBeInTheDocument();

      fireEvent.touchStart(bubble, { touches: [{ clientX: 200, clientY: 100 }] });
      fireEvent.touchEnd(bubble, { changedTouches: [{ clientX: 120, clientY: 100 }] });

      expect(sendSpy).toHaveBeenCalledWith({
        type: 'action.swipe',
        chatId: 'chat-1',
        messageId: 2,
        direction: 'left',
      });
    });

    it('does not send action.swipe for a small horizontal movement', () => {
      const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
      setActiveChatId('chat-1');
      setState('settings', {} as any);
      setState('activeChat', makeChat({ activeChildId: 2 }));
      setState('messages', {
        'chat-1': [makeMsg(1, 'Hello')],
      });
      setState('swipes', {
        'chat-1': [makeMsg(2, 'Swipe')],
      });
      setState('chatCharacter', { id: 'char-1', name: 'Alice' } as any);
      render(() => <ChatView />);

      const bubble = document.querySelector('.message-bubble.swipeable') as HTMLElement;
      fireEvent.touchStart(bubble, { touches: [{ clientX: 200, clientY: 100 }] });
      fireEvent.touchEnd(bubble, { changedTouches: [{ clientX: 180, clientY: 100 }] });

      expect(sendSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'action.swipe' }),
      );
    });

    it('renders raw escaped text when encodeTags is enabled', () => {
      setState('settings', { encodeTags: true } as any);
      setState('activeChat', makeChat());
      setState('messages', {
        'chat-1': [makeMsg(1, '<script>alert("x")</script>')],
      });
      setState('chatCharacter', { id: 'char-1', name: 'Alice' } as any);
      render(() => <ChatView />);

      const encoded = document.querySelector('.encoded-tags code');
      expect(encoded).toBeInTheDocument();
      expect(encoded?.textContent).toContain('&lt;script&gt;');
      expect(encoded?.textContent).toContain('&quot;x&quot;');
      expect(document.querySelector('.message-content')).not.toBeInTheDocument();
    });

    it('renders normal HTML content when encodeTags is disabled', () => {
      setState('settings', { encodeTags: false } as any);
      setState('activeChat', makeChat());
      setState('messages', {
        'chat-1': [makeMsg(1, 'Hello')],
      });
      setState('chatCharacter', { id: 'char-1', name: 'Alice' } as any);
      render(() => <ChatView />);

      expect(document.querySelector('.encoded-tags')).not.toBeInTheDocument();
      expect(document.querySelector('.message-content')).toBeInTheDocument();
    });

    it('clicking a data-post-response button sends the response then generates', async () => {
      const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
      setActiveChatId('chat-1');
      setState('settings', {} as any);
      setState('activeChat', makeChat());
      const msg = makeMsg(1, 'battle menu');
      msg.renderedHtml =
        '<div class="hud"><button data-post-response="attack">Attack!</button>' +
        '<button data-post-response="flee">Run away</button></div>';
      setState('messages', { 'chat-1': [msg] });
      setState('chatCharacter', { id: 'char-1', name: 'Alice' } as any);
      render(() => <ChatView />);

      const button = document.querySelector('button[data-post-response="attack"]') as HTMLElement;
      expect(button).toBeInTheDocument();
      fireEvent.click(button);

      // The chat is already materialized, so the send fires after a microtask.
      await vi.waitFor(() => {
        expect(sendSpy).toHaveBeenCalledWith({ type: 'action.sendAndGenerate', chatId: 'chat-1', content: 'attack' });
      });
      // click-to-edit must not fire for button clicks
      expect(document.querySelector('.message-edit')).not.toBeInTheDocument();
    });

    it('clicking message content without a button does not post anything', () => {
      const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
      setActiveChatId('chat-1');
      setState('settings', {} as any);
      setState('activeChat', makeChat());
      const msg = makeMsg(1, 'plain text');
      msg.renderedHtml = '<div class="hud"><span>just text</span></div>';
      setState('messages', { 'chat-1': [msg] });
      setState('chatCharacter', { id: 'char-1', name: 'Alice' } as any);
      render(() => <ChatView />);

      const span = document.querySelector('.hud span') as HTMLElement;
      fireEvent.click(span);

      expect(sendSpy).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'action.send' }));
    });

    it('submitting a data-post-response form posts fenced XML then generates', async () => {
      const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
      setActiveChatId('chat-1');
      setState('settings', {} as any);
      setState('activeChat', makeChat());
      const msg = makeMsg(1, 'battle form');
      msg.renderedHtml =
        '<form data-post-response="action">' +
        '<input name="target" type="text" value="the goblin">' +
        '<input type="checkbox" name="sneak" value="yes" checked>' +
        '<input type="checkbox" name="shield" value="yes">' +
        '<select name="weapon"><option value="sword">Sword</option><option value="bow" selected>Bow</option></select>' +
        '<textarea name="flourish"></textarea>' +
        '<button type="submit">Attack</button></form>';
      setState('messages', { 'chat-1': [msg] });
      setState('chatCharacter', { id: 'char-1', name: 'Alice' } as any);
      render(() => <ChatView />);

      const form = document.querySelector('form[data-post-response]') as HTMLFormElement;
      expect(form).toBeInTheDocument();
      (form.querySelector('textarea') as HTMLTextAreaElement).value = 'from <the> shadows';
      fireEvent.submit(form);

      const expected =
        '```xml\n' +
        '<action>\n' +
        '  <target>the goblin</target>\n' +
        '  <sneak>yes</sneak>\n' +
        '  <weapon>bow</weapon>\n' +
        '  <flourish>from &lt;the&gt; shadows</flourish>\n' +
        '</action>\n' +
        '```';
      await vi.waitFor(() => {
        expect(sendSpy).toHaveBeenCalledWith({ type: 'action.sendAndGenerate', chatId: 'chat-1', content: expected });
      });
      // click-to-edit must not fire for form interaction
      expect(document.querySelector('.message-edit')).not.toBeInTheDocument();
    });

    it('prevents navigation on any message form but only marked forms post', () => {
      const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
      setActiveChatId('chat-1');
      setState('settings', {} as any);
      setState('activeChat', makeChat());
      const msg = makeMsg(1, 'plain form');
      msg.renderedHtml = '<form><input name="a" type="text" value="v"><button type="submit">go</button></form>';
      setState('messages', { 'chat-1': [msg] });
      setState('chatCharacter', { id: 'char-1', name: 'Alice' } as any);
      render(() => <ChatView />);

      const form = document.querySelector('form') as HTMLFormElement;
      const event = new Event('submit', { bubbles: true, cancelable: true });
      form.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      expect(sendSpy).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'action.send' }));
    });

    it('posts nothing when a marked form has no field values', () => {
      const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
      setActiveChatId('chat-1');
      setState('settings', {} as any);
      setState('activeChat', makeChat());
      const msg = makeMsg(1, 'empty form');
      msg.renderedHtml =
        '<form data-post-response="action"><input type="text" value="no-name">' +
        '<button type="submit">go</button></form>';
      setState('messages', { 'chat-1': [msg] });
      setState('chatCharacter', { id: 'char-1', name: 'Alice' } as any);
      render(() => <ChatView />);

      fireEvent.submit(document.querySelector('form[data-post-response]') as HTMLFormElement);

      expect(sendSpy).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'action.send' }));
    });

    it('clicking a data-post-response button in the virtual greeting materializes, then posts and generates', async () => {
      // The virtual greeting bubble is read-only, but read-only gates editing,
      // not the button protocol — first_mes is where cards put their menus.
      // The click first sends chat.materialize (turning the greeting into real
      // DB messages) and only then posts the response.
      const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
      const handlers = new Map<string, Set<(m: unknown) => void>>();
      vi.spyOn(bus, 'on').mockImplementation((event: any, handler: any) => {
        if (!handlers.has(event)) handlers.set(event, new Set());
        handlers.get(event)!.add(handler);
        return () => handlers.get(event)!.delete(handler);
      });
      setActiveChatId('chat-greeting');
      setState('settings', {} as any);
      setState('activeChat', makeChat({ id: 'chat-greeting', materialized: false }));
      setState('messages', { 'chat-greeting': [] });
      setState('greeting', 'menu');
      setState(
        'greetingHtml',
        '<div class="menu"><button data-post-response="lumia_pick_0">First Day</button></div>',
      );
      setState('chatCharacter', {
        id: 'char-1',
        name: 'Alice',
        firstMes: 'menu',
        alternateGreetings: [],
      } as any);
      render(() => <ChatView />);

      const button = document.querySelector('button[data-post-response="lumia_pick_0"]') as HTMLElement;
      expect(button).toBeInTheDocument();
      fireEvent.click(button);

      // Materialization is requested first…
      expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'chat.materialize', chatId: 'chat-greeting' }));
      expect(sendSpy).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'action.sendAndGenerate' }));
      // …and the response is posted once the server answers with a snapshot.
      (handlers.get('chat.snapshot') ?? new Set()).forEach((h) => h({ chat: { id: 'chat-greeting' } }));
      await vi.waitFor(() => {
        expect(sendSpy).toHaveBeenCalledWith({ type: 'action.sendAndGenerate', chatId: 'chat-greeting', content: 'lumia_pick_0' });
      });
      // click-to-edit must stay gated off in the read-only greeting
      expect(document.querySelector('.message-edit')).not.toBeInTheDocument();
    });

    it('submitting a data-post-response form in the virtual greeting materializes, then posts and generates', async () => {
      const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
      const handlers = new Map<string, Set<(m: unknown) => void>>();
      vi.spyOn(bus, 'on').mockImplementation((event: any, handler: any) => {
        if (!handlers.has(event)) handlers.set(event, new Set());
        handlers.get(event)!.add(handler);
        return () => handlers.get(event)!.delete(handler);
      });
      setActiveChatId('chat-greeting');
      setState('settings', {} as any);
      setState('activeChat', makeChat({ id: 'chat-greeting', materialized: false }));
      setState('messages', { 'chat-greeting': [] });
      setState('greeting', 'menu form');
      setState(
        'greetingHtml',
        '<form data-post-response="lumia_start">' +
          '<input type="radio" name="lang" value="kr" checked>' +
          '<input type="radio" name="lang" value="en">' +
          '<input type="radio" name="scenario" value="0" checked>' +
          '<button type="submit">START</button></form>',
      );
      setState('chatCharacter', {
        id: 'char-1',
        name: 'Alice',
        firstMes: 'menu form',
        alternateGreetings: [],
      } as any);
      render(() => <ChatView />);

      const form = document.querySelector('form[data-post-response]') as HTMLFormElement;
      expect(form).toBeInTheDocument();
      fireEvent.submit(form);

      expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'chat.materialize', chatId: 'chat-greeting' }));
      (handlers.get('chat.snapshot') ?? new Set()).forEach((h) => h({ chat: { id: 'chat-greeting' } }));

      const expected =
        '```xml\n' +
        '<lumia_start>\n' +
        '  <lang>kr</lang>\n' +
        '  <scenario>0</scenario>\n' +
        '</lumia_start>\n' +
        '```';
      await vi.waitFor(() => {
        expect(sendSpy).toHaveBeenCalledWith({ type: 'action.sendAndGenerate', chatId: 'chat-greeting', content: expected });
      });
    });
  });
});
