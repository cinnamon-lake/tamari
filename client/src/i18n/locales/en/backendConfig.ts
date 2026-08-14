/**
 * BackendConfig domain — BackendConfigModal.tsx.
 *
 * Not translated (intentional): provider labels (OpenAI, OpenRouter, Claude,
 * Gemini, llama.cpp, TabbyAPI, KoboldCPP) and instruct-template display names
 * (Llama 3, Mistral, Qwen 3, …) are product/identifier proper nouns; default
 * API URLs are data; the request-script placeholder is an executable Lua code
 * example. The leading prose comment of that placeholder IS translated
 * (requestScriptHint). Reuses common.name / common.loading / common.close.
 */
export const backendConfig = {
  // Modal chrome
  title: 'Backend Config',
  ariaLabel: 'Backend Config',
  saving: 'Saving…',

  // Active config selector
  activeSection: 'Active Backend Config',
  configLabel: 'Config',
  duplicateConfig: 'Duplicate Config',
  deleteConfig: 'Delete Config',

  // Editor header
  editing: 'Edit: {{name}}',

  // Connection
  generationMode: 'Generation Mode',
  generationModeChat: 'Chat Completion',
  generationModeText: 'Text Completion',
  provider: 'Provider',
  apiUrl: 'API URL',
  apiKey: 'API Key',
  openrouterProvider: 'OpenRouter Provider',
  allProviders: 'All providers',

  // Model picker
  model: 'Model',
  modelsFailedPlaceholder: 'Model listing failed — enter manually',
  modelNamePlaceholder: 'Enter model name',
  refreshModels: 'Refresh model list',
  selectModel: 'Select a model...',
  modelContextBadge: '({{n}} ctx)',

  // Request transformer
  requestTransformer: 'Request Transformer (Lua)',
  requestScriptHint: 'Mutate the request table before it is sent',

  // Mock provider
  mockScript: 'Mock Response Script',
  mockScriptHint:
    'Deterministic canned responses, one directive per line: respond:<text> (default), seq:<n>:<text> (nth call), tool:<name>:<json> (tool call). For card-testing sessions — no network.',

  // Instruct template
  instructTemplate: 'Instruct Template',
  instructNone: 'None (plain)',

  // Sampling parameters
  samplerEnabled: 'Send this parameter',
  samplingSection: 'Sampling',
  contextSection: 'Context & Limits',
  optionsSection: 'Options',
  temperature: 'Temperature',
  maxTokens: 'Max Tokens',
  topP: 'Top P',
  topK: 'Top K',
  minP: 'Min P',
  topA: 'Top A',
  repetitionPenalty: 'Repetition Penalty',
  frequencyPenalty: 'Frequency Penalty',
  presencePenalty: 'Presence Penalty',
  contextLength: 'Context Length',
  promptHistoryLimit: 'Prompt History Limit',

  // Stop strings & logit bias
  stopStrings: 'Stop Strings (one per line)',
  stopStringsPlaceholder: 'Enter stopping strings, one per line',
  logitBias: 'Logit Bias (token:bias, one per line)',
  logitBiasPlaceholder: 'e.g. 12345:5 or word:-10',

  // Reasoning
  includeReasoning: 'Include reasoning blocks in prompt context',
  disabledByAppendOnly: '(forced on by append-only prompt layout)',
  openrouterReasoning: 'OpenRouter Reasoning',
  reasoningEffort: 'Reasoning Effort',
  reasoningSummary: 'Reasoning Summary',
  effortExtremeHigh: 'Extreme High',
  effortHigh: 'High',
  effortMedium: 'Medium',
  effortLow: 'Low',
  effortMinimal: 'Minimal',
  effortNone: 'None',
  summaryAuto: 'Auto',
  summaryConcise: 'Concise',
  summaryDetailed: 'Detailed',
  optionDefault: 'Default',

  // Media support
  mediaSupport: 'Media Support',
  mediaImages: 'Images',
  mediaAudio: 'Audio',
  mediaVideo: 'Video',

  // Advanced sampling (provider-gated; stored in providerParams)
  advSection: 'Advanced Sampling',
  adv: {
    omit: 'Omit field',
    on: 'On',
    off: 'Off',
    // Mirostat
    mirostatMode: 'Mirostat Mode',
    mirostatTau: 'Mirostat Tau',
    mirostatEta: 'Mirostat Eta',
    // Alternative samplers
    typicalP: 'Typical P',
    tfs: 'Tail Free Sampling',
    penaltyAlpha: 'Penalty Alpha',
    // DRY
    dryMultiplier: 'DRY Multiplier',
    dryBase: 'DRY Base',
    dryAllowedLength: 'DRY Allowed Length',
    dryPenaltyLastN: 'DRY Penalty Last N',
    drySequenceBreakers: 'DRY Sequence Breakers',
    // XTC
    xtcThreshold: 'XTC Threshold',
    xtcProbability: 'XTC Probability',
    // Smoothing
    smoothingFactor: 'Smoothing Factor',
    smoothingCurve: 'Smoothing Curve',
    // Dynamic temperature
    dynatemp: 'Dynamic Temperature',
    minTemp: 'Min Temp',
    maxTemp: 'Max Temp',
    dynatempExponent: 'Dynatemp Exponent',
    // Decoding
    seed: 'Seed',
    banEosToken: 'Ban EOS Token',
    skipSpecialTokens: 'Skip Special Tokens',
    addBosToken: 'Add BOS Token',
    bannedTokens: 'Banned Tokens',
    // Grammar
    grammarString: 'Grammar (GBNF)',
    // Group headings
    group: {
      mirostat: 'Mirostat',
      samplers: 'Alternative Samplers',
      dry: 'DRY',
      xtc: 'XTC',
      smoothing: 'Smoothing',
      dynatemp: 'Dynamic Temperature',
      decoding: 'Decoding',
      grammar: 'Structured Output',
    },
    // Placeholders
    placeholder: {
      grammar: 'root ::= ...',
      bannedTokens: 'One token or string per line',
      drySequenceBreakers: 'One breaker per line',
    },
  },

  // Generated name suffix & popup messages
  copySuffix: '{{name}} (Copy)',
  cannotDeleteLast: 'Cannot delete the last backend config',
  deleteConfirm: 'Delete backend config "{{name}}"?',
};
