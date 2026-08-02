import { CHARACTERS_DOC } from './characters.js';
import { BACKENDS_DOC } from './backends.js';
import { WORKBENCH_DOC } from './workbench.js';
import { CUSTOM_BACKENDS_DOC } from './customBackends.js';
import { REQUEST_SCRIPTS_DOC } from './requestScripts.js';
import { MACROS_DOC } from './macros.js';
import { REGEXES_DOC } from './regexes.js';
import { LOREBOOKS_DOC } from './lorebooks.js';
import { PROMPT_LISTS_DOC } from './promptLists.js';
import { TOOLSETS_DOC } from './toolsets.js';
import { QUICK_REPLIES_DOC } from './quickReplies.js';
import { CHATS_DOC } from './chats.js';
import { GAME_CARDS_DOC } from './gameCards.js';
import { GAME_CARDS_FACTORY_DOC } from './gameCardsFactory.js';
import { GAME_CARDS_EVENTS_DOC } from './gameCardsEvents.js';

export const DOCS_TOPICS = [
  'characters',
  'backends',
  'workbench',
  'custom_backends',
  'request_scripts',
  'macros',
  'regexes',
  'lorebooks',
  'prompt_lists',
  'toolsets',
  'quick_replies',
  'chats',
  'game_cards',
  'game_cards_factory',
  'game_cards_events',
] as const;

export type DocsTopic = (typeof DOCS_TOPICS)[number];

export const DOCS_CONTENT: Record<DocsTopic, string> = {
  characters: CHARACTERS_DOC,
  backends: BACKENDS_DOC,
  workbench: WORKBENCH_DOC,
  custom_backends: CUSTOM_BACKENDS_DOC,
  request_scripts: REQUEST_SCRIPTS_DOC,
  macros: MACROS_DOC,
  regexes: REGEXES_DOC,
  lorebooks: LOREBOOKS_DOC,
  prompt_lists: PROMPT_LISTS_DOC,
  toolsets: TOOLSETS_DOC,
  quick_replies: QUICK_REPLIES_DOC,
  chats: CHATS_DOC,
  game_cards: GAME_CARDS_DOC,
  game_cards_factory: GAME_CARDS_FACTORY_DOC,
  game_cards_events: GAME_CARDS_EVENTS_DOC,
};
