import { For, Show, createSignal, createEffect, onCleanup } from 'solid-js';
import { state } from '../stores/serverStore.js';
import { bus } from '../bus/WebSocketBus.js';
import { SchemaForm } from './SchemaForm.js';
import { IdBadge } from './IdBadge.js';
import { confirmPopup } from '../stores/popupStore.js';
import { useI18n } from '../i18n/index.js';
import { trapFocus, saveFocus, restoreFocus } from '../lib/focusUtils.js';
import type { Toolset, ToolTemplate } from '@tamari/types';
import './ToolsModal.css';

export function ToolsModal(props: { onClose: () => void }) {
  const { t } = useI18n();
  saveFocus();

  const close = () => {
    restoreFocus();
    props.onClose();
  };

  const [lastCreatedToolsetId, setLastCreatedToolsetId] = createSignal<string | null>(null);
  const [lastCreatedLuaId, setLastCreatedLuaId] = createSignal<string | null>(null);

  createEffect(() => {
    const unsub1 = bus.on('toolset.created', (msg) => {
      // Only react to our own creates — otherwise another tab's create auto-expands a card here (AGENTS.md §3).
      if (msg.clientId !== state.clientId) return;
      setLastCreatedToolsetId(msg.toolset.id);
      setTimeout(() => setLastCreatedToolsetId((current) => (current === msg.toolset.id ? null : current)), 3000);
    });
    const unsub2 = bus.on('toolTemplate.created', (msg) => {
      if (msg.clientId !== state.clientId) return;
      setLastCreatedLuaId(msg.toolTemplate.id);
      setTimeout(() => setLastCreatedLuaId((current) => (current === msg.toolTemplate.id ? null : current)), 3000);
    });
    return () => {
      unsub1();
      unsub2();
    };
  });

  return (
    <div class="modal-overlay" onClick={close}>
      <div class="modal tools-modal" role="dialog" aria-modal="true" aria-label={t('tools.title')} onKeyDown={(e) => trapFocus(e.currentTarget, e)} onClick={(e) => e.stopPropagation()}>
        <div class="modal-header-row">
          <h2 class="modal-title">
            <i class="bi bi-tools" /> {t('tools.title')}
          </h2>
          <button class="icon-btn" onClick={close} title={t('common.close')} aria-label={t('common.close')} type="button">
            <i class="bi bi-x-lg" />
          </button>
        </div>

        <p class="tools-description">
          {t('tools.intro')}
        </p>

        <div class="tools-panels">
          <div class="tools-list">
            <h3 class="panel-title"><i class="bi bi-collection" /> {t('tools.toolsets')}</h3>
            <For each={state.toolsets} fallback={<p class="tools-empty">{t('tools.noToolsets')}</p>}>
              {(toolset) => <ToolsetCard id={toolset.id} toolset={toolset} autoExpand={lastCreatedToolsetId() === toolset.id} />}
            </For>
            <NewToolsetButton />
          </div>

          <div class="lua-tools-panel">
            <h3 class="panel-title"><i class="bi bi-code-slash" /> {t('tools.luaTemplates')}</h3>
            <p class="tools-description">
              {t('tools.luaTemplatesIntro')} <code class="inline-code">serialize()</code> / <code class="inline-code">deserialize()</code>{t('tools.luaTemplatesIntroSuffix')}
            </p>
            <LuaTemplateList autoEditId={lastCreatedLuaId()} />
          </div>
        </div>

        <div class="modal-actions">
          <button class="btn btn-primary" onClick={close}>
            {t('tools.done')}
          </button>
        </div>
      </div>
    </div>
  );
}

function ToolsetCard(props: { id?: string; toolset: Toolset; autoExpand?: boolean }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = createSignal(props.autoExpand ?? false);

  createEffect(() => {
    if (props.autoExpand) setExpanded(true);
  });

  const toggle = () => {
    bus.send({
      type: 'toolset.update',
      toolsetId: props.toolset.id,
      patch: { enabled: !props.toolset.enabled },
    });
  };

  const templateName = () => {
    const tmpl = state.tools.find((tm) => tm.id === props.toolset.templateId);
    return tmpl?.name ?? props.toolset.templateId;
  };

  const remove = async () => {
    if (!(await confirmPopup(t('tools.deleteToolsetConfirm', { name: props.toolset.name })))) return;
    bus.send({ type: 'toolset.delete', toolsetId: props.toolset.id });
  };

  return (
    <div class="toolset-card">
      <div class="toolset-header">
        <div class="toolset-header-body">
          <span class="toolset-header-name">{props.toolset.name}</span>
          <span class="toolset-header-meta">{templateName()}</span>
        </div>
        <div class="toolset-header-actions">
          <IdBadge id={props.toolset.id} iconOnly />
          <button
            class="btn btn-sm btn-ghost"
            onClick={() => setExpanded(!expanded())}
            title={expanded() ? t('tools.hideConfig') : t('tools.showConfig')}
          >
            <i class={`bi ${expanded() ? 'bi-chevron-up' : 'bi-chevron-down'}`} />
          </button>
          <input
            type="checkbox"
            class="toolset-checkbox"
            checked={props.toolset.enabled}
            onChange={toggle}
            title={props.toolset.enabled ? t('tools.enabled') : t('tools.disabled')}
            aria-label={props.toolset.enabled ? t('tools.enabled') : t('tools.disabled')}
          />
          <button class="btn btn-sm btn-ghost btn-danger" onClick={remove} title={t('common.delete')} aria-label={t('common.delete')}>
            <i class="bi bi-trash" />
          </button>
        </div>
      </div>

      <Show when={expanded()}>
        <div class="toolset-body">
          <ToolsetConfigPanel toolset={props.toolset} />
        </div>
      </Show>
    </div>
  );
}

function ToolsetConfigPanel(props: { toolset: Toolset }) {
  const { t } = useI18n();
  const ts = props.toolset;

  const [name, setName] = createSignal(ts.name);
  const [templateId, setTemplateId] = createSignal(ts.templateId);
  const [config, setConfig] = createSignal(ts.config);
  const [toolOverrides, setToolOverrides] = createSignal(ts.toolOverrides);
  const [savedIndicator, setSavedIndicator] = createSignal(false);
  // Dirty = local edits the server hasn't acknowledged yet. While dirty,
  // store updates (another client's changes) must not clobber the form; the
  // debounced save clears it and the next store change reloads. Own save
  // echoes reload too, but to the values already in the form (a no-op).
  const [dirty, setDirty] = createSignal(false);

  // Reload the form from the store whenever the entity changes and we're not
  // mid-edit — this is how ANOTHER client's updates reach the open form. The
  // fingerprint deep-tracks the editable fields: Solid only subscribes to
  // what an effect reads, and nested config/override mutations keep the same
  // object reference, so shallow reads would never refire.
  let lastFingerprint = '';
  createEffect(() => {
    const current = props.toolset;
    const fingerprint = JSON.stringify([current.name, current.templateId, current.config, current.toolOverrides]);
    if (fingerprint === lastFingerprint) return;
    lastFingerprint = fingerprint;
    if (dirty()) return;
    setName(current.name);
    setTemplateId(current.templateId);
    setConfig(current.config);
    setToolOverrides(current.toolOverrides);
  });

  let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;

  const doSave = () => {
    // The row can outlive its entity: a delete echo unmounts us, and the
    // onCleanup flush would otherwise send an update for a deleted id.
    if (!state.toolsets.some((toolset) => toolset.id === ts.id)) return;
    bus.send({
      type: 'toolset.update',
      toolsetId: ts.id,
      patch: {
        name: name(),
        templateId: templateId(),
        config: config(),
        toolOverrides: toolOverrides(),
      },
    });
    setDirty(false);
    setSavedIndicator(true);
    setTimeout(() => setSavedIndicator(false), 1200);
  };

  const scheduleAutoSave = () => {
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => {
      // Null the handle when firing — a stale handle makes the onCleanup
      // flush re-send a full save on every later unmount.
      autoSaveTimer = null;
      doSave();
    }, 600);
  };

  // Flush a pending auto-save on unmount so closing the modal within the
  // debounce window doesn't silently lose the edit.
  onCleanup(() => {
    if (autoSaveTimer) {
      clearTimeout(autoSaveTimer);
      doSave();
    }
  });

  const info = () => state.tools.find((tool) => tool.id === templateId());
  const tools = () => info()?.tools ?? [];
  const configSchema = () => info()?.configSchema;
  const hasGlobalConfig = () => {
    const cs = configSchema();
    return cs && typeof cs === 'object' && Object.keys(cs).length > 0;
  };

  return (
    <>
      <div class="instance-field">
        <label class="field-label">{t('common.name')}</label>
        <input
          class="input"
          type="text"
          value={name()}
          onInput={(e) => {
            setName(e.currentTarget.value);
            setDirty(true);
            scheduleAutoSave();
          }}
        />
      </div>
      <div class="instance-field">
        <label class="field-label">{t('tools.template')}</label>
        <select
          class="select"
          value={templateId()}
          onChange={(e) => {
            setTemplateId(e.currentTarget.value);
            setDirty(true);
            scheduleAutoSave();
          }}
        >
          <For each={state.tools}>
            {(tool) => <option id={tool.id} class="select-option" value={tool.id}>{tool.name}</option>}
          </For>
        </select>
      </div>

      <Show when={hasGlobalConfig()}>
        <div class="instance-section">
          <label class="section-label">{t('tools.configuration')}</label>
          <SchemaForm
            schema={configSchema()!}
            value={config()}
            onChange={(v) => {
              setConfig(v);
              setDirty(true);
              scheduleAutoSave();
            }}
          />
        </div>
      </Show>

      <Show
        when={tools().length > 0}
        fallback={
          <p class="tools-empty">
            {t('tools.noToolDefinitions')} <code class="template-code">{templateId()}</code>.
          </p>
        }
      >
        <div class="instance-section">
          <label class="section-label">{t('tools.toolsAvailable')}</label>
          <For each={tools()}>
            {(tool) => (
              <ToolOverrideRow
                id={tool.name}
                toolName={tool.name}
                description={tool.description}
                parameters={tool.parameters}
                overrides={toolOverrides()[tool.name] ?? {}}
                onChange={(overrides) => {
                  setToolOverrides((prev) => ({
                    ...prev,
                    [tool.name]: overrides,
                  }));
                  setDirty(true);
                  scheduleAutoSave();
                }}
              />
            )}
          </For>
        </div>
      </Show>
      <Show when={savedIndicator()}>
        <span class="save-indicator">{t('tools.saved')}</span>
      </Show>
    </>
  );
}

function ToolOverrideRow(props: {
  id?: string;
  toolName: string;
  description: string;
  parameters?: Record<string, unknown>;
  overrides: { name?: string; description?: string; parameterDescriptions?: Record<string, string> };
  onChange: (overrides: {
    name?: string;
    description?: string;
    parameterDescriptions?: Record<string, string>;
  }) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = createSignal(props.overrides.name ?? '');
  const [description, setDescription] = createSignal(props.overrides.description ?? '');
  const [paramDescriptions, setParamDescriptions] = createSignal(props.overrides.parameterDescriptions ?? {});
  // Dirty + fingerprint: same live-update/dirty-protection scheme as
  // ToolsetConfigPanel — another client's update arrives here via the parent
  // panel's reload of toolOverrides.
  const [dirty, setDirty] = createSignal(false);

  let lastFingerprint = '';
  createEffect(() => {
    const fingerprint = JSON.stringify(props.overrides);
    if (fingerprint === lastFingerprint) return;
    lastFingerprint = fingerprint;
    if (dirty()) return;
    setName(props.overrides.name ?? '');
    setDescription(props.overrides.description ?? '');
    setParamDescriptions(props.overrides.parameterDescriptions ?? {});
  });

  let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;

  const doSave = () => {
    props.onChange({
      name: name() || undefined,
      description: description() || undefined,
      parameterDescriptions: paramDescriptions(),
    });
    setDirty(false);
  };

  const scheduleAutoSave = () => {
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => {
      // Null the handle when firing — a stale handle makes the onCleanup
      // flush re-send a full save on every later unmount.
      autoSaveTimer = null;
      doSave();
    }, 600);
  };

  // Flush a pending auto-save on unmount so closing the modal within the
  // debounce window doesn't silently lose the edit.
  onCleanup(() => {
    if (autoSaveTimer) {
      clearTimeout(autoSaveTimer);
      doSave();
    }
  });

  const paramEntries = () => {
    const propsMap = (props.parameters as Record<string, Record<string, unknown>> | undefined)?.properties;
    if (!propsMap) return [];
    return Object.entries(propsMap).map(([key, prop]) => ({
      key,
      desc: ((prop as Record<string, unknown>).description as string) ?? '',
    }));
  };

  return (
    <div class="instance-row">
      <div class="instance-row-editor">
        <div class="instance-field">
          <code class="tool-code">{props.toolName}</code>
          <label class="field-label" title={t('tools.toolNameHint')}>{t('common.name')}</label>
          <input
            class="input"
            type="text"
            value={name()}
            onInput={(e) => {
              setName(e.currentTarget.value);
              setDirty(true);
              scheduleAutoSave();
            }}
            placeholder={props.toolName}
          />
        </div>
        <div class="instance-field">
          <label class="field-label">{t('tools.descriptionLabel')}</label>
          <textarea
            class="textarea"
            value={description()}
            onInput={(e) => {
              setDescription(e.currentTarget.value);
              setDirty(true);
              scheduleAutoSave();
            }}
            placeholder={props.description}
            rows={2}
          />
        </div>
        <Show when={paramEntries().length > 0}>
          <div class="instance-section">
            <label class="section-label">{t('tools.parameterDescriptions')}</label>
            <For each={paramEntries()}>
              {(param) => (
                <div id={param.key} class="instance-param">
                  <span class="instance-param-key">{param.key}</span>
                  <input
                    class="instance-input"
                    type="text"
                    value={paramDescriptions()[param.key] ?? ''}
                    onInput={(e) => {
                      const val = e.currentTarget.value;
                      setParamDescriptions((prev) => {
                        const next = { ...prev };
                        if (val) {
                          next[param.key] = val;
                        } else {
                          delete next[param.key];
                        }
                        return next;
                      });
                      setDirty(true);
                      scheduleAutoSave();
                    }}
                    placeholder={param.desc}
                  />
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
}

function NewToolsetButton() {
  const { t } = useI18n();
  const create = () => {
    const first = state.tools[0];
    if (!first) return;
    bus.send({
      type: 'toolset.create',
      data: {
        templateId: first.id,
        name: t('tools.newToolset'),
        config: {},
        toolOverrides: {},
        enabled: true,
      },
    });
  };

  return (
    <button class="btn btn-sm" onClick={create} disabled={state.tools.length === 0}>
      <i class="bi bi-plus-lg" /> {t('tools.newToolset')}
    </button>
  );
}

// ---------- Lua Templates UI ----------

function LuaTemplateList(props: { autoEditId: string | null }) {
  const { t } = useI18n();
  return (
    <div class="lua-tool-list">
      <For each={state.toolTemplates}>
        {(tmpl) => <LuaTemplateRow id={tmpl.id} template={tmpl} autoEdit={props.autoEditId === tmpl.id} />}
      </For>

      <button
        class="btn btn-sm"
        onClick={() =>
          bus.send({
            type: 'toolTemplate.create',
            data: { name: t('tools.newLuaTemplate'), code: defaultLuaTemplateCode, configSchema: {} },
          })
        }
      >
        <i class="bi bi-plus-lg" /> {t('tools.newLuaTemplate')}
      </button>
    </div>
  );
}

function LuaTemplateRow(props: { id?: string; template: ToolTemplate; autoEdit?: boolean }) {
  const { t } = useI18n();
  const [editing, setEditing] = createSignal(props.autoEdit ?? false);

  createEffect(() => {
    if (props.autoEdit) setEditing(true);
  });

  const remove = async () => {
    if (!(await confirmPopup(t('tools.deleteLuaTemplateConfirm', { name: props.template.name })))) return;
    bus.send({ type: 'toolTemplate.delete', toolTemplateId: props.template.id });
  };

  return (
    <div class="instance-row">
      <Show
        when={editing()}
        fallback={
          <div class="lua-tool-display">
            <div class="lua-tool-main">
              <i class="bi bi-code-square" />
              <span class="lua-tool-name">{props.template.name}</span>
              <IdBadge id={props.template.id} />
            </div>
            <div class="instance-row-actions">
              <button class="btn btn-sm btn-ghost" onClick={() => setEditing(true)} title={t('tools.editLuaTemplate')} aria-label={t('tools.editLuaTemplate')}>
                <i class="bi bi-pencil" />
              </button>
              <button class="btn btn-sm btn-ghost btn-danger" onClick={remove} title={t('tools.deleteLuaTemplate')} aria-label={t('tools.deleteLuaTemplate')}>
                <i class="bi bi-trash" />
              </button>
            </div>
          </div>
        }
      >
        <LuaTemplateEditor template={props.template} onDone={() => setEditing(false)} />
      </Show>
    </div>
  );
}

function LuaTemplateEditor(props: { template: ToolTemplate; onDone: () => void }) {
  const { t } = useI18n();
  const [name, setName] = createSignal(props.template.name);
  const [code, setCode] = createSignal(props.template.code);
  const [sandbox, setSandbox] = createSignal<NonNullable<ToolTemplate['sandbox']>>({ ...(props.template.sandbox ?? {}) });
  const [savedIndicator, setSavedIndicator] = createSignal(false);
  // Dirty + fingerprint: same live-update/dirty-protection scheme as
  // ToolsetConfigPanel — while clean, another client's update to this
  // template reloads the editor.
  const [dirty, setDirty] = createSignal(false);

  let lastFingerprint = '';
  createEffect(() => {
    const current = props.template;
    const fingerprint = JSON.stringify([current.name, current.code, current.sandbox]);
    if (fingerprint === lastFingerprint) return;
    lastFingerprint = fingerprint;
    if (dirty()) return;
    setName(current.name);
    setCode(current.code);
    setSandbox({ ...(current.sandbox ?? {}) });
  });

  let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;

  const doSave = () => {
    // The row can outlive its entity: a delete echo unmounts us, and the
    // onCleanup flush would otherwise send an update for a deleted id.
    if (!state.toolTemplates.some((tmpl) => tmpl.id === props.template.id)) return;
    bus.send({
      type: 'toolTemplate.update',
      toolTemplateId: props.template.id,
      patch: { name: name(), code: code(), sandbox: sandbox() },
    });
    setDirty(false);
    setSavedIndicator(true);
    setTimeout(() => setSavedIndicator(false), 1200);
  };

  const scheduleAutoSave = () => {
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => {
      // Null the handle when firing — a stale handle makes the onCleanup
      // flush re-send a full save on every later unmount.
      autoSaveTimer = null;
      doSave();
    }, 600);
  };

  // Flush a pending auto-save on unmount so closing the editor within the
  // debounce window doesn't silently lose the edit.
  onCleanup(() => {
    if (autoSaveTimer) {
      clearTimeout(autoSaveTimer);
      doSave();
    }
  });

  return (
    <div class="instance-row-editor">
      <div class="lua-tool-editor-fields">
        <div class="instance-field">
          <label class="field-label">{t('common.name')}</label>
          <input
            class="input"
            type="text"
            value={name()}
            onInput={(e) => {
              setName(e.currentTarget.value);
              setDirty(true);
              scheduleAutoSave();
            }}
          />
        </div>
      </div>
      <div class="lua-tool-editor-code">
        <label class="field-label">{t('tools.luaCode')}</label>
        <textarea
          class="textarea"
          value={code()}
          onInput={(e) => {
            setCode(e.currentTarget.value);
            setDirty(true);
            scheduleAutoSave();
          }}
          spellcheck={false}
          rows={16}
        />
      </div>
      <div class="lua-tool-sandbox">
        <label class="field-label">{t('tools.sandboxFlags')}</label>
        <label class="checkbox-row">
          <input
            type="checkbox"
            checked={sandbox().allowIo ?? false}
            onChange={(e) => {
              setSandbox({ ...sandbox(), allowIo: e.currentTarget.checked });
              setDirty(true);
              scheduleAutoSave();
            }}
          />
          <span class="checkbox-label-text">{t('tools.sandboxAllowIo')}</span>
        </label>
        <label class="checkbox-row">
          <input
            type="checkbox"
            checked={sandbox().allowOs ?? false}
            onChange={(e) => {
              setSandbox({ ...sandbox(), allowOs: e.currentTarget.checked });
              setDirty(true);
              scheduleAutoSave();
            }}
          />
          <span class="checkbox-label-text">{t('tools.sandboxAllowOs')}</span>
        </label>
        <label class="checkbox-row">
          <input
            type="checkbox"
            checked={sandbox().allowDebug ?? false}
            onChange={(e) => {
              setSandbox({ ...sandbox(), allowDebug: e.currentTarget.checked });
              setDirty(true);
              scheduleAutoSave();
            }}
          />
          <span class="checkbox-label-text">{t('tools.sandboxAllowDebug')}</span>
        </label>
        <label class="checkbox-row">
          <input
            type="checkbox"
            checked={sandbox().allowRequire ?? false}
            onChange={(e) => {
              setSandbox({ ...sandbox(), allowRequire: e.currentTarget.checked });
              setDirty(true);
              scheduleAutoSave();
            }}
          />
          <span class="checkbox-label-text">{t('tools.sandboxAllowRequire')}</span>
        </label>
        <label class="checkbox-row">
          <input
            type="checkbox"
            checked={sandbox().allowNet ?? false}
            onChange={(e) => {
              setSandbox({ ...sandbox(), allowNet: e.currentTarget.checked });
              setDirty(true);
              scheduleAutoSave();
            }}
          />
          <span class="checkbox-label-text">{t('tools.sandboxAllowNet')}</span>
        </label>
        <label class="checkbox-row">
          <input
            type="checkbox"
            checked={sandbox().allowFiles ?? false}
            onChange={(e) => {
              setSandbox({ ...sandbox(), allowFiles: e.currentTarget.checked });
              setDirty(true);
              scheduleAutoSave();
            }}
          />
          <span class="checkbox-label-text">{t('tools.sandboxAllowFiles')}</span>
        </label>
        <label class="checkbox-row">
          <input
            type="checkbox"
            checked={sandbox().allowSt ?? false}
            onChange={(e) => {
              setSandbox({ ...sandbox(), allowSt: e.currentTarget.checked });
              setDirty(true);
              scheduleAutoSave();
            }}
          />
          <span class="checkbox-label-text">{t('tools.sandboxAllowSt')}</span>
        </label>
      </div>
      <div class="instance-row-actions">
        <Show when={savedIndicator()}>
          <span class="save-indicator">{t('tools.saved')}</span>
        </Show>
        <button class="btn btn-sm btn-ghost" onClick={props.onDone}>
          {t('tools.done')}
        </button>
      </div>
    </div>
  );
}

const defaultLuaTemplateCode = `Tool = {}
Tool.state = {}

function Tool.getDefinition()
  return {
    stateKey = "my_state",
    configSchema = {},
    tools = {
      {
        name = "my_tool",
        description = "Describe what this tool does.",
        parameters = {
          type = "object",
          properties = {
            input = {
              type = "string",
              description = "Input parameter"
            }
          },
          required = {"input"}
        }
      }
    }
  }
end

function Tool.execute(args, context, toolName)
  -- args.input is the parameter from the LLM
  -- context.chatId and context.config are available
  return {
    content = "Result: " .. tostring(args.input),
    extra = {}
  }
end

function Tool.serialize()
  return json.encode(Tool.state)
end

function Tool.deserialize(raw)
  Tool.state = json.decode(raw)
end

return Tool
`;
