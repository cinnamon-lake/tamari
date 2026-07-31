/**
 * English source dictionary — composed from per-domain fragments.
 *
 * Each domain lives in its own file under `./` (e.g. `settings.ts`, `chat.ts`).
 * This keeps the translation surface modular: a contributor localizing one
 * area only edits one fragment. `RawDictionary` is inferred from this composed
 * object, so the flattened keys are type-checked everywhere `t()` is called.
 *
 * To add a new domain: create `<name>.ts` exporting `const <name> = { ... }`,
 * import + spread it below.
 */
import { core } from './core.js';
import { settings } from './settings.js';
import { chat } from './chat.js';
import { messageInput } from './messageInput.js';
import { chatHeader } from './chatHeader.js';
import { backendConfig } from './backendConfig.js';
import { worldInfo } from './worldInfo.js';
import { tools } from './tools.js';
import { promptList } from './promptList.js';
import { persona } from './persona.js';
import { character } from './character.js';
import { audio } from './audio.js';
import { quickReply } from './quickReply.js';
import { media } from './media.js';
import { authorsNote } from './authorsNote.js';
import { groupChat } from './groupChat.js';
import { stats } from './stats.js';
import { schemaForm } from './schemaForm.js';
import { secrets } from './secrets.js';
import { customBackends } from './customBackends.js';
import { generationTraces } from './generationTraces.js';

export const dict = {
  ...core,
  settings,
  chat,
  messageInput,
  chatHeader,
  backendConfig,
  worldInfo,
  tools,
  promptList,
  persona,
  character,
  audio,
  quickReply,
  media,
  authorsNote,
  groupChat,
  stats,
  schemaForm,
  secrets,
  customBackends,
  generationTraces,
};
