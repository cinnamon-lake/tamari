/**
 * Lazy greeting materialization.
 *
 * Greetings (firstMes + alternateGreetings) live on the character card
 * and are displayed as virtual messages until the user engages with the chat.
 * At that point they are inserted into the message tree as sibling messages
 * with parentId = null, each becoming a potential branch root.
 */

import type { EventBus } from '../bus/EventBus.js';
import type { IChatRepository } from '../repos/ChatRepository.js';
import type { ICharacterAssetRepository } from '../repos/CharacterAssetRepository.js';
import type { IPersonaRepository } from '../repos/PersonaRepository.js';
import type { Character } from '@tamari/types';
import type { ChatBroadcastService } from '../services/ChatBroadcastService.js';
import { MacroResolver } from '../pipeline/MacroResolver.js';

export interface GreetingMaterializerDeps {
  bus: EventBus;
  chats: IChatRepository;
  chatBroadcast: ChatBroadcastService;
  assets?: ICharacterAssetRepository;
  personas?: IPersonaRepository;
  userName?: string;
}

function parseRisuDefaultVariables(raw: unknown): Record<string, string> {
  if (typeof raw !== 'string') return {};
  const vars: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) vars[key] = value;
  }
  return vars;
}

function buildAssetMap(character: Character, assetList: Array<{ name: string; id: string; ext: string }>): Record<string, string> {
  const map: Record<string, string> = {};
  for (const asset of assetList) {
    if (asset.name) {
      map[asset.name] = `/api/characters/${character.id}/assets/${asset.id}.${asset.ext}`;
    }
  }
  return map;
}

export async function materializeGreetings(
  deps: GreetingMaterializerDeps,
  chatId: string,
  character: Character,
  selectedIndex: number,
): Promise<void> {
  const { chats, chatBroadcast, assets, personas } = deps;

  const greetings: string[] = [];
  if (character.firstMes.trim()) {
    greetings.push(character.firstMes.trim());
  }
  for (const alt of character.alternateGreetings) {
    if (alt.trim()) greetings.push(alt.trim());
  }

  if (greetings.length === 0) {
    // No greeting to materialize: mark the chat materialized and broadcast
    // anyway — otherwise the client's materializeChat() promise never
    // resolves and the Send button silently dead-ends on an empty timeline.
    await chats.updateChat(chatId, { materialized: true });
    await chatBroadcast.broadcastSnapshot(chatId);
    return;
  }

  const index = Math.max(0, Math.min(selectedIndex, greetings.length - 1));
  let selectedGreeting = greetings[index] ?? '';

  // Resolve userName: explicit setting > persona name > 'User'
  let userName = deps.userName;
  if ((!userName || userName === 'User') && personas) {
    const chat = await chats.getChatById(chatId);
    if (chat?.personaId) {
      const persona = await personas.getById(chat.personaId);
      if (persona?.name) userName = persona.name;
    }
  }

  // Resolve macros in greeting (RisuAI compatibility)
  const resolver = MacroResolver.createStorageResolver();
  const risuExt = (character.extensions.risuai ?? {}) as Record<string, unknown>;
  const macroVars = parseRisuDefaultVariables(risuExt.defaultVariables);

  let characterAssets: Record<string, string> = {};
  if (assets) {
    const assetList = await assets.listForCharacter(character.id);
    characterAssets = buildAssetMap(character, assetList);
  }

  const macroCtx = {
    userName: userName ?? 'User',
    charName: character.name,
    description: character.description,
    personality: character.personality,
    scenario: character.scenario,
    macroVars,
    characterAssets,
  };

  selectedGreeting = resolver.resolve(selectedGreeting, macroCtx);

  // Capture any {{setvar}} assignments made during greeting resolution
  const greetingVariables = { ...macroCtx.macroVars };

  // NOTE: raw HTML <img src="..."> tags are intentionally NOT resolved here —
  // resolveHtmlImages is display-only (see DisplayRenderer.renderTextPart) so
  // stored messages keep the original card text and display regexes see it
  // as authored.

  const msg = await chats.appendMessage(chatId, {
    role: 'assistant',
    extra: { characterId: character.id, macroVars: greetingVariables, parts: [{ type: 'text', text: selectedGreeting }] },
    parentId: null,
  });

  await chats.updateChat(chatId, { headMessageId: null, activeChildId: msg.id, materialized: true });

  await chatBroadcast.broadcastSnapshot(chatId);
}
