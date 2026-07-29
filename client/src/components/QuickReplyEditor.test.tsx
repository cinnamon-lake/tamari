import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@solidjs/testing-library';
import { QuickReplyEditor } from './QuickReplyEditor.js';
import { bus } from '../bus/WebSocketBus.js';
import type { QuickReply } from '@tamari/types';
import { QuickReplyAutoExecute } from '@tamari/types';

describe('QuickReplyEditor', () => {
  beforeEach(() => {
    vi.spyOn(bus, 'send').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders in create mode', () => {
    render(() => (
      <QuickReplyEditor chatId="chat-1" characterId="char-1" onClose={() => {}} />
    ));
    expect(screen.getByText('New Quick Reply')).toBeInTheDocument();
  });

  it('renders in edit mode', () => {
    const qr = makeQR({ id: 'qr1', label: 'Greet', script: 'st.send("Hi")' });
    render(() => (
      <QuickReplyEditor qr={qr} chatId="chat-1" characterId="char-1" onClose={() => {}} />
    ));
    expect(screen.getByText('Edit Quick Reply')).toBeInTheDocument();
    const labelInput = screen.getByDisplayValue<HTMLInputElement>('Greet');
    expect(labelInput).toBeInTheDocument();
  });

  it('sends quickreply.create on save in create mode', () => {
    const sendSpy = vi.spyOn(bus, 'send');
    const onClose = vi.fn();
    render(() => (
      <QuickReplyEditor chatId="chat-1" characterId="char-1" onClose={onClose} />
    ));

    const labelInput = document.querySelector('input[type="text"]') as HTMLInputElement;
    fireEvent.input(labelInput, { target: { value: 'New QR' } });

    screen.getByText('Save').click();

    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'quickreply.create',
      data: expect.objectContaining({ label: 'New QR' }),
    }));
    expect(onClose).toHaveBeenCalled();
  });

  it('sends quickreply.update on save in edit mode', () => {
    const sendSpy = vi.spyOn(bus, 'send');
    const qr = makeQR({ id: 'qr1', label: 'Old', scope: 'global' });
    render(() => (
      <QuickReplyEditor qr={qr} chatId="chat-1" characterId="char-1" onClose={() => {}} />
    ));

    const labelInput = screen.getByDisplayValue<HTMLInputElement>('Old');
    fireEvent.input(labelInput, { target: { value: 'Updated' } });

    screen.getByText('Save').click();

    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'quickreply.update',
      id: 'qr1',
      patch: expect.objectContaining({ label: 'Updated' }),
    }));
  });

  it('sends quickreply.delete on delete in edit mode', () => {
    const sendSpy = vi.spyOn(bus, 'send');
    const qr = makeQR({ id: 'qr1', label: 'Test' });
    render(() => (
      <QuickReplyEditor qr={qr} chatId="chat-1" characterId="char-1" onClose={() => {}} />
    ));

    screen.getByText('Delete').click();

    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'quickreply.delete',
      id: 'qr1',
    }));
  });

  it('hides delete button in create mode', () => {
    render(() => (
      <QuickReplyEditor chatId="chat-1" characterId="char-1" onClose={() => {}} />
    ));
    expect(screen.queryByText('Delete')).not.toBeInTheDocument();
  });

  it('shows scope selector in create mode', () => {
    render(() => (
      <QuickReplyEditor chatId="chat-1" characterId="char-1" onClose={() => {}} />
    ));
    expect(screen.getByText('Scope')).toBeInTheDocument();
  });

  it('hides scope selector in edit mode', () => {
    const qr = makeQR({ id: 'qr1' });
    render(() => (
      <QuickReplyEditor qr={qr} chatId="chat-1" characterId="char-1" onClose={() => {}} />
    ));
    expect(screen.queryByLabelText('Scope')).not.toBeInTheDocument();
  });

  it('closes on cancel', () => {
    const onClose = vi.fn();
    render(() => (
      <QuickReplyEditor chatId="chat-1" characterId="char-1" onClose={onClose} />
    ));
    screen.getByText('Cancel').click();
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on backdrop click', () => {
    const onClose = vi.fn();
    render(() => (
      <QuickReplyEditor chatId="chat-1" characterId="char-1" onClose={onClose} />
    ));
    const overlay = document.querySelector('.modal-overlay');
    overlay?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onClose).toHaveBeenCalled();
  });

  it('includes autoExecute bitmask and orderIndex in create payload', () => {
    const sendSpy = vi.spyOn(bus, 'send');
    render(() => (
      <QuickReplyEditor chatId="chat-1" characterId="char-1" onClose={() => {}} />
    ));

    const orderInput = screen.getByLabelText<HTMLInputElement>('Order');
    fireEvent.input(orderInput, { target: { value: '5' } });

    const userMsgCheckbox = screen.getByLabelText<HTMLInputElement>('User message');
    fireEvent.click(userMsgCheckbox);

    screen.getByText('Save').click();

    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'quickreply.create',
      data: expect.objectContaining({
        autoExecute: QuickReplyAutoExecute.USER_MESSAGE,
        orderIndex: 5,
      }),
    }));
  });

  it('preserves existing autoExecute bits in edit mode', () => {
    const sendSpy = vi.spyOn(bus, 'send');
    const qr = makeQR({
      id: 'qr1',
      autoExecute: QuickReplyAutoExecute.USER_MESSAGE | QuickReplyAutoExecute.AI_MESSAGE,
      orderIndex: 3,
    });
    render(() => (
      <QuickReplyEditor qr={qr} chatId="chat-1" characterId="char-1" onClose={() => {}} />
    ));

    const userMsgCheckbox = screen.getByLabelText<HTMLInputElement>('User message');
    const aiMsgCheckbox = screen.getByLabelText<HTMLInputElement>('AI message');
    expect(userMsgCheckbox.checked).toBe(true);
    expect(aiMsgCheckbox.checked).toBe(true);

    const startupCheckbox = screen.getByLabelText<HTMLInputElement>('Startup');
    fireEvent.click(startupCheckbox);

    screen.getByText('Save').click();

    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'quickreply.update',
      id: 'qr1',
      patch: expect.objectContaining({
        autoExecute: QuickReplyAutoExecute.USER_MESSAGE | QuickReplyAutoExecute.AI_MESSAGE | QuickReplyAutoExecute.STARTUP,
        orderIndex: 3,
      }),
    }));
  });

  function makeQR(overrides: Partial<QuickReply> = {}): QuickReply {
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
