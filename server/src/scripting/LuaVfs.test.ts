import { describe, it, expect } from 'vitest';
import { LuaRuntime } from './LuaRuntime.js';
import { validateVfsPath } from './LuaVfs.js';

describe('validateVfsPath', () => {
  it.each([
    ['lib/utils', 'lib/utils.lua'],
    ['lib/utils.lua', 'lib/utils.lua'],
    ['./lib/utils', 'lib/utils.lua'],
    ['utils', 'utils.lua'],
    ['a/b/c.lua', 'a/b/c.lua'],
    ['my-module_v2', 'my-module_v2.lua'],
  ])('normalizes %s → %s', (input, expected) => {
    expect(validateVfsPath(input)).toBe(expected);
  });

  it.each([
    '/abs.lua',       // leading slash
    '../x.lua',       // traversal
    'a/../b.lua',     // inner traversal
    'a//b.lua',       // empty segment
    'a/b/',           // trailing slash
    'bad name.lua',   // spaces
    'bad$name.lua',   // special chars
    '',               // empty
    '.hidden/x.lua',  // dot segment
  ])('rejects %s', (input) => {
    expect(validateVfsPath(input)).toBeNull();
  });
});

describe('VFS require', () => {
  const runtime = new LuaRuntime();

  async function runWithVfs(script: string, files: Record<string, string>) {
    const { lua, cleanup } = await runtime.createState({ vfsFiles: files });
    try {
      return await runtime.run(lua, script);
    } finally {
      cleanup();
    }
  }

  it('requires a module and uses its return value', async () => {
    const { result, error } = await runWithVfs(
      `local g = require('lib/greeting')
       return g.hello('world')`,
      { 'lib/greeting.lua': `return { hello = function(name) return 'hi ' .. name end }` },
    );
    expect(error).toBeUndefined();
    expect(result).toBe('hi world');
  });

  it('appends .lua and strips leading ./ when resolving', async () => {
    const { result } = await runWithVfs(
      `return require('./utils') == require('utils.lua')`,
      { 'utils.lua': 'return {}' },
    );
    expect(result).toBe(true);
  });

  it('executes a module only once per state (package.loaded semantics)', async () => {
    const { result, error } = await runWithVfs(
      `require('counter')
       require('counter')
       return __count`,
      { 'counter.lua': `__count = (__count or 0) + 1
return {}` },
    );
    expect(error).toBeUndefined();
    expect(result).toBe(1);
  });

  it('supports modules requiring modules', async () => {
    const { result, error } = await runWithVfs(
      `local b = require('b')
       return b.value`,
      {
        'a.lua': `return { value = 42 }`,
        'b.lua': `local a = require('a')
return { value = a.value + 1 }`,
      },
    );
    expect(error).toBeUndefined();
    expect(result).toBe(43);
  });

  it('raises on circular requires', async () => {
    const { error } = await runWithVfs(
      `return require('a')`,
      {
        'a.lua': `return require('b')`,
        'b.lua': `return require('a')`,
      },
    );
    expect(error).toContain('circular require');
  });

  it('raises on unknown modules', async () => {
    const { error } = await runWithVfs(`return require('nope')`, {});
    expect(error).toContain('module not found');
  });

  it('raises on invalid module paths', async () => {
    const { error } = await runWithVfs(
      `return require('../escape')`,
      { 'escape.lua': 'return 1' },
    );
    expect(error).toContain('invalid module path');
  });

  it('cannot reach sources outside the VFS map', async () => {
    const { error } = await runWithVfs(
      `return require('/etc/passwd')`,
      { 'etc/passwd.lua': 'return "oops"' },
    );
    expect(error).toContain('invalid module path');
  });

  it('strips load/loadstring/dofile but keeps require', async () => {
    const { lua, cleanup } = await runtime.createState({ vfsFiles: {} });
    try {
      const { result } = await runtime.run(
        lua,
        `return { load = type(load), loadstring = type(loadstring), dofile = type(dofile), require = type(require) }`,
      );
      expect(result).toEqual({ load: 'nil', loadstring: 'nil', dofile: 'nil', require: 'function' });
    } finally {
      cleanup();
    }
  });

  it('leaves require absent when no vfsFiles are given', async () => {
    const { lua, cleanup } = await runtime.createState({});
    try {
      const { result } = await runtime.run(lua, `return require`);
      expect(result).toBeNull();
    } finally {
      cleanup();
    }
  });
});
