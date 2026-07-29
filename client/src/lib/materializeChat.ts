import { bus } from '../bus/WebSocketBus.js';
import { state } from '../stores/serverStore.js';

/**
 * Materialize virtual greetings into real DB messages.
 *
 * If the current chat is empty and has a character, this sends the
 * `chat.materialize` request and waits for the server to create greeting
 * messages. Once resolved, the chat has real messages and normal
 * operations (send, edit, etc.) can proceed.
 */
export function materializeChat(chatId: string): Promise<void> {
  const chat = state.activeChat;
  if (!chat || chat.id !== chatId || chat.materialized || !chat.characterId) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const unsubscribe = bus.on('chat.snapshot', (msg) => {
      if (msg.chat.id === chatId) {
        unsubscribe();
        resolve();
      }
    });

    const selectedIndex = Number(chat.metadata.selectedGreetingIndex ?? 0);
    bus.send({ type: 'chat.materialize', chatId, selectedIndex });
  });
}
