/**
 * Transformer chains management modal — CRUD for named, ordered transformer
 * chains. A chain is a list of steps (built-in transforms with typed params,
 * or Lua transformer scripts) that rewrite the rendered message array before
 * the backend sees it; backend configs reference a chain via
 * `transformerChainId`.
 *
 * Chains live server-side: the list lives in serverStore.transformerChains and
 * stays fresh via `transformerchain.listed` rebroadcasts after every mutation
 * (CustomBackendsModal precedent — no active-entity snapshot for this entity).
 * The modal requests fresh chain + script lists on open.
 *
 * There is no Save button: edits auto-save debounced with a dirty flag
 * (BackendConfigModal / PromptListModal precedent). "Add Chain" creates the
 * entity immediately; the clientId-filtered `transformerchain.created` echo
 * opens the edit form on it. Pending edits flush on form close / modal close
 * / switching the edit target, and are cancelled when the target is deleted.
 */

import { createSignal, createEffect, Show, For, onMount, onCleanup } from 'solid-js';
import type { BuiltinTransformerId, TransformerChain, TransformerStep } from '@tamari/types';
import { useI18n } from '../i18n/index.js';
import { Modal } from './Modal.js';
import { confirmPopup } from '../stores/popupStore.js';
import { state } from '../stores/serverStore.js';
import { bus } from '../bus/WebSocketBus.js';
import { str } from '../lib/coerce.js';
import { AUTOSAVE_DEBOUNCE_MS } from '../timing.js';
import './TransformerChainsModal.css';

const BUILTIN_IDS: BuiltinTransformerId[] = [
  'squash-system',
  'whitespace',
  'strip-reasoning',
  'history-squash',
  'ensure-thinking',
];

/** Starting params for a freshly added builtin step (server schema defaults). */
function defaultBuiltinParams(id: BuiltinTransformerId): Record<string, unknown> | undefined {
  if (id === 'whitespace') return { mode: 'trim' };
  return undefined;
}

export function TransformerChainsModal(props: { onClose: () => void }) {
  const { t } = useI18n();
  // t() narrows literal keys to string but returns `unknown` for
  // dynamically-built key paths (@solid-primitives/i18n); coerce the
  // per-builtin lookups.
  const td = (key: string): string => t(key) as string;
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [formName, setFormName] = createSignal('');
  const [formDescription, setFormDescription] = createSignal('');
  const [steps, setSteps] = createSignal<TransformerStep[]>([]);
  const [dirty, setDirty] = createSignal(false);
  const [builtinToAdd, setBuiltinToAdd] = createSignal<BuiltinTransformerId>('whitespace');
  const [scriptToAdd, setScriptToAdd] = createSignal('');

  onMount(() => {
    bus.send({ type: 'transformerchain.list' });
    bus.send({ type: 'transformerscript.list' });
  });

  // Add Chain creates server-side immediately; our own created echo opens
  // the edit form. Self-filtered so another tab's creation doesn't hijack
  // the form (AGENTS.md §Active Entity).
  const unsubCreated = bus.on('transformerchain.created', (msg) => {
    if (msg.clientId !== state.clientId) return;
    openEdit(msg.item);
  });
  onCleanup(unsubCreated);

  const close = () => {
    flushPending();
    props.onClose();
  };

  /** Send the current form as an update. Skipped while invalid (blank name)
      so a half-typed edit never clobbers the stored entity. */
  const saveForm = () => {
    const id = editingId();
    const name = formName().trim();
    if (!id || !name) return;
    bus.send({
      type: 'transformerchain.save',
      id,
      data: { name, description: formDescription().trim(), steps: steps() },
    });
  };

  /** Flush a pending debounced save NOW — clearing dirty first would cancel
      the timer and silently drop the edits (BackendConfigModal precedent). */
  const flushPending = () => {
    if (!dirty()) return;
    saveForm();
    setDirty(false);
  };

  // Auto-save the open chain (debounced).
  createEffect(() => {
    if (!dirty()) return;
    formName();
    formDescription();
    steps();

    const timer = setTimeout(() => {
      saveForm();
      setDirty(false);
    }, AUTOSAVE_DEBOUNCE_MS);
    onCleanup(() => clearTimeout(timer));
  });

  const openEdit = (chain: TransformerChain) => {
    // Flush edits against the PREVIOUS target before switching — its save
    // goes out with that target's id.
    flushPending();
    setEditingId(chain.id);
    setFormName(chain.name);
    setFormDescription(chain.description);
    setSteps(chain.steps.map((step) => ({ ...step })));
    setDirty(false);
  };

  const addChain = () => {
    flushPending();
    // Upsert without id = create; the created echo opens the edit form.
    bus.send({
      type: 'transformerchain.save',
      data: { name: t('transformers.newChainName'), description: '', steps: [] },
    });
  };

  const closeForm = () => {
    flushPending();
    setEditingId(null);
  };

  const remove = async (chain: TransformerChain) => {
    if (!(await confirmPopup(t('transformers.deleteChainConfirm', { name: chain.name })))) return;
    // Cancel any pending debounced save when the edit form is open on this
    // chain — its target is about to disappear (BackendConfigModal
    // delete-after-save hazard).
    if (editingId() === chain.id) {
      setDirty(false);
      closeForm();
    }
    bus.send({ type: 'transformerchain.delete', id: chain.id });
  };

  const stepLabel = (step: TransformerStep): string => {
    if (step.kind === 'builtin') return td(`transformers.builtin.${step.id}`);
    const script = state.transformerScripts.find((s) => s.id === step.scriptId);
    return script?.name ?? step.scriptId;
  };

  const updateStepAt = (index: number, updater: (step: TransformerStep) => TransformerStep) => {
    setSteps((list) => list.map((step, i) => (i === index ? updater(step) : step)));
    setDirty(true);
  };

  const moveStep = (index: number, direction: -1 | 1) => {
    setSteps((list) => {
      const target = index + direction;
      if (target < 0 || target >= list.length) return list;
      const next = [...list];
      const a = next[index];
      const b = next[target];
      if (!a || !b) return list;
      next[index] = b;
      next[target] = a;
      return next;
    });
    setDirty(true);
  };

  const toggleStep = (index: number, enabled: boolean) => {
    updateStepAt(index, (step) => ({ ...step, enabled }));
  };

  const removeStep = (index: number) => {
    setSteps((list) => list.filter((_, i) => i !== index));
    setDirty(true);
  };

  /** Set one param key on a builtin step; an empty string clears the key so
      the server-side default applies (matters for the dynamic prefixes). */
  const setStepParam = (index: number, key: string, value: string) => {
    updateStepAt(index, (step) => {
      if (step.kind !== 'builtin') return step;
      const params = { ...step.params };
      if (value === '') {
        delete params[key];
      } else {
        params[key] = value;
      }
      return { ...step, params };
    });
  };

  const addBuiltin = () => {
    const id = builtinToAdd();
    const params = defaultBuiltinParams(id);
    setSteps((list) => [...list, { kind: 'builtin', id, enabled: true, ...(params ? { params } : {}) }]);
    setDirty(true);
  };

  const addLua = () => {
    const scriptId = scriptToAdd() || state.transformerScripts[0]?.id || '';
    if (!scriptId) return;
    setSteps((list) => [...list, { kind: 'lua', scriptId, enabled: true }]);
    setDirty(true);
  };

  const paramValue = (step: TransformerStep, key: string): string => {
    if (step.kind !== 'builtin') return '';
    return str(step.params?.[key]);
  };

  const markDirty = (setter: (value: string) => void) => (value: string) => {
    setter(value);
    setDirty(true);
  };

  return (
    <Modal
      title={t('transformers.chainsTitle')}
      onClose={close}
      class="modal settings-modal transformer-chains-modal"
      ariaLabel={t('transformers.chainsTitle')}
    >
      <section class="settings-section">
        <p class="hint-text">{t('transformers.chainsDescription')}</p>
      </section>

      <section class="settings-section">
        <Show
          when={state.transformerChains.length > 0}
          fallback={<p class="hint-text">{t('transformers.chainsEmpty')}</p>}
        >
          <For each={state.transformerChains}>
            {(chain) => (
              <div class="flex-between">
                <div class="flex-col-sm flex-1 min-w-0">
                  <span class="text-sm">
                    <strong>{chain.name}</strong>
                  </span>
                  <Show when={chain.description}>
                    <span class="text-xs text-muted">{chain.description}</span>
                  </Show>
                </div>
                <div class="flex-row-sm">
                  <button class="text-btn small" type="button" onClick={() => openEdit(chain)}>
                    {t('transformers.editChain')}
                  </button>
                  <button class="text-btn danger small" type="button" onClick={() => void remove(chain)}>
                    {t('transformers.deleteChain')}
                  </button>
                </div>
              </div>
            )}
          </For>
        </Show>
      </section>

      {/* Edit form — auto-saves; opened by Edit or by the Add Chain echo. */}
      <Show when={editingId() !== null}>
        <section class="settings-section">
          <h3 class="section-heading">{t('transformers.editChain')}</h3>
          <label class="field-label">
            {t('transformers.chainName')}
            <input
              class="input"
              value={formName()}
              onInput={(e) => markDirty(setFormName)(e.currentTarget.value)}
              placeholder="my-chain"
            />
          </label>
          <label class="field-label">
            {t('transformers.chainDescriptionLabel')}
            <input
              class="input"
              value={formDescription()}
              onInput={(e) => markDirty(setFormDescription)(e.currentTarget.value)}
            />
          </label>

          <h4 class="text-sm text-muted mb-0 mt-md">{t('transformers.steps')}</h4>
          <Show when={steps().length > 0} fallback={<p class="hint-text">{t('transformers.stepsEmpty')}</p>}>
            <For each={steps()}>
              {(step, index) => (
                <div class="transformer-chain-step">
                  <div class="transformer-chain-step-head">
                    <label class="checkbox-row">
                      <input
                        class="checkbox-input"
                        type="checkbox"
                        checked={step.enabled}
                        onChange={(e) => toggleStep(index(), e.currentTarget.checked)}
                        aria-label={t('transformers.stepEnabled')}
                      />
                      <span class="transformer-chain-step-name">{stepLabel(step)}</span>
                    </label>
                    <div class="transformer-chain-step-actions">
                      <button
                        class="icon-btn small"
                        type="button"
                        disabled={index() === 0}
                        onClick={() => moveStep(index(), -1)}
                        title={t('transformers.moveUp')}
                        aria-label={t('transformers.moveUp')}
                      >
                        <i class="bi bi-arrow-up" />
                      </button>
                      <button
                        class="icon-btn small"
                        type="button"
                        disabled={index() === steps().length - 1}
                        onClick={() => moveStep(index(), 1)}
                        title={t('transformers.moveDown')}
                        aria-label={t('transformers.moveDown')}
                      >
                        <i class="bi bi-arrow-down" />
                      </button>
                      <button
                        class="icon-btn small"
                        type="button"
                        onClick={() => removeStep(index())}
                        title={t('transformers.removeStep')}
                        aria-label={t('transformers.removeStep')}
                      >
                        <i class="bi bi-x-lg" />
                      </button>
                    </div>
                  </div>

                  {/* Builtin params (typed per builtin id); Lua steps have none. */}
                  <Show when={step.kind === 'builtin' && step.id === 'whitespace'}>
                    <label class="field-label">
                      {t('transformers.params.mode')}
                      <select
                        class="select"
                        value={paramValue(step, 'mode') || 'none'}
                        onChange={(e) => setStepParam(index(), 'mode', e.currentTarget.value)}
                      >
                        <option class="select-option" value="none">
                          {t('transformers.params.modeNone')}
                        </option>
                        <option class="select-option" value="trim">
                          {t('transformers.params.modeTrim')}
                        </option>
                        <option class="select-option" value="full">
                          {t('transformers.params.modeFull')}
                        </option>
                      </select>
                    </label>
                  </Show>
                  <Show when={step.kind === 'builtin' && step.id === 'history-squash'}>
                    <div class="transformer-chain-step-params">
                      <label class="field-label">
                        {t('transformers.params.role')}
                        <select
                          class="select"
                          value={paramValue(step, 'role') || 'user'}
                          onChange={(e) => setStepParam(index(), 'role', e.currentTarget.value)}
                        >
                          <option class="select-option" value="user">
                            {t('transformers.params.roleUser')}
                          </option>
                          <option class="select-option" value="assistant">
                            {t('transformers.params.roleAssistant')}
                          </option>
                        </select>
                      </label>
                      <label class="field-label">
                        {t('transformers.params.userPrefix')}
                        <input
                          class="input"
                          value={paramValue(step, 'userPrefix')}
                          onInput={(e) => setStepParam(index(), 'userPrefix', e.currentTarget.value)}
                        />
                      </label>
                      <label class="field-label">
                        {t('transformers.params.userSuffix')}
                        <input
                          class="input"
                          value={paramValue(step, 'userSuffix')}
                          onInput={(e) => setStepParam(index(), 'userSuffix', e.currentTarget.value)}
                        />
                      </label>
                      <label class="field-label">
                        {t('transformers.params.charPrefix')}
                        <input
                          class="input"
                          value={paramValue(step, 'charPrefix')}
                          onInput={(e) => setStepParam(index(), 'charPrefix', e.currentTarget.value)}
                        />
                      </label>
                      <label class="field-label">
                        {t('transformers.params.charSuffix')}
                        <input
                          class="input"
                          value={paramValue(step, 'charSuffix')}
                          onInput={(e) => setStepParam(index(), 'charSuffix', e.currentTarget.value)}
                        />
                      </label>
                    </div>
                  </Show>
                  <Show when={step.kind === 'builtin' && step.id === 'ensure-thinking'}>
                    <label class="field-label">
                      {t('transformers.params.placeholder')}
                      <input
                        class="input"
                        value={paramValue(step, 'placeholder')}
                        onInput={(e) => setStepParam(index(), 'placeholder', e.currentTarget.value)}
                      />
                    </label>
                  </Show>
                </div>
              )}
            </For>
          </Show>

          <div class="transformer-chain-add-row">
            <label class="field-label flex-1 min-w-0">
              {t('transformers.addBuiltin')}
              <select
                class="select"
                value={builtinToAdd()}
                onChange={(e) => setBuiltinToAdd(e.currentTarget.value as BuiltinTransformerId)}
              >
                <For each={BUILTIN_IDS}>
                  {(id) => (
                    <option class="select-option" id={id} value={id}>
                      {td(`transformers.builtin.${id}`)}
                    </option>
                  )}
                </For>
              </select>
            </label>
            <button class="text-btn small" type="button" onClick={addBuiltin}>
              <i class="bi bi-plus-lg" /> {t('transformers.addBuiltinButton')}
            </button>
          </div>

          <div class="transformer-chain-add-row">
            <label class="field-label flex-1 min-w-0">
              {t('transformers.addLua')}
              <select class="select" value={scriptToAdd()} onChange={(e) => setScriptToAdd(e.currentTarget.value)}>
                <For each={state.transformerScripts}>
                  {(s) => (
                    <option class="select-option" id={s.id} value={s.id}>
                      {s.name}
                    </option>
                  )}
                </For>
              </select>
            </label>
            <button
              class="text-btn small"
              type="button"
              disabled={state.transformerScripts.length === 0}
              onClick={addLua}
            >
              <i class="bi bi-plus-lg" /> {t('transformers.addLuaButton')}
            </button>
          </div>
          <Show when={state.transformerScripts.length === 0}>
            <span class="hint-text">{t('transformers.noScriptsAvailable')}</span>
          </Show>

          <div class="flex-row-sm mt-sm">
            <button class="text-btn" type="button" onClick={closeForm}>
              {t('transformers.doneEditing')}
            </button>
          </div>
        </section>
      </Show>

      <Show when={editingId() === null}>
        <button class="text-btn" type="button" onClick={addChain}>
          <i class="bi bi-plus-lg" /> {t('transformers.addChain')}
        </button>
      </Show>

      <div class="modal-actions">
        <button class="btn" onClick={close}>
          {t('common.close')}
        </button>
      </div>
    </Modal>
  );
}
