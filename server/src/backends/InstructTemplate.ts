/**
 * Instruct templates for text-completion adapters.
 *
 * An instruct template defines how a text-completion adapter wraps system
 * prompts, user messages, and assistant messages when flattening
 * `Prompt.messages` into a single string for the wire (formatTextPrompt.ts).
 *
 * This replaces the old ST's separate instruct-mode system (BOS, BOU, BOA,
 * etc. fields) with a single declarative template.
 */

import { str } from '../lib/coerce.js';

export interface InstructTemplate {
  name: string;
  /** Prefix for the entire prompt (e.g. `<s>`) */
  bos?: string;
  /** Suffix for the entire prompt */
  eos?: string;
  /** Separator between prompt chunks (default: `\n\n`) */
  separator?: string;
  /** Wrap system/content prompts: `{{content}}` is replaced */
  systemPrefix?: string;
  systemSuffix?: string;
  /** Wrap user-turn messages */
  userPrefix?: string;
  userSuffix?: string;
  /** Wrap assistant-turn messages */
  assistantPrefix?: string;
  assistantSuffix?: string;
  /** Prefix for the reply we're asking the model to generate */
  responsePrefix?: string;
  /** Reasoning block extraction and reconstruction (text-completion mode only) */
  reasoning?: {
    /** Regex pattern with two capture groups: (1) thinking block, (2) content */
    pattern: string;
    /** Opening delimiter (for reconstruction) */
    prefix: string;
    /** Closing delimiter (for reconstruction and stripping) */
    suffix: string;
    /** Separator between reasoning block and content (for reconstruction) */
    separator: string;
  };
}

const BUILTIN_TEMPLATES: Map<string, InstructTemplate> = new Map([
  [
    'none',
    {
      name: 'None (plain)',
      separator: '\n\n',
    },
  ],
  [
    'alpaca',
    {
      name: 'Alpaca',
      separator: '\n\n',
      systemPrefix: '',
      systemSuffix: '',
      userPrefix: '### Instruction:\n',
      userSuffix: '',
      assistantPrefix: '### Response:\n',
      assistantSuffix: '',
      responsePrefix: '### Response:\n',
    },
  ],
  [
    'chatml',
    {
      name: 'ChatML',
      separator: '',
      systemPrefix: '<|im_start|>system\n',
      systemSuffix: '<|im_end|>\n',
      userPrefix: '<|im_start|>user\n',
      userSuffix: '<|im_end|>\n',
      assistantPrefix: '<|im_start|>assistant\n',
      assistantSuffix: '<|im_end|>\n',
      responsePrefix: '<|im_start|>assistant\n',
    },
  ],
  [
    'llama2',
    {
      name: 'Llama 2',
      bos: '<s>',
      separator: ' ',
      systemPrefix: '[INST] <<SYS>>\n',
      systemSuffix: '\n<</SYS>> [/INST]',
      userPrefix: '[INST] ',
      userSuffix: ' [/INST]',
      assistantPrefix: ' ',
      assistantSuffix: ' ',
      responsePrefix: ' ',
    },
  ],
  [
    'llama3',
    {
      name: 'Llama 3',
      bos: '<|begin_of_text|>',
      separator: '',
      systemPrefix: '<|start_header_id|>system<|end_header_id|>\n\n',
      systemSuffix: '<|eot_id|>',
      userPrefix: '<|start_header_id|>user<|end_header_id|>\n\n',
      userSuffix: '<|eot_id|>',
      assistantPrefix: '<|start_header_id|>assistant<|end_header_id|>\n\n',
      assistantSuffix: '<|eot_id|>',
      responsePrefix: '<|start_header_id|>assistant<|end_header_id|>\n\n',
    },
  ],
  // Mistral v0.1 (legacy key kept for backwards compatibility)
  [
    'mistral',
    {
      name: 'Mistral',
      bos: '<s>',
      separator: '',
      systemPrefix: ' [INST] ',
      systemSuffix: '\n\n',
      userPrefix: '',
      userSuffix: ' [/INST]',
      assistantPrefix: ' ',
      assistantSuffix: '',
      responsePrefix: ' ',
      eos: '</s>',
    },
  ],
  [
    'mistral-v0.1',
    {
      name: 'Mistral v0.1',
      bos: '<s>',
      separator: '',
      systemPrefix: ' [INST] ',
      systemSuffix: '\n\n',
      userPrefix: '',
      userSuffix: ' [/INST]',
      assistantPrefix: ' ',
      assistantSuffix: '',
      responsePrefix: ' ',
      eos: '</s>',
    },
  ],
  [
    'mistral-v0.3',
    {
      name: 'Mistral v0.3',
      bos: '<s>',
      separator: '',
      systemPrefix: '[INST] ',
      systemSuffix: '\n\n',
      userPrefix: '',
      userSuffix: '[/INST]',
      assistantPrefix: ' ',
      assistantSuffix: '',
      responsePrefix: ' ',
      eos: '</s>',
    },
  ],
  [
    'mistral-nemo',
    {
      name: 'Mistral Nemo',
      bos: '<s>',
      separator: '',
      systemPrefix: '[INST]',
      systemSuffix: '\n\n',
      userPrefix: '',
      userSuffix: '[/INST]',
      assistantPrefix: '',
      assistantSuffix: '',
      responsePrefix: '',
      eos: '</s>',
    },
  ],
  [
    'mistral-large-2411',
    {
      name: 'Mistral Large 2411',
      bos: '<s>',
      separator: '',
      systemPrefix: '[SYSTEM_PROMPT] ',
      systemSuffix: '[/SYSTEM_PROMPT]',
      userPrefix: '[INST] ',
      userSuffix: '[/INST]',
      assistantPrefix: ' ',
      assistantSuffix: '',
      responsePrefix: ' ',
      eos: '</s>',
    },
  ],
  // Mistral v3 family (Small 24B/3.1/3.2, Medium 3.5, Large 3, Ministral 3, Devstral 2)
  [
    'kimi-k2.6',
    {
      name: 'Kimi K2.6',
      separator: '',
      systemPrefix: '<|im_system|>system<|im_middle|>',
      systemSuffix: '<|im_end|>',
      userPrefix: '<|im_user|>user<|im_middle|>',
      userSuffix: '<|im_end|>',
      assistantPrefix: '<|im_assistant|>assistant<|im_middle|>',
      assistantSuffix: '<|im_end|>',
      responsePrefix: '<|im_assistant|>assistant<|im_middle|><think></think>',
    },
  ],
  [
    'kimi-k2.6-thinking',
    {
      name: 'Kimi K2.6 (Thinking)',
      separator: '',
      systemPrefix: '<|im_system|>system<|im_middle|>',
      systemSuffix: '<|im_end|>',
      userPrefix: '<|im_user|>user<|im_middle|>',
      userSuffix: '<|im_end|>',
      assistantPrefix: '<|im_assistant|>assistant<|im_middle|>',
      assistantSuffix: '<|im_end|>',
      responsePrefix: '<|im_assistant|>assistant<|im_middle|><think>',
      reasoning: {
        pattern: '(.*?<\\/think>\\s*)?(.*)',
        prefix: '<think>',
        suffix: '</think>',
        separator: '',
      },
    },
  ],
  // Moonshot Kimi K3 (XTML message format; see encoding_k3.py). Each message is
  // wrapped as <|open|>message role="..."<|sep|>...<|close|>message<|sep|><|end_of_msg|>.
  // Non-thinking: assistant turns nest a <response> channel only — the <think>
  // channel is dropped entirely per encoding_k3.py. No separator between
  // messages, so separator is ''.
  [
    'kimi-k3',
    {
      name: 'Kimi K3',
      separator: '',
      systemPrefix: '<|open|>message role="system"<|sep|>',
      systemSuffix: '<|close|>message<|sep|><|end_of_msg|>',
      userPrefix: '<|open|>message role="user"<|sep|>',
      userSuffix: '<|close|>message<|sep|><|end_of_msg|>',
      assistantPrefix: '<|open|>message role="assistant"<|sep|><|open|>response<|sep|>',
      assistantSuffix: '<|close|>response<|sep|><|close|>message<|sep|><|end_of_msg|>',
      responsePrefix: '<|open|>message role="assistant"<|sep|><|open|>response<|sep|>',
    },
  ],
  [
    'kimi-k3-thinking',
    {
      name: 'Kimi K3 (Thinking)',
      separator: '',
      systemPrefix: '<|open|>message role="system"<|sep|>',
      systemSuffix: '<|close|>message<|sep|><|end_of_msg|>',
      userPrefix: '<|open|>message role="user"<|sep|>',
      userSuffix: '<|close|>message<|sep|><|end_of_msg|>',
      // Every assistant turn carries the structural <think>/<response> channels,
      // even when empty (see encoding_k3.py), so the empty think + response open
      // is baked into the prefix — messages without stored reasoning stay well-formed.
      assistantPrefix: '<|open|>message role="assistant"<|sep|><|open|>think<|sep|><|close|>think<|sep|><|open|>response<|sep|>',
      assistantSuffix: '<|close|>response<|sep|><|close|>message<|sep|><|end_of_msg|>',
      // The response prefix opens the <think> channel; the model closes it and
      // opens <response> before the visible content, so the reasoning block's
      // suffix spans both tokens.
      responsePrefix: '<|open|>message role="assistant"<|sep|><|open|>think<|sep|>',
      reasoning: {
        pattern: '(.*?<\\|close\\|>think<\\|sep\\|><\\|open\\|>response<\\|sep\\|>)?(.*)',
        prefix: '<|open|>think<|sep|>',
        suffix: '<|close|>think<|sep|><|open|>response<|sep|>',
        separator: '',
      },
    },
  ],
  // Z.ai GLM 5.1
  [
    'glm-5.1',
    {
      name: 'GLM 5.1',
      bos: '[gMASK]<sop>',
      separator: '',
      systemPrefix: '<|system|>\n',
      systemSuffix: '',
      userPrefix: '<|user|>\n',
      userSuffix: '',
      assistantPrefix: '<|assistant|>\n',
      assistantSuffix: '',
      responsePrefix: '<|assistant|></think>',
    },
  ],
  [
    'glm-5.1-thinking',
    {
      name: 'GLM 5.1 (Thinking)',
      bos: '[gMASK]<sop>',
      separator: '',
      systemPrefix: '<|system|>\n',
      systemSuffix: '',
      userPrefix: '<|user|>\n',
      userSuffix: '',
      assistantPrefix: '<|assistant|>\n',
      assistantSuffix: '',
      responsePrefix: '<|assistant|><think>',
      reasoning: {
        pattern: '(.*?<\\/think>\\s*)?(.*)',
        prefix: '<think>',
        suffix: '</think>',
        separator: '',
      },
    },
  ],
  // DeepSeek V4 Pro
  [
    'deepseek-v4-pro',
    {
      name: 'DeepSeek V4 Pro',
      bos: '<｜begin▁of▁sentence｜>',
      separator: '',
      systemPrefix: '',
      systemSuffix: '',
      userPrefix: '<｜User｜>',
      userSuffix: '',
      assistantPrefix: '<｜Assistant｜>',
      assistantSuffix: '<｜end▁of▁sentence｜>',
      responsePrefix: '<｜Assistant｜></think>',
    },
  ],
  [
    'deepseek-v4-pro-thinking',
    {
      name: 'DeepSeek V4 Pro (Thinking)',
      bos: '<｜begin▁of▁sentence｜>',
      separator: '',
      systemPrefix: '',
      systemSuffix: '',
      userPrefix: '<｜User｜>',
      userSuffix: '',
      assistantPrefix: '<｜Assistant｜>',
      assistantSuffix: '<｜end▁of▁sentence｜>',
      responsePrefix: '<｜Assistant｜><think>',
      reasoning: {
        pattern: '(.*?<\\/think>\\s*)?(.*)',
        prefix: '<think>',
        suffix: '</think>',
        separator: '',
      },
    },
  ],
  // Meta Llama 4
  [
    'llama4',
    {
      name: 'Llama 4',
      bos: '<|begin_of_text|>',
      separator: '',
      systemPrefix: '<|header_start|>system<|header_end|>\n\n',
      systemSuffix: '<|eot|>',
      userPrefix: '<|header_start|>user<|header_end|>\n\n',
      userSuffix: '<|eot|>',
      assistantPrefix: '<|header_start|>assistant<|header_end|>\n\n',
      assistantSuffix: '<|eot|>',
      responsePrefix: '<|header_start|>assistant<|header_end|>\n\n',
    },
  ],
  // Google Gemma 4
  [
    'gemma4',
    {
      name: 'Gemma 4',
      bos: '<bos>',
      separator: '',
      systemPrefix: '<|turn|>system\n',
      systemSuffix: '<turn|>\n',
      userPrefix: '<|turn|>user\n',
      userSuffix: '<turn|>\n',
      assistantPrefix: '<|turn|>model\n',
      assistantSuffix: '<turn|>\n',
      responsePrefix: '<|turn|>model\n',
    },
  ],
  [
    'gemma4-thinking',
    {
      name: 'Gemma 4 (Thinking)',
      bos: '<bos>',
      separator: '',
      systemPrefix: '<|turn|>system\n',
      systemSuffix: '<turn|>\n',
      userPrefix: '<|turn|>user\n',
      userSuffix: '<turn|>\n',
      assistantPrefix: '<|turn|>model\n',
      assistantSuffix: '<turn|>\n',
      responsePrefix: '<|turn|>model\n<|channel|>thought\n',
      reasoning: {
        pattern: '(.*?)<channel\\|>\\s*(.*)',
        prefix: '<|channel|>thought\n',
        suffix: '\n<channel|>',
        separator: '',
      },
    },
  ],
  // Mistral v3 family (Large 3, Ministral 3, Devstral 2, Small 3.2, Small 4, Medium 4)
  [
    'mistral-v3',
    {
      name: 'Mistral v3',
      bos: '<s>',
      separator: '',
      systemPrefix: '[SYSTEM_PROMPT]',
      systemSuffix: '[/SYSTEM_PROMPT]',
      userPrefix: '[INST]',
      userSuffix: '[/INST]',
      assistantPrefix: '',
      assistantSuffix: '</s>',
      responsePrefix: '',
    },
  ],
  [
    'mistral-v3-thinking',
    {
      name: 'Mistral v3 (Thinking)',
      bos: '<s>',
      separator: '',
      systemPrefix: '[SYSTEM_PROMPT]',
      systemSuffix: '[/SYSTEM_PROMPT]',
      userPrefix: '[INST]',
      userSuffix: '[/INST]',
      assistantPrefix: '',
      assistantSuffix: '</s>',
      responsePrefix: '[THINK]',
      reasoning: {
        pattern: '(.*?\\[/THINK\\]\\s*)?(.*)',
        prefix: '[THINK]',
        suffix: '[/THINK]',
        separator: '',
      },
    },
  ],
  // NVIDIA Nemotron 3
  [
    'nemotron-3',
    {
      name: 'NVIDIA Nemotron 3',
      separator: '',
      systemPrefix: '<|im_start|>system\n',
      systemSuffix: '<|im_end|>\n',
      userPrefix: '<|im_start|>user\n',
      userSuffix: '<|im_end|>\n',
      assistantPrefix: '<|im_start|>assistant\n',
      assistantSuffix: '<|im_end|>\n',
      responsePrefix: '<|im_start|>assistant\n<think></think>',
    },
  ],
  [
    'nemotron-3-thinking',
    {
      name: 'NVIDIA Nemotron 3 (Thinking)',
      separator: '',
      systemPrefix: '<|im_start|>system\n',
      systemSuffix: '<|im_end|>\n',
      userPrefix: '<|im_start|>user\n',
      userSuffix: '<|im_end|>\n',
      assistantPrefix: '<|im_start|>assistant\n',
      assistantSuffix: '<|im_end|>\n',
      responsePrefix: '<|im_start|>assistant\n<think>\n',
      reasoning: {
        pattern: '(.*?<\\/think>\\s*)?(.*)',
        prefix: '<think>\n',
        suffix: '</think>',
        separator: '\n',
      },
    },
  ],
  // Qwen 3 (ChatML, optional thinking)
  [
    'qwen3',
    {
      name: 'Qwen 3',
      separator: '',
      systemPrefix: '<|im_start|>system\n',
      systemSuffix: '<|im_end|>\n',
      userPrefix: '<|im_start|>user\n',
      userSuffix: '<|im_end|>\n',
      assistantPrefix: '<|im_start|>assistant\n',
      assistantSuffix: '<|im_end|>\n',
      responsePrefix: '<|im_start|>assistant\n<think>\n\n</think>\n\n',
    },
  ],
  [
    'qwen3-thinking',
    {
      name: 'Qwen 3 (Thinking)',
      separator: '',
      systemPrefix: '<|im_start|>system\n',
      systemSuffix: '<|im_end|>\n',
      userPrefix: '<|im_start|>user\n',
      userSuffix: '<|im_end|>\n',
      assistantPrefix: '<|im_start|>assistant\n',
      assistantSuffix: '<|im_end|>\n',
      responsePrefix: '<|im_start|>assistant\n<think>\n',
      reasoning: {
        pattern: '(.*?<\\/think>\\s*)?(.*)',
        prefix: '<think>\n',
        suffix: '</think>',
        separator: '\n\n',
      },
    },
  ],
  // Qwen 3.5 / 3.6 (ChatML + vision tokens)
  [
    'qwen3.5',
    {
      name: 'Qwen 3.5 / 3.6',
      separator: '',
      systemPrefix: '<|im_start|>system\n',
      systemSuffix: '<|im_end|>\n',
      userPrefix: '<|im_start|>user\n',
      userSuffix: '<|im_end|>\n',
      assistantPrefix: '<|im_start|>assistant\n',
      assistantSuffix: '<|im_end|>\n',
      responsePrefix: '<|im_start|>assistant\n<think>\n\n</think>\n\n',
    },
  ],
  [
    'qwen3.5-thinking',
    {
      name: 'Qwen 3.5 / 3.6 (Thinking)',
      separator: '',
      systemPrefix: '<|im_start|>system\n',
      systemSuffix: '<|im_end|>\n',
      userPrefix: '<|im_start|>user\n',
      userSuffix: '<|im_end|>\n',
      assistantPrefix: '<|im_start|>assistant\n',
      assistantSuffix: '<|im_end|>\n',
      responsePrefix: '<|im_start|>assistant\n<think>\n',
      reasoning: {
        pattern: '(.*?<\\/think>\\s*)?(.*)',
        prefix: '<think>\n',
        suffix: '</think>',
        separator: '\n\n',
      },
    },
  ],
  // Microsoft Phi-4 Mini
  [
    'phi-4-mini',
    {
      name: 'Phi-4 Mini',
      bos: '<|endoftext|>',
      separator: '',
      systemPrefix: '<|system|>\n',
      systemSuffix: '<|end|>\n',
      userPrefix: '<|user|>\n',
      userSuffix: '<|end|>\n',
      assistantPrefix: '<|assistant|>\n',
      assistantSuffix: '<|end|>\n',
      responsePrefix: '<|assistant|>\n',
    },
  ],
  // Microsoft Phi-4 Reasoning Plus
  [
    'phi-4-reasoning-plus',
    {
      name: 'Phi-4 Reasoning Plus',
      bos: '<|endoftext|>',
      separator: '',
      systemPrefix: '<|im_start|>system<|im_sep|>',
      systemSuffix: '<|im_end|>',
      userPrefix: '<|im_start|>user<|im_sep|>',
      userSuffix: '<|im_end|>',
      assistantPrefix: '<|im_start|>assistant<|im_sep|>',
      assistantSuffix: '<|im_end|>',
      responsePrefix: '<|im_start|>assistant<|im_sep|><think>\n',
      reasoning: {
        pattern: '(.*?<\\/think>\\s*)?(.*)',
        prefix: '<think>\n',
        suffix: '</think>',
        separator: '\n',
      },
    },
  ],
  // IBM Granite 4.0 / 4.1
  [
    'granite-4.0',
    {
      name: 'IBM Granite 4.0 / 4.1',
      separator: '',
      systemPrefix: '<|start_of_role|>system<|end_of_role|>',
      systemSuffix: '<|end_of_text|>',
      userPrefix: '<|start_of_role|>user<|end_of_role|>',
      userSuffix: '<|end_of_text|>',
      assistantPrefix: '<|start_of_role|>assistant<|end_of_role|>',
      assistantSuffix: '<|end_of_text|>',
      responsePrefix: '<|start_of_role|>assistant<|end_of_role|>',
    },
  ],
  // MiniMax Text-01
  [
    'minimax-text-01',
    {
      name: 'MiniMax Text-01',
      separator: '',
      systemPrefix: '<beginning_of_sentence>system ai_setting=assistant\n',
      systemSuffix: '<end_of_sentence>\n',
      userPrefix: '<beginning_of_sentence>user name=user\n',
      userSuffix: '<end_of_sentence>\n',
      assistantPrefix: '<beginning_of_sentence>ai name=assistant\n',
      assistantSuffix: '<end_of_sentence>\n',
      responsePrefix: '<beginning_of_sentence>ai name=assistant\n',
    },
  ],

]);

function fallbackTemplate(): InstructTemplate {
  const t = BUILTIN_TEMPLATES.get('none');
  if (!t) throw new Error('Builtin instruct template "none" is missing');
  return t;
}

export function getInstructTemplate(
  name?: string,
  custom?: Map<string, InstructTemplate> | Record<string, InstructTemplate>,
): InstructTemplate {
  if (!name) return fallbackTemplate();
  if (custom) {
    const lookup = custom instanceof Map ? custom.get(name) : custom[name];
    if (lookup) return lookup;
  }
  return BUILTIN_TEMPLATES.get(name) ?? fallbackTemplate();
}

/**
 * Parse user-defined instruct templates from the global `instructTemplates`
 * setting (an array of template objects keyed by `id`). Moved here from
 * ChatPromptAssembly: template parsing is a backend-adapter concern.
 */
export function parseCustomInstructTemplates(raw: unknown): Record<string, InstructTemplate> | undefined {
  if (!raw || !Array.isArray(raw)) return undefined;
  const result: Record<string, InstructTemplate> = {};
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const id = str((item as Record<string, unknown>)['id']);
    if (!id) continue;
    const t = item as Record<string, unknown>;
    result[id] = {
      name: str(t['name'], id),
      bos: t['bos'] !== undefined ? str(t['bos']) : undefined,
      eos: t['eos'] !== undefined ? str(t['eos']) : undefined,
      separator: t['separator'] !== undefined ? str(t['separator']) : undefined,
      systemPrefix: t['systemPrefix'] !== undefined ? str(t['systemPrefix']) : undefined,
      systemSuffix: t['systemSuffix'] !== undefined ? str(t['systemSuffix']) : undefined,
      userPrefix: t['userPrefix'] !== undefined ? str(t['userPrefix']) : undefined,
      userSuffix: t['userSuffix'] !== undefined ? str(t['userSuffix']) : undefined,
      assistantPrefix: t['assistantPrefix'] !== undefined ? str(t['assistantPrefix']) : undefined,
      assistantSuffix: t['assistantSuffix'] !== undefined ? str(t['assistantSuffix']) : undefined,
      responsePrefix: t['responsePrefix'] !== undefined ? str(t['responsePrefix']) : undefined,
    };
  }
  return Object.keys(result).length > 0 ? result : undefined;
}


