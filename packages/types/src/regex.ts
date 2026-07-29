/**
 * Regex rule for find/replace transformations.
 *
 * Placement flags (`prompt`, `display`) determine WHERE the rule is applied:
 * - `prompt`: applied to messages when building the LLM prompt (ephemeral)
 * - `display`: applied when rendering messages in the UI (ephemeral)
 *
 * Role flags (`userInput`, `aiOutput`) are additional filters that restrict
 * WHICH messages the rule affects. If neither is set, the rule applies to all
 * roles. If `userInput` is set, the rule only affects user messages. If
 * `aiOutput` is set, the rule only affects assistant messages.
 */
export interface RegexRule {
  id: string;
  name: string;
  findRegex: string;
  replaceString: string;
  /**
   * Optional Lua replacement (Layer 2, docs/design/scriptable-layers.md).
   * Source must define `replace(match, captures)` returning the replacement
   * string; `captures` is a 1-indexed array of capture groups (nil for
   * unmatched optional groups). A non-string/nil return keeps the original
   * match. When present and non-empty, this takes precedence over
   * `replaceString`. Runs server-side at prompt-build / finalize time — never
   * in the browser at render time.
   */
  replaceLua?: string;
  disabled: boolean;
  userInput: boolean;
  aiOutput: boolean;
  prompt: boolean;
  display: boolean;
}

export interface ReasoningTemplate {
  id: string;
  name: string;
  prefix: string;
  suffix: string;
  separator: string;
}
