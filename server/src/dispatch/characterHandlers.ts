/**
 * `character.*` messages — selection, CRUD, avatar/asset cleanup.
 */

import { randomUUID } from 'node:crypto';
import {
  toCharacterSummary,
  withCharacterAvatar,
  withCharacterAssets,
} from '../lib/summaries.js';
import { maybeRebroadcastGreetingSnapshot } from './helpers.js';
import { broadcastQuickReplyList } from '../services/quickReplyBroadcast.js';
import type { DispatcherDeps, Handlers } from './types.js';

export function buildCharacterHandlers(
  deps: DispatcherDeps,
): Handlers<'character.select' | 'character.create' | 'character.update' | 'character.delete'> {
  const {
    bus,
    characters,
    characterAssets,
    chats,
    storage,
    quickReplies,
    chatBroadcast,
  } = deps;

  return {
    'character.select': async (client, msg) => {
      const character = await characters.getById(msg.characterId);
      if (!character) {
        bus.sendTo(client.id, { type: 'error', message: 'Character not found', code: 'NOT_FOUND' });
        return;
      }
      const assetList = await characterAssets.listForCharacter(character.id);
      bus.broadcast({ type: 'character.snapshot', character: withCharacterAssets(withCharacterAvatar(character), assetList) }, client.id);
    },

    'character.create': async (client, msg) => {
      const id = randomUUID();
      const character = await characters.create(id, { ...msg.data, avatarPath: null });
      const withAvatar = withCharacterAvatar(character);
      bus.broadcast({ type: 'character.created', character: withAvatar }, client.id);
      const assetList = await characterAssets.listForCharacter(character.id);
      bus.broadcast({ type: 'character.snapshot', character: withCharacterAssets(withAvatar, assetList) }, client.id);
      const list = await characters.listSummaries();
      bus.broadcast({ type: 'character.listed', characters: list.items.map(toCharacterSummary) }, client.id);
    },

    'character.update': async (client, msg) => {
      const character = await characters.update(msg.characterId, msg.patch);
      const assetList = await characterAssets.listForCharacter(character.id);
      const enriched = withCharacterAssets(withCharacterAvatar(character), assetList);
      bus.broadcast({ type: 'character.updated', character: enriched }, client.id);
      bus.broadcast({ type: 'character.snapshot', character: enriched }, client.id);
      const list = await characters.listSummaries();
      bus.broadcast({ type: 'character.listed', characters: list.items.map(toCharacterSummary) }, client.id);
      const chatList = await chats.listChats({ characterId: msg.characterId, limit: 0 });
      for (const chat of chatList.items) {
        await maybeRebroadcastGreetingSnapshot(chatBroadcast, chat, client.id);
      }
    },

    'character.delete': async (client, msg) => {
      const char = await characters.getById(msg.characterId);
      if (char?.avatarPath) storage.delete(char.avatarPath);
      // Clean up asset files
      const assetList = await characterAssets.listForCharacter(msg.characterId);
      for (const asset of assetList) {
        if (asset.filePath) storage.delete(asset.filePath);
      }
      await quickReplies.deleteByScope('character', msg.characterId);
      await characters.delete(msg.characterId);
      if (char?.avatarThumbnailPath) storage.delete(char.avatarThumbnailPath);
      bus.broadcast({ type: 'character.deleted', characterId: msg.characterId }, client.id);
      const list = await characters.listSummaries();
      bus.broadcast({ type: 'character.listed', characters: list.items.map(toCharacterSummary) }, client.id);
      // The character-scoped quick replies are gone too — converge QR lists (§5).
      await broadcastQuickReplyList(bus, quickReplies, client.id);
    },
  };
}
