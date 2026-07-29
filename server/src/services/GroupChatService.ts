import type { IChatMemberRepository } from '../repos/ChatMemberRepository.js';
import type { IChatRepository } from '../repos/ChatRepository.js';
import { getLogger } from '../lib/logger.js';

const log = getLogger('GroupChatService');

/**
 * How group members are activated when the user sends a message
 * or auto-mode triggers a round.
 */
export type ActivationStrategy = 'NATURAL' | 'LIST' | 'MANUAL' | 'POOLED';

export interface GroupChatSettings {
  activationStrategy: ActivationStrategy;
  /** Character ID forced in MANUAL mode */
  manualCharacterId: string | null;
  /** Whether auto-mode is enabled for this group */
  autoModeEnabled: boolean;
  /** Interval in seconds between auto-mode rounds */
  autoModeIntervalSeconds: number;
  /** Minimum number of members that respond in POOLED mode */
  pooledMinMembers: number;
  /** Maximum number of members that respond in POOLED mode */
  pooledMaxMembers: number;
  /** Number of turns to wait before a member can speak again (NATURAL/POOLED) */
  cooldownTurns: number;
}

const DEFAULT_GROUP_SETTINGS: GroupChatSettings = {
  activationStrategy: 'NATURAL',
  manualCharacterId: null,
  autoModeEnabled: false,
  autoModeIntervalSeconds: 30,
  pooledMinMembers: 1,
  pooledMaxMembers: 3,
  cooldownTurns: 0,
};

/**
 * Service for group chat member activation and auto-mode orchestration.
 *
 * Activation strategies:
 * - NATURAL: All active members respond (useful for simultaneous replies).
 * - LIST: Members respond one-at-a-time in fixed list order (round-robin).
 * - MANUAL: Only the selected member responds.
 * - POOLED: Random subset of active members, weighted by talkativeness.
 */
export class GroupChatService {
  private autoTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private rng: () => number;

  constructor(
    private chatMembers: IChatMemberRepository,
    private chats: IChatRepository,
    private chatMetaBroadcast: import('./ChatMetaBroadcastService.js').ChatMetaBroadcastService,
    private onAutoTrigger: (chatId: string) => void | Promise<void>,
    rng?: () => number,
  ) {
    this.rng = rng ?? Math.random;
  }

  /**
   * Get group settings for a chat from chat metadata.
   */
  async getSettings(chatId: string): Promise<GroupChatSettings> {
    const chat = await this.chats.getChatById(chatId);
    const meta = (chat?.metadata) ?? {};
    const settings = meta.groupChatSettings as Partial<GroupChatSettings> | undefined;
    return { ...DEFAULT_GROUP_SETTINGS, ...settings };
  }

  /**
   * Update group settings in chat metadata.
   */
  async updateSettings(chatId: string, patch: Partial<GroupChatSettings>): Promise<GroupChatSettings> {
    const chat = await this.chats.getChatById(chatId);
    if (!chat) throw new Error('Chat not found');
    // Atomic deep-merge of just the settings patch (SQLite json_patch) — avoids the
    // read-modify-write race that could clobber unrelated metadata keys.
    const updatedChat = await this.chats.mergeChatMetadata(chatId, { groupChatSettings: patch });
    this.chatMetaBroadcast.broadcastChatUpdated(updatedChat);
    const stored = (updatedChat.metadata.groupChatSettings as Partial<GroupChatSettings> | undefined) ?? {};
    return { ...DEFAULT_GROUP_SETTINGS, ...stored };
  }

  /**
   * Determine which characters should generate a response for the current turn.
   *
   * @param chatId - The group chat ID.
   * @param isUserInitiated - Whether this was triggered by the user pressing Send.
   * @returns Ordered list of character IDs that should respond.
   */
  async getActivatedMembers(chatId: string, isUserInitiated: boolean): Promise<string[]> {
    const groupSettings = await this.getSettings(chatId);
    const members = await this.chatMembers.getMembers(chatId);
    const activeMembers = members.filter((m) => m.enabled);

    if (activeMembers.length === 0) return [];

    switch (groupSettings.activationStrategy) {
      case 'NATURAL':
        return this.resolveNatural(activeMembers);
      case 'LIST':
        return this.resolveList(chatId, activeMembers, isUserInitiated);
      case 'MANUAL':
        return this.resolveManual(activeMembers, groupSettings);
      case 'POOLED':
        return this.resolvePooled(activeMembers, groupSettings);
      default:
        return activeMembers.map((m) => m.characterId);
    }
  }

  /** NATURAL: All active members respond. */
  private resolveNatural(
    activeMembers: Awaited<ReturnType<IChatMemberRepository['getMembers']>>,
  ): string[] {
    return activeMembers.map((m) => m.characterId);
  }

  /** LIST: Round-robin through active members in insertion order. */
  private async resolveList(
    chatId: string,
    activeMembers: Awaited<ReturnType<IChatMemberRepository['getMembers']>>,
    isUserInitiated: boolean,
  ): Promise<string[]> {
    if (activeMembers.length === 0) return [];

    const chat = await this.chats.getChatById(chatId);
    const meta = (chat?.metadata) ?? {};
    const lastListIndex = (meta.lastListIndex as number | undefined) ?? -1;

    // On user send, advance to next member
    if (isUserInitiated) {
      const nextIndex = (lastListIndex + 1) % activeMembers.length;
      const updatedChat = await this.chats.mergeChatMetadata(chatId, { lastListIndex: nextIndex });
      this.chatMetaBroadcast.broadcastChatUpdated(updatedChat);
      return [activeMembers[nextIndex]!.characterId];
    }

    // Auto-mode or regeneration: use current position
    const currentIndex = Math.max(0, lastListIndex + 1) % activeMembers.length;
    return [activeMembers[currentIndex]!.characterId];
  }

  /** MANUAL: Only the manually-selected member responds. */
  private resolveManual(
    activeMembers: Awaited<ReturnType<IChatMemberRepository['getMembers']>>,
    settings: GroupChatSettings,
  ): string[] {
    if (!settings.manualCharacterId) return [];
    const found = activeMembers.find((m) => m.characterId === settings.manualCharacterId);
    return found ? [found.characterId] : [];
  }

  /** POOLED: Random subset weighted by talkativeness. */
  private resolvePooled(
    activeMembers: Awaited<ReturnType<IChatMemberRepository['getMembers']>>,
    settings: GroupChatSettings,
  ): string[] {
    const min = Math.max(1, Math.min(settings.pooledMinMembers, activeMembers.length));
    const max = Math.max(min, Math.min(settings.pooledMaxMembers, activeMembers.length));
    const count = min + Math.floor(this.rng() * (max - min + 1));

    // Weighted random selection without replacement
    const pool = [...activeMembers];
    const selected: string[] = [];
    let totalTalkativeness = pool.reduce((sum, m) => sum + m.talkativeness, 0);

    for (let i = 0; i < count && pool.length > 0; i++) {
      let random = this.rng() * totalTalkativeness;
      let selectedIndex = 0;
      for (let j = 0; j < pool.length; j++) {
        random -= pool[j]!.talkativeness;
        if (random <= 0) {
          selectedIndex = j;
          break;
        }
      }
      selected.push(pool[selectedIndex]!.characterId);
      totalTalkativeness -= pool[selectedIndex]!.talkativeness;
      pool.splice(selectedIndex, 1);
    }

    return selected;
  }

  // ------------------------------------------------------------------
  // Auto-mode
  // ------------------------------------------------------------------

  /**
   * Start auto-mode for a group chat.
   */
  async startAutoMode(chatId: string): Promise<void> {
    this.stopAutoMode(chatId);
    const groupSettings = await this.getSettings(chatId);
    if (!groupSettings.autoModeEnabled) return;

    const intervalMs = groupSettings.autoModeIntervalSeconds * 1000;
    const schedule = () => {
      const timer = setTimeout(() => {
        // setTimeout expects a void callback; wrap the async turn and surface
        // any rejection instead of letting it vanish as an unhandled rejection.
        (async () => {
          try {
            await this.onAutoTrigger(chatId);
          } finally {
            // Re-schedule only if the timer is still registered
            // (it may have been stopped during the callback)
            if (this.autoTimers.has(chatId)) {
              schedule();
            }
          }
        })().catch((err) => {
          log.error({ err, chatId }, 'auto-mode tick failed');
        });
      }, intervalMs);
      this.autoTimers.set(chatId, timer);
    };
    schedule();
  }

  /**
   * Stop auto-mode for a group chat.
   */
  stopAutoMode(chatId: string): void {
    const timer = this.autoTimers.get(chatId);
    if (timer) {
      clearTimeout(timer);
      this.autoTimers.delete(chatId);
    }
  }

  /**
   * Restart auto-mode if settings changed.
   */
  async restartAutoMode(chatId: string): Promise<void> {
    const groupSettings = await this.getSettings(chatId);
    this.stopAutoMode(chatId);
    if (groupSettings.autoModeEnabled) {
      await this.startAutoMode(chatId);
    }
  }

  /**
   * Stop all auto-mode timers.
   */
  stopAll(): void {
    for (const [chatId, timer] of this.autoTimers) {
      clearTimeout(timer);
      this.autoTimers.delete(chatId);
    }
  }
}
