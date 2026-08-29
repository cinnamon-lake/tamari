/**
 * st-api domain: utilities — pure string/array/math/JSON helpers and token
 * counting. No chat state, no deps beyond the tokenizer provider.
 */

import { tokenCounterProvider } from '../../tokenizers/TokenCounter.js';
import type { StApi } from './types.js';

export type UtilitiesApi = Pick<
  StApi,
  | 'token_count'
  | 'count_tokens'
  | 'upper'
  | 'lower'
  | 'trim_tokens'
  | 'replace'
  | 'replace_regex'
  | 'match'
  | 'test'
  | 'substring'
  | 'trim_start'
  | 'trim_end'
  | 'random'
  | 'now'
  | 'array_wrap'
  | 'array_unwrap'
  | 'pass'
  | 'is_empty'
  | 'len'
  | 'join'
  | 'split'
  | 'includes'
  | 'starts_with'
  | 'ends_with'
  | 'json_encode'
  | 'json_decode'
  | 'abs'
  | 'floor'
  | 'ceil'
  | 'round'
  | 'clamp'
>;

export function createUtilities(): UtilitiesApi {
  return {
    token_count: (text: string) => {
      const counter = tokenCounterProvider.provideTokenCounter('');
      return counter.count(String(text));
    },

    count_tokens: (text: string) => {
      const counter = tokenCounterProvider.provideTokenCounter('');
      return counter.count(String(text));
    },

    upper: (text: string) => String(text).toUpperCase(),
    lower: (text: string) => String(text).toLowerCase(),

    trim_tokens: (text: string, limit: number) => {
      const counter = tokenCounterProvider.provideTokenCounter('');
      const target = Math.max(0, Math.floor(Number(limit) || 0));
      let trimmed = String(text);
      while (counter.count(trimmed) > target && trimmed.length > 0) {
        trimmed = trimmed.slice(0, -1);
      }
      return trimmed;
    },

    replace: (text: string, search: string, replacement: string) => {
      return String(text).split(String(search)).join(String(replacement));
    },

    replace_regex: (text: string, pattern: string, replacement: string) => {
      return String(text).replace(new RegExp(String(pattern), 'g'), String(replacement));
    },

    match: (text: string, pattern: string) => {
      const matches = String(text).match(new RegExp(String(pattern), 'g'));
      return matches ?? [];
    },

    test: (text: string, pattern: string) => {
      return new RegExp(String(pattern)).test(String(text));
    },

    substring: (text: string, start: number, end?: number) => {
      return String(text).substring(Number(start), end !== undefined ? Number(end) : undefined);
    },

    trim_start: (text: string) => {
      const str = String(text);
      const index = str.match(/[.!?\n]/)?.index;
      return index !== undefined ? str.substring(0, index + 1) : str;
    },

    trim_end: (text: string) => {
      const str = String(text);
      const index = str.match(/[.!?\n](?!.*[.!?\n])/)?.index;
      return index !== undefined ? str.substring(index + 1) : str;
    },

    random: (min?: number, max?: number) => {
      const lo = min !== undefined ? Math.floor(Number(min)) : 0;
      const hi = max !== undefined ? Math.floor(Number(max)) : 100;
      return Math.floor(Math.random() * (hi - lo + 1)) + lo;
    },

    now: () => Math.floor(Date.now() / 1000),

    array_wrap: (value: unknown) => [value],
    array_unwrap: (arr: unknown[]) => (Array.isArray(arr) ? arr[0] : arr),

    pass: (value: unknown) => value,

    is_empty: (value: unknown) => {
      if (value === null || value === undefined) return true;
      if (typeof value === 'string') return value.trim().length === 0;
      if (Array.isArray(value)) return value.length === 0;
      if (typeof value === 'object') return Object.keys(value).length === 0;
      return false;
    },

    len: (value: unknown) => {
      if (typeof value === 'string') return value.length;
      if (Array.isArray(value)) return value.length;
      return 0;
    },

    join: (arr: unknown[], separator?: string) => {
      if (!Array.isArray(arr)) throw new Error('join: expected array');
      return arr.join(typeof separator === 'string' ? separator : ',');
    },

    split: (text: string, separator?: string) => {
      return String(text).split(typeof separator === 'string' ? separator : ',');
    },

    includes: (text: string, search: string) => String(text).includes(String(search)),
    starts_with: (text: string, prefix: string) => String(text).startsWith(String(prefix)),
    ends_with: (text: string, suffix: string) => String(text).endsWith(String(suffix)),

    json_encode: (value: unknown) => JSON.stringify(value),
    json_decode: (text: string): unknown => JSON.parse(String(text)),

    abs: (n: number) => Math.abs(Number(n)),
    floor: (n: number) => Math.floor(Number(n)),
    ceil: (n: number) => Math.ceil(Number(n)),
    round: (n: number) => Math.round(Number(n)),
    clamp: (n: number, min: number, max: number) => Math.min(Math.max(Number(n), Number(min)), Number(max)),
  };
}
