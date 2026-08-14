/**
 * MCP (Model Context Protocol) endpoint — the read/test-only tool surface for
 * external LLM agents (kimi code / claude code style) developing unpacked
 * cards on disk.
 *
 * Deliberately read/test-only for card/config data: agents WRITE card files
 * with their own filesystem tools, and no tool here writes card or config
 * data (no write/edit/rm, no non-test run verbs). "Test" is not "no side
 * effects", though:
 *   - test_card / test_session_* run REAL generations (against the active
 *     backend config by default — real LLM cost), but always in in-memory
 *     test sessions: no real chat rows, no DB writes, no UI broadcasts.
 *   - test_backend mode 'live' sends a real authenticated request to the
 *     configured backend.
 *   - test_luatool may act on the real chat/attachments depending on the
 *     template's sandbox flags.
 * Whitelist:
 *   - test_card            scripted multi-turn card test (CardTestService → TestSessionService)
 *   - test_session_start   open an interactive card-testing session
 *   - test_session_message send a user message and run one generation
 *   - test_session_state   inspect the session chain / generations / script state
 *   - test_session_end     end a session early (sessions also expire on idle)
 *   - test_backend_logic   dry-run a card's backend_logic.lua
 *   - test_regex           preview merged regex rules against sample text
 *   - test_luatool         run a Lua tool (stored template or ad-hoc code)
 *   - test_custom_backend  dry-run a custom-backend script
 *   - test_backend         dry/live-test a backend config
 *   - read_generation      read /generations/<id>/{meta.json,error.txt,prompt.json,prompts.json} debug traces
 *
 * Transport: MCP Streamable HTTP, stateless (one McpServer+transport per POST).
 * Auth: the router is mounted under /api behind the existing bearer
 * requireAuth (TAMARI_SECRET). Gated on the `mcp.enabled` setting — 404 when off.
 */

import { Router } from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { ISettingsRepository } from '../repos/SettingsRepository.js';
import type { WorkbenchTemplate } from '../services/templates/workbench/WorkbenchTemplate.js';
import { TestCardArgsBase, type CardTestService } from '../services/CardTestService.js';
import { toToolResult, type TestSessionService } from '../services/TestSessionService.js';
import type { ToolExecuteResult } from '../services/ToolTemplate.js';

export interface McpRouterDeps {
  workbench: WorkbenchTemplate;
  cardTest: CardTestService;
  testSessions: TestSessionService;
  settings: ISettingsRepository;
}

/** Normalize a ToolExecuteResult into MCP text content. */
function textResult(result: ToolExecuteResult): { content: { type: 'text'; text: string }[]; isError?: boolean } {
  const text = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
  return { content: [{ type: 'text', text }], ...(text.startsWith('Error: ') ? { isError: true } : {}) };
}

function buildMcpServer(deps: McpRouterDeps): McpServer {
  const server = new McpServer({ name: 'tamari', version: '2.0.0-alpha.0' });

  const runVerb = (verb: string) => async (args: Record<string, unknown>) =>
    textResult(await deps.workbench.execute('run', { verb, args }));

  server.registerTool(
    'test_card',
    {
      description:
        'Scripted multi-turn test of a character card (DB id like unpacked/<slug>, or folderPath of an unpacked card folder). ' +
        'Runs each scripted user turn through the real generation path in an in-memory test session — no real chat is created, ' +
        'no DB writes, no UI broadcasts. Uses the ACTIVE backend config by default (real generations, real LLM cost); pass ' +
        'backendConfigId to pin a config (e.g. a deterministic mock-provider config). The session is KEPT by default ' +
        '(keepChat: false ends it immediately); the returned sessionId continues via test_session_message / test_session_state. ' +
        'Returns the transcript + generation ids; full prompts are captured per run — read them via test_session_state with a generationId.',
      inputSchema: TestCardArgsBase.shape,
    },
    async (args) => textResult(await deps.cardTest.run(args)),
  );

  server.registerTool(
    'test_session_start',
    {
      description:
        'Open an interactive card-testing session for a character card (DB id like unpacked/<slug>, or folderPath of an unpacked ' +
        'card folder) and return its materialized greeting. Runs the real generation path (prompt assembly, scripted-card layer, ' +
        'tool loop) against in-memory state — no real chat rows, no DB writes, no UI broadcasts. Uses the ACTIVE backend config ' +
        'by default (real LLM, real cost); pass backendConfigId for a specific config (e.g. a mock-provider config for ' +
        'deterministic runs). Sessions expire after 30 min idle; continue with test_session_message, inspect with ' +
        'test_session_state, close with test_session_end.',
      inputSchema: {
        characterId: z.string().optional().describe('Card id. Unpacked cards use their unpacked/<slug> id.'),
        folderPath: z
          .string()
          .optional()
          .describe('Alternative to characterId: path of an unpacked card folder (absolute, or relative to <dataDir>/unpacked-cards).'),
        personaId: z.string().optional().describe('Persona to chat as. Default: the first persona.'),
        greetingIndex: z.number().int().min(0).optional().describe('Greeting to materialize (0 = firstMes, then alternateGreetings). Default 0.'),
        backendConfigId: z
          .string()
          .optional()
          .describe('Backend config to run against. Default: the ACTIVE config (real LLM, real cost). Pass a mock-provider config id for deterministic runs.'),
      },
    },
    async (args) => textResult(await toToolResult(deps.testSessions.start(args))),
  );

  server.registerTool(
    'test_session_message',
    {
      description:
        'Send a user message in a test session and run one generation turn. Returns the assistant reply, the generation id, ' +
        'the finish reason, and — for scripted cards — the card’s Lua state (scriptState) and any backend script print() ' +
        'output (debug). Sessions expire after 30 min idle.',
      inputSchema: {
        sessionId: z.string().describe('Session id from test_session_start or test_card.'),
        content: z.string().min(1).describe('The user message to send.'),
        timeoutMs: z.number().int().min(1000).max(600_000).optional().describe('Generation timeout. Default 120000ms.'),
      },
    },
    async (args) => textResult(await toToolResult(deps.testSessions.message(args))),
  );

  server.registerTool(
    'test_session_state',
    {
      description:
        'Inspect a test session: the message chain (role + text), its generations (id/status/meta without prompts), and the ' +
        'card’s latest Lua script state. Pass generationId to fetch one generation’s FULL meta including every captured round ' +
        'prompt (prompts can be big — hence opt-in).',
      inputSchema: {
        sessionId: z.string().describe('Session id from test_session_start or test_card.'),
        generationId: z.string().optional().describe('Fetch this generation’s full record (incl. captured prompts) instead of the lean session state.'),
      },
    },
    async (args) => textResult(await toToolResult(deps.testSessions.state(args))),
  );

  server.registerTool(
    'test_session_end',
    {
      description:
        'End a test session early: aborts any in-flight generation and drops all in-memory state (chain, generation records). ' +
        'Sessions also expire automatically after 30 min idle.',
      inputSchema: {
        sessionId: z.string().describe('Session id from test_session_start or test_card.'),
      },
    },
    async (args) => textResult(await toToolResult(deps.testSessions.end(args))),
  );

  server.registerTool(
    'test_backend_logic',
    {
      description: "Dry-run a card's backend_logic.lua (main.lua + required modules) against a recording delegate — no real backend calls.",
      inputSchema: {
        characterId: z.string(),
        input: z.string(),
        luaSource: z.string().optional(),
        state: z.unknown().optional(),
        delegateResponse: z.unknown().optional(),
      },
    },
    runVerb('test_backend_logic'),
  );

  server.registerTool(
    'test_regex',
    {
      description: 'Preview merged regex rules (global + character-scoped) against sample text.',
      inputSchema: {
        characterId: z.string().optional(),
        text: z.string(),
        role: z.string().optional(),
      },
    },
    runVerb('test_regex'),
  );

  server.registerTool(
    'test_luatool',
    {
      description: 'Run a tool from a Lua tool template (stored id or ad-hoc code).',
      inputSchema: {
        id: z.string().optional(),
        code: z.string().optional(),
        sandbox: z.boolean().optional(),
        toolName: z.string(),
        args: z.record(z.string(), z.unknown()).optional(),
        config: z.record(z.string(), z.unknown()).optional(),
      },
    },
    runVerb('test_luatool'),
  );

  server.registerTool(
    'test_custom_backend',
    {
      description: 'Dry-run a custom-backend script against a recording delegate.',
      inputSchema: {
        id: z.string().optional(),
        luaSource: z.string().optional(),
        input: z.string(),
        state: z.unknown().optional(),
        delegateResponse: z.unknown().optional(),
      },
    },
    runVerb('test_custom_backend'),
  );

  server.registerTool(
    'test_backend',
    {
      description: 'Dry-run or live-test a backend config (configId defaults to the active backend; patch applies in memory only).',
      inputSchema: {
        configId: z.string().optional(),
        patch: z.record(z.string(), z.unknown()).optional(),
        prompt: z.string().optional(),
        mode: z.enum(['dry', 'live']).optional(),
      },
    },
    runVerb('test_backend'),
  );

  server.registerTool(
    'read_generation',
    {
      description:
        'Read a generation debug trace file (/generations/<id>/<file>): meta.json (full record), error.txt (rendered error chain), ' +
        'prompt.json (round-1 prompt) and prompts.json (all captured round prompts, in order) — the prompt files are present when ' +
        'prompt capture was on for that run (target-level capturePrompts or the debugPrompts setting, e.g. during test_card).',
      inputSchema: {
        generationId: z.string(),
        file: z.enum(['meta.json', 'error.txt', 'prompt.json', 'prompts.json']),
      },
    },
    async (args) =>
      textResult(await deps.workbench.execute('read', { path: `/generations/${args.generationId}/${args.file}` })),
  );

  return server;
}

export function createMcpRouter(deps: McpRouterDeps): Router {
  const router = Router();

  // Feature gate — the endpoint does not exist unless mcp.enabled is on.
  router.use((_req, res, next) => {
    deps.settings
      .get('mcp.enabled')
      .then((enabled) => {
        if (enabled === true) next();
        else
          res.status(404).json({
            error: 'The MCP server is unavailable! Please ask the user to enable it in the settings menu (Settings → Developer → MCP server).',
          });
      })
      .catch(next);
  });

  router.post('/', (req, res, next) => {
    (async () => {
      const server = buildMcpServer(deps);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    })().catch(next);
  });

  // Stateless server: no SSE stream, no session termination.
  const methodNotAllowed = (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) =>
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed — stateless MCP server, POST only' }, id: null });
  router.get('/', methodNotAllowed);
  router.delete('/', methodNotAllowed);

  return router;
}
