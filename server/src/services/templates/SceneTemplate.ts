import { z } from 'zod';
import type { Character, CharacterAsset } from '@tamari/types';
import type { ToolRegistry } from '../ToolRegistry.js';
import type { ToolContext, ToolExecuteResult, ToolTemplate } from '../ToolTemplate.js';
import type { ICharacterAssetRepository } from '../../repos/CharacterAssetRepository.js';
import type { ICharacterRepository } from '../../repos/CharacterRepository.js';
import type { IChatMemberRepository } from '../../repos/ChatMemberRepository.js';
import type { IChatRepository } from '../../repos/ChatRepository.js';

export interface SceneTemplateDeps {
  chats: IChatRepository;
  characters: ICharacterRepository;
  characterAssets: ICharacterAssetRepository;
  chatMembers: IChatMemberRepository;
}

export function registerSceneTemplate(registry: ToolRegistry, deps: SceneTemplateDeps): void {
  registry.registerTemplate(new SceneTemplate(deps));
}

/** Resolved, client-ready sprite — what the stage panel renders. */
interface SceneSprite {
  name: string;
  emotion?: string;
  position: 'left' | 'center' | 'right';
  url: string;
}

/** Resolved, client-ready scene. Persisted per chat inside the serialized state blob. */
interface SceneState {
  backgroundUrl: string | null;
  sprites: SceneSprite[];
  caption: string;
}

const BackgroundArg = z
  .union([
    z.object({
      source: z.literal('attachment'),
      id: z.string().min(1).describe('Attachment id (e.g. a forge_image result)'),
    }),
    z.object({
      source: z.literal('asset'),
      name: z.string().min(1).describe("Name of the chat character's image asset (background type preferred)"),
    }),
  ])
  .nullish()
  .describe('New background; omitted or null clears it');

const SpriteArg = z.object({
  character: z.string().min(1).describe('Character name (group-chat member first, then any character)'),
  emotion: z
    .string()
    .optional()
    .describe("Name of an emotion-type asset (CharX convention); falls back to the character's avatar"),
  position: z.enum(['left', 'center', 'right']),
});

/** Args for `scene_set` — full scene replacement. Single source for the LLM schema and runtime validation. */
const SceneSetArgs = z.object({
  background: BackgroundArg,
  sprites: z.array(SpriteArg).optional().describe('Full sprite roster; an empty array clears the stage'),
  caption: z.string().optional().describe('Short caption shown in the inline scene-change chip'),
});

const SceneGetArgs = z.object({});

function assetUrl(characterId: string, asset: CharacterAsset): string {
  return `/api/characters/${characterId}/assets/${asset.id}.${asset.ext}`;
}

/** Find an asset by name, preferring `preferredType` when several share the name. */
function pickAsset(assets: CharacterAsset[], name: string, preferredType: string): CharacterAsset | undefined {
  const matches = assets.filter((a) => a.name === name);
  return matches.find((a) => a.type === preferredType) ?? matches[0];
}

export class SceneTemplate implements ToolTemplate {
  id = 'scene';
  name = 'Scene';
  source = 'builtin' as const;

  /** Scenes keyed by chatId — populated by deserialize() before each execute(). */
  private scenes: Record<string, SceneState> = {};
  /**
   * Built-in templates are registry singletons and the registry only calls
   * deserialize() when the branch history carries a snapshot. Track whether one
   * happened so a call without a snapshot starts empty instead of leaking
   * another chat's scenes into this branch's serialized state.
   */
  private hasSnapshot = false;

  constructor(private deps: SceneTemplateDeps) {}

  getDefinition() {
    return {
      stateKey: 'scene',
      configSchema: {},
      tools: [
        {
          name: 'scene_set',
          description:
            'Set the visual scene for the story: background image, character sprites (with emotions), and a short caption. Full replacement — anything omitted is cleared.',
          parameters: z.toJSONSchema(SceneSetArgs) as Record<string, unknown>,
        },
        {
          name: 'scene_get',
          description: 'Get the current scene as text.',
          parameters: z.toJSONSchema(SceneGetArgs) as Record<string, unknown>,
        },
      ],
    };
  }

  async execute(toolName: string, args: Record<string, unknown>, context?: ToolContext): Promise<ToolExecuteResult> {
    const scenes = this.hasSnapshot ? this.scenes : {};
    this.hasSnapshot = false;
    // serialize() runs after execute and reads this field.
    this.scenes = scenes;
    if (toolName === 'scene_set') return this.sceneSet(args, context, scenes);
    if (toolName === 'scene_get') return this.sceneGet(context, scenes);
    return { content: `Unknown tool: ${toolName}` };
  }

  private async sceneSet(
    args: Record<string, unknown>,
    context: ToolContext | undefined,
    scenes: Record<string, SceneState>,
  ): Promise<ToolExecuteResult> {
    const chatId = context?.chatId;
    if (!chatId) return { content: 'Error: no active chat' };

    const parsed = SceneSetArgs.safeParse(args);
    if (!parsed.success) return { content: 'Error: invalid scene_set arguments' };

    const chat = await this.deps.chats.getChatById(chatId);
    if (!chat) return { content: 'Error: chat not found' };

    const misses: string[] = [];

    // Background — omitted/null clears.
    let backgroundUrl: string | null = null;
    const background = parsed.data.background;
    if (background?.source === 'attachment') {
      backgroundUrl = `/api/attachments/${background.id}`;
    } else if (background?.source === 'asset') {
      if (!chat.characterId) {
        misses.push(`background asset "${background.name}" (chat has no character)`);
      } else {
        const assets = await this.deps.characterAssets.listForCharacter(chat.characterId);
        const asset = pickAsset(assets, background.name, 'background');
        if (asset?.filePath) {
          backgroundUrl = assetUrl(chat.characterId, asset);
        } else {
          misses.push(`background asset "${background.name}" not found`);
        }
      }
    }

    // Sprites — full roster replacement; unresolvable entries are omitted and noted.
    const sprites: SceneSprite[] = [];
    for (const s of parsed.data.sprites ?? []) {
      const character = await this.resolveCharacter(chatId, s.character);
      if (!character) {
        misses.push(`character "${s.character}" not found`);
        continue;
      }
      let url: string | null = null;
      if (s.emotion) {
        const assets = await this.deps.characterAssets.listForCharacter(character.id);
        const emotionAsset = pickAsset(assets, s.emotion, 'emotion');
        if (emotionAsset?.filePath) {
          url = assetUrl(character.id, emotionAsset);
        } else {
          misses.push(`emotion asset "${s.emotion}" not found for "${character.name}" (using avatar)`);
        }
      }
      url ??= character.avatarPath ? `/${character.avatarPath}` : null;
      if (!url) {
        misses.push(`no image available for "${character.name}"`);
        continue;
      }
      sprites.push({
        name: character.name,
        ...(s.emotion ? { emotion: s.emotion } : {}),
        position: s.position,
        url,
      });
    }

    const caption = parsed.data.caption ?? '';
    const scene: SceneState = { backgroundUrl, sprites, caption };
    scenes[chatId] = scene;

    const lines: string[] = ['Scene updated.'];
    lines.push(backgroundUrl ? `Background: ${backgroundUrl}` : 'Background: cleared');
    lines.push(
      sprites.length > 0
        ? `Sprites: ${sprites.map((s) => `${s.name}${s.emotion ? ` (${s.emotion})` : ''} ${s.position}`).join(', ')}`
        : 'Sprites: none',
    );
    if (caption) lines.push(`Caption: ${caption}`);
    if (misses.length > 0) lines.push(`Unresolved: ${misses.join('; ')}`);

    return {
      content: lines.join('\n'),
      extra: { renderType: 'scene', scene },
    };
  }

  private sceneGet(context: ToolContext | undefined, scenes: Record<string, SceneState>): ToolExecuteResult {
    const chatId = context?.chatId;
    if (!chatId) return { content: 'Error: no active chat' };
    const scene = scenes[chatId];
    if (!scene) return { content: 'No scene set.' };
    const lines: string[] = [];
    lines.push(scene.backgroundUrl ? `Background: ${scene.backgroundUrl}` : 'Background: none');
    lines.push(
      scene.sprites.length > 0
        ? `Sprites: ${scene.sprites.map((s) => `${s.name}${s.emotion ? ` (${s.emotion})` : ''} ${s.position}`).join(', ')}`
        : 'Sprites: none',
    );
    if (scene.caption) lines.push(`Caption: ${scene.caption}`);
    return { content: lines.join('\n') };
  }

  /** Resolve a sprite name: group-chat members first, then globally by name. */
  private async resolveCharacter(chatId: string, name: string): Promise<Character | undefined> {
    const members = await this.deps.chatMembers.getMembers(chatId);
    if (members.length > 0) {
      const memberChars = await this.deps.characters.getByIds(members.map((m) => m.characterId));
      const found = memberChars.find((c) => c.name.toLowerCase() === name.toLowerCase());
      if (found) return found;
    }
    return this.deps.characters.getByName(name);
  }

  serialize(): string {
    return Object.keys(this.scenes).length > 0 ? JSON.stringify(this.scenes) : '';
  }

  deserialize(raw: string): void {
    const parsed: unknown = JSON.parse(raw);
    this.scenes =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, SceneState>) : {};
    this.hasSnapshot = true;
  }
}
