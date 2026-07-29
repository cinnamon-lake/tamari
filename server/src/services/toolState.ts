/**
 * Shared helpers for the branch-aware tool state protocol (`_toolState`).
 *
 * Protocol ownership is split by template source:
 * - Builtin TS templates: ToolRegistry owns deserialize → execute → serialize.
 *   Builtin templates are stateful singletons whose serialize()/deserialize()
 *   mutate the instance, so the registry drives the protocol around execute().
 * - Lua templates: LuaToolExecutor owns the full protocol. Each execution
 *   loads a fresh Lua state, restores the latest snapshot via the Lua
 *   `deserialize`, and serializes afterwards. ToolRegistry's Lua wrapper
 *   (`wrapLuaTemplate`) deliberately uses no-op serialize/deserialize stubs so
 *   the registry-level protocol is inert for Lua templates — the real restore
 *   happens inside LuaToolExecutor.execute().
 */

import type { MessageExtra } from '@tamari/types';

/**
 * Message/result `extra` key under which per-stateKey serialized tool state
 * snapshots are stored: `extra._toolState = { [stateKey]: serialized }`.
 */
export const TOOL_STATE_KEY = '_toolState';

/**
 * Scan the branch message history backwards for the newest serialized state
 * snapshot for `stateKey`. Tool-result content parts are checked newest-first
 * before a top-level `_toolState` map on the message extra. Accepts anything
 * with a message `extra` (full repo Messages, ToolContextMessages, …).
 */
export function findLatestStateSnapshot(stateKey: string, messages?: Array<{ extra?: MessageExtra }>): string | undefined {
  if (!messages || messages.length === 0) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    const parts = msg.extra?.parts;
    if (parts) {
      for (let j = parts.length - 1; j >= 0; j--) {
        const part = parts[j];
        if (part?.type === 'tool_result') {
          const stateMap = part.extra?.[TOOL_STATE_KEY] as Record<string, string> | undefined;
          if (stateMap && stateKey in stateMap) {
            return stateMap[stateKey];
          }
        }
      }
    }
    const topState = msg.extra?.[TOOL_STATE_KEY];
    if (topState && stateKey in topState) {
      return topState[stateKey];
    }
  }
  return undefined;
}
