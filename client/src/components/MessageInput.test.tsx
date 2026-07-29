import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@solidjs/testing-library';
import { MessageInput } from './MessageInput.js';
import { setState } from '../stores/serverStore.js';
import { setActiveChatId } from '../stores/uiStore.js';
import { bus } from '../bus/WebSocketBus.js';

vi.mock('../lib/uploadAttachments.js', () => ({
  uploadAttachments: vi.fn(async (files: File[]) =>
    files.map((file, i) => ({
      id: `att-${i}`,
      mimeType: file.type || 'application/octet-stream',
      url: `blob://att-${i}`,
      meta: { name: file.name, size: file.size },
    })),
  ),
}));

import { uploadAttachments } from '../lib/uploadAttachments.js';

describe('MessageInput', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setState('activeChat', null);
    setState('settings', {});
    setState('generation', { status: 'idle', activeId: null, chatId: null, targetMessageId: null, streamingText: '', streamingReasoning: '', impersonationDraft: '' });
    setActiveChatId(null);
  });

  it('does not render when no active chat', () => {
    render(() => <MessageInput />);
    expect(document.querySelector('.message-input-area')).not.toBeInTheDocument();
  });

  it('renders when active chat exists', () => {
    setActiveChatId('chat-1');
    render(() => <MessageInput />);
    expect(document.querySelector('.message-input-area')).toBeInTheDocument();
    expect(screen.getByPlaceholderText<HTMLTextAreaElement>('Type a message...')).toBeInTheDocument();
  });

  it('sends one atomic action.sendAndGenerate on send click', async () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    setActiveChatId('chat-1');
    render(() => <MessageInput />);

    const textarea = screen.getByPlaceholderText<HTMLTextAreaElement>('Type a message...');
    fireEvent.input(textarea, { target: { value: 'Hello world' } });
    screen.getByTitle('Send').click();

    await new Promise((r) => setTimeout(r, 0));
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'action.sendAndGenerate',
      chatId: 'chat-1',
      content: 'Hello world',
    }));
    // The paired action.send / action.generate frames are gone — one atomic
    // message per send so the server can't reorder them.
    expect(sendSpy).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'action.send' }));
    expect(sendSpy).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'action.generate' }));
  });

  it('clears text after send', async () => {
    vi.spyOn(bus, 'send').mockImplementation(() => {});
    setActiveChatId('chat-1');
    render(() => <MessageInput />);

    const textarea = screen.getByPlaceholderText<HTMLTextAreaElement>('Type a message...');
    fireEvent.input(textarea, { target: { value: 'Hello' } });
    screen.getByTitle('Send').click();

    await new Promise((r) => setTimeout(r, 0));
    expect(textarea.value).toBe('');
  });

  it('shows slash command autocomplete', () => {
    setActiveChatId('chat-1');
    render(() => <MessageInput />);

    const textarea = screen.getByPlaceholderText<HTMLTextAreaElement>('Type a message...');
    fireEvent.input(textarea, { target: { value: '/na' } });

    expect(document.querySelector('.slash-autocomplete')).toBeInTheDocument();
  });

  it('sends impersonate on impersonate click', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    setActiveChatId('chat-1');
    render(() => <MessageInput />);
    screen.getByTitle('Impersonate').click();
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'action.impersonate',
      chatId: 'chat-1',
    }));
  });

  it('shows stop button during streaming', () => {
    setActiveChatId('chat-1');
    setState('generation', {
      status: 'streaming',
      activeId: 'gen-1',
      chatId: 'chat-1',
      targetMessageId: 1,
      streamingText: '',
      streamingReasoning: '',
      impersonationDraft: '',
    });
    render(() => <MessageInput />);
    expect(screen.getByText('Stop')).toBeInTheDocument();
  });

  it('sends action.stop when stop clicked', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    setActiveChatId('chat-1');
    setState('generation', {
      status: 'streaming',
      activeId: 'gen-1',
      chatId: 'chat-1',
      targetMessageId: 1,
      streamingText: '',
      streamingReasoning: '',
      impersonationDraft: '',
    });
    render(() => <MessageInput />);
    screen.getByText('Stop').click();
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'action.stop',
      generationId: 'gen-1',
    }));
  });

  it('disables input during streaming', () => {
    setActiveChatId('chat-1');
    setState('generation', {
      status: 'streaming',
      activeId: 'gen-1',
      chatId: 'chat-1',
      targetMessageId: 1,
      streamingText: '',
      streamingReasoning: '',
      impersonationDraft: '',
    });
    render(() => <MessageInput />);
    const textarea = screen.getByPlaceholderText<HTMLTextAreaElement>('Type a message...');
    expect(textarea.disabled).toBe(true);
  });

  it('renders attachment previews', () => {
    setActiveChatId('chat-1');
    render(() => <MessageInput />);
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).toBeInTheDocument();
  });

  it('shows lock placeholder when input locked', async () => {
    vi.spyOn(bus, 'send').mockImplementation(() => {});
    setActiveChatId('chat-1');
    render(() => <MessageInput />);
    const textarea = screen.getByPlaceholderText<HTMLTextAreaElement>('Type a message...');
    fireEvent.input(textarea, { target: { value: '/lock' } });
    screen.getByTitle('Send').click();
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByPlaceholderText<HTMLTextAreaElement>('Input is locked. Type /unlock to enable.')).toBeInTheDocument();
  });

  it('sends quick continue when enabled and clicked', () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    setActiveChatId('chat-1');
    setState('settings', { quickContinue: true });
    render(() => <MessageInput />);
    screen.getByTitle('Quick Continue').click();
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'action.continue',
      chatId: 'chat-1',
    }));
  });

  it('sends on Enter when send-on-enter is enabled', async () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    setActiveChatId('chat-1');
    setState('settings', { sendOnEnter: 'enabled' });
    render(() => <MessageInput />);

    const textarea = screen.getByPlaceholderText<HTMLTextAreaElement>('Type a message...');
    fireEvent.input(textarea, { target: { value: 'Hello' } });
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', shiftKey: false });

    await new Promise((r) => setTimeout(r, 0));
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'action.sendAndGenerate', content: 'Hello' }));
  });

  it('inserts a newline on Shift+Enter instead of sending', async () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    setActiveChatId('chat-1');
    setState('settings', { sendOnEnter: 'enabled' });
    render(() => <MessageInput />);

    const textarea = screen.getByPlaceholderText<HTMLTextAreaElement>('Type a message...');
    fireEvent.input(textarea, { target: { value: 'Hello' } });
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', shiftKey: true });

    await new Promise((r) => setTimeout(r, 0));
    const actionSendCalls = sendSpy.mock.calls.filter(
      (c) => String((c[0] as Record<string, string>).type).startsWith('action.send'),
    );
    expect(actionSendCalls).toHaveLength(0);
  });

  it('does not send an empty message', async () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    setActiveChatId('chat-1');
    render(() => <MessageInput />);

    screen.getByTitle('Send').click();
    await new Promise((r) => setTimeout(r, 0));

    const sendCalls = sendSpy.mock.calls.filter((c) => String((c[0] as Record<string, string>).type).startsWith('action.send'));
    expect(sendCalls).toHaveLength(0);
  });

  it('uploads files selected through the file input', async () => {
    setActiveChatId('chat-1');
    render(() => <MessageInput />);

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['content'], 'image.png', { type: 'image/png' });
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => expect(uploadAttachments).toHaveBeenCalledWith([file]));
    expect(document.querySelector('.attachment-preview')).toBeInTheDocument();
  });

  it('removes an attachment preview when the remove button is clicked', async () => {
    vi.spyOn(bus, 'send').mockImplementation(() => {});
    setActiveChatId('chat-1');
    render(() => <MessageInput />);

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [new File(['x'], 'doc.txt', { type: 'text/plain' })] } });
    await waitFor(() => expect(document.querySelector('.attachment-preview')).toBeInTheDocument());

    const removeBtn = document.querySelector('[aria-label="Remove attachment"]') as HTMLButtonElement;
    removeBtn.click();
    await waitFor(() => expect(document.querySelector('.attachment-preview')).not.toBeInTheDocument());
  });

  it('sends a message with attachments', async () => {
    const sendSpy = vi.spyOn(bus, 'send').mockImplementation(() => {});
    setActiveChatId('chat-1');
    render(() => <MessageInput />);

    const textarea = screen.getByPlaceholderText<HTMLTextAreaElement>('Type a message...');
    fireEvent.input(textarea, { target: { value: 'Look at this' } });

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [new File(['x'], 'pic.png', { type: 'image/png' })] } });
    await waitFor(() => expect(document.querySelector('.attachment-preview')).toBeInTheDocument());

    screen.getByTitle('Send').click();
    await new Promise((r) => setTimeout(r, 0));

    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'action.sendAndGenerate',
      content: 'Look at this',
      attachments: expect.arrayContaining([expect.objectContaining({ id: 'att-0' })]),
    }));
  });

  it('shows macro autocomplete when typing {{', () => {
    setActiveChatId('chat-1');
    render(() => <MessageInput />);

    const textarea = screen.getByPlaceholderText<HTMLTextAreaElement>('Type a message...');
    fireEvent.input(textarea, { target: { value: 'Hello {{us' } });
    fireEvent.keyUp(textarea, { key: 's' });

    expect(document.querySelector('.slash-autocomplete')).toBeInTheDocument();
  });
});
