/**
 * Request transformers domain — TransformerChainsModal.tsx,
 * TransformerScriptsModal.tsx, and the transformer-chain selector in
 * BackendConfigModal.tsx. Chains are named, ordered lists of steps (built-in
 * transforms or Lua scripts) that rewrite the rendered message array before
 * the backend sees it. Reuses common.name / common.close / common.delete.
 */
export const transformers = {
  // Sidebar entry points
  chainsTitle: 'Transformer Chains',
  scriptsTitle: 'Transformer Scripts',

  // BackendConfigModal — chain selector (top-level transformerChainId)
  chainLabel: 'Transformer Chain',
  chainNone: 'None',
  chainHint: 'Transforms applied to the rendered prompt before it is sent. Edit chains in the Transformer Chains menu.',

  // TransformerChainsModal
  chainsDescription:
    'Named, ordered lists of transforms applied to the rendered prompt before it is sent. Attach a chain to a backend config to activate it.',
  chainsEmpty: 'No transformer chains yet.',
  addChain: 'Add Chain',
  editChain: 'Edit',
  deleteChain: 'Delete',
  deleteChainConfirm: 'Delete transformer chain "{{name}}"?',
  chainName: 'Name',
  chainDescriptionLabel: 'Description',
  steps: 'Steps',
  stepsEmpty: 'No steps yet — add a built-in transform or a Lua script below.',
  stepEnabled: 'Enabled',
  moveUp: 'Move up',
  moveDown: 'Move down',
  removeStep: 'Remove step',
  addBuiltin: 'Add Built-in Transform',
  addBuiltinButton: 'Add transform',
  addLua: 'Add Lua Script',
  addLuaButton: 'Add script',
  noScriptsAvailable: 'No transformer scripts yet. Create one in the Transformer Scripts menu.',
  newChainName: 'New Chain',
  doneEditing: 'Done',

  // Builtin step labels + params
  builtin: {
    'squash-system': 'Squash system messages',
    whitespace: 'Whitespace normalization',
    'strip-reasoning': 'Strip reasoning blocks',
    'history-squash': 'History squash',
    'ensure-thinking': 'Ensure thinking block',
  },
  params: {
    mode: 'Mode',
    modeNone: 'None',
    modeTrim: 'Trim leading/trailing whitespace',
    modeFull: 'Trim and collapse internal runs',
    role: 'Target role',
    roleUser: 'User',
    roleAssistant: 'Assistant',
    userPrefix: 'User prefix (empty = "<user>: ")',
    userSuffix: 'User suffix',
    charPrefix: 'Character prefix (empty = "<char>: ")',
    charSuffix: 'Character suffix',
    placeholder: 'Placeholder text',
  },

  // TransformerScriptsModal
  scriptsDescription:
    'Lua scripts that rewrite the rendered message array. Use them as steps in a transformer chain. A script defines handle(messages, ctx) and returns the message array to send.',
  scriptsEmpty: 'No transformer scripts yet.',
  addScript: 'Add Script',
  editScript: 'Edit',
  deleteScript: 'Delete',
  deleteScriptConfirm: 'Delete transformer script "{{name}}"?',
  newScriptName: 'New Script',
  scriptName: 'Name',
  scriptDescriptionLabel: 'Description',
  luaSource: 'Lua Source',
  luaSourceHint:
    'Define handle(messages, ctx) and return the (possibly new) message array. Changes save automatically.',
  validate: 'Validate',
  validating: 'Validating…',
  validateOk: 'Script loads cleanly.',
};
