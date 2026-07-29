import { describe, it, expect, beforeEach } from 'vitest';
import {
  activeChatId,
  setActiveChatId,
  loadingOlderChatId,
  setLoadingOlderChatId,
  pendingChatId,
  setPendingChatId,
  activeCharacterId,
  setActiveCharacterId,
  activePersonaId,
  setActivePersonaId,
  activeWorldInfoId,
  setActiveWorldInfoId,
  activeBackendConfigId,
  setActiveBackendConfigId,
  activePromptListId,
  setActivePromptListId,
  chatSearchQuery,
  setChatSearchQuery,
  selectedCharacterId,
  setSelectedCharacterId,
} from './uiStore.js';

describe('uiStore signals', () => {
  beforeEach(() => {
    // Reset all signals to default state
    setActiveChatId(null);
    setLoadingOlderChatId(null);
    setPendingChatId(null);
    setActiveCharacterId(null);
    setActivePersonaId(null);
    setActiveWorldInfoId(null);
    setActiveBackendConfigId(null);
    setActivePromptListId(null);
    setChatSearchQuery('');
    setSelectedCharacterId(null);
  });

  it('activeChatId updates independently', () => {
    expect(activeChatId()).toBeNull();
    setActiveChatId('chat-1');
    expect(activeChatId()).toBe('chat-1');
  });

  it('loadingOlderChatId updates', () => {
    expect(loadingOlderChatId()).toBeNull();
    setLoadingOlderChatId('chat-1');
    expect(loadingOlderChatId()).toBe('chat-1');
  });

  it('pendingChatId updates', () => {
    setPendingChatId('chat-1');
    expect(pendingChatId()).toBe('chat-1');
  });

  it('activeCharacterId updates', () => {
    setActiveCharacterId('char-1');
    expect(activeCharacterId()).toBe('char-1');
  });

  it('activePersonaId updates', () => {
    setActivePersonaId('persona-1');
    expect(activePersonaId()).toBe('persona-1');
  });

  it('activeWorldInfoId updates', () => {
    setActiveWorldInfoId('wi-1');
    expect(activeWorldInfoId()).toBe('wi-1');
  });

  it('activeBackendConfigId updates', () => {
    setActiveBackendConfigId('bc-1');
    expect(activeBackendConfigId()).toBe('bc-1');
  });

  it('activePromptListId updates', () => {
    setActivePromptListId('pl-1');
    expect(activePromptListId()).toBe('pl-1');
  });

  it('chatSearchQuery updates', () => {
    expect(chatSearchQuery()).toBe('');
    setChatSearchQuery('hello');
    expect(chatSearchQuery()).toBe('hello');
  });

  it('selectedCharacterId updates', () => {
    setSelectedCharacterId('char-1');
    expect(selectedCharacterId()).toBe('char-1');
  });

  it('signals are independent', () => {
    setActiveChatId('chat-1');
    setActiveCharacterId('char-1');
    expect(activeChatId()).toBe('chat-1');
    expect(activeCharacterId()).toBe('char-1');
  });
});
