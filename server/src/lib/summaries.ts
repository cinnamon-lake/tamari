/**
 * Map full database entities to lightweight summary objects for client list views.
 */

import type {
  Character,
  CharacterAsset,
  CharacterSummary,
  Chat,
  ChatMember,
  ChatMemberSummary,
  ChatSummary,
  Persona,
  PersonaSummary,
  BackendConfig,
  BackendConfigSummary,
  PromptList,
  PromptListSummary,
} from '@tamari/types';

function fileUrl(filePath: string | null): string | null {
  return filePath ? `/${filePath}` : null;
}

export function toCharacterSummary(
  char: Pick<Character, 'id' | 'name' | 'tags' | 'avatarPath' | 'avatarThumbnailPath' | 'external' | 'createdAt' | 'updatedAt'>,
): CharacterSummary {
  return {
    id: char.id,
    name: char.name,
    tags: char.tags,
    avatarUrl: fileUrl(char.avatarPath),
    thumbnailUrl: fileUrl(char.avatarThumbnailPath),
    exportUrl: `/api/characters/${char.id}/export?format=v3`,
    external: char.external,
    createdAt: char.createdAt,
    updatedAt: char.updatedAt,
  };
}

export function toPersonaSummary(
  persona: Pick<Persona, 'id' | 'name' | 'description' | 'avatarPath' | 'avatarThumbnailPath'>,
): PersonaSummary {
  return {
    id: persona.id,
    name: persona.name,
    description: persona.description,
    avatarUrl: fileUrl(persona.avatarPath),
    thumbnailUrl: fileUrl(persona.avatarThumbnailPath),
    avatarUploadUrl: `/api/personas/${persona.id}/avatar`,
  };
}

export function toBackendConfigSummary(backendConfig: Pick<BackendConfig, 'id' | 'name'>): BackendConfigSummary {
  return {
    id: backendConfig.id,
    name: backendConfig.name,
  };
}

export function toPromptListSummary(promptList: Pick<PromptList, 'id' | 'name'>): PromptListSummary {
  return {
    id: promptList.id,
    name: promptList.name,
  };
}

/** Enrich a full Character with its canonical avatar URL. */
export function withCharacterAvatar<T extends Character>(char: T): T {
  return {
    ...char,
    avatarUrl: fileUrl(char.avatarPath),
    thumbnailUrl: fileUrl(char.avatarThumbnailPath),
    exportUrl: `/api/characters/${char.id}/export?format=v3`,
    charxUrl: `/api/characters/${char.id}/export?format=charx`,
    avatarUploadUrl: `/api/characters/${char.id}/avatar`,
  };
}

/** Enrich a full Character with its asset list and canonical asset URLs. */
export function withCharacterAssets<T extends Character>(char: T, assets: CharacterAsset[]): T & { assets: Array<CharacterAsset & { assetUrl: string | null; uri: string | null }> } {
  const enrichedAssets = assets.map((a) => ({
    ...a,
    assetUrl: a.filePath ? `/api/characters/${char.id}/assets/${a.id}.${a.ext}` : null,
    uri: (a.meta as Record<string, string> | undefined)?.zipPath
      ? `embeded://${(a.meta as Record<string, string>).zipPath}`
      : null,
  }));
  return { ...char, assets: enrichedAssets };
}

export function toChatSummary(
  chat: Pick<Chat, 'id' | 'characterId' | 'name' | 'createdAt' | 'updatedAt' | 'forkedFromChatId' | 'forkedAtMessageId'>,
): ChatSummary {
  return {
    id: chat.id,
    characterId: chat.characterId,
    name: chat.name,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    forkedFromChatId: chat.forkedFromChatId,
    forkedAtMessageId: chat.forkedAtMessageId,
  };
}

/** Enrich a Chat with its canonical export URLs. */
export function withChatUrls<T extends Chat>(chat: T): T {
  return {
    ...chat,
    jsonlExportUrl: `/api/chats/${chat.id}/export?format=jsonl`,
    txtExportUrl: `/api/chats/${chat.id}/export?format=txt`,
  };
}

/** Enrich a full Persona with its canonical avatar URL. */
export function withPersonaAvatar<T extends Persona>(persona: T): T {
  return {
    ...persona,
    avatarUrl: fileUrl(persona.avatarPath),
    thumbnailUrl: fileUrl(persona.avatarThumbnailPath),
    avatarUploadUrl: `/api/personas/${persona.id}/avatar`,
  };
}

/** Enrich a ChatMember with canonical character name and avatar URLs. */
export function toChatMemberSummary(member: ChatMember, char: Character): ChatMemberSummary {
  return {
    ...member,
    characterName: char.name,
    characterAvatarUrl: fileUrl(char.avatarPath),
    characterThumbnailUrl: fileUrl(char.avatarThumbnailPath),
  };
}
