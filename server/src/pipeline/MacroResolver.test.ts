import { describe, it, expect } from 'vitest';
import { MacroResolver, type MacroContext } from './MacroResolver.js';

const ctx: MacroContext = {
  userName: 'TestUser',
  charName: 'Seraphina',
  description: 'A helpful AI assistant.',
  personality: 'Kind and patient.',
  scenario: 'You are in a digital tavern.',
  model: 'gpt-4',
  maxContext: 8192,
  maxResponse: 512,
};

/** Deterministic RNG for tests. Cycles through the provided values. */
function deterministicRng(values: number[]): () => number {
  let i = 0;
  return () => {
    const v = values[i % values.length]!;
    i++;
    return v;
  };
}

describe('MacroResolver', () => {
  const resolver = MacroResolver.createStorageResolver();

  it('resolves basic identity macros', () => {
    expect(resolver.resolve('Hello {{user}}', ctx)).toBe('Hello TestUser');
    expect(resolver.resolve('I am {{char}}', ctx)).toBe('I am Seraphina');
    expect(resolver.resolve('I am {{character}}', ctx)).toBe('I am Seraphina');
  });

  it('resolves character field macros', () => {
    expect(resolver.resolve('{{description}}', ctx)).toBe('A helpful AI assistant.');
    expect(resolver.resolve('{{personality}}', ctx)).toBe('Kind and patient.');
    expect(resolver.resolve('{{scenario}}', ctx)).toBe('You are in a digital tavern.');
  });

  it('resolves model and token limit macros', () => {
    expect(resolver.resolve('Model: {{model}}', ctx)).toBe('Model: gpt-4');
    expect(resolver.resolve('Context: {{maxContext}}', ctx)).toBe('Context: 8192');
    expect(resolver.resolve('Response: {{maxResponse}}', ctx)).toBe('Response: 512');
  });

  it('resolves time macros', () => {
    const now = new Date('2024-06-15T14:30:00Z');
    const timeCtx = { ...ctx, now };
    expect(resolver.resolve('{{time}}', timeCtx)).toBe('14:30');
    expect(resolver.resolve('{{date}}', timeCtx)).toBe('June 15, 2024');
    expect(resolver.resolve('{{weekday}}', timeCtx)).toBe('Saturday');
    expect(resolver.resolve('{{isotime}}', timeCtx)).toBe('14:30');
    expect(resolver.resolve('{{isodate}}', timeCtx)).toBe('2024-06-15');
  });

  it('resolves datetimeformat macro', () => {
    const now = new Date('2024-06-15T14:30:00Z');
    const timeCtx = { ...ctx, now };
    expect(resolver.resolve('{{datetimeformat::YYYY-MM-DD HH:mm}}', timeCtx)).toBe('2024-06-15 14:30');
  });

  it('resolves random macros', () => {
    const seeded = MacroResolver.createStorageResolver(deterministicRng([0.5]));
    const result = seeded.resolve('{{random::1::10}}', ctx);
    expect(result).toBe('6'); // floor(0.5 * 10) + 1 = 6
  });

  it('resolves pick macro deterministically', () => {
    const seeded = MacroResolver.createStorageResolver(deterministicRng([0.5]));
    const result = seeded.resolve('{{pick::a::b::c}}', ctx);
    expect(result).toBe('b'); // floor(0.5 * 3) = 1 → 'b'
  });

  it('resolves roll macro deterministically', () => {
    const seeded = MacroResolver.createStorageResolver(deterministicRng([0.5, 0.5]));
    const result = seeded.resolve('{{roll::2d6}}', ctx);
    expect(result).toBe('8'); // floor(0.5 * 6) + 1 = 4, twice = 8
  });

  it('resolves if blocks', () => {
    expect(resolver.resolve('{% if {{user}} %}yes{% endif %}', ctx)).toBe('yes');
    expect(resolver.resolve('{% if %}no{% endif %}', ctx)).toBe('');
    expect(resolver.resolve('{% if {{user}} %}yes{% else %}no{% endif %}', ctx)).toBe('yes');
    expect(resolver.resolve('{% if %}yes{% else %}no{% endif %}', ctx)).toBe('no');
  });

  it('resolves nested if blocks', () => {
    const text = '{% if {{user}} %}{% if {{char}} %}both{% endif %}{% endif %}';
    expect(resolver.resolve(text, ctx)).toBe('both');
  });

  it('resolves unless blocks', () => {
    expect(resolver.resolve('{% unless {{user}} %}no{% endunless %}', ctx)).toBe('');
    expect(resolver.resolve('{% unless %}yes{% endunless %}', ctx)).toBe('yes');
  });

  it('resolves for blocks', () => {
    expect(resolver.resolve('{% for x::a::b::c %}{{x}}{% endfor %}', ctx)).toBe('abc');
    expect(resolver.resolve('{% for x::1::2::3 %}[{{forIndex}}:{{x}}]{% endfor %}', ctx)).toBe('[0:1][1:2][2:3]');
  });

  it('for blocks do not permanently mutate resolver macros', () => {
    const r = MacroResolver.createStorageResolver();
    r.resolve('{% for x::a::b %}{{x}}{% endfor %}', ctx);
    // After the loop, 'x' should not be registered
    expect(r.resolve('{{x}}', ctx)).toBe('{{x}}');
  });

  it('resolves chat inspection macros', () => {
    const chatCtx: MacroContext = {
      ...ctx,
      messages: [
        { id: 1, role: 'user', content: 'Hello' },
        { id: 2, role: 'assistant', content: 'Hi there' },
        { id: 3, role: 'user', content: 'How are you?' },
      ],
    };
    expect(resolver.resolve('{{lastMessage}}', chatCtx)).toBe('How are you?');
    expect(resolver.resolve('{{lastMessageId}}', chatCtx)).toBe('3');
    expect(resolver.resolve('{{lastUserMessage}}', chatCtx)).toBe('How are you?');
    expect(resolver.resolve('{{lastCharMessage}}', chatCtx)).toBe('Hi there');
    expect(resolver.resolve('{{firstIncludedMessageId}}', chatCtx)).toBe('1');
    expect(resolver.resolve('{{currentSwipeId}}', chatCtx)).toBe('3');
  });

  it('resolves state macros', () => {
    const stateCtx: MacroContext = { ...ctx, lastGenerationType: 'continue' };
    expect(resolver.resolve('{{lastGenerationType}}', stateCtx)).toBe('continue');
  });

  it('resolves hasExtension macro', () => {
    const extCtx: MacroContext = { ...ctx, extensions: ['regex', 'tts'] };
    expect(resolver.resolve('{{hasExtension::regex}}', extCtx)).toBe('true');
    expect(resolver.resolve('{{hasExtension::missing}}', extCtx)).toBe('');
    expect(resolver.resolve('{{hasExtension::}}', extCtx)).toBe('');
  });

  it('resolves legacy variable shorthand', () => {
    const varCtx: MacroContext = {
      ...ctx,
      macroVars: { mood: 'happy', tone: 'gentle' },
      globalVars: { version: '2.0', debug: 'on' },
    };
    expect(resolver.resolve('{{.mood}}', varCtx)).toBe('happy');
    expect(resolver.resolve('{{.tone}}', varCtx)).toBe('gentle');
    expect(resolver.resolve('{{.missing}}', varCtx)).toBe('');
    expect(resolver.resolve('{{$version}}', varCtx)).toBe('2.0');
    expect(resolver.resolve('{{$debug}}', varCtx)).toBe('on');
    expect(resolver.resolve('{{$missing}}', varCtx)).toBe('');
  });

  it('passes through unknown macros unchanged', () => {
    expect(resolver.resolve('{{unknown}}', ctx)).toBe('{{unknown}}');
  });

  it('resolves noop and newline', () => {
    expect(resolver.resolve('{{noop}}', ctx)).toBe('');
    expect(resolver.resolve('a{{newline}}b', ctx)).toBe('a\nb');
  });

  it('resolves character card V3 utility macros', () => {
    expect(resolver.resolve('{{reverse::Hello}}', ctx)).toBe('olleH');
    expect(resolver.resolve('{{reverse::123 456}}', ctx)).toBe('654 321');
    expect(resolver.resolve('{{comment::this is ignored}}', ctx)).toBe('');
    expect(resolver.resolve('{{hidden_key::secret trigger}}', ctx)).toBe('');
    expect(resolver.resolve('{{// anything here}}', ctx)).toBe('');
  });

  it('supports custom macros', () => {
    resolver.register('custom', (ctx, args) => {
      const a0 = args[0]?.has_resolved() ? args[0].resolve() : undefined;
      return `${ctx.userName}-${a0 ?? 'default'}`;
    });
    expect(resolver.resolve('{{custom::x}}', ctx)).toBe('TestUser-x');
  });

  it('supports custom block handlers', () => {
    resolver.registerBlock('greet', {
      tryResolve: (condition, branches, _ctx, _resolver) => {
        const name = condition.resolve();
        if (!branches[0]!.has_resolved()) return undefined;
        return `Hello ${name}! ${branches[0]!.resolve()}`;
      },
    });
    expect(resolver.resolve('{% greet {{user}} %}welcome{% endgreet %}', ctx)).toBe('Hello TestUser! welcome');
  });

  it('detects non-deterministic macros', () => {
    expect(resolver.hasNondeterministicMacros('{{random::1::10}}')).toBe(true);
    expect(resolver.hasNondeterministicMacros('{{pick::a::b}}')).toBe(true);
    expect(resolver.hasNondeterministicMacros('{{roll::2d6}}')).toBe(true);
    expect(resolver.hasNondeterministicMacros('{{time}}')).toBe(true);
    expect(resolver.hasNondeterministicMacros('{{date}}')).toBe(true);
    expect(resolver.hasNondeterministicMacros('{{weekday}}')).toBe(true);
    expect(resolver.hasNondeterministicMacros('{{isotime}}')).toBe(true);
    expect(resolver.hasNondeterministicMacros('{{isodate}}')).toBe(true);
    expect(resolver.hasNondeterministicMacros('{{datetimeformat::YYYY}}')).toBe(true);
  });

  it('does not flag deterministic macros as non-deterministic', () => {
    expect(resolver.hasNondeterministicMacros('{{user}}')).toBe(false);
    expect(resolver.hasNondeterministicMacros('{{char}}')).toBe(false);
    expect(resolver.hasNondeterministicMacros('{{description}}')).toBe(false);
    expect(resolver.hasNondeterministicMacros('{{model}}')).toBe(false);
    expect(resolver.hasNondeterministicMacros('Hello world')).toBe(false);
    expect(resolver.hasNondeterministicMacros('{% if {{user}} %}yes{% endif %}')).toBe(false);
  });

  it('does not flag chat inspection or state macros as non-deterministic', () => {
    expect(resolver.hasNondeterministicMacros('{{lastMessage}}')).toBe(false);
    expect(resolver.hasNondeterministicMacros('{{lastGenerationType}}')).toBe(false);
    expect(resolver.hasNondeterministicMacros('{{hasExtension::tts}}')).toBe(false);
    expect(resolver.hasNondeterministicMacros('{{.mood}}')).toBe(false);
    expect(resolver.hasNondeterministicMacros('{{$version}}')).toBe(false);
  });

  it('resolves getvar macro', () => {
    const varCtx: MacroContext = {
      ...ctx,
      macroVars: { place: 'shrine', mood: 'happy' },
      globalVars: { version: '2.0' },
    };
    expect(resolver.resolve('{{getvar::place}}', varCtx)).toBe('shrine');
    expect(resolver.resolve('{{getvar::mood}}', varCtx)).toBe('happy');
    expect(resolver.resolve('{{getvar::version}}', varCtx)).toBe('2.0');
    expect(resolver.resolve('{{getvar::missing}}', varCtx)).toBe('{{getvar::missing}}');
  });

  it('resolves equal macro with nested macros', () => {
    const varCtx: MacroContext = {
      ...ctx,
      macroVars: { place: 'shrine', lang: 'English' },
    };
    expect(resolver.resolve('{{equal::{{getvar::place}}::shrine}}', varCtx)).toBe('true');
    expect(resolver.resolve('{{equal::{{getvar::place}}::temple}}', varCtx)).toBe('');
    expect(resolver.resolve('{{equal::{{getvar::lang}}::English}}', varCtx)).toBe('true');
  });

  it('resolves ? (truthy) macro with &&', () => {
    const varCtx: MacroContext = {
      ...ctx,
      macroVars: { place: 'shrine', situ: 'known', lang: 'English' },
    };
    const expr =
      '{{? {{equal::{{getvar::place}}::shrine}}&&{{equal::{{getvar::situ}}::known}}&&{{equal::{{getvar::lang}}::English}}}}';
    expect(resolver.resolve(expr, varCtx)).toBe('true');

    const expr2 =
      '{{? {{equal::{{getvar::place}}::shrine}}&&{{equal::{{getvar::situ}}::unknown}}}}';
    expect(resolver.resolve(expr2, varCtx)).toBe('');
  });

  it('resolves img macro to markdown image', () => {
    const displayResolver = MacroResolver.createDisplayResolver();
    const assetCtx: MacroContext = {
      ...ctx,
      characterAssets: { 'logo.png': '/api/characters/1/assets/logo', 'map.png': '/api/characters/1/assets/map' },
    };
    expect(displayResolver.resolve('{{img::logo.png}}', assetCtx)).toBe('![logo.png](/api/characters/1/assets/logo)');
    expect(displayResolver.resolve('{{img::missing.png}}', assetCtx)).toBe('![missing.png]');
  });

  it('resolves img macro with sanitized name fallback', () => {
    const displayResolver = MacroResolver.createDisplayResolver();
    const assetCtx: MacroContext = {
      ...ctx,
      // Import sanitizes spaces → underscores
      characterAssets: { 'Touhou_Full-Map.png': '/api/characters/1/assets/map' },
    };
    expect(displayResolver.resolve('{{img::Touhou Full-Map.png}}', assetCtx)).toBe(
      '![Touhou Full-Map.png](/api/characters/1/assets/map)',
    );
  });

  it('resolves time with format argument', () => {
    const now = new Date('2024-06-15T14:30:00Z');
    const timeCtx = { ...ctx, now };
    expect(resolver.resolve('{{time::YYYY}}', timeCtx)).toBe('2024');
    expect(resolver.resolve('{{time::YYYY-MM-DD}}', timeCtx)).toBe('2024-06-15');
  });

  it('resolves complex condition with {% if %} and &&', () => {
    const varCtx: MacroContext = {
      ...ctx,
      macroVars: { place: '하쿠레이_신사', situ: '아는_상황', lang: 'English' },
    };
    const greeting = '{% if {{equal::{{getvar::place}}::하쿠레이_신사}} && {{equal::{{getvar::situ}}::아는_상황}} && {{equal::{{getvar::lang}}::English}} %}Hello from Hakurei Shrine!{% endif %}';
    expect(resolver.resolve(greeting, varCtx)).toBe('Hello from Hakurei Shrine!');
  });

  it('multi-pass: setvar before getvar in same field', () => {
    const r = MacroResolver.createStorageResolver();
    const result = r.resolve('{{getvar::x}} {{setvar::x::hello}}', ctx);
    expect(result).toBe('hello ');
  });

  it('multi-pass: setvar in one field, getvar in another', () => {
    const r = MacroResolver.createStorageResolver();
    const results = r.resolveAll(
      ['{{setvar::x::hello}}', '{{getvar::x}}'],
      { ...ctx, macroVars: {}, globalVars: {} },
    );
    expect(results[0]).toBe('');
    expect(results[1]).toBe('hello');
  });

  it('multi-pass: nested setvar dependencies', () => {
    const r = MacroResolver.createStorageResolver();
    const result = r.resolve('{{getvar::a}} {{setvar::a::{{getvar::b}}}} {{setvar::b::world}}', ctx);
    expect(result).toBe('world  ');
  });

  it('multi-pass: reverse field order also works', () => {
    const r = MacroResolver.createStorageResolver();
    const results = r.resolveAll(
      ['{{getvar::x}}', '{{setvar::x::hello}}'],
      { ...ctx, macroVars: {}, globalVars: {} },
    );
    // Multi-pass is across ALL fields, so setvar in field 1 resolves before
    // getvar in field 0 is retried in pass 2.
    expect(results[0]).toBe('hello');
    expect(results[1]).toBe('');
  });

  it('multi-pass: deep chain of setvars', () => {
    const r = MacroResolver.createStorageResolver();
    const result = r.resolve(
      '{{getvar::a}} {{setvar::a::{{getvar::b}}}} {{setvar::b::{{getvar::c}}}} {{setvar::c::deep}}',
      { ...ctx, macroVars: {} },
    );
    expect(result).toBe('deep   ');
  });

  it('multi-pass: diamond dependency pattern', () => {
    const r = MacroResolver.createStorageResolver();
    const result = r.resolve(
      '{{setvar::base::x}}{{getvar::base}} {{getvar::base}}',
      { ...ctx, macroVars: {} },
    );
    expect(result).toBe('x x');
  });

  it('multi-pass: multiple setvars for same key, last wins', () => {
    const r = MacroResolver.createStorageResolver();
    const result = r.resolve(
      '{{setvar::x::first}} {{setvar::x::second}} {{getvar::x}}',
      ctx,
    );
    expect(result).toBe('  second');
  });

  it('multi-pass: setvar with macro value', () => {
    const r = MacroResolver.createStorageResolver();
    const result = r.resolve(
      '{{setvar::greet::Hello {{user}}}}{{getvar::greet}}',
      ctx,
    );
    expect(result).toBe('Hello TestUser');
  });

  it('blocks: if with unresolved condition returns empty until resolved', () => {
    const r = MacroResolver.createStorageResolver();
    const result = r.resolve(
      '{% if {{getvar::flag}} %}shown{% endif %}',
      { ...ctx, macroVars: {} },
    );
    // flag never set → condition never resolves → block returns empty
    expect(result).toBe('');
  });

  it('blocks: nested if blocks', () => {
    const r = MacroResolver.createStorageResolver();
    const result = r.resolve(
      '{% if {{user}} %}{% if {{char}} %}inner{% else %}else-inner{% endif %}{% else %}outer-else{% endif %}',
      ctx,
    );
    expect(result).toBe('inner');
  });

  it('blocks: unless with truthy condition hides content', () => {
    const r = MacroResolver.createStorageResolver();
    const result = r.resolve(
      '{% unless {{user}} %}hidden{% endunless %}',
      ctx,
    );
    expect(result).toBe('');
  });

  it('blocks: unless with empty condition shows content', () => {
    const r = MacroResolver.createStorageResolver();
    const result = r.resolve(
      '{% unless %}shown{% endunless %}',
      ctx,
    );
    expect(result).toBe('shown');
  });

  it('blocks: for loop with nested content', () => {
    const r = MacroResolver.createStorageResolver();
    const result = r.resolve(
      '{% for item::a::b::c %}[{{item}}]{% endfor %}',
      ctx,
    );
    expect(result).toBe('[a][b][c]');
  });

  it('blocks: for loop index macro', () => {
    const r = MacroResolver.createStorageResolver();
    const result = r.resolve(
      '{% for i::x::y::z %}{{forIndex}}{% endfor %}',
      ctx,
    );
    expect(result).toBe('012');
  });

  it('blocks: for loop does not leak loop variable', () => {
    const r = MacroResolver.createStorageResolver();
    r.resolve('{% for i::a::b %}{{i}}{% endfor %}', ctx);
    expect(r.resolve('{{i}}', ctx)).toBe('{{i}}');
  });

  it('blocks: for loop restores overridden macro', () => {
    const r = MacroResolver.createStorageResolver();
    // 'user' is a built-in macro
    const result = r.resolve('{% for user::a::b %}{{user}}{% endfor %} after:{{user}}', ctx);
    expect(result).toBe('ab after:TestUser');
  });

  it('error handling: unknown macro passes through unchanged', () => {
    const r = MacroResolver.createStorageResolver();
    expect(r.resolve('{{bogus}}', ctx)).toBe('{{bogus}}');
  });

  it('error handling: macro handler can throw', () => {
    const r = MacroResolver.createStorageResolver();
    r.register('boom', () => {
      throw new Error('intentional');
    });
    expect(r.resolve('{{boom}}', ctx)).toBe('[Error: macro "boom" threw: intentional]');
  });

  it('error handling: block handler can throw', () => {
    const r = MacroResolver.createStorageResolver();
    r.registerBlock('kaboom', {
      tryResolve: () => {
        throw new Error('block error');
      },
    });
    expect(r.resolve('{% kaboom %}x{% endkaboom %}', ctx)).toBe(
      '[Error: block threw: block error]',
    );
  });

  it('edge cases: empty template', () => {
    const r = MacroResolver.createStorageResolver();
    expect(r.resolve('', ctx)).toBe('');
  });

  it('edge cases: template with only whitespace', () => {
    const r = MacroResolver.createStorageResolver();
    expect(r.resolve('   \n\t  ', ctx)).toBe('   \n\t  ');
  });

  it('edge cases: macro with empty arg', () => {
    const r = MacroResolver.createStorageResolver();
    expect(r.resolve('{{getvar::}}', ctx)).toBe('{{getvar::}}');
  });

  it('edge cases: macro with nested unresolved macro in arg', () => {
    const r = MacroResolver.createStorageResolver();
    const result = r.resolve('{{getvar::{{getvar::key}}}}', ctx);
    // key is never set, so both getvars stay unresolved
    expect(result).toBe('{{getvar::{{getvar::key}}}}');
  });

  it('edge cases: unclosed block tags pass through as literal text', () => {
    const r = MacroResolver.createStorageResolver();
    expect(r.resolve('{% if {{user}} %}unclosed', ctx)).toBe('{% if {{user}} %}unclosed');
  });

  it('edge cases: orphaned block middle/close tags pass through as literal text', () => {
    const r = MacroResolver.createStorageResolver();
    expect(r.resolve('{% else %}orphan{% endif %}', ctx)).toBe('{% else %}orphan{% endif %}');
  });

  it('boolean expressions: empty string is falsy', () => {
    const r = MacroResolver.createStorageResolver();
    expect(r.resolve('{% if %}no{% else %}yes{% endif %}', ctx)).toBe('yes');
  });

  it('boolean expressions: || short-circuits correctly', () => {
    const r = MacroResolver.createStorageResolver();
    expect(
      r.resolve('{% if {{equal::a::a}}||{{equal::b::c}} %}yes{% endif %}', ctx),
    ).toBe('yes');
  });

  it('boolean expressions: && requires both sides', () => {
    const r = MacroResolver.createStorageResolver();
    expect(
      r.resolve('{% if {{equal::a::a}}&&{{equal::b::c}} %}yes{% else %}no{% endif %}', ctx),
    ).toBe('no');
  });

  it('boolean expressions: mixed && and ||', () => {
    const r = MacroResolver.createStorageResolver();
    // a||b&&c  →  (a||b)&&c  because && binds tighter
    expect(
      r.resolve('{% if {{equal::x::y}}||{{equal::a::a}}&&{{equal::b::b}} %}yes{% endif %}', ctx),
    ).toBe('yes');
  });

  it('caching: repeated resolve returns cached result', () => {
    const r = MacroResolver.createStorageResolver();
    const template = '{{user}}';
    expect(r.resolve(template, ctx)).toBe('TestUser');
    expect(r.resolve(template, ctx)).toBe('TestUser');
  });

  it('caching: for loop clears cache between iterations', () => {
    const r = MacroResolver.createStorageResolver();
    // Custom macro that counts calls
    let calls = 0;
    r.register('counter', () => {
      calls++;
      return String(calls);
    });
    const result = r.resolve('{% for i::a::b::c %}{{counter}}{% endfor %}', ctx);
    expect(result).toBe('123');
    expect(calls).toBe(3);
  });

  it('resolveAll: empty array returns empty array', () => {
    const r = MacroResolver.createStorageResolver();
    expect(r.resolveAll([], ctx)).toEqual([]);
  });

  it('resolveAll: single item behaves like resolve', () => {
    const r = MacroResolver.createStorageResolver();
    expect(r.resolveAll(['Hello {{user}}'], ctx)).toEqual(['Hello TestUser']);
  });

  it('resolveAll: multiple independent fields', () => {
    const r = MacroResolver.createStorageResolver();
    const results = r.resolveAll(['{{user}}', '{{char}}', '{{model}}'], ctx);
    expect(results).toEqual(['TestUser', 'Seraphina', 'gpt-4']);
  });

  it('resolveAll: shared context accumulates setvars across fields', () => {
    const r = MacroResolver.createStorageResolver();
    const results = r.resolveAll(
      ['{{setvar::x::1}}', '{{setvar::y::2}}', '{{getvar::x}}-{{getvar::y}}'],
      { ...ctx, macroVars: {} },
    );
    expect(results).toEqual(['', '', '1-2']);
  });
});

describe('block passthrough for prose', () => {
  it('markdown table mentioning block syntax resolves to itself', () => {
    const r = MacroResolver.createStorageResolver();
    // Original bug report: prose documenting `{% if %}` truncated the rest of
    // the message. `{{#if}}` is an unknown macro and already passes through.
    const prose = '| `{{#if}}` RisuAI blocks → `{% if %}` auto-converted |';
    expect(r.resolve(prose, ctx)).toBe(prose);
  });

  it('unterminated opener passes through, genuine macros after it still resolve', () => {
    const r = MacroResolver.createStorageResolver();
    expect(r.resolve('{% if %}tail {{user}}', ctx)).toBe('{% if %}tail TestUser');
  });

  it('unterminated known block with truthy condition is literal too', () => {
    const r = MacroResolver.createStorageResolver();
    expect(r.resolve('{% if {{user}} %}unclosed', ctx)).toBe('{% if {{user}} %}unclosed');
  });

  it('nested unterminated blocks are literal', () => {
    const r = MacroResolver.createStorageResolver();
    expect(r.resolve('{% if a %}x{% if b %}y', ctx)).toBe('{% if a %}x{% if b %}y');
  });

  it('unknown terminated block passes through unchanged', () => {
    const r = MacroResolver.createStorageResolver();
    expect(r.resolve('{% trans %}hello{% endtrans %}', ctx)).toBe('{% trans %}hello{% endtrans %}');
  });

  it('orphaned close tag passes through unchanged', () => {
    const r = MacroResolver.createStorageResolver();
    expect(r.resolve('a{% endif %}b', ctx)).toBe('a{% endif %}b');
  });

  it('well-formed blocks still evaluate', () => {
    const r = MacroResolver.createStorageResolver();
    expect(r.resolve('{% if {{user}} %}yes{% endif %}', ctx)).toBe('yes');
    expect(r.resolve('{% if %}no{% else %}yes{% endif %}', ctx)).toBe('yes');
  });
});
