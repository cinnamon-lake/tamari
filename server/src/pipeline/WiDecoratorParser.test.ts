import { describe, it, expect } from 'vitest';
import { parseDecorators } from './WiDecoratorParser.js';

describe('parseDecorators', () => {
  it('returns content unchanged when no decorators', () => {
    const result = parseDecorators('Hello world');
    expect(result.overrides.content).toBe('Hello world');
    expect(result.flags).toEqual({});
  });

  it('strips decorators from content', () => {
    const result = parseDecorators('@@activate\nThe sky is green');
    expect(result.overrides.content).toBe('The sky is green');
  });

  it('handles multiple decorators', () => {
    const result = parseDecorators('@@depth 3\n@@role system\n@@activate\nContent here');
    expect(result.overrides.content).toBe('Content here');
    expect(result.overrides.depth).toBe(3);
    expect(result.overrides.position).toBe('atDepth');
    expect(result.overrides.role).toBe('system');
    expect(result.overrides.constant).toBe(true);
  });

  it('returns empty content when all lines are decorators', () => {
    const result = parseDecorators('@@activate\n@@dont_activate');
    expect(result.overrides.content).toBe('');
  });

  it('maps @@activate to constant', () => {
    const result = parseDecorators('@@activate\nContent');
    expect(result.overrides.constant).toBe(true);
  });

  it('maps @@dont_activate to disable', () => {
    const result = parseDecorators('@@dont_activate\nContent');
    expect(result.overrides.disable).toBe(true);
  });

  it('maps @@depth N to depth + position=atDepth', () => {
    const result = parseDecorators('@@depth 5\nContent');
    expect(result.overrides.depth).toBe(5);
    expect(result.overrides.position).toBe('atDepth');
  });

  it('maps @@role to role', () => {
    const result = parseDecorators('@@role system\nContent');
    expect(result.overrides.role).toBe('system');
  });

  it('rejects invalid @@role values', () => {
    const result = parseDecorators('@@role narrator\nContent');
    expect(result.overrides.role).toBeUndefined();
  });

  it('maps @@keep_activate_after_match to sticky', () => {
    const result = parseDecorators('@@keep_activate_after_match\nContent');
    expect(result.overrides.sticky).toBeGreaterThan(999_000);
  });

  it('maps @@activate_only_after N to delay', () => {
    const result = parseDecorators('@@activate_only_after 5\nContent');
    expect(result.overrides.delay).toBe(5);
  });

  it('maps @@activate_only_every N to cooldown', () => {
    const result = parseDecorators('@@activate_only_every 3\nContent');
    expect(result.overrides.cooldown).toBe(3);
  });

  it('sets dontActivateAfterMatch flag', () => {
    const result = parseDecorators('@@dont_activate_after_match\nContent');
    expect(result.flags.dontActivateAfterMatch).toBe(true);
  });

  it('parses @@additional_keys as comma-separated list', () => {
    const result = parseDecorators('@@additional_keys foo, bar, baz\nContent');
    expect(result.flags.additionalKeys).toEqual(['foo', 'bar', 'baz']);
  });

  it('parses @@exclude_keys as comma-separated list', () => {
    const result = parseDecorators('@@exclude_keys foo, bar\nContent');
    expect(result.flags.excludeKeys).toEqual(['foo', 'bar']);
  });

  it('parses @@scan_depth N', () => {
    const result = parseDecorators('@@scan_depth 10\nContent');
    expect(result.flags.scanDepth).toBe(10);
  });

  it('parses @@is_greeting N', () => {
    const result = parseDecorators('@@is_greeting 2\nContent');
    expect(result.flags.isGreeting).toBe(2);
  });

  it('parses @@ignore_on_max_context', () => {
    const result = parseDecorators('@@ignore_on_max_context\nContent');
    expect(result.flags.ignoreOnMaxContext).toBe(true);
  });

  it('unknown @@ decorator is consumed, looks for @@@ fallback', () => {
    const result = parseDecorators('@@activate\n@@unknown_decorator foo\nThis is content');
    // @@activate is parsed; @@unknown is consumed (not leaked into content);
    // no @@@ fallback follows, so content is just "This is content".
    expect(result.overrides.content).toBe('This is content');
    expect(result.overrides.constant).toBe(true);
  });

  it('@@@ fallback with no preceding unknown @@ is skipped', () => {
    const result = parseDecorators('@@@activate\nContent');
    // @@@ with no preceding unknown @@ → skipped (no fallback to process).
    expect(result.overrides.constant).toBeUndefined();
    expect(result.overrides.content).toBe('Content');
  });

  it('@@@ fallback after unknown decorator is used', () => {
    const result = parseDecorators('@@unknown_decorator\n@@@activate\nContent');
    // @@unknown is unknown → look for fallback. @@@activate is known → use it.
    expect(result.overrides.constant).toBe(true);
    expect(result.overrides.content).toBe('Content');
  });

  it('multiple @@@ fallback chain — first known fallback wins', () => {
    const result = parseDecorators('@@unknown\n@@@also_unknown\n@@@activate\nContent');
    // @@unknown → pending. @@@also_unknown → also unknown, stay pending.
    // @@@activate → known → use it.
    expect(result.overrides.constant).toBe(true);
    expect(result.overrides.content).toBe('Content');
  });
});
