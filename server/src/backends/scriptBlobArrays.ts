/**
 * JSON + recursive-array primitives over the script blob repository.
 *
 * These are the JS side of the `store` global's higher-level ops — one
 * promise (one Lua :await()) per operation, so scripts never chain
 * get→decode→append→put across the Lua↔JS boundary:
 *
 *   putJson(name, value)   — value is eagerly deep-converted from a Lua
 *                            (proxy) table to plain JSON, then stored.
 *   getJson(id)            — validated read: returns the RAW JSON string
 *                            (Lua decodes it natively — a decode that can
 *                            never fail, because it was validated here).
 *                            Missing → undefined (Lua nil); corrupt → throws.
 *   append(prevId, item)   — persistent linked list: one node
 *                            { item, prev } per call, returns the new head.
 *                            The item may be an array (the batching idiom).
 *                            Missing prev → throws (a pointer to nothing).
 *   readArray(id)          — walks the chain oldest-first and recursively
 *                            flattens array items, returns the result as a
 *                            JSON string (validated by construction).
 *
 * Reads return JSON strings rather than parsed structures ON PURPOSE: the
 * lib ecosystem (json.encode, sanitize.data, string ops) works on native
 * Lua tables, and long-lived wasmoon proxies are a known GC hazard — so
 * the Lua side json.decode's once, into natives.
 */

import type { IScriptBlobRepository } from '../repos/ScriptBlobRepository.js';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Deep-convert a Lua (wasmoon proxy) value to plain JSON data. */
function toPlainJson(v: unknown): Json {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean' || typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'object') return null; // functions/userdata: not data
  if (Array.isArray(v)) return v.map(toPlainJson);
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj);
  // A Lua sequence arrives as an array OR as an object with 1..n numeric keys.
  if (keys.length > 0 && keys.every((k) => /^\d+$/.test(k))) {
    const nums = keys.map(Number).sort((a, b) => a - b);
    if (nums[0] === 1 && nums[nums.length - 1] === nums.length) {
      return nums.map((n) => toPlainJson(obj[String(n)]));
    }
  }
  const out: Record<string, Json> = {};
  for (const k of keys) out[k] = toPlainJson(obj[k]);
  return out;
}

export async function storePutJson(repo: IScriptBlobRepository, name: string, value: unknown): Promise<string> {
  return repo.put(name, JSON.stringify(toPlainJson(value)));
}

/** Validated read: raw JSON string (Lua decodes natively), nil when missing, loud when corrupt. */
export async function storeGetJson(repo: IScriptBlobRepository, id: unknown): Promise<string | undefined> {
  const sid = typeof id === 'string' ? id : '';
  const body = await repo.get(sid);
  if (body === null) return undefined;
  try {
    JSON.parse(body);
  } catch {
    throw new Error(`store.getJson: corrupted JSON blob (${sid})`);
  }
  return body;
}

interface ListNode {
  item: unknown;
  prev: unknown; // string id | null at rest; validated on read
}

/** Coerce a Lua id argument: nil/"" → null (no link), string → itself, anything else is a bug. */
function asId(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'string') return v;
  throw new Error(`store: blob ids must be strings, got ${typeof v}`);
}

export async function storeAppend(repo: IScriptBlobRepository, prevId: unknown, item: unknown): Promise<string> {
  const prev = asId(prevId);
  if (prev !== null && (await repo.get(prev)) === null) {
    throw new Error(`store.append: missing prev blob (${prev}) — a pointer to nothing is a bug`);
  }
  const node: ListNode = { item: toPlainJson(item), prev };
  return repo.put('arr', JSON.stringify(node));
}

/** Walk the chain oldest-first, recursively flattening array items. */
export async function storeReadArray(repo: IScriptBlobRepository, id: unknown): Promise<string> {
  let cur = asId(id);
  const chain: unknown[] = [];
  while (cur !== null) {
    const body = await repo.get(cur);
    if (body === null) throw new Error(`store.readArray: missing node blob (${cur}) — a pointer to nothing is a bug`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error(`store.readArray: corrupted node blob (${cur})`);
    }
    if (typeof parsed !== 'object' || parsed === null || !('item' in parsed)) {
      throw new Error(`store.readArray: blob (${cur}) is not a list node`);
    }
    const node = parsed as ListNode;
    chain.push(node.item);
    cur = typeof node.prev === 'string' ? node.prev : null;
  }
  chain.reverse();
  const out: unknown[] = [];
  const flatten = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const x of v) flatten(x);
    } else {
      out.push(v);
    }
  };
  for (const item of chain) flatten(item);
  return JSON.stringify(out);
}
