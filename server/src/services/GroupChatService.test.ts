import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GroupChatService, type GroupChatSettings } from './GroupChatService.js';
import type { IChatMemberRepository } from '../repos/ChatMemberRepository.js';
import type { IChatRepository } from '../repos/ChatRepository.js';
import type { ChatMember, Chat } from '@tamari/types';

function makeMember(overrides?: Partial<ChatMember>): ChatMember {
  return {
    chatId: 'chat-1',
    characterId: 'char-1',
    talkativeness: 1.0,
    depthPrompt: '',
    depthPromptDepth: 4,
    enabled: true,
    ...overrides,
  };
}

function makeChat(settings?: Partial<GroupChatSettings>): Chat {
  return {
    id: 'chat-1',
    characterId: null,
    personaId: null,
    name: 'Test Group',
    headMessageId: null,
    activeChildId: null,
    materialized: false,
    createdAt: 0,
    updatedAt: 0,
    metadata: settings ? { groupChatSettings: settings } : {},
    forkedFromChatId: null,
    forkedAtMessageId: null,
  };
}

/** Deterministic RNG for tests. Cycles through the provided values. */
function deterministicRng(values: number[]): () => number {
  let i = 0;
  return () => {
    const v = values[i % values.length]!;
    i++;
    return v;
  };
}

describe('GroupChatService', () => {
  let mockMembers: IChatMemberRepository;
  let mockChats: IChatRepository;
  let autoTrigger: (chatId: string) => void | Promise<void>;
  let service: GroupChatService;

  beforeEach(() => {
    mockMembers = {
      getMembers: vi.fn(),
      addMember: vi.fn(),
      removeMember: vi.fn(),
      updateMember: vi.fn(),
      removeAllMembers: vi.fn(),
    };

    mockChats = {
      getChatById: vi.fn(),
      listChats: vi.fn(),
      createChat: vi.fn(),
      updateChat: vi.fn(),
      mergeChatMetadata: vi.fn(),
      deleteChat: vi.fn(),
      getMessageById: vi.fn(),
      getMessages: vi.fn(),
      getMessageCount: vi.fn(),
      appendMessage: vi.fn(),
      updateMessage: vi.fn(),
      deleteMessage: vi.fn(),
      getSiblings: vi.fn(),
    } as unknown as IChatRepository;

    autoTrigger = vi.fn();
    service = new GroupChatService(mockMembers, mockChats, { broadcastChatUpdated: vi.fn() } as unknown as import('./GroupChatService.js').GroupChatService['chatMetaBroadcast'], autoTrigger);
  });

  describe('getSettings / updateSettings', () => {
    it('returns default settings when no metadata exists', async () => {
      vi.mocked(mockChats.getChatById).mockResolvedValue(makeChat());
      const settings = await service.getSettings('chat-1');
      expect(settings.activationStrategy).toBe('NATURAL');
      expect(settings.autoModeEnabled).toBe(false);
    });

    it('returns persisted settings from metadata', async () => {
      vi.mocked(mockChats.getChatById).mockResolvedValue(
        makeChat({ activationStrategy: 'POOLED', pooledMaxMembers: 5 }),
      );
      const settings = await service.getSettings('chat-1');
      expect(settings.activationStrategy).toBe('POOLED');
      expect(settings.pooledMaxMembers).toBe(5);
    });

    it('updates settings in chat metadata', async () => {
      vi.mocked(mockChats.getChatById).mockResolvedValue(makeChat());
      vi.mocked(mockChats.mergeChatMetadata).mockImplementation(async (_id, partial) => {
        return makeChat(partial.groupChatSettings as GroupChatSettings);
      });

      const updated = await service.updateSettings('chat-1', { activationStrategy: 'LIST' });
      expect(updated.activationStrategy).toBe('LIST');
      expect(mockChats.mergeChatMetadata).toHaveBeenCalledWith('chat-1', {
        groupChatSettings: { activationStrategy: 'LIST' },
      });
    });
  });

  describe('NATURAL strategy', () => {
    it('returns all active members', async () => {
      vi.mocked(mockChats.getChatById).mockResolvedValue(makeChat());
      vi.mocked(mockMembers.getMembers).mockResolvedValue([
        makeMember({ characterId: 'char-a' }),
        makeMember({ characterId: 'char-b', enabled: false }),
        makeMember({ characterId: 'char-c' }),
      ]);

      const activated = await service.getActivatedMembers('chat-1', true);
      expect(activated).toEqual(['char-a', 'char-c']);
    });

    it('returns empty when no active members', async () => {
      vi.mocked(mockChats.getChatById).mockResolvedValue(makeChat());
      vi.mocked(mockMembers.getMembers).mockResolvedValue([makeMember({ enabled: false })]);

      const activated = await service.getActivatedMembers('chat-1', true);
      expect(activated).toEqual([]);
    });
  });

  describe('LIST strategy', () => {
    it('rotates through members on user send', async () => {
      let storedMeta: Record<string, unknown> = { groupChatSettings: { activationStrategy: 'LIST' } };
      vi.mocked(mockChats.getChatById).mockImplementation(async () => {
        return {
          ...makeChat({ activationStrategy: 'LIST' }),
          metadata: storedMeta,
        };
      });
      vi.mocked(mockChats.mergeChatMetadata).mockImplementation(async (_id, partial) => {
        storedMeta = { ...storedMeta, ...partial };
        return {
          ...makeChat({ activationStrategy: 'LIST' }),
          metadata: storedMeta,
        };
      });
      vi.mocked(mockMembers.getMembers).mockResolvedValue([
        makeMember({ characterId: 'char-a' }),
        makeMember({ characterId: 'char-b' }),
        makeMember({ characterId: 'char-c' }),
      ]);

      // First call
      let activated = await service.getActivatedMembers('chat-1', true);
      expect(activated).toEqual(['char-a']);

      // After first call, metadata would have lastListIndex = 0, so next is 1
      activated = await service.getActivatedMembers('chat-1', true);
      expect(activated).toEqual(['char-b']);

      // Next is 2
      activated = await service.getActivatedMembers('chat-1', true);
      expect(activated).toEqual(['char-c']);

      // Wraps around to 0
      activated = await service.getActivatedMembers('chat-1', true);
      expect(activated).toEqual(['char-a']);
    });
  });

  describe('MANUAL strategy', () => {
    it('returns only the selected character', async () => {
      vi.mocked(mockChats.getChatById).mockResolvedValue(
        makeChat({ activationStrategy: 'MANUAL', manualCharacterId: 'char-b' }),
      );
      vi.mocked(mockMembers.getMembers).mockResolvedValue([
        makeMember({ characterId: 'char-a' }),
        makeMember({ characterId: 'char-b' }),
      ]);

      const activated = await service.getActivatedMembers('chat-1', true);
      expect(activated).toEqual(['char-b']);
    });

    it('returns empty when selected character is not active', async () => {
      vi.mocked(mockChats.getChatById).mockResolvedValue(
        makeChat({ activationStrategy: 'MANUAL', manualCharacterId: 'char-x' }),
      );
      vi.mocked(mockMembers.getMembers).mockResolvedValue([makeMember({ characterId: 'char-a' })]);

      const activated = await service.getActivatedMembers('chat-1', true);
      expect(activated).toEqual([]);
    });
  });

  describe('POOLED strategy', () => {
    it('returns a subset of active members', async () => {
      vi.mocked(mockChats.getChatById).mockResolvedValue(
        makeChat({ activationStrategy: 'POOLED', pooledMinMembers: 1, pooledMaxMembers: 2 }),
      );
      vi.mocked(mockMembers.getMembers).mockResolvedValue([
        makeMember({ characterId: 'char-a' }),
        makeMember({ characterId: 'char-b' }),
        makeMember({ characterId: 'char-c' }),
      ]);

      const activated = await service.getActivatedMembers('chat-1', true);
      expect(activated.length).toBeGreaterThanOrEqual(1);
      expect(activated.length).toBeLessThanOrEqual(2);
    });

    it('weights by talkativeness', async () => {
      const seededService = new GroupChatService(
        mockMembers,
        mockChats,
        { broadcastChatUpdated: vi.fn() } as unknown as import('./GroupChatService.js').GroupChatService['chatMetaBroadcast'],
        autoTrigger,
        deterministicRng([0.5, 0.5]),
      );
      vi.mocked(mockChats.getChatById).mockResolvedValue(
        makeChat({ activationStrategy: 'POOLED', pooledMinMembers: 1, pooledMaxMembers: 1 }),
      );
      vi.mocked(mockMembers.getMembers).mockResolvedValue([
        makeMember({ characterId: 'char-quiet', talkativeness: 0.01 }),
        makeMember({ characterId: 'char-loud', talkativeness: 100 }),
      ]);

      // With rng=0.5: count = 1 + floor(0.5 * 1) = 1
      // random = 0.5 * 100.01 = 50.005
      // random -= 0.01 = 49.995 > 0
      // random -= 100 = -50.005 <= 0 → selects char-loud (index 1)
      const activated = await seededService.getActivatedMembers('chat-1', true);
      expect(activated).toEqual(['char-loud']);
    });

    it('selects quiet character with low rng value', async () => {
      const seededService = new GroupChatService(
        mockMembers,
        mockChats,
        { broadcastChatUpdated: vi.fn() } as unknown as import('./GroupChatService.js').GroupChatService['chatMetaBroadcast'],
        autoTrigger,
        deterministicRng([0.5, 0.00001]),
      );
      vi.mocked(mockChats.getChatById).mockResolvedValue(
        makeChat({ activationStrategy: 'POOLED', pooledMinMembers: 1, pooledMaxMembers: 1 }),
      );
      vi.mocked(mockMembers.getMembers).mockResolvedValue([
        makeMember({ characterId: 'char-quiet', talkativeness: 0.01 }),
        makeMember({ characterId: 'char-loud', talkativeness: 100 }),
      ]);

      // With rng=0.00001: count = 1 + floor(0.5 * 1) = 1
      // random = 0.00001 * 100.01 = 0.0010001
      // random -= 0.01 = -0.0089999 <= 0 → selects char-quiet (index 0)
      const activated = await seededService.getActivatedMembers('chat-1', true);
      expect(activated).toEqual(['char-quiet']);
    });
  });

  describe('auto-mode', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('starts and triggers auto-mode', async () => {
      vi.mocked(mockChats.getChatById).mockResolvedValue(
        makeChat({ autoModeEnabled: true, autoModeIntervalSeconds: 5 }),
      );
      vi.mocked(mockMembers.getMembers).mockResolvedValue([makeMember()]);

      await service.startAutoMode('chat-1');
      expect(autoTrigger).not.toHaveBeenCalled();

      vi.advanceTimersByTime(5000);
      expect(autoTrigger).toHaveBeenCalledWith('chat-1');
    });

    it('does not start when auto-mode is disabled', async () => {
      vi.mocked(mockChats.getChatById).mockResolvedValue(makeChat({ autoModeEnabled: false }));

      await service.startAutoMode('chat-1');
      vi.advanceTimersByTime(30000);
      expect(autoTrigger).not.toHaveBeenCalled();
    });

    it('stops auto-mode', async () => {
      vi.mocked(mockChats.getChatById).mockResolvedValue(
        makeChat({ autoModeEnabled: true, autoModeIntervalSeconds: 5 }),
      );
      vi.mocked(mockMembers.getMembers).mockResolvedValue([makeMember()]);

      await service.startAutoMode('chat-1');
      service.stopAutoMode('chat-1');

      vi.advanceTimersByTime(10000);
      expect(autoTrigger).not.toHaveBeenCalled();
    });

    it('stops all timers', async () => {
      vi.mocked(mockChats.getChatById).mockResolvedValue(
        makeChat({ autoModeEnabled: true, autoModeIntervalSeconds: 5 }),
      );
      vi.mocked(mockMembers.getMembers).mockResolvedValue([makeMember()]);

      await service.startAutoMode('chat-1');
      await service.startAutoMode('chat-2');
      service.stopAll();

      vi.advanceTimersByTime(10000);
      expect(autoTrigger).not.toHaveBeenCalled();
    });
  });
});
