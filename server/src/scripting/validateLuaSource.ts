/**
 * Shared load-check for card backend_logic Lua source.
 *
 * Extracted from CharacterWorkbench (backend_logic_set / backend_logic_edit /
 * backend_file_set) so the unpacked-card folder parser applies the exact same
 * validation to on-disk backend_logic/ directories.
 */

import type { LuaRuntime } from './LuaRuntime.js';

/** Load-check Lua in a fresh sandbox WITH the card's module map: the chunk
    must parse, requires against EXISTING modules must resolve and load, and
    (for main.lua) generate() must be defined. A "module not found" error is
    tolerated — main-before-modules is a legal authoring order; the dry-run
    (test_backend_logic) validates the full set. Returns error string | null. */
export async function validateLuaSource(
  luaRuntime: LuaRuntime,
  source: string,
  files: Record<string, string>,
  needsGenerate: boolean,
): Promise<string | null> {
  const attempt = async (withMap: boolean, stubRequire: boolean): Promise<string | null> => {
    try {
      const { lua, cleanup } = await luaRuntime.createState(withMap ? { vfsFiles: files } : {}, 10_000);
      try {
        if (stubRequire) lua.global.set('require', () => ({}));
        await lua.doString(source);
        if (needsGenerate && typeof lua.global.get('generate') !== 'function') {
          return 'script must define generate(prompt, ctx)';
        }
        return null;
      } finally {
        cleanup();
      }
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };
  const err = await attempt(true, false);
  if (err === null || !err.includes('module not found:')) return err;
  return attempt(false, true);
}

/** Load-check a backend script: must load and define generate(). */
export function validateBackendLuaSource(
  luaRuntime: LuaRuntime,
  source: string,
  files: Record<string, string>,
): Promise<string | null> {
  return validateLuaSource(luaRuntime, source, files, true);
}
