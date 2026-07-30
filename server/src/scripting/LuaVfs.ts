/**
 * LuaVfs — a sandboxed, per-card virtual filesystem for Lua `require`.
 *
 * Modules live in a plain path→source map (`extensions.contextualBackend.files`
 * for card backend_logic). `require` is implemented as a generated Lua prelude
 * (NOT a TS bridge): wasmoon's JS→Lua calls are async, which would force
 * `require('x'):await()` ergonomics. The prelude captures the `load` builtin
 * into a closure, so it MUST be installed before LuaRuntime strips the global.
 *
 * The filesystem is never touched — the VFS map is the only module source.
 * See docs/design/complex-card-scripting.md.
 */

/** Normalize a require path or VFS key: 'lib/utils' → 'lib/utils.lua'.
    Returns the canonical key, or null for invalid paths. */
export function validateVfsPath(path: string): string | null {
  let p = path.trim();
  while (p.startsWith('./')) p = p.slice(2);
  if (p.startsWith('/') || p.length === 0) return null;
  if (!p.endsWith('.lua')) p += '.lua';
  const segs = p.split('/');
  for (const seg of segs) {
    if (seg.length === 0) return null; // '//', trailing '/'
  }
  for (let i = 0; i < segs.length - 1; i++) {
    if (!/^[A-Za-z0-9_-]+$/.test(segs[i]!)) return null;
  }
  if (!/^[A-Za-z0-9_-]+\.lua$/.test(segs[segs.length - 1]!)) return null;
  return p;
}

/** Pick a long-bracket level whose closer never appears in `s`. */
function luaLongString(s: string): string {
  for (let level = 0; ; level++) {
    const eq = '='.repeat(level);
    if (!s.includes(`]${eq}]`)) return `[${eq}[${s}]${eq}]`;
  }
}

/**
 * Generate the Lua prelude that defines `require` over `files`. Keys that fail
 * validation are skipped (getCharacterBackendScript is the de-facto validator
 * and reports them; a bad key must not break the whole prelude).
 */
export function vfsRequirePrelude(files: Record<string, string>): string {
  const entries: string[] = [];
  for (const [key, source] of Object.entries(files)) {
    const normalized = validateVfsPath(key);
    if (!normalized) continue;
    entries.push(`[ ${luaLongString(normalized)} ] = ${luaLongString(source)}`);
  }
  // The prelude captures `load` before LuaRuntime strips the global. Semantics
  // mirror package.loaded: a module executes once per Lua state; nil results
  // cache as `true`; circular requires and unknown modules raise Lua errors.
  return `do
  local __load = load
  local __sources = { ${entries.join(',\n    ')} }
  local __loaded = {}
  local __loading = {}
  local function normalize(path)
    if type(path) ~= 'string' then return nil end
    path = path:gsub('^%./+', '')
    if path:sub(1, 1) == '/' or path == '' then return nil end
    if path:sub(-4) ~= '.lua' then path = path .. '.lua' end
    if path:find('//') then return nil end
    for seg in path:gmatch('[^/]+') do
      if not seg:match('^[A-Za-z0-9_%-]+$') and not seg:match('^[A-Za-z0-9_%-]+%.lua$') then
        return nil
      end
    end
    return path
  end
  function require(path)
    local key = normalize(path)
    if not key then error('invalid module path: ' .. tostring(path), 2) end
    if __loaded[key] ~= nil then return __loaded[key] end
    local src = __sources[key]
    if src == nil then error('module not found: ' .. tostring(path), 2) end
    if __loading[key] then error('circular require: ' .. key, 2) end
    __loading[key] = true
    local chunk, cerr = __load(src, '@' .. key)
    if chunk == nil then
      __loading[key] = nil
      error('failed to load ' .. key .. ': ' .. tostring(cerr), 2)
    end
    local ok, result = pcall(chunk)
    __loading[key] = nil
    if not ok then error(result, 0) end
    if result == nil then result = true end
    __loaded[key] = result
    return result
  end
end
`;
}
