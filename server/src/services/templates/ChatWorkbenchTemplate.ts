/**
 * Chat workbench tool template.
 *
 * Lets the model inspect and edit group-chat membership. Split off from the
 * Character Workbench: chat editing is unrelated to authoring a card.
 * Membership mutations share their validation/broadcast logic with the Lua
 * `st` API via services/chatMembership.ts.
 *
 * All errors are returned as `content` strings, never thrown.
 */

import { z } from 'zod';
import { formatZodIssues, type ToolContext, type ToolExecuteResult, type ToolTemplate } from '../ToolTemplate.js';
import type { ICharacterRepository } from '../../repos/CharacterRepository.js';
import type { IChatRepository } from '../../repos/ChatRepository.js';
import type { IChatMemberRepository } from '../../repos/ChatMemberRepository.js';
import type { ChatMetaBroadcastService } from '../ChatMetaBroadcastService.js';
import { addChatMember, removeChatMember } from '../chatMembership.js';

export interface ChatWorkbenchDeps {
  chats: IChatRepository;
  characters: ICharacterRepository;
  chatMembers: IChatMemberRepository;
  chatMetaBroadcast: Pick<ChatMetaBroadcastService, 'broadcastGroupMemberAdded' | 'broadcastGroupMemberRemoved'>;
}

export function registerChatWorkbenchTemplate(
  registry: { registerTemplate(template: ToolTemplate): void },
  deps: ChatWorkbenchDeps,
): void {
  registry.registerTemplate(new ChatWorkbenchTemplate(deps));
}

const ChatMemberArgs = z.object({
  characterId: z.string().describe('Character id to add/remove.'),
  chatId: z.string().optional().describe('Target group chat. Defaults to the current chat.'),
});

const ChatListMembersArgs = z.object({
  chatId: z.string().optional().describe('Target group chat. Defaults to the current chat.'),
});

class ChatWorkbenchTemplate implements ToolTemplate {
  id = 'chat_workbench';
  name = 'Chat Workbench';
  source = 'builtin' as const;

  constructor(private deps: ChatWorkbenchDeps) {}

  getDefinition() {
    return {
      stateKey: 'chat_workbench',
      configSchema: {},
      tools: [
        {
          name: 'chat_list_members',
          description: 'List the members of a group chat (defaults to the current chat).',
          parameters: z.toJSONSchema(ChatListMembersArgs) as Record<string, unknown>,
        },
        {
          name: 'chat_add_member',
          description: 'Add a character to a group chat (defaults to the current chat). The chat must be a group chat, not a single-character chat.',
          parameters: z.toJSONSchema(ChatMemberArgs) as Record<string, unknown>,
        },
        {
          name: 'chat_remove_member',
          description: 'Remove a character from a group chat (defaults to the current chat).',
          parameters: z.toJSONSchema(ChatMemberArgs) as Record<string, unknown>,
        },
      ],
    };
  }

  async execute(toolName: string, args: Record<string, unknown>, context?: ToolContext): Promise<ToolExecuteResult> {
    try {
      switch (toolName) {
        case 'chat_list_members':
          return await this.listMembers(args, context);
        case 'chat_add_member':
          return await this.addMember(args, context);
        case 'chat_remove_member':
          return await this.removeMember(args, context);
        default:
          return { content: `Error: unknown tool ${toolName}` };
      }
    } catch (err) {
      return { content: `Error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private resolveChatId(explicit: string | undefined, context?: ToolContext): string | null {
    return explicit ?? context?.chatId ?? null;
  }

  private async listMembers(args: Record<string, unknown>, context?: ToolContext): Promise<ToolExecuteResult> {
    const parsed = ChatListMembersArgs.safeParse(args);
    if (!parsed.success) return { content: `Error: invalid arguments — ${formatZodIssues(parsed.error)}` };
    const chatId = this.resolveChatId(parsed.data.chatId, context);
    if (!chatId) return { content: 'Error: no chatId given and no current chat context' };
    const members = await this.deps.chatMembers.getMembers(chatId);
    const withNames = await Promise.all(
      members.map(async (m) => ({
        characterId: m.characterId,
        name: (await this.deps.characters.getById(m.characterId))?.name ?? null,
      })),
    );
    return { content: JSON.stringify({ chatId, members: withNames }) };
  }

  private async addMember(args: Record<string, unknown>, context?: ToolContext): Promise<ToolExecuteResult> {
    const parsed = ChatMemberArgs.safeParse(args);
    if (!parsed.success) return { content: `Error: invalid arguments — ${formatZodIssues(parsed.error)}` };
    const chatId = this.resolveChatId(parsed.data.chatId, context);
    if (!chatId) return { content: 'Error: no chatId given and no current chat context' };
    try {
      const member = await addChatMember(this.deps, chatId, parsed.data.characterId);
      return { content: JSON.stringify({ chatId, characterId: member.characterId }) };
    } catch (err) {
      return { content: `Error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private async removeMember(args: Record<string, unknown>, context?: ToolContext): Promise<ToolExecuteResult> {
    const parsed = ChatMemberArgs.safeParse(args);
    if (!parsed.success) return { content: `Error: invalid arguments — ${formatZodIssues(parsed.error)}` };
    const chatId = this.resolveChatId(parsed.data.chatId, context);
    if (!chatId) return { content: 'Error: no chatId given and no current chat context' };
    try {
      await removeChatMember(this.deps, chatId, parsed.data.characterId);
      return { content: JSON.stringify({ chatId, removed: parsed.data.characterId }) };
    } catch (err) {
      return { content: `Error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  serialize(): string { return ''; }
  deserialize(_raw: string): void {}
}
