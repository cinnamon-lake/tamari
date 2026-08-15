/**
 * MemoryService — rolling summary memory with inline message citations.
 *
 * Maintains a compact summary of older chat events, stored in the anchored
 * user message's `extra.memory` field. The summary is injected before the
 * chat history and the model can call tools to retrieve raw messages.
 */

import type { MemorySettings, MemorySummary, MemoryCitation, Message } from '@tamari/types';
import { getMessageText, DEFAULT_MEMORY_SUMMARY_PROMPT } from '@tamari/types';
import type { IChatRepository } from '../repos/ChatRepository.js';
import type { ISettingsRepository } from '../repos/SettingsRepository.js';
import type { IBackendConfigRepository } from '../repos/BackendConfigRepository.js';
import type { IPromptListRepository } from '../repos/PromptListRepository.js';
import type { BackendAdapter, Prompt } from '../backends/BackendAdapter.js';
import type { BackendAdapterFactory } from '../backends/factory.js';
import { buildBackendSettings } from '../backends/buildBackendSettings.js';
import { getLogger } from '../lib/logger.js';

const logger = getLogger('MemoryService');

const MEMORY_EXTRA_KEY = 'memory';

/** Max wall-clock time for a single summarization backend call before abort.
 * Prevents a stalled/hung backend from holding the chat lock indefinitely. */
const SUMMARIZATION_TIMEOUT_MS = 120_000;

export interface MemoryServiceDeps {
  chats: IChatRepository;
  settings: ISettingsRepository;
  backendConfigs: IBackendConfigRepository;
  promptLists: IPromptListRepository;
  backendFactory: BackendAdapterFactory;
}

interface MemoryExtra {
  summaryText: string;
  citations: MemoryCitation[];
  anchoredAt: number;
}

function isMemoryExtra(value: unknown): value is MemoryExtra {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.summaryText === 'string' &&
    Array.isArray(v.citations) &&
    typeof v.anchoredAt === 'number'
  );
}

export class MemoryService {
  constructor(private deps: MemoryServiceDeps) {}

  private async loadSettings(): Promise<MemorySettings> {
    // The typed settings view is parsed through AppSettingsSchema (which nests
    // MemorySettingsSchema) on every read, so memory field defaults are already
    // applied — no need to re-merge defaults here. Single source of truth for
    // defaults: packages/types/src/schemas.ts (MemorySettingsSchema).
    return (await this.deps.settings.getTyped()).memory;
  }

  /**
   * The summarization system prompt lives in the active prompt list as the
   * builtin `memorySummary` utility prompt (same lookup as
   * GenerationRunner.resolveBackend). Falls back to the default text when the
   * list or prompt is missing or its content was cleared.
   */
  private async loadSummaryPrompt(): Promise<string> {
    const allSettings = await this.deps.settings.list();
    const promptList = allSettings.activePromptListId
      ? await this.deps.promptLists.getById(allSettings.activePromptListId)
      : undefined;
    const content = promptList?.prompts.find((p) => p.identifier === 'memorySummary')?.content;
    return content && content.trim().length > 0 ? content : DEFAULT_MEMORY_SUMMARY_PROMPT;
  }

  /**
   * Ensure the rolling summary is up to date for the chat's active branch,
   * and return the latest applicable summary.
   */
  async ensureSummaryUpdated(chatId: string): Promise<MemorySummary | null> {
    const settings = await this.loadSettings();
    if (!settings.enabled) return null;

    const chain = await this.deps.chats.getMessageChain(chatId);
    if (chain.length === 0) return null;

    const userMessages = chain.filter((m) => m.role === 'user');
    if (userMessages.length === 0) return null;

    // The leaf is the last message in the chain.
    const leaf = chain[chain.length - 1]!;

    // Find the newest user message that is at least `depth` messages behind the leaf.
    const candidateAnchor = this.findAnchorCandidate(chain, leaf, settings.depth);
    if (!candidateAnchor) return null;

    // Find the most recent existing memory summary that is an ancestor of (or equal to) the candidate.
    const existing = this.findLatestApplicableSummary(chain, candidateAnchor.id);

    // Count user messages between existing anchor and candidate anchor.
    const userMessagesSinceAnchor = existing
      ? this.countUserMessagesBetween(chain, existing.anchoredMessageId, candidateAnchor.id)
      : this.countUserMessagesBetween(chain, null, candidateAnchor.id);

    if (userMessagesSinceAnchor < settings.updateInterval) {
      // No update needed; return existing summary if still applicable.
      return existing;
    }

    // Build the set of messages to summarize.
    const messagesToSummarize = this.collectMessagesToSummarize(chain, existing?.anchoredMessageId ?? null, candidateAnchor.id);
    if (messagesToSummarize.length === 0) {
      return existing;
    }

    // Generate the summary.
    const summaryText = await this.summarizeMessages(messagesToSummarize, settings);
    if (!summaryText) {
      logger.warn({ chatId, candidateAnchorId: candidateAnchor.id }, 'MemoryService: summarization returned empty');
      return existing;
    }

    const citations = parseCitations(summaryText);
    const memoryExtra: MemoryExtra = {
      summaryText,
      citations,
      anchoredAt: candidateAnchor.id,
    };

    await this.deps.chats.updateMessage(candidateAnchor.id, {
      extra: { ...candidateAnchor.extra, [MEMORY_EXTRA_KEY]: memoryExtra },
    });

    return {
      summaryText,
      citations,
      anchoredMessageId: candidateAnchor.id,
    };
  }

  /**
   * Tool handler: retrieve raw text of specific messages by ID.
   */
  async getRawMessages(chatId: string, args: { messageIds: number[] }): Promise<string> {
    const ids = Array.isArray(args.messageIds) ? args.messageIds : [];
    if (ids.length === 0) return 'No message IDs provided.';

    const chain = await this.deps.chats.getMessageChain(chatId);
    const byId = new Map(chain.map((m) => [m.id, m]));

    const lines: string[] = [];
    for (const id of ids) {
      const msg = byId.get(id);
      if (!msg) {
        lines.push(`[msg:${id}] not found in current chat branch.`);
        continue;
      }
      const text = getMessageText(msg.extra.parts).trim();
      const roleLabel = msg.role === 'user' ? 'You' : msg.role;
      lines.push(`[msg:${id}] ${roleLabel}: ${text || '(empty)'}`);
    }

    return lines.join('\n\n');
  }

  /**
   * Tool handler: focused summary of a message range.
   */
  async summarizeRange(chatId: string, args: { startMessageId: number; endMessageId: number; focus?: string }): Promise<string> {
    const chain = await this.deps.chats.getMessageChain(chatId);
    const byId = new Map(chain.map((m) => [m.id, m]));

    const startMsg = byId.get(args.startMessageId);
    const endMsg = byId.get(args.endMessageId);
    if (!startMsg || !endMsg) {
      return 'One or both message IDs not found in current chat branch.';
    }

    const startIndex = chain.indexOf(startMsg);
    const endIndex = chain.indexOf(endMsg);
    if (startIndex === -1 || endIndex === -1 || startIndex > endIndex) {
      return 'Invalid message range.';
    }

    const range = chain.slice(startIndex, endIndex + 1);
    if (range.length === 0) return 'No messages in range.';

    const settings = await this.loadSettings();
    const systemPrompt = await this.loadSummaryPrompt();
    const prompt = this.buildRangePrompt(range, args.focus, settings, systemPrompt);
    return this.runSummarizationBackend(prompt, settings);
  }

  private findAnchorCandidate(chain: Message[], _leaf: Message, depth: number): Message | null {
    // We need a user message that is at least `depth` messages behind the leaf.
    // Walk backward from the leaf; when we've seen `depth` messages, the next user message encountered is the candidate.
    let messagesBehind = 0;
    for (let i = chain.length - 1; i >= 0; i--) {
      const msg = chain[i]!;
      if (messagesBehind >= depth && msg.role === 'user') {
        return msg;
      }
      messagesBehind++;
    }
    return null;
  }

  private findLatestApplicableSummary(chain: Message[], upToMessageId: number): MemorySummary | null {
    const byId = new Map(chain.map((m) => [m.id, m]))
    for (let i = chain.length - 1; i >= 0; i--) {
      const msg = chain[i]!;
      if (msg.id === upToMessageId || this.isAncestor(msg.id, upToMessageId, byId)) {
        const mem = msg.extra[MEMORY_EXTRA_KEY];
        if (isMemoryExtra(mem)) {
          return {
            summaryText: mem.summaryText,
            citations: mem.citations,
            anchoredMessageId: mem.anchoredAt,
          };
        }
      }
    }
    return null;
  }

  private isAncestor(ancestorId: number, descendantId: number, byId: Map<number, Message>): boolean {
    let current = byId.get(descendantId);
    while (current?.parentId) {
      if (current.parentId === ancestorId) return true;
      current = byId.get(current.parentId);
    }
    return false;
  }

  private countUserMessagesBetween(chain: Message[], startId: number | null, endId: number): number {
    let counting = startId === null;
    let count = 0;
    for (const msg of chain) {
      if (!counting && msg.id === startId) {
        counting = true;
        continue;
      }
      if (counting && msg.role === 'user') {
        count++;
      }
      if (msg.id === endId) break;
    }
    return count;
  }

  private collectMessagesToSummarize(chain: Message[], afterId: number | null, upToId: number): Message[] {
    let collecting = afterId === null;
    const result: Message[] = [];
    for (const msg of chain) {
      if (!collecting && msg.id === afterId) {
        collecting = true;
        continue;
      }
      if (collecting) {
        result.push(msg);
      }
      if (msg.id === upToId) break;
    }
    return result;
  }

  private async summarizeMessages(messages: Message[], settings: MemorySettings): Promise<string> {
    const systemPrompt = await this.loadSummaryPrompt();
    const prompt = this.buildSummaryPrompt(messages, settings, systemPrompt);
    return this.runSummarizationBackend(prompt, settings);
  }

  private buildSummaryPrompt(messages: Message[], settings: MemorySettings, systemPrompt: string): Prompt {
    const lines = messages.map((m) => {
      const text = getMessageText(m.extra.parts).trim();
      const roleLabel = m.role === 'user' ? 'You' : m.role === 'assistant' ? 'Assistant' : m.role;
      return `[msg:${m.id}] ${roleLabel}: ${text}`;
    });

    const userContent =
      'Summarize the following roleplay history. For each important event, include a citation to the message ID(s) it came from using [msg:ID] format.\n\n' +
      lines.join('\n\n');

    return {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      tokenUsage: { prompt: 0, completion: settings.maxSummaryTokens },
      params: {
        max_tokens: settings.maxSummaryTokens,
        temperature: 0.3,
      },
    };
  }

  private buildRangePrompt(messages: Message[], focus: string | undefined, settings: MemorySettings, systemPrompt: string): Prompt {
    const lines = messages.map((m) => {
      const text = getMessageText(m.extra.parts).trim();
      const roleLabel = m.role === 'user' ? 'You' : m.role === 'assistant' ? 'Assistant' : m.role;
      return `[msg:${m.id}] ${roleLabel}: ${text}`;
    });

    const focusLine = focus ? ` Focus on: ${focus}` : '';
    const userContent =
      `Provide a focused summary of the following message range.${focusLine}\n\n` +
      lines.join('\n\n');

    return {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      tokenUsage: { prompt: 0, completion: settings.maxSummaryTokens },
      params: {
        max_tokens: settings.maxSummaryTokens,
        temperature: 0.3,
      },
    };
  }

  private async runSummarizationBackend(prompt: Prompt, settings: MemorySettings): Promise<string> {
    const backend = await this.resolveBackend(settings.backendConfigId);
    if (!backend) {
      throw new Error('MemoryService: no backend configured for summarization');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SUMMARIZATION_TIMEOUT_MS);
    try {
      const stream = backend.stream(prompt, controller.signal);
      const chunks: string[] = [];
      let next = await stream.next();
      while (!next.done) {
        const item = next.value;
        if (item.type === 'text') {
          chunks.push(item.token);
        }
        next = await stream.next();
      }

      const result = next.value;
      if (result.error) {
        throw new Error(`MemoryService summarization failed: ${result.error}`);
      }

      return chunks.join('').trim();
    } finally {
      clearTimeout(timer);
    }
  }

  private async resolveBackend(configId: string): Promise<BackendAdapter | null> {
    const allSettings = await this.deps.settings.list();
    const backendConfig = configId ? await this.deps.backendConfigs.getById(configId) : null;
    if (configId && !backendConfig) {
      logger.warn({ configId }, 'MemoryService: configured backend config not found, falling back to active');
    }
    return await this.deps.backendFactory.create(buildBackendSettings(allSettings, backendConfig));
  }
}

/**
 * Parse inline [msg:ID] citations from summary text.
 * Supports [msg:123] and [msg:123, msg:456].
 */
export function parseCitations(summaryText: string): MemoryCitation[] {
  const citationRegex = /\[msg:(\d+(?:,\s*msg:\d+)*)\]/g;
  const seen = new Set<string>();
  const citations: MemoryCitation[] = [];

  let match: RegExpExecArray | null;
  while ((match = citationRegex.exec(summaryText)) !== null) {
    const raw = match[1]!;
    const messageIds = raw.split(',').map((s) => Number(s.replace('msg:', '').trim()));
    const key = messageIds.join(',');
    if (seen.has(key)) continue;
    seen.add(key);

    // Extract surrounding sentence as the event description.
    const sentence = extractSentence(summaryText, match.index);
    citations.push({ event: sentence, messageIds });
  }

  return citations;
}

function extractSentence(text: string, citationIndex: number): string {
  const before = text.slice(0, citationIndex);
  const after = text.slice(citationIndex);

  function startAfter(delimiter: string): number {
    const idx = before.lastIndexOf(delimiter);
    return idx === -1 ? 0 : idx + delimiter.length;
  }

  const sentenceStart = Math.max(
    startAfter('. '),
    startAfter('\n'),
    startAfter('! '),
    startAfter('? '),
  );

  let sentenceEnd = after.search(/[.!?]\s/);
  if (sentenceEnd === -1) sentenceEnd = after.search(/[.!?]$/);
  if (sentenceEnd === -1) sentenceEnd = after.length;
  else sentenceEnd += 1; // include the punctuation

  const sentence = (before.slice(sentenceStart) + after.slice(0, sentenceEnd)).trim();
  return sentence.replace(/\[msg:\d+(?:,\s*msg:\d+)*\]/g, '').trim() || 'Event';
}
