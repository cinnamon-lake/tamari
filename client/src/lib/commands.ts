import { bus } from '../bus/WebSocketBus.js';
import { state } from '../stores/serverStore.js';
import { addToast } from '../stores/toastStore.js';
import { buildClientMessage, THEME_PRESETS } from './slashCommands.js';
import type { ParsedCommand } from './slashCommands.js';

export interface CommandDeps {
  setText: (text: string) => void;
  setShowAutocomplete: (show: boolean) => void;
  setInputLocked: (locked: boolean) => void;
}

export function selectChat(chatId: string) {
  const limit = Number(state.settings['chatMessageLoadLimit']);
  bus.send({ type: 'chat.select', chatId, limit });
}

function fuzzyFindPersona(name: string) {
  const lower = name.toLowerCase();
  return state.personas.find(
    (p) => p.name.toLowerCase() === lower || p.name.toLowerCase().includes(lower),
  );
}

/**
 * Resolve a character by fuzzy name match for slash commands.
 * This is command argument resolution, not view-state derivation.
 * AGENTS.md active-entity snapshots are used for rendering; this
 * searches the sidebar list only when the user types a name.
 */
function fuzzyFindCharacter(name: string) {
  const lower = name.toLowerCase();
  return state.characters.find(
    (c) => c.name.toLowerCase() === lower || c.name.toLowerCase().includes(lower),
  );
}

function clearInput(deps: CommandDeps) {
  deps.setText('');
  deps.setShowAutocomplete(false);
}

/**
 * Execute a parsed slash command.
 * @returns `true` if the command was fully handled (including sending any WS messages),
 *          `false` if the input should fall through to normal message sending.
 */
export function executeSlashCommand(
  parsed: ParsedCommand,
  chatId: string,
  deps: CommandDeps,
): boolean {
  switch (parsed.command) {
    case 'name': {
      const newName = parsed.args.join(' ');
      if (newName) {
        bus.send({ type: 'settings.set', key: 'userName', value: newName });
      }
      clearInput(deps);
      return true;
    }

    case 'bg': {
      const url = parsed.args.join(' ');
      bus.send({ type: 'settings.set', key: 'backgroundImageUrl', value: url });
      clearInput(deps);
      return true;
    }

    case 'theme': {
      const preset = parsed.args[0]?.toLowerCase();
      const css =
        preset && THEME_PRESETS[preset] !== undefined
          ? THEME_PRESETS[preset]
          : parsed.args.join(' ');
      bus.send({ type: 'settings.set', key: 'themeCustomCss', value: css });
      clearInput(deps);
      return true;
    }

    case 'persona': {
      const name = parsed.args.join(' ');
      const persona = fuzzyFindPersona(name);
      if (persona) {
        bus.send({ type: 'chat.update', chatId, patch: { personaId: persona.id } });
      } else {
        addToast(`Persona "${name}" not found`, 'error');
      }
      clearInput(deps);
      return true;
    }

    case 'char': {
      const name = parsed.args.join(' ');
      const char = fuzzyFindCharacter(name);
      if (!char) {
        addToast(`Character "${name}" not found`, 'error');
        clearInput(deps);
        return true;
      }
      const existingChats = state.chats
        .filter((c) => c.characterId === char.id)
        .sort((a, b) => b.updatedAt - a.updatedAt);
      if (existingChats.length > 0) {
        selectChat(existingChats[0]!.id);
      } else {
        bus.send({
          type: 'chat.create',
          data: {
            characterId: char.id,
            name: `${char.name} - ${new Date().toLocaleDateString()}`,
          },
        });
        const unsubscribe = bus.on('chat.created', (msg) => {
          if (msg.chat.characterId === char.id) {
            unsubscribe();
            selectChat(msg.chat.id);
          }
        });
      }
      clearInput(deps);
      return true;
    }

    case 'lock': {
      deps.setInputLocked(true);
      clearInput(deps);
      return true;
    }

    case 'unlock': {
      deps.setInputLocked(false);
      clearInput(deps);
      return true;
    }

    case 'wi': {
      const sub = parsed.args[0]?.toLowerCase();
      const bookId = state.chatCharacter?.worldInfoId;
      if (!bookId) {
        addToast('No lorebook linked to this chat', 'error');
        clearInput(deps);
        return true;
      }
      const book = state.worldInfo.find((b) => b.id === bookId);
      if (!book) {
        addToast('Lorebook not found', 'error');
        clearInput(deps);
        return true;
      }

      if (sub === 'list') {
        const lines = book.entries.map(
          (e, i) =>
            `${i + 1}. [${e.keys.join(', ')}] ${e.content.slice(0, 60)}${e.content.length > 60 ? '...' : ''}`,
        );
        bus.send({
          type: 'action.system',
          chatId,
          content: lines.length > 0 ? lines.join('\n') : 'No entries in this lorebook.',
        });
        clearInput(deps);
        return true;
      }

      if (sub === 'get') {
        const key = parsed.args[1];
        if (!key) {
          addToast('Usage: /wi get <key>', 'error');
          clearInput(deps);
          return true;
        }
        const entry = book.entries.find((e) =>
          e.keys.some((k) => k.toLowerCase() === key.toLowerCase()),
        );
        if (!entry) {
          addToast(`No entry with key "${key}"`, 'error');
          clearInput(deps);
          return true;
        }
        bus.send({
          type: 'action.system',
          chatId,
          content: `[${entry.keys.join(', ')}]\n${entry.content}`,
        });
        clearInput(deps);
        return true;
      }

      if (sub === 'add') {
        if (parsed.args.length < 3) {
          addToast('Usage: /wi add <keys> <content...>', 'error');
          clearInput(deps);
          return true;
        }
        const keys = parsed.args[1]!;
        const content = parsed.args.slice(2).join(' ');
        bus.send({
          type: 'worldinfo.entry.create',
          bookId,
          data: {
            keys: keys
              .split(',')
              .map((k) => k.trim())
              .filter(Boolean),
            content,
            comment: '',
            position: 'before_char',
            order: 0,
            probability: 100,
            constant: false,
            selective: false,
            secondaryKeys: [],
            addMemo: false,
            disable: false,
            regex: false,
            recursive: false,
            depth: 0,
            role: 'system',
            retrievalMode: 'keyword',
          },
        });
        clearInput(deps);
        return true;
      }

      if (sub === 'del') {
        const key = parsed.args[1];
        if (!key) {
          addToast('Usage: /wi del <key>', 'error');
          clearInput(deps);
          return true;
        }
        const entry = book.entries.find((e) =>
          e.keys.some((k) => k.toLowerCase() === key.toLowerCase()),
        );
        if (!entry) {
          addToast(`No entry with key "${key}"`, 'error');
          clearInput(deps);
          return true;
        }
        bus.send({ type: 'worldinfo.entry.delete', bookId, entryId: entry.id });
        clearInput(deps);
        return true;
      }

      addToast('Unknown /wi subcommand. Use: list, get, add, del', 'error');
      clearInput(deps);
      return true;
    }

    case 'listvar': {
      const globalVars = (state.settings['globalVars'] as Record<string, string> | undefined) ?? {};
      const chat = state.activeChat;
      const chatVars = (chat?.metadata?.macroVars as Record<string, string> | undefined) ?? {};
      const entries = [
        ...Object.entries(globalVars).map(([k, v]) => `{{$${k}}} = ${v}`),
        ...Object.entries(chatVars).map(([k, v]) => `{{.${k}}} = ${v}`),
      ];
      if (entries.length === 0) {
        addToast('No variables set');
      } else {
        addToast(entries.join('\n'));
      }
      clearInput(deps);
      return true;
    }

    default: {
      const msg = buildClientMessage(chatId, parsed);
      if (msg) {
        // /send maps to the atomic action.sendAndGenerate — no paired
        // action.generate frame (the pair raced server-side).
        bus.send(msg);
        clearInput(deps);
        return true;
      }
      return false;
    }
  }
}
