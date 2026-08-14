/**
 * CardTestService — scripted multi-turn card test behind the `test_card`
 * workbench run verb (and the read/test-only MCP surface).
 *
 * Rebuilt on TestSessionService: a run is start → one session message per
 * scripted turn → transcript, running the REAL generation path against
 * in-memory repositories. No real chat rows, no DB writes, no UI broadcasts,
 * no global debugPrompts flip — prompts are captured per run via the
 * target-level capturePrompts flag and stay inspectable through
 * test_session_state (or read_generation for the session's records).
 *
 * Generations run against the ACTIVE backend config by default (real LLM,
 * real cost); pass backendConfigId to pin a specific config (e.g. a
 * deterministic `mock` provider config).
 *
 * The session is KEPT by default (idle-TTL'd by TestSessionService) so the
 * agent can continue interactively or inspect state/prompts; keepChat: false
 * ends it immediately.
 */

import { z } from 'zod';
import type { ToolExecuteResult } from './ToolTemplate.js';
import type { TestSessionService } from './TestSessionService.js';

const MAX_TURNS = 20;
const DEFAULT_TURN_TIMEOUT_MS = 120_000;

/** Exported so the MCP surface can register the same fields without duplicating them. */
export const TestCardArgsBase = z.object({
  characterId: z.string().optional().describe('Card id. Unpacked cards use their unpacked/<slug> id.'),
  folderPath: z
    .string()
    .optional()
    .describe('Alternative to characterId: path of an unpacked card folder (absolute, or relative to <dataDir>/unpacked-cards).'),
  turns: z.array(z.string().min(1)).min(1).max(MAX_TURNS).describe('Scripted user messages, sent one per turn.'),
  keepChat: z
    .boolean()
    .optional()
    .describe(
      'Keep the test session after the run. Default true — the session (and its captured prompts) stays inspectable via test_session_state until it expires (30 min idle). Pass false to end the session immediately.',
    ),
  backendConfigId: z
    .string()
    .optional()
    .describe('Backend config to run against. Default: the ACTIVE config (real LLM, real cost). Pass a mock-provider config id for a deterministic run.'),
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(600_000)
    .optional()
    .describe(`Per-turn generation timeout. Default ${DEFAULT_TURN_TIMEOUT_MS}ms.`),
});

const TestCardArgs = TestCardArgsBase.refine((d) => d.characterId !== undefined || d.folderPath !== undefined, {
  message: 'provide characterId or folderPath',
});

export interface CardTestServiceDeps {
  testSessions: TestSessionService;
}

interface TurnResult {
  input: string;
  reply: string;
  generationId?: string;
  finishReason?: string;
}

export class CardTestService {
  constructor(private deps: CardTestServiceDeps) {}

  /** MCP/workbench entry point: validates args, returns { content } like a provider op. */
  async run(rawArgs: Record<string, unknown>): Promise<ToolExecuteResult> {
    const parsed = TestCardArgs.safeParse(rawArgs);
    if (!parsed.success) {
      return { content: `Error: invalid arguments — ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
    }
    const args = parsed.data;
    let sessionId: string | undefined;
    try {
      const started = await this.deps.testSessions.start({
        ...(args.characterId !== undefined ? { characterId: args.characterId } : {}),
        ...(args.folderPath !== undefined ? { folderPath: args.folderPath } : {}),
        ...(args.backendConfigId !== undefined ? { backendConfigId: args.backendConfigId } : {}),
      });
      sessionId = started.sessionId;

      const turns: TurnResult[] = [];
      for (const input of args.turns) {
        const turn = await this.deps.testSessions.message({
          sessionId,
          content: input,
          ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
        });
        turns.push({ input, reply: turn.reply, generationId: turn.generationId, finishReason: turn.finishReason });
      }

      const keep = args.keepChat !== false;
      if (!keep) {
        await this.deps.testSessions.end({ sessionId });
        sessionId = undefined;
      }

      return {
        content: JSON.stringify(
          {
            characterId: started.characterId,
            characterName: started.characterName,
            ...(sessionId !== undefined ? { sessionId } : {}),
            turns,
            generationIds: turns.flatMap((t) => (t.generationId !== undefined ? [t.generationId] : [])),
            hint: keep
              ? 'The test session is kept (see sessionId) — continue it interactively with test_session_message, or inspect the chain/generations/captured prompts with test_session_state (pass a generationId for full meta incl. prompts). Sessions expire after 30 min idle. keepChat: false ends the session immediately.'
              : 'The test session was ended (keepChat: false); its in-memory state and generation records are gone.',
          },
          null,
          2,
        ),
      };
    } catch (e) {
      // keepChat: false — never leave the session behind on a failed run.
      if (sessionId !== undefined && args.keepChat === false) {
        await this.deps.testSessions.end({ sessionId }).catch(() => {});
      }
      return { content: `Error: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
}
