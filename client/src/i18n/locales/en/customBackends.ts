/**
 * Custom backends domain — CustomBackendsModal.tsx + the `custom` provider
 * section in BackendConfigModal.tsx. Lua-driven backend adapters.
 */
export const customBackends = {
  title: 'Custom Backends',
  description:
    'Named Lua scripts that drive generation. Select one from a backend config via the "Custom (Lua)" provider.',
  empty: 'No custom backends yet.',
  add: 'Add Custom Backend',
  edit: 'Edit',
  delete: 'Delete',
  name: 'Name',
  descriptionLabel: 'Description',
  luaSource: 'Lua Source',
  luaSourceHint: 'The script must define generate(prompt, ctx).',
  save: 'Save',
  cancel: 'Cancel',
  deleteConfirm: 'Delete custom backend "{{name}}"?',
  // BackendDryRunPanel — dry-run test section (shared with the character editor)
  testHeading: 'Test (dry run)',
  testInputLabel: 'Sample Input',
  testInputPlaceholder: 'A sample user message...',
  testStateLabel: 'State (JSON, optional)',
  testDelegateLabel: 'Delegate Response (optional)',
  testDelegatePlaceholder: '[dry-run delegate response]',
  testRun: 'Run',
  testRunning: 'Running…',
  testFailed: 'Dry run failed.',
  testOutput: 'Output',
  testReasoning: 'Reasoning',
  testUsage: 'Tokens: {{prompt}} prompt / {{completion}} completion',
  testStateOut: 'State Out',
  testFeedState: 'Use as state for next run',
  testDelegations: 'Delegations ({{count}})',
  testDelegateDefaultId: 'default delegate',
  // BackendConfigModal — `custom` provider section
  providerSection: 'Custom Backend',
  selectBackend: 'Select a custom backend',
  noneAvailable: 'No custom backends yet. Create one in the Custom Backends menu.',
  delegateBackend: 'Delegate Backend',
  delegateHint: 'Config the script delegates to by default (backends.generate without an id).',
  delegateDefault: 'Active backend at generation time',
};
