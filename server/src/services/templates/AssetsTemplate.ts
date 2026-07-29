import { z } from 'zod';
import type { ToolRegistry } from '../ToolRegistry.js';
import type { ToolContext, ToolExecuteResult, ToolTemplate } from '../ToolTemplate.js';
import type { ICharacterAssetRepository } from '../../repos/CharacterAssetRepository.js';
import type { IChatRepository } from '../../repos/ChatRepository.js';

export interface AssetsTemplateDeps {
  assets: ICharacterAssetRepository;
  chats: IChatRepository;
}

export function registerAssetsTemplate(registry: ToolRegistry, deps: AssetsTemplateDeps): void {
  registry.registerTemplate(new AssetsTemplate(deps));
}

/** Args for `list_assets`. Single source of truth for the LLM schema and runtime validation. */
const AssetsArgs = z.object({
  limit: z.coerce.number().int().optional().describe('Max number of assets to list (default: 10)'),
});

class AssetsTemplate implements ToolTemplate {
  id = 'assets';
  name = 'Asset Lister';
  source = 'builtin' as const;

  constructor(private deps: AssetsTemplateDeps) {}

  getDefinition() {
    return {
      stateKey: 'assets',
      configSchema: {},
      tools: [
        {
          name: 'list_assets',
          description: 'List image assets for the current character',
          parameters: z.toJSONSchema(AssetsArgs) as Record<string, unknown>,
        },
      ],
    };
  }

  async execute(_toolName: string, args: Record<string, unknown>, context?: ToolContext): Promise<ToolExecuteResult> {
    const chatId = context?.chatId;
    if (!chatId) return { content: 'Error: no active chat' };

    const chat = await this.deps.chats.getChatById(chatId);
    if (!chat || !chat.characterId) return { content: 'Error: chat not found' };

    const parsed = AssetsArgs.safeParse(args);
    if (!parsed.success) return { content: 'Error: invalid list_assets arguments' };
    const limit = Math.max(1, Math.min(50, parsed.data.limit || 10));
    const items = await this.deps.assets.listForCharacter(chat.characterId);
    const limited = items.slice(0, limit);

    if (limited.length === 0) return { content: 'No assets found for this character.' };
    const lines = limited.map((a: { name: string; type: string }) => `- ${a.name} (${a.type})`);
    return { content: `Assets (${limited.length}):\n${lines.join('\n')}` };
  }

  serialize(): string { return ''; }
  deserialize(_raw: string): void {}
}
