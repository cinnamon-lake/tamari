
import type { MacroGenerationType, MessageRole } from '@tamari/types';

/**
 * Evaluate a simple boolean expression string after all macros have been resolved.
 * Supports: && (AND), || (OR), and truthy/falsy values.
 */
export function evaluateBooleanExpression(expr: string): boolean {
  const trimmed = expr.trim();
  if (!trimmed) return false;

  const orParts = splitByOperator(trimmed, '||');
  for (const orPart of orParts) {
    const andParts = splitByOperator(orPart, '&&');
    const allTrue = andParts.every((p) => isTruthy(p));
    if (allTrue) return true;
  }
  return false;
}

function splitByOperator(expr: string, op: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === '(') {
      depth++;
      current += ch;
    } else if (ch === ')') {
      depth--;
      current += ch;
    } else if (depth === 0 && expr.slice(i, i + op.length) === op) {
      parts.push(current.trim());
      current = '';
      i += op.length - 1;
    } else {
      current += ch;
    }
  }
  parts.push(current.trim());
  return parts.length > 0 ? parts : [expr];
}

function isTruthy(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === 'false' || trimmed === '0') return false;
  return true;
}

export interface MacroMessage {
  id: number | string;
  role: MessageRole;
  content: string;
}

export interface MacroContext {
  userName: string;
  charName: string;
  description?: string;
  personality?: string;
  scenario?: string;
  persona?: string;
  model?: string;
  maxContext?: number;
  maxResponse?: number;
  now?: Date;
  messages?: MacroMessage[];
  lastGenerationType?: MacroGenerationType;
  extensions?: string[];
  macroVars?: Record<string, string>;
  globalVars?: Record<string, string>;
  characterAssets?: Record<string, string>;
  /** Attachment map for display macro resolution: id → { url, mimeType } */
  attachments?: Record<string, { url: string; mimeType: string }>;
}

export type Token =
  | { type: 'TEXT'; value: string }
  | { type: 'EXPR'; content: string }
  | { type: 'BLOCK_OPEN'; name: string; condition: string; raw: string }
  | { type: 'BLOCK_MIDDLE'; name: string; condition: string; raw: string }
  | { type: 'BLOCK_CLOSE'; name: string; raw: string };

export type MacroHandler = (ctx: MacroContext, args: Resoluble[], resolver: MacroResolver) => string | undefined;

export interface BlockHandler {
  tryResolve(condition: Resoluble, branches: Resoluble[], ctx: MacroContext, resolver: MacroResolver): string | undefined;
}

/** Maximum passes before giving up on a template. */
const MAX_PASSES = 10;

// ---------------------------------------------------------------------------
// Resoluble AST
// ---------------------------------------------------------------------------

export abstract class Resoluble {
  abstract has_resolved(): boolean;
  abstract resolve(): string;
}

export class TextResoluble extends Resoluble {
  constructor(private text: string) {
    super();
  }
  has_resolved(): boolean {
    return true;
  }
  resolve(): string {
    return this.text;
  }
}

export class ConcatResoluble extends Resoluble {
  constructor(private children: Resoluble[]) {
    super();
  }
  has_resolved(): boolean {
    return this.children.every((c) => c.has_resolved());
  }
  resolve(): string {
    return this.children.map((c) => c.resolve()).join('');
  }
}

export class MacroResoluble extends Resoluble {
  private cached: string | undefined;
  private done = false;

  constructor(
    private name: string,
    private args: Resoluble[],
    private resolver: MacroResolver,
  ) {
    super();
  }

  private getHandler(): MacroHandler | undefined {
    return this.resolver.getMacroHandler(this.name);
  }

  private passThrough(): string {
    const argValues = this.args.map((a) => a.resolve());
    return `{{${this.name}${argValues.map((v) => '::' + v).join('')}}}`;
  }

  has_resolved(): boolean {
    if (this.done) return true;
    const handler = this.getHandler();
    if (!handler) {
      // Unknown macro — pass through unchanged
      this.cached = this.passThrough();
      this.done = true;
      return true;
    }
    if (!this.args.every((a) => a.has_resolved())) return false;
    try {
      const result = handler(this.resolver.ctx, this.args, this.resolver);
      if (result === undefined) return false;
      this.cached = result;
      this.done = true;
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.cached = `[Error: macro "${this.name}" threw: ${message}]`;
      this.done = true;
      return true;
    }
  }

  resolve(): string {
    if (this.done) return this.cached ?? '';
    const handler = this.getHandler();
    if (!handler) {
      // Unknown macro — pass through unchanged
      this.cached = this.passThrough();
      this.done = true;
      return this.cached;
    }
    try {
      const result = handler(this.resolver.ctx, this.args, this.resolver);
      if (result !== undefined) {
        this.cached = result;
        this.done = true;
        return result;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.cached = `[Error: macro "${this.name}" threw: ${message}]`;
      this.done = true;
      return this.cached;
    }
    // Not ready — emit raw syntax with best-effort resolved args
    const argValues = this.args.map((a) => a.resolve());
    return `{{${this.name}${argValues.map((v) => '::' + v).join('')}}}`;
  }

  invalidate(): void {
    this.done = false;
    this.cached = undefined;
  }
}

export class BlockResoluble extends Resoluble {
  private cached: string | undefined;
  private done = false;

  constructor(
    private condition: Resoluble,
    private branches: Resoluble[],
    private handler: BlockHandler | undefined,
    private context: MacroContext,
    private resolver: MacroResolver,
  ) {
    super();
  }

  has_resolved(): boolean {
    if (this.done) return true;
    if (!this.handler) {
      // Unknown block — defensive fallback; the parser now passes unknown
      // blocks through as literal text before a BlockResoluble is constructed.
      this.cached = '';
      this.done = true;
      return true;
    }
    if (!this.condition.has_resolved()) return false;
    try {
      const result = this.handler.tryResolve(this.condition, this.branches, this.context, this.resolver);
      if (result === undefined) return false;
      this.cached = result;
      this.done = true;
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.cached = `[Error: block threw: ${message}]`;
      this.done = true;
      return true;
    }
  }

  resolve(): string {
    if (this.done) return this.cached ?? '';
    if (!this.handler) {
      // Unknown block — defensive fallback; see has_resolved(). The parser
      // passes unknown blocks through as literal text, so this is unreachable
      // from normal parsing.
      this.cached = '';
      this.done = true;
      return this.cached;
    }
    try {
      const result = this.handler.tryResolve(this.condition, this.branches, this.context, this.resolver);
      if (result !== undefined) {
        this.cached = result;
        this.done = true;
        return result;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.cached = `[Error: block threw: ${message}]`;
      this.done = true;
      return this.cached;
    }
    // Not ready — return empty placeholder (will fill in on next pass)
    return '';
  }

  invalidate(): void {
    this.done = false;
    this.cached = undefined;
  }
}

// ---------------------------------------------------------------------------
// Lexer (unchanged tokenization)
// ---------------------------------------------------------------------------

class Lexer {
  lex(input: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;

    while (i < input.length) {
      const exprStart = input.indexOf('{{', i);
      const blockStart = input.indexOf('{%', i);

      const nextSpecial = Math.min(
        exprStart === -1 ? Infinity : exprStart,
        blockStart === -1 ? Infinity : blockStart,
      );

      if (nextSpecial === Infinity) {
        if (i < input.length) {
          tokens.push({ type: 'TEXT', value: input.slice(i) });
        }
        break;
      }

      if (nextSpecial > i) {
        tokens.push({ type: 'TEXT', value: input.slice(i, nextSpecial) });
      }

      if (nextSpecial === exprStart) {
        let end = exprStart + 2;
        let depth = 1;
        while (end < input.length - 1 && depth > 0) {
          if (input[end] === '{' && input[end + 1] === '{') {
            depth++;
            end += 2;
          } else if (input[end] === '}' && input[end + 1] === '}') {
            depth--;
            if (depth === 0) break;
            end += 2;
          } else {
            end++;
          }
        }
        if (depth > 0) {
          tokens.push({ type: 'TEXT', value: input.slice(i) });
          break;
        }
        const content = input.slice(exprStart + 2, end);
        tokens.push({ type: 'EXPR', content });
        i = end + 2;
      } else {
        const end = input.indexOf('%}', blockStart + 2);
        if (end === -1) {
          tokens.push({ type: 'TEXT', value: input.slice(i) });
          break;
        }
        const inner = input.slice(blockStart + 2, end).trim();
        const raw = input.slice(blockStart, end + 2);
        const token = this.parseBlock(inner, raw);
        if (token) {
          tokens.push(token);
        } else {
          tokens.push({ type: 'TEXT', value: raw });
        }
        i = end + 2;
      }
    }

    return tokens;
  }

  private parseBlock(inner: string, raw: string): Token | null {
    const spaceIdx = inner.search(/\s/);
    const name = spaceIdx === -1 ? inner : inner.slice(0, spaceIdx);
    const rest = spaceIdx === -1 ? '' : inner.slice(spaceIdx + 1).trim();

    if (name.startsWith('end')) {
      return { type: 'BLOCK_CLOSE', name: name.slice(3), raw };
    }

    const middles = new Set(['else', 'elsif', 'elif', 'otherwise']);
    if (middles.has(name)) {
      return { type: 'BLOCK_MIDDLE', name, condition: rest, raw };
    }

    return { type: 'BLOCK_OPEN', name, condition: rest, raw };
  }
}

// ---------------------------------------------------------------------------
// Parser: Token[] → Resoluble tree
// ---------------------------------------------------------------------------

/** Reconstruct the exact source a token slice was lexed from. */
function tokensToSource(tokens: Token[]): string {
  return tokens
    .map((t) => {
      switch (t.type) {
        case 'TEXT': return t.value;
        case 'EXPR': return `{{${t.content}}}`;
        default: return t.raw; // BLOCK_OPEN / BLOCK_MIDDLE / BLOCK_CLOSE
      }
    })
    .join('');
}

class Parser {
  constructor(private resolver: MacroResolver) {}

  parse(template: string): Resoluble {
    const tokens = this.resolver.lex(template);
    return this.buildTree(tokens);
  }

  private buildTree(tokens: Token[]): Resoluble {
    const children: Resoluble[] = [];
    let i = 0;
    while (i < tokens.length) {
      const tok = tokens[i];
      if (!tok) break;
      switch (tok.type) {
        case 'TEXT':
          children.push(new TextResoluble(tok.value));
          i++;
          break;
        case 'EXPR':
          children.push(this.parseMacro(tok.content));
          i++;
          break;
        case 'BLOCK_OPEN': {
          const { endIndex, branches, terminated } = this.collectBlock(tokens, i);
          if (!terminated) {
            // Unterminated block — the opener is prose, not a directive.
            // Emit it literally and reprocess the remaining tokens normally.
            children.push(new TextResoluble(tok.raw));
            i++;
            break;
          }
          const handler = this.resolver.getBlockHandler(tok.name);
          if (!handler) {
            // Unknown block — pass the whole construct through as literal text.
            children.push(new TextResoluble(tokensToSource(tokens.slice(i, endIndex))));
            i = endIndex;
            break;
          }
          const branchResolubles = branches.map((b) => this.buildTree(b));
          const conditionResoluble = tok.condition ? this.parse(tok.condition) : new TextResoluble('');
          children.push(
            new BlockResoluble(conditionResoluble, branchResolubles, handler, this.resolver.ctx, this.resolver),
          );
          i = endIndex;
          break;
        }
        default:
          // Stray BLOCK_MIDDLE / BLOCK_CLOSE tokens are prose, not directives.
          children.push(new TextResoluble(tok.raw));
          i++;
          break;
      }
    }
    const onlyChild = children.length === 1 ? children[0] : undefined;
    return onlyChild ?? new ConcatResoluble(children);
  }

  private parseMacro(content: string): Resoluble {
    const { name, args } = this.parseMacroCall(content);

    // Legacy variable shorthand: {{.varname}} → macro "." with arg "varname"
    if (name.startsWith('.')) {
      const key = name.slice(1);
      return new MacroResoluble('.', [new TextResoluble(key)], this.resolver);
    }
    if (name.startsWith('$')) {
      const key = name.slice(1);
      return new MacroResoluble('$', [new TextResoluble(key)], this.resolver);
    }

    const argResolubles = args.map((arg) => this.parse(arg));
    return new MacroResoluble(name, argResolubles, this.resolver);
  }

  private parseMacroCall(content: string): { name: string; args: string[] } {
    let nameEnd = -1;
    let sepLength = 0;
    let depth = 0;
    for (let i = 0; i < content.length; i++) {
      if (content.slice(i, i + 2) === '{{') {
        depth++;
        i++;
      } else if (content.slice(i, i + 2) === '}}') {
        depth--;
        i++;
      } else if (depth === 0) {
        if (content.slice(i, i + 2) === '::') {
          nameEnd = i;
          sepLength = 2;
          break;
        }
        if (content[i] === ' ') {
          nameEnd = i;
          sepLength = 1;
          break;
        }
      }
    }

    const name = nameEnd === -1 ? content.trim() : content.slice(0, nameEnd).trim();
    const rest = nameEnd === -1 ? '' : content.slice(nameEnd + sepLength);

    const args: string[] = [];
    let current = '';
    let argDepth = 0;
    for (let i = 0; i < rest.length; i++) {
      if (rest.slice(i, i + 2) === '{{') {
        argDepth++;
        current += '{{';
        i++;
      } else if (rest.slice(i, i + 2) === '}}') {
        argDepth--;
        current += '}}';
        i++;
      } else if (argDepth === 0 && rest.slice(i, i + 2) === '::') {
        args.push(current);
        current = '';
        i++;
      } else {
        current += rest[i];
      }
    }
    const hadDelimiter = nameEnd !== -1;
    if (current || args.length > 0 || (hadDelimiter && content.endsWith('::'))) {
      args.push(current);
    }

    return { name, args };
  }

  private collectBlock(tokens: Token[], startIdx: number): { endIndex: number; branches: Token[][]; terminated: boolean } {
    const open = tokens[startIdx];
    if (!open || open.type !== 'BLOCK_OPEN') {
      throw new Error('collectBlock must start at a BLOCK_OPEN token');
    }
    let i = startIdx + 1;
    let depth = 1;
    let current: Token[] = [];
    const branches: Token[][] = [current];

    while (i < tokens.length && depth > 0) {
      const tok = tokens[i];
      if (!tok) break;
      if (tok.type === 'BLOCK_OPEN') {
        depth++;
        current.push(tok);
      } else if (tok.type === 'BLOCK_CLOSE') {
        if (tok.name === open.name && depth === 1) {
          depth--;
        } else {
          depth--;
          if (depth > 0) current.push(tok);
        }
      } else if (tok.type === 'BLOCK_MIDDLE' && depth === 1) {
        current = [];
        branches.push(current);
      } else {
        current.push(tok);
      }
      i++;
    }

    return { endIndex: i, branches, terminated: depth === 0 };
  }
}

// ---------------------------------------------------------------------------
// MacroResolver
// ---------------------------------------------------------------------------

export class MacroResolver {
  private macros = new Map<string, MacroHandler>();
  private blocks = new Map<string, BlockHandler>();
  /** Names of macros flagged `deterministic: false` at registration. */
  private nondeterministicMacros = new Set<string>();
  private lexer = new Lexer();
  private rng: () => number;

  /** Context used during parsing (set temporarily by resolve/resolveAll). */
  ctx: MacroContext = { userName: '', charName: '' };

  constructor(rng?: () => number) {
    this.rng = rng ?? Math.random;
  }

  static createStorageResolver(rng?: () => number): MacroResolver {
    const r = new MacroResolver(rng);
    r.registerStorageDefaults();
    r.registerBlockDefaults();
    return r;
  }

  static createDisplayResolver(rng?: () => number): MacroResolver {
    const r = new MacroResolver(rng);
    r.registerDisplayDefaults();
    r.registerBlockDefaults();
    return r;
  }

  static createPromptResolver(rng?: () => number): MacroResolver {
    return MacroResolver.createStorageResolver(rng);
  }

  /** Internal: lex a template into tokens. */
  lex(template: string): Token[] {
    return this.lexer.lex(template);
  }

  getMacroHandler(name: string): MacroHandler | undefined {
    return this.macros.get(name);
  }

  getBlockHandler(name: string): BlockHandler | undefined {
    return this.blocks.get(name);
  }

  /**
   * Resolve multiple templates in a shared context.
   * Multi-pass: macros that depend on state built up during resolution
   * (e.g. setvar → getvar) will resolve across passes.
   */
  resolveAll(templates: string[], ctx: MacroContext): string[] {
    const prevCtx = this.ctx;
    this.ctx = ctx;
    try {
      const parser = new Parser(this);
      const roots = templates.map((t) => parser.parse(t));

      for (let pass = 0; pass < MAX_PASSES; pass++) {
        let allResolved = true;
        for (const root of roots) {
          if (!root.has_resolved()) {
            allResolved = false;
          }
        }
        if (allResolved) break;
        // Drive resolution forward on every root
        for (const root of roots) {
          root.resolve();
        }
      }

      const results = roots.map((r) => r.resolve());
      return results;
    } finally {
      this.ctx = prevCtx;
    }
  }

  /** Resolve a single template. */
  resolve(template: string, ctx: MacroContext): string {
    return this.resolveAll([template], ctx)[0] ?? '';
  }

  /**
   * Check whether a template contains non-deterministic macros that would
   * make prompt caching wasteful. Derived from the `deterministic: false`
   * flags set at registration time.
   */
  hasNondeterministicMacros(template: string): boolean {
    const tokens = this.lexer.lex(template);
    for (const tok of tokens) {
      if (tok.type !== 'EXPR') continue;
      const colonIdx = tok.content.indexOf('::');
      const name = colonIdx === -1 ? tok.content.trim() : tok.content.slice(0, colonIdx).trim();
      if (this.nondeterministicMacros.has(name)) {
        return true;
      }
    }
    return false;
  }

  register(name: string, handler: MacroHandler, opts?: { deterministic?: boolean }): void {
    this.macros.set(name, handler);
    if (opts?.deterministic === false) {
      this.nondeterministicMacros.add(name);
    } else {
      this.nondeterministicMacros.delete(name);
    }
  }

  registerBlock(name: string, handler: BlockHandler): void {
    this.blocks.set(name, handler);
  }

  registerStorageDefaults(): void {
    // ---- Identity macros ----
    this.macros.set('user', (ctx) => ctx.userName);
    this.macros.set('char', (ctx) => ctx.charName);
    this.macros.set('character', (ctx) => ctx.charName);
    this.macros.set('charIfNotGroup', (ctx) => ctx.charName);
    this.macros.set('group', (ctx) => ctx.charName);
    this.macros.set('groupNotMuted', (ctx) => ctx.charName);

    // ---- Character field macros ----
    this.macros.set('description', (ctx) => ctx.description ?? '');
    this.macros.set('charDescription', (ctx) => ctx.description ?? '');
    this.macros.set('personality', (ctx) => ctx.personality ?? '');
    this.macros.set('charPersonality', (ctx) => ctx.personality ?? '');
    this.macros.set('scenario', (ctx) => ctx.scenario ?? '');
    this.macros.set('charScenario', (ctx) => ctx.scenario ?? '');
    this.macros.set('persona', (ctx) => ctx.persona ?? '');

    // ---- Model / token limit macros ----
    this.macros.set('model', (ctx) => ctx.model ?? 'unknown');
    this.macros.set('maxContext', (ctx) => String(ctx.maxContext ?? 4096));
    this.macros.set('maxResponse', (ctx) => String(ctx.maxResponse ?? 512));
    this.macros.set('maxPrompt', (ctx) => String(ctx.maxContext ?? 4096));

    // ---- Time / date macros (UTC) — non-deterministic: value changes per turn ----
    this.register('time', (ctx, args) => {
      const d = ctx.now ?? new Date();
      if (args.length > 0 && args[0]) {
        if (!args[0].has_resolved()) return undefined;
        const fmt = args[0].resolve();
        return fmt
          .replace('YYYY', String(d.getUTCFullYear()))
          .replace('MM', String(d.getUTCMonth() + 1).padStart(2, '0'))
          .replace('DD', String(d.getUTCDate()).padStart(2, '0'))
          .replace('HH', String(d.getUTCHours()).padStart(2, '0'))
          .replace('mm', String(d.getUTCMinutes()).padStart(2, '0'))
          .replace('ss', String(d.getUTCSeconds()).padStart(2, '0'));
      }
      const h = String(d.getUTCHours()).padStart(2, '0');
      const m = String(d.getUTCMinutes()).padStart(2, '0');
      return `${h}:${m}`;
    }, { deterministic: false });
    this.register('date', (ctx) => {
      const d = ctx.now ?? new Date();
      return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    }, { deterministic: false });
    this.register('weekday', (ctx) => {
      const d = ctx.now ?? new Date();
      return d.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
    }, { deterministic: false });
    this.register('isotime', (ctx) => {
      const d = ctx.now ?? new Date();
      return (d.toISOString().split('T')[1] ?? '').slice(0, 5);
    }, { deterministic: false });
    this.register('isodate', (ctx) => {
      const d = ctx.now ?? new Date();
      return d.toISOString().split('T')[0];
    }, { deterministic: false });
    this.register('datetimeformat', (ctx, args) => {
      const d = ctx.now ?? new Date();
      if (args.length === 0 || !args[0]) return d.toISOString();
      if (!args[0].has_resolved()) return undefined;
      const fmt = args[0].resolve();
      return fmt
        .replace('YYYY', String(d.getUTCFullYear()))
        .replace('MM', String(d.getUTCMonth() + 1).padStart(2, '0'))
        .replace('DD', String(d.getUTCDate()).padStart(2, '0'))
        .replace('HH', String(d.getUTCHours()).padStart(2, '0'))
        .replace('mm', String(d.getUTCMinutes()).padStart(2, '0'))
        .replace('ss', String(d.getUTCSeconds()).padStart(2, '0'));
    }, { deterministic: false });

    // ---- Chat inspection macros ----
    this.macros.set('lastMessage', (ctx) => {
      const msgs = ctx.messages ?? [];
      return msgs[msgs.length - 1]?.content ?? '';
    });
    this.macros.set('lastMessageId', (ctx) => {
      const msgs = ctx.messages ?? [];
      return String(msgs[msgs.length - 1]?.id ?? '');
    });
    this.macros.set('lastUserMessage', (ctx) => {
      const msgs = ctx.messages ?? [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i];
        if (msg?.role === 'user') return msg.content;
      }
      return '';
    });
    this.macros.set('lastCharMessage', (ctx) => {
      const msgs = ctx.messages ?? [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i];
        if (msg?.role === 'assistant') return msg.content;
      }
      return '';
    });
    this.macros.set('firstIncludedMessageId', (ctx) => {
      const msgs = ctx.messages ?? [];
      return String(msgs[0]?.id ?? '');
    });
    this.macros.set('currentSwipeId', (ctx) => {
      const msgs = ctx.messages ?? [];
      return String(msgs[msgs.length - 1]?.id ?? '');
    });

    // ---- State macros ----
    this.macros.set('lastGenerationType', (ctx) => ctx.lastGenerationType ?? '');
    this.macros.set('hasExtension', (ctx, args) => {
      if (!ctx.extensions) return '';
      if (args.length === 0 || !args[0]) return '';
      if (!args[0].has_resolved()) return undefined;
      return ctx.extensions.includes(args[0].resolve()) ? 'true' : '';
    });

    // ---- Randomization macros — non-deterministic: rng-driven ----
    this.register('random', (_ctx, args) => {
      if (args.length === 0) return String(this.rng());
      if (args.length === 1 && args[0]) {
        if (!args[0].has_resolved()) return undefined;
        const max = parseInt(args[0].resolve(), 10);
        if (!isNaN(max)) return String(Math.floor(this.rng() * max) + 1);
        return String(this.rng());
      }
      if (args.length >= 2 && args[0] && args[1]) {
        if (!args[0].has_resolved() || !args[1].has_resolved()) return undefined;
        const min = parseInt(args[0].resolve(), 10);
        const max = parseInt(args[1].resolve(), 10);
        if (!isNaN(min) && !isNaN(max)) {
          return String(Math.floor(this.rng() * (max - min + 1)) + min);
        }
      }
      return String(this.rng());
    }, { deterministic: false });
    this.register('pick', (_ctx, args) => {
      if (args.length === 0) return '';
      const resolved = args.map((a) => (a.has_resolved() ? a.resolve() : undefined));
      if (resolved.some((v) => v === undefined)) return undefined;
      return resolved[Math.floor(this.rng() * resolved.length)] ?? '';
    }, { deterministic: false });
    this.register('roll', (_ctx, args) => {
      if (args.length === 0 || !args[0]) return String(Math.floor(this.rng() * 20) + 1);
      if (!args[0].has_resolved()) return undefined;
      const match = args[0].resolve().match(/(\d+)d(\d+)/i);
      const countStr = match?.[1];
      const sidesStr = match?.[2];
      if (!countStr || !sidesStr) return '';
      const count = parseInt(countStr, 10);
      const sides = parseInt(sidesStr, 10);
      let total = 0;
      for (let i = 0; i < count; i++) total += Math.floor(this.rng() * sides) + 1;
      return String(total);
    }, { deterministic: false });

    // ---- Variable macros ----
    this.macros.set('getvar', (ctx, args) => {
      if (!args[0]?.has_resolved()) return undefined;
      const key = args[0].resolve();
      if (ctx.macroVars && key in ctx.macroVars) return ctx.macroVars[key];
      if (ctx.globalVars && key in ctx.globalVars) return ctx.globalVars[key];
      return undefined; // Not set yet — wait for next pass
    });
    this.macros.set('setvar', (ctx, args) => {
      if (!args[0]?.has_resolved()) return undefined;
      const key = args[0].resolve();
      if (!args[1]?.has_resolved()) return undefined;
      const value = args[1].resolve();
      if (!ctx.macroVars) ctx.macroVars = {};
      ctx.macroVars[key] = value;
      return '';
    });

    // ---- Comparison macros ----
    this.macros.set('equal', (_ctx, args) => {
      if (args.length < 2) return '';
      const argA = args[0];
      const argB = args[1];
      if (!argA?.has_resolved() || !argB?.has_resolved()) return undefined;
      const a = argA.resolve();
      const b = argB.resolve();
      return a === b ? 'true' : '';
    });

    // ---- Truthy evaluator (RisuAI {{? expr}}) ----
    this.macros.set('?', (_ctx, args) => {
      if (args.length === 0) return '';
      if (!args.every((a) => a.has_resolved())) return undefined;
      const expr = args.map((a) => a.resolve()).join('::');
      return evaluateBooleanExpression(expr) ? 'true' : '';
    });

    // ---- Utility macros ----
    this.macros.set('noop', () => '');
    this.macros.set('newline', () => '\n');
    this.macros.set('trim', (_ctx, args) => {
      if (args.length === 0 || !args[0]) return '';
      if (!args[0].has_resolved()) return undefined;
      return args[0].resolve().trim();
    });

    // ---- Character card V3 CBS macros ----
    this.macros.set('reverse', (_ctx, args) => {
      if (args.length === 0 || !args[0]) return '';
      if (!args[0].has_resolved()) return undefined;
      return Array.from(args[0].resolve()).reverse().join('');
    });
    this.macros.set('comment', () => '');
    this.macros.set('hidden_key', () => '');
    this.macros.set('//', () => '');

    // Legacy shorthand: {{.varname}} and {{$varname}}
    this.macros.set('.', (ctx, args) => {
      if (!args[0]?.has_resolved()) return undefined;
      const key = args[0].resolve();
      if (ctx.macroVars && key in ctx.macroVars) return ctx.macroVars[key];
      return '';
    });
    this.macros.set('$', (ctx, args) => {
      if (!args[0]?.has_resolved()) return undefined;
      const key = args[0].resolve();
      if (ctx.globalVars && key in ctx.globalVars) return ctx.globalVars[key];
      return '';
    });
  }

  registerDisplayDefaults(): void {
    // ---- Image macro (display-only: resolves character assets to markdown) ----
    this.macros.set('img', (ctx, args) => {
      if (!args[0]?.has_resolved()) return undefined;
      const name = args[0].resolve();
      if (!name) return '';
      let url = ctx.characterAssets?.[name];
      if (!url) {
        const sanitized = name.replace(/[^a-zA-Z0-9._-]/g, '_');
        url = ctx.characterAssets?.[sanitized];
      }
      return url ? `![${name}](${url})` : `![${name}]`;
    });

    // ---- Attachment macro (display-only: resolves to inline media HTML) ----
    this.macros.set('attachment', (ctx, args) => {
      if (!args[0]?.has_resolved()) return undefined;
      const id = args[0].resolve();
      const att = ctx.attachments?.[id];
      if (!att) return `{{attachment::${id}}}`;
      if (att.mimeType.startsWith('audio/')) {
        return `<audio class="message-inline-audio" controls src="${att.url}" preload="metadata" />`;
      }
      if (att.mimeType.startsWith('video/')) {
        return `<video class="message-inline-video" controls src="${att.url}" preload="metadata" />`;
      }
      return `<img class="message-inline-img" src="${att.url}" alt="" loading="lazy" />`;
    });
  }

  registerBlockDefaults(): void {
    this.blocks.set('if', {
      tryResolve: (condition, branches, _ctx, _resolver) => {
        if (!condition.has_resolved()) return undefined;
        const resolved = condition.resolve();
        const isTrue = evaluateBooleanExpression(resolved);
        const chosen = isTrue ? branches[0] ?? new TextResoluble('') : branches[1] ?? new TextResoluble('');
        if (!chosen.has_resolved()) return undefined;
        return chosen.resolve();
      },
    });

    this.blocks.set('unless', {
      tryResolve: (condition, branches, _ctx, _resolver) => {
        if (!condition.has_resolved()) return undefined;
        const resolved = condition.resolve();
        const isTrue = resolved.length > 0 && resolved !== 'false' && resolved !== '0';
        const chosen = isTrue ? branches[1] ?? new TextResoluble('') : branches[0] ?? new TextResoluble('');
        if (!chosen.has_resolved()) return undefined;
        return chosen.resolve();
      },
    });

    this.blocks.set('for', {
      tryResolve: (condition, branches, _ctx, resolver) => {
        if (!condition.has_resolved()) return undefined;
        const parts = condition.resolve().split('::');
        if (parts.length < 2) return '';
        const varName = (parts[0] ?? '').trim();
        const items = parts.slice(1);
        const body = branches[0];
        if (!body) return '';

        const oldHandler = resolver.macros.get(varName);
        const oldIndexHandler = resolver.macros.get('forIndex');
        let output = '';

        for (let i = 0; i < items.length; i++) {
          resolver.register(varName, () => items[i] ?? '');
          resolver.register('forIndex', () => String(i));
          invalidateTree(body);
          output += body.resolve();
        }

        if (oldHandler) {
          resolver.register(varName, oldHandler);
        } else {
          resolver.macros.delete(varName);
        }
        if (oldIndexHandler) {
          resolver.register('forIndex', oldIndexHandler);
        } else {
          resolver.macros.delete('forIndex');
        }

        return output;
      },
    });
  }
}

/** Recursively clear cached results on every MacroResoluble and BlockResoluble in a tree. */
function invalidateTree(root: Resoluble): void {
  if (root instanceof MacroResoluble) {
    root.invalidate();
  } else if (root instanceof BlockResoluble) {
    root.invalidate();
    invalidateTree(root['condition']);
    for (const branch of root['branches']) {
      invalidateTree(branch);
    }
  } else if (root instanceof ConcatResoluble) {
    for (const child of root['children']) {
      invalidateTree(child);
    }
  }
}
