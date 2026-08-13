import type { Message, MessageExtra, Character, CharacterAsset, RegexRule } from '@tamari/types';
import type { EventBus } from '../bus/EventBus.js';
import type {
  IChatRepository,
  ICharacterRepository,
  IPersonaRepository,
  ISettingsRepository,
  ICharacterAssetRepository,
} from '../repos/index.js';
import { getChatSnapshotMessages } from '../lib/swipeInfo.js';
import { renderMessageParts, renderTextPartHtml, renderMarkdownToHtml, type DisplayRenderContext } from './DisplayRenderer.js';
import { applyRules, filterRulesByRole } from './RegexEngine.js';
import { mergeRegexRules } from './characterRegex.js';
import {
  withCharacterAvatar,
  withCharacterAssets,
  withPersonaAvatar,
  withChatUrls,
} from '../lib/summaries.js';
import { resolveHtmlImages } from '../lib/resolveHtmlImages.js';
import { MacroResolver } from '../pipeline/MacroResolver.js';

export interface ChatBroadcastServiceDeps {
  bus: EventBus;
  chats: IChatRepository;
  characters: ICharacterRepository;
  personas: IPersonaRepository;
  settings: ISettingsRepository;
  characterAssets?: ICharacterAssetRepository;
}

export class ChatBroadcastService {
  constructor(private deps: ChatBroadcastServiceDeps) {}

  async broadcastSnapshot(chatId: string, limit?: number, excludeClientId?: string): Promise<void> {
    const chat = await this.deps.chats.getChatById(chatId);
    if (!chat) throw new Error('Chat not found');

    const { bulk, swipes } = await getChatSnapshotMessages(this.deps.chats, chat.id, limit ?? 100);
    const character = chat.characterId ? await this.deps.characters.getById(chat.characterId) : undefined;
    const persona = chat.personaId ? await this.deps.personas.getById(chat.personaId) : undefined;

    let greeting: string | undefined;
    const greetingAssets: Record<string, string> = {};
    let greetingAssetList: CharacterAsset[] = [];
    let enrichedCharacter: Character | undefined;
    if (character) {
      const withAvatar = withCharacterAvatar(character);
      const assetList = this.deps.characterAssets
        ? await this.deps.characterAssets.listForCharacter(character.id)
        : [];
      enrichedCharacter = withCharacterAssets(withAvatar, assetList);
      if (bulk.length === 0) {
        const greetings: string[] = [];
        if (character.firstMes.trim()) greetings.push(character.firstMes.trim());
        for (const alt of character.alternateGreetings) {
          if (alt.trim()) greetings.push(alt.trim());
        }
        const selectedIndex = Number(chat.metadata.selectedGreetingIndex ?? 0);
        const index = Math.max(0, Math.min(selectedIndex, greetings.length - 1));
        const rawGreeting = greetings[index];
        if (rawGreeting) {
          const resolver = MacroResolver.createStorageResolver();
          const risuExt = (character.extensions.risuai ?? {}) as Record<string, unknown>;
          const macroVars: Record<string, string> = {};
          if (typeof risuExt.defaultVariables === 'string') {
            for (const line of (risuExt.defaultVariables).split('\n')) {
              const idx = line.indexOf('=');
              if (idx !== -1) {
                const key = line.slice(0, idx).trim();
                const value = line.slice(idx + 1).trim();
                if (key) macroVars[key] = value;
              }
            }
          }
          for (const asset of assetList) {
            if (asset.name) {
              greetingAssets[asset.name] = `/api/characters/${character.id}/assets/${asset.id}.${asset.ext}`;
            }
          }
          const settingsUserName = (await this.deps.settings.getTyped()).userName;
          const userName = persona?.name || settingsUserName || 'User';
          const macroCtx = {
            userName,
            charName: character.name,
            description: character.description,
            personality: character.personality,
            scenario: character.scenario,
            macroVars,
            characterAssets: greetingAssets,
          };
          greeting = resolver.resolve(rawGreeting, macroCtx);
          // Raw <img src="..."> URLs are resolved later, at display time —
          // after display regexes, mirroring renderTextPart's ordering.
          greetingAssetList = assetList;
        }
      }
    }

    // Enrich messages with canonical names/avatars so the client never has
    // to derive them via state.characters.find() or state.personas.find().
    let enrichedMessages = bulk;
    let enrichedSwipes = swipes;
    if (bulk.length > 0 || swipes.length > 0) {
      const charIds = new Set<string>();
      const personaIds = new Set<string>();
      for (const msg of [...bulk, ...swipes]) {
        if (typeof msg.extra.characterId === 'string') charIds.add(msg.extra.characterId);
        if (typeof msg.extra.personaId === 'string') personaIds.add(msg.extra.personaId);
      }
      const charMap = new Map<string, { name: string; url: string | null }>();
      const personaMap = new Map<string, { name: string; url: string | null }>();
      if (charIds.size > 0) {
        for (const c of await this.deps.characters.getByIds([...charIds])) {
          charMap.set(c.id, { name: c.name, url: c.thumbnailUrl ?? c.avatarUrl ?? null });
        }
      }
      if (personaIds.size > 0) {
        for (const p of await this.deps.personas.getByIds([...personaIds])) {
          personaMap.set(p.id, { name: p.name, url: p.thumbnailUrl ?? p.avatarUrl ?? null });
        }
      }
      const enrich = (msg: Message): Message => {
        const nextExtra: MessageExtra = { ...msg.extra };
        const charMeta = typeof msg.extra.characterId === 'string' ? charMap.get(msg.extra.characterId) : undefined;
        if (charMeta) {
          nextExtra.characterName = charMeta.name;
          if (charMeta.url) nextExtra.characterAvatarUrl = charMeta.url;
        }
        const personaMeta = typeof msg.extra.personaId === 'string' ? personaMap.get(msg.extra.personaId) : undefined;
        if (personaMeta) {
          nextExtra.personaName = personaMeta.name;
          if (personaMeta.url) nextExtra.personaAvatarUrl = personaMeta.url;
        }
        return { ...msg, extra: nextExtra };
      };
      enrichedMessages = bulk.map(enrich);
      enrichedSwipes = swipes.map(enrich);
    }

    // Compute renderedHtml for all messages and swipes
    const allSettings = await this.deps.settings.list();
    const regexRules = mergeRegexRules((allSettings['regexRules'] as RegexRule[] | undefined) ?? [], character);
    const strictHtml = Boolean(allSettings['strictHtmlSanitization']);
    const settingsUserName = (await this.deps.settings.getTyped()).userName;
    const userName = settingsUserName || persona?.name || 'User';
    const charName = character?.name ?? 'Character';
    const greetingDisplayRules = filterRulesByRole(regexRules, 'display', 'assistant');
    let greetingHtml: string | undefined;
    if (greeting) {
      let greetingText = await applyRules(greeting, greetingDisplayRules);
      // Display macros (img) — virtual greetings resolve character assets the
      // same way materialized messages do, instead of showing literal macro text.
      const displayResolver = MacroResolver.createDisplayResolver();
      greetingText = displayResolver.resolve(greetingText, { userName, charName, characterAssets: greetingAssets });
      // Resolve raw <img src="..."> asset URLs — display-only, after regexes
      // and macros, same ordering as renderTextPart.
      if (character) {
        greetingText = resolveHtmlImages(greetingText, greetingAssetList, character.id);
      }
      greetingHtml = renderMarkdownToHtml(greetingText, strictHtml);
    }
    const chatCharacterAssets = character && this.deps.characterAssets
      ? await this.deps.characterAssets.listForCharacter(character.id)
      : [];

    const renderMessage = async (msg: Message): Promise<Message> => {
      if (msg.role === 'tool') return msg;
      const html = await renderMessageParts({
        message: msg,
        character,
        characterAssets: chatCharacterAssets,
        regexRules,
        strictHtmlSanitization: strictHtml,
        userName,
        charName,
      });
      return { ...msg, renderedHtml: html };
    };

    enrichedMessages = await Promise.all(enrichedMessages.map(renderMessage));
    enrichedSwipes = await Promise.all(enrichedSwipes.map(renderMessage));

    this.deps.bus.broadcast(
      {
        type: 'chat.snapshot',
        chat: withChatUrls(chat),
        messages: enrichedMessages,
        swipes: enrichedSwipes,
        character: enrichedCharacter,
        persona: persona ? withPersonaAvatar(persona) : undefined,
        greeting,
        greetingHtml,
      },
      excludeClientId,
    );
  }

  async broadcastMessageSnapshot(
    chatId: string,
    messageId: number,
    excludeClientId?: string,
  ): Promise<void> {
    const message = await this.deps.chats.getMessageById(messageId);
    if (!message) throw new Error('Message not found');

    const chat = await this.deps.chats.getChatById(chatId);
    if (!chat) throw new Error('Chat not found');

    const renderedMessage = await this.renderSingleMessage(chat, message);
    this.deps.bus.broadcast(
      {
        type: 'message.snapshot',
        chatId,
        message: renderedMessage,
      },
      excludeClientId,
    );
  }

  async broadcastMessageAppended(chatId: string, messageId: number, excludeClientId?: string): Promise<void> {
    const message = await this.deps.chats.getMessageById(messageId);
    if (!message) throw new Error('Message not found');

    const chat = await this.deps.chats.getChatById(chatId);
    if (!chat) throw new Error('Chat not found');

    const renderedMessage = await this.renderSingleMessage(chat, message);
    this.deps.bus.broadcast(
      {
        type: 'message.appended',
        chatId,
        message: renderedMessage,
      },
      excludeClientId,
    );
  }

  /**
   * Broadcast a single-part update (streaming flush path). Replaces (or, when
   * partIndex is one past the end, appends) one part client-side — the client
   * re-renders only that part instead of the whole message.
   */
  async broadcastPartSnapshot(
    chatId: string,
    messageId: number,
    partIndex: number,
    excludeClientId?: string,
  ): Promise<void> {
    const message = await this.deps.chats.getMessageById(messageId);
    if (!message) throw new Error('Message not found');

    const chat = await this.deps.chats.getChatById(chatId);
    if (!chat) throw new Error('Chat not found');

    const part = message.extra.parts?.[partIndex];
    if (!part) return;

    let renderedHtml: string | null = null;
    if (message.role !== 'tool' && part.type === 'text' && part.text.trim()) {
      const ctx = await this.buildDisplayContext(chat, message);
      renderedHtml = await renderTextPartHtml(part.text, ctx);
    }

    this.deps.bus.broadcast(
      {
        type: 'part.snapshot',
        chatId,
        messageId,
        partIndex,
        part,
        renderedHtml,
      },
      excludeClientId,
    );
  }

  /** Assemble the DisplayRenderContext shared by full-message and per-part rendering. */
  private async buildDisplayContext(
    chat: NonNullable<Awaited<ReturnType<IChatRepository['getChatById']>>>,
    message: Message,
  ): Promise<DisplayRenderContext> {
    const character = chat.characterId ? await this.deps.characters.getById(chat.characterId) : undefined;
    const persona = chat.personaId ? await this.deps.personas.getById(chat.personaId) : undefined;

    const allSettings = await this.deps.settings.list();
    const regexRules = mergeRegexRules((allSettings['regexRules'] as RegexRule[] | undefined) ?? [], character);
    const strictHtml = Boolean(allSettings['strictHtmlSanitization']);
    const settingsUserName = (await this.deps.settings.getTyped()).userName;
    const userName = settingsUserName || persona?.name || 'User';
    const charName = character?.name ?? 'Character';
    const characterAssets = character && this.deps.characterAssets
      ? await this.deps.characterAssets.listForCharacter(character.id)
      : [];

    return {
      message,
      character,
      characterAssets,
      regexRules,
      strictHtmlSanitization: strictHtml,
      userName,
      charName,
    };
  }

  private async renderSingleMessage(
    chat: NonNullable<Awaited<ReturnType<IChatRepository['getChatById']>>>,
    message: Message,
  ): Promise<Message> {
    if (message.role === 'tool') return message;

    // Enrich with canonical names/avatars
    const charIds = new Set<string>();
    const personaIds = new Set<string>();
    if (typeof message.extra.characterId === 'string') charIds.add(message.extra.characterId);
    if (typeof message.extra.personaId === 'string') personaIds.add(message.extra.personaId);

    const charMap = new Map<string, { name: string; url: string | null }>();
    const personaMap = new Map<string, { name: string; url: string | null }>();
    if (charIds.size > 0) {
      for (const c of await this.deps.characters.getByIds([...charIds])) {
        charMap.set(c.id, { name: c.name, url: c.thumbnailUrl ?? c.avatarUrl ?? null });
      }
    }
    if (personaIds.size > 0) {
      for (const p of await this.deps.personas.getByIds([...personaIds])) {
        personaMap.set(p.id, { name: p.name, url: p.thumbnailUrl ?? p.avatarUrl ?? null });
      }
    }

    const nextExtra: MessageExtra = { ...message.extra };
    const charMeta = typeof message.extra.characterId === 'string' ? charMap.get(message.extra.characterId) : undefined;
    if (charMeta) {
      nextExtra.characterName = charMeta.name;
      if (charMeta.url) nextExtra.characterAvatarUrl = charMeta.url;
    }
    const personaMeta = typeof message.extra.personaId === 'string' ? personaMap.get(message.extra.personaId) : undefined;
    if (personaMeta) {
      nextExtra.personaName = personaMeta.name;
      if (personaMeta.url) nextExtra.personaAvatarUrl = personaMeta.url;
    }
    const enrichedMessage = { ...message, extra: nextExtra };

    const ctx = await this.buildDisplayContext(chat, enrichedMessage);
    const html = await renderMessageParts(ctx);

    return { ...enrichedMessage, renderedHtml: html };
  }
}
