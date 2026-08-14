/**
 * CardTestService — headless chat simulation behind the `test_card` workbench
 * run verb (and the read/test-only MCP surface).
 *
 * Drives the real bus/dispatcher with an internal client connection, exactly
 * the message sequence a browser client (and the e2e harness) uses:
 *   chat.create → chat.materialize → action.sendAndGenerate per scripted turn
 * and captures the resulting broadcasts on the internal client's fake socket.
 * Generations run against the ACTIVE backend config — deterministic runs are
 * achieved by pointing that config at a mock LLM first (deliberately not
 * something this service does: no server-driven config mutation).
 *
 * `debugPrompts` is enabled for the duration of the run (and restored after)
 * so each turn's prompt is inspectable at /generations/<id>/prompt.json.
 *
 * The temporary chat is deleted unless keepChat is set. Broadcasts from the
 * run (chat.created, generation.*, …) go to all connected clients — this is a
 * single-user app and the chat is cleaned up, so the noise is acceptable.
 */

import path from 'node:path';
import { z } from 'zod';
import { WebSocket } from 'ws';
import type { EventBus } from '../bus/EventBus.js';
import type { ChatRepository } from '../repos/ChatRepository.js';
import type { ICharacterRepository } from '../repos/CharacterRepository.js';
import type { ISettingsRepository } from '../repos/SettingsRepository.js';
import type { ClientMessage, ServerMessage } from '@tamari/types';
import type { ToolExecuteResult } from './ToolTemplate.js';
import type { UnpackedCardService } from './unpacked/UnpackedCardService.js';
import { unpackedCardId } from './unpacked/unpackedIds.js';

const MAX_TURNS = 20;
const DEFAULT_TURN_TIMEOUT_MS = 120_000;

const TestCardArgs = z
  .object({
    characterId: z.string().optional().describe('Card id. Unpacked cards use their unpacked/<slug> id.'),
    folderPath: z
      .string()
      .optional()
      .describe('Alternative to characterId: path of an unpacked card folder (absolute, or relative to <dataDir>/unpacked-cards).'),
    turns: z.array(z.string().min(1)).min(1).max(MAX_TURNS).describe('Scripted user messages, sent one per turn.'),
    keepChat: z.boolean().optional().describe('Keep the test chat instead of deleting it after the run. Default false.'),
    timeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(600_000)
      .optional()
      .describe(`Per-turn generation timeout. Default ${DEFAULT_TURN_TIMEOUT_MS}ms.`),
  })
  .refine((d) => d.characterId !== undefined || d.folderPath !== undefined, {
    message: 'provide characterId or folderPath',
  });

export interface CardTestServiceDeps {
  bus: EventBus;
  chats: ChatRepository;
  characters: ICharacterRepository;
  settings: ISettingsRepository;
  unpackedCards: UnpackedCardService;
}

interface TurnResult {
  input: string;
  reply: string;
  generationId?: string;
  finishReason?: string;
}

/** findLast without the es2023 lib requirement. */
function lastOf<T>(arr: T[], pred: (item: T) => boolean): T | undefined {
  for (let i = arr.length - 1; i >= 0; i--) {
    const item = arr[i]!;
    if (pred(item)) return item;
  }
  return undefined;
}

export class CardTestService {
  constructor(private deps: CardTestServiceDeps) {}

  /** MCP/workbench entry point: validates args, returns { content } like a provider op. */
  async run(rawArgs: Record<string, unknown>): Promise<ToolExecuteResult> {
    const parsed = TestCardArgs.safeParse(rawArgs);
    if (!parsed.success) {
      return { content: `Error: invalid arguments — ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
    }
    try {
      const result = await this.simulate(parsed.data);
      return { content: JSON.stringify(result, null, 2) };
    } catch (e) {
      return { content: `Error: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  private async simulate(args: z.infer<typeof TestCardArgs>) {
    const { bus, chats, characters, settings, unpackedCards } = this.deps;

    // ---- resolve the card ----
    let characterId = args.characterId;
    if (characterId === undefined && args.folderPath !== undefined) {
      const abs = path.resolve(unpackedCards.rootDir, args.folderPath);
      const slug = path.basename(abs);
      characterId = unpackedCardId(slug);
      if (!unpackedCards.has(characterId)) {
        throw new Error(`no active unpacked card at ${args.folderPath} (is unpackedCards.enabled on, and does the folder parse?)`);
      }
    }
    const character = characterId !== undefined ? await characters.getById(characterId) : undefined;
    if (!character || characterId === undefined) throw new Error(`character not found: ${characterId ?? args.folderPath}`);

    // ---- internal client ----
    const captured: ServerMessage[] = [];
    const fakeWs = {
      readyState: WebSocket.OPEN,
      send: (data: string) => {
        try {
          captured.push(JSON.parse(data) as ServerMessage);
        } catch {
          /* non-JSON frame — ignore */
        }
      },
      close: () => {},
    } as unknown as WebSocket;
    const connection = bus.addClient(fakeWs);
    connection.authenticated = true;

    const send = (msg: ClientMessage) => bus.dispatch(connection, msg);
    const errorsOf = () => captured.filter((m) => m.type === 'error').map((m) => m.message);

    const previousDebugPrompts = await settings.get('debugPrompts');
    await settings.setValue('debugPrompts', true);

    let chatId: string | undefined;
    try {
      // ---- chat lifecycle ----
      await send({ type: 'chat.create', data: { characterId, name: `test_card ${new Date().toISOString()}` } });
      const created = lastOf(captured, (m) => m.type === 'chat.created');
      if (created === undefined || created.type !== 'chat.created') {
        throw new Error(`chat.create failed: ${errorsOf().join('; ') || 'no chat.created broadcast'}`);
      }
      const cid = created.chat.id;
      chatId = cid;

      await send({ type: 'chat.materialize', chatId: cid, selectedIndex: 0 });

      // ---- scripted turns ----
      const timeoutMs = args.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
      const turns: TurnResult[] = [];
      for (const input of args.turns) {
        const marker = captured.length;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            send({ type: 'action.sendAndGenerate', chatId: cid, content: input }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error(`generation timed out after ${timeoutMs}ms`)), timeoutMs);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        const fresh = captured.slice(marker);
        const turnError = fresh.find((m) => m.type === 'error');
        if (turnError !== undefined) throw new Error(turnError.message);
        const started = lastOf(fresh, (m) => m.type === 'generation.started');
        const done = lastOf(fresh, (m) => m.type === 'generation.done');
        turns.push({
          input,
          reply: '', // filled from the message chain below
          ...(started !== undefined && started.type === 'generation.started' ? { generationId: started.generationId } : {}),
          ...(done !== undefined && done.type === 'generation.done' ? { finishReason: done.finishReason } : {}),
        });
      }

      // Pair assistant replies to turns via generation.started's messageId.
      const messageGenId = new Map<number, string>();
      for (const m of captured) {
        if (m.type === 'generation.started' && m.chatId === cid && m.messageId !== undefined) {
          messageGenId.set(m.messageId, m.generationId);
        }
      }
      const chain = await chats.getMessageChain(cid);
      const replies = chain.filter((m) => m.role === 'assistant');
      for (const msg of replies) {
        const text = (msg.extra.parts ?? [])
          .filter((p) => p.type === 'text')
          .map((p) => p.text)
          .join('');
        const generationId = messageGenId.get(msg.id);
        const turn = turns.find((t) => (generationId !== undefined ? t.generationId === generationId : false));
        if (turn) turn.reply = text;
      }

      return {
        characterId,
        characterName: character.name,
        ...(args.keepChat === true ? { chatId } : {}),
        turns,
        generationIds: turns.flatMap((t) => (t.generationId !== undefined ? [t.generationId] : [])),
        hint: 'Full prompts were captured (debugPrompts on for this run) — read them at /generations/<id>/prompt.json',
      };
    } finally {
      if (chatId !== undefined && args.keepChat !== true) {
        await send({ type: 'chat.delete', chatId }).catch(() => {});
      }
      await settings.setValue('debugPrompts', previousDebugPrompts ?? false).catch(() => {});
      bus.removeClient(connection.id);
    }
  }
}
