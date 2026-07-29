import type { ClientMessageInput } from '@tamari/types';

export interface SlashCommand {
  name: string;
  description: string;
  args: string[];
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'send', description: 'Submit the input immediately', args: [] },
  { name: 'sys', description: 'Inject a system message', args: ['text'] },
  { name: 'reset', description: 'Clear chat history', args: [] },
  { name: 'cut', description: 'Remove last N messages', args: ['count'] },
  { name: 'continue', description: 'Continue the assistant message', args: [] },
  { name: 'impersonate', description: 'Generate a user message as draft', args: [] },
  { name: 'regenerate', description: 'Regenerate the last message', args: [] },
  { name: 'regen', description: 'Alias for /regenerate', args: [] },
  { name: 'swipe', description: 'Swipe a message left or right', args: ['direction'] },
  { name: 'name', description: 'Change local display name', args: ['name'] },
  { name: 'bg', description: 'Set background image URL', args: ['url'] },
  { name: 'theme', description: 'Set theme preset or custom CSS', args: ['preset'] },
  { name: 'persona', description: 'Switch active persona', args: ['name'] },
  { name: 'char', description: 'Switch to a character chat', args: ['name'] },
  { name: 'lock', description: 'Lock the input to prevent sends', args: [] },
  { name: 'unlock', description: 'Unlock the input', args: [] },
  { name: 'wi', description: 'World info CRUD shortcuts', args: ['subcommand'] },
  { name: 'inject', description: 'Inject text into the next prompt', args: ['text'] },
  { name: 'flushinject', description: 'Clear pending prompt injections', args: [] },
  { name: 'gen', description: 'Generate with chat context (no message appended)', args: ['prompt'] },
  { name: 'genraw', description: 'Raw generation (no chat context)', args: ['prompt'] },
  { name: 'ask', description: 'Generate as a specific character', args: ['character', 'message'] },
  { name: 'sysgen', description: 'Generate a system message via LLM', args: ['text'] },
  { name: 'listvar', description: 'List chat variables', args: [] },
];

export interface ParsedCommand {
  command: string;
  args: string[];
  raw: string;
}

export function parseCommand(text: string): ParsedCommand | null {
  if (!text.startsWith('/')) return null;
  const trimmed = text.slice(1).trim();
  const parts = trimmed.split(/\s+/);
  if (parts.length === 0) return null;
  return {
    command: parts[0]!,
    args: parts.slice(1),
    raw: text.trim(),
  };
}

export function buildClientMessage(chatId: string, parsed: ParsedCommand): ClientMessageInput | null {
  switch (parsed.command) {
    case 'send':
      return { type: 'action.sendAndGenerate', chatId, content: parsed.args.join(' ') };
    case 'sys':
      return { type: 'action.system', chatId, content: parsed.args.join(' ') };
    case 'reset':
      return { type: 'chat.reset', chatId };
    case 'cut': {
      const count = Number(parsed.args[0] ?? '1');
      return { type: 'action.cut', chatId, count: Number.isNaN(count) ? 1 : count };
    }
    case 'continue':
      return { type: 'action.continue', chatId };
    case 'impersonate':
      return { type: 'action.impersonate', chatId };
    case 'regenerate':
    case 'regen':
      return { type: 'action.regenerate', chatId };
    case 'swipe': {
      const direction = parsed.args[0];
      if (direction !== 'left' && direction !== 'right') return null;
      return { type: 'action.swipe', chatId, direction };
    }
    case 'name':
    case 'bg':
    case 'theme':
    case 'persona':
    case 'char':
    case 'lock':
    case 'unlock':
    case 'inject':
    case 'flushinject':
    case 'listvar':
      return null; // client-side only
    case 'gen':
      return { type: 'action.gen', chatId, prompt: parsed.args.join(' ') };
    case 'genraw':
      return { type: 'action.genraw', chatId, prompt: parsed.args.join(' ') };
    case 'ask': {
      const characterName = parsed.args[0] ?? '';
      const content = parsed.args.slice(1).join(' ');
      if (!characterName || !content) return null;
      return { type: 'action.ask', chatId, characterName, content };
    }
    case 'sysgen':
      return { type: 'action.sysgen', chatId, content: parsed.args.join(' ') };
    default:
      return null;
  }
}

export interface MacroDef {
  name: string;
  description: string;
  args?: string;
}

/** Built-in macros available for autocomplete. Must stay in sync with server MacroResolver. */
export const MACROS: MacroDef[] = [
  { name: 'user', description: 'User name', args: '' },
  { name: 'char', description: 'Character name', args: '' },
  { name: 'character', description: 'Character name', args: '' },
  { name: 'charIfNotGroup', description: 'Character name if not in group chat', args: '' },
  { name: 'group', description: 'Group name', args: '' },
  { name: 'groupNotMuted', description: 'Group name if not muted', args: '' },
  { name: 'description', description: 'Character description', args: '' },
  { name: 'charDescription', description: 'Character description', args: '' },
  { name: 'personality', description: 'Character personality', args: '' },
  { name: 'charPersonality', description: 'Character personality', args: '' },
  { name: 'scenario', description: 'Character scenario', args: '' },
  { name: 'charScenario', description: 'Character scenario', args: '' },
  { name: 'persona', description: 'Active persona description', args: '' },
  { name: 'model', description: 'Active model name', args: '' },
  { name: 'maxContext', description: 'Max context length', args: '' },
  { name: 'maxResponse', description: 'Max response tokens', args: '' },
  { name: 'maxPrompt', description: 'Max prompt tokens', args: '' },
  { name: 'time', description: 'Current time (HH:mm)', args: '' },
  { name: 'date', description: 'Current date', args: '' },
  { name: 'weekday', description: 'Current weekday', args: '' },
  { name: 'isotime', description: 'ISO time', args: '' },
  { name: 'isodate', description: 'ISO date', args: '' },
  { name: 'datetimeformat', description: 'Custom datetime format', args: 'format' },
  { name: 'lastMessage', description: 'Content of the last message', args: '' },
  { name: 'lastMessageId', description: 'ID of the last message', args: '' },
  { name: 'lastUserMessage', description: 'Content of the last user message', args: '' },
  { name: 'lastCharMessage', description: 'Content of the last assistant message', args: '' },
  { name: 'firstIncludedMessageId', description: 'ID of the first message in context', args: '' },
  { name: 'currentSwipeId', description: 'ID of the current swipe', args: '' },
  { name: 'lastGenerationType', description: 'Type of the last generation', args: '' },
  { name: 'hasExtension', description: 'Check if an extension is active', args: 'name' },
  { name: 'random', description: 'Random number', args: 'min::max' },
  { name: 'pick', description: 'Random choice', args: 'a::b::c' },
  { name: 'roll', description: 'Dice roll', args: 'NdM' },
  { name: 'noop', description: 'No output', args: '' },
  { name: 'newline', description: 'Line break', args: '' },
  { name: 'trim', description: 'Trim whitespace', args: 'text' },
];

/** Parse partial macro at cursor position. Returns null if not inside {{... */
export function parseMacroAtCursor(text: string, cursorPos: number): { prefix: string; start: number } | null {
  const beforeCursor = text.slice(0, cursorPos);
  const match = beforeCursor.match(/\{\{([^}]*)$/);
  if (!match) return null;
  return { prefix: match[1]!, start: match.index ?? 0 };
}

/** Built-in theme presets mapped to CSS snippets. */
export const THEME_PRESETS: Record<string, string> = {
  dark: '',
  light: `:root {
  --color-bg-primary:   #fafafa;
  --color-bg-secondary: #f4f4f5;
  --color-bg-tertiary:  #e4e4e7;
  --color-bg-elevated:  #ffffff;
  --color-text-primary:   #18181b;
  --color-text-secondary: #52525b;
  --color-text-muted:     #a1a1aa;
  --color-text-inverse:   #fafafa;
  --color-accent:        #4f46e5;
  --color-accent-hover:  #4338ca;
  --color-accent-soft:   rgba(79, 70, 229, 0.12);
  --color-success: #16a34a;
  --color-warning: #d97706;
  --color-danger:  #dc2626;
  --color-border-subtle: rgba(0, 0, 0, 0.08);
  --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.08), 0 1px 3px 0 rgba(0, 0, 0, 0.05);
  --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.10), 0 2px 4px -2px rgba(0, 0, 0, 0.05);
  --shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.10), 0 4px 6px -4px rgba(0, 0, 0, 0.05);
}`,
  'high-contrast': `:root {
  --color-bg-primary:   #000000;
  --color-bg-secondary: #000000;
  --color-bg-tertiary:  #111111;
  --color-bg-elevated:  #111111;
  --color-text-primary:   #ffffff;
  --color-text-secondary: #ffffff;
  --color-text-muted:     #cccccc;
  --color-text-inverse:   #000000;
  --color-accent:        #ffff00;
  --color-accent-hover:  #ffff66;
  --color-accent-soft:   rgba(255, 255, 0, 0.20);
  --color-success: #00ff00;
  --color-warning: #ff9900;
  --color-danger:  #ff0000;
  --color-border-subtle: rgba(255, 255, 255, 0.30);
  --shadow-sm: none;
  --shadow-md: none;
  --shadow-lg: none;
}`,
  none: '',
};
