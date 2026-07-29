/**
 * Viewer + attach for imported RisuAI (.risum) modules on a character card.
 * Users attach external modules DIRECTLY to the character here (file upload →
 * POST /characters/:id/risu-module — asset payloads are imported as character
 * assets); the section list is a read-only porting reference (info / triggers /
 * trigger / regex / lorebook / assets over REST, see server characters.ts
 * risu-module routes).
 */

import { createSignal, onMount, Show, For } from 'solid-js';
import { apiFetch } from '../../lib/apiFetch.js';
import { useI18n } from '../../i18n/index.js';

/** Mirrors server RisuModuleMeta (characterRisuModules.ts). */
export interface RisuModuleMeta {
  id: string;
  name: string;
  namespace?: string;
  source: 'embedded' | 'attached';
  filePath: string;
  counts: { triggers: number; regex: number; lorebook: number; assets: number };
  hasLua: boolean;
  lowLevelAccess: boolean;
}

type ViewerSection = 'info' | 'triggers' | 'regex' | 'lorebook' | 'assets';

const VIEWER_SECTIONS: readonly ViewerSection[] = ['info', 'triggers', 'regex', 'lorebook', 'assets'];

/** Row shape of the section=triggers summary list. */
interface TriggerSummary {
  index: number;
  type: string;
  comment: string;
  effectCount: number;
  conditionCount: number;
  hasLua: boolean;
}

const SECTION_LABEL_KEYS = {
  info: 'character.risuModuleSectionInfo',
  triggers: 'character.risuModuleSectionTriggers',
  regex: 'character.risuModuleSectionRegex',
  lorebook: 'character.risuModuleSectionLorebook',
  assets: 'character.risuModuleSectionAssets',
} as const;

/** Shared <pre> styling for JSON blobs (wrap long lines, cap height). */
const PRE_STYLE = {
  'white-space': 'pre-wrap',
  'word-break': 'break-word',
  'max-height': '20rem',
  overflow: 'auto',
  margin: 'var(--space-xs) 0 0',
} as const;

export function RisuModuleViewer(props: { characterId: string }) {
  const { t } = useI18n();
  const [modules, setModules] = createSignal<RisuModuleMeta[]>([]);
  const [listError, setListError] = createSignal<string | null>(null);
  const [expanded, setExpanded] = createSignal(false);
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [section, setSection] = createSignal<ViewerSection>('info');
  const [sectionData, setSectionData] = createSignal<unknown>(null);
  const [sectionLoading, setSectionLoading] = createSignal(false);
  const [sectionError, setSectionError] = createSignal<string | null>(null);
  const [triggerDetail, setTriggerDetail] = createSignal<{ index: number; data: unknown } | null>(null);
  const [attaching, setAttaching] = createSignal(false);
  const [attachError, setAttachError] = createSignal<string | null>(null);
  const [attachNote, setAttachNote] = createSignal<string | null>(null);
  let fileInput: HTMLInputElement | undefined;

  const listUrl = () => `/api/characters/${encodeURIComponent(props.characterId)}/risu-modules`;
  const attachUrl = () => `/api/characters/${encodeURIComponent(props.characterId)}/risu-module`;
  const moduleUrl = (moduleId: string, query = '') =>
    `/api/characters/${encodeURIComponent(props.characterId)}/risu-modules/${encodeURIComponent(moduleId)}${query}`;

  const refreshModules = async () => {
    try {
      const res = await apiFetch(listUrl());
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { total: number; modules: RisuModuleMeta[] };
      setModules(body.modules);
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    }
  };

  onMount(refreshModules);

  /** Direct-to-card attach: the natural home for external modules (never chat attachments). */
  const attachFile = async (file: File) => {
    setAttaching(true);
    setAttachError(null);
    setAttachNote(null);
    try {
      const form = new FormData();
      form.append('file', file, file.name);
      const res = await apiFetch(attachUrl(), { method: 'POST', body: form });
      const body = (await res.json().catch(() => ({}))) as { error?: string; module?: RisuModuleMeta; assetsStored?: number };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setAttachNote(
        t('character.risuModuleAttachSuccess', { name: body.module?.name ?? file.name, assets: body.assetsStored ?? 0 }),
      );
      setExpanded(true);
      await refreshModules();
    } catch (err) {
      setAttachError(err instanceof Error ? err.message : String(err));
    } finally {
      setAttaching(false);
      if (fileInput) fileInput.value = '';
    }
  };

  const loadSection = async (moduleId: string, s: ViewerSection) => {
    setSectionLoading(true);
    setSectionError(null);
    setTriggerDetail(null);
    try {
      const res = await apiFetch(moduleUrl(moduleId, `?section=${s}`));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSectionData(await res.json());
    } catch (err) {
      setSectionData(null);
      setSectionError(err instanceof Error ? err.message : String(err));
    } finally {
      setSectionLoading(false);
    }
  };

  const selectModule = (id: string) => {
    setSelectedId(id);
    setSection('info');
    void loadSection(id, 'info');
  };

  const pickSection = (s: ViewerSection) => {
    setSection(s);
    const id = selectedId();
    if (id) void loadSection(id, s);
  };

  const viewTrigger = async (index: number) => {
    const id = selectedId();
    if (!id) return;
    setSectionError(null);
    try {
      const res = await apiFetch(moduleUrl(id, `?section=trigger&index=${index}`));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setTriggerDetail({ index, data: (await res.json()) as unknown });
    } catch (err) {
      setTriggerDetail(null);
      setSectionError(err instanceof Error ? err.message : String(err));
    }
  };

  const selectedModule = () => modules().find((m) => m.id === selectedId());

  return (
    <>
      <Show when={listError()}>
        <p class="hint-text text-danger">
          {t('character.risuModuleLoadFailed')}: {listError()}
        </p>
      </Show>
      <div class="risu-module-viewer">
        <div class="flex-row-sm">
          <Show when={modules().length > 0}>
            <button class="advanced-toggle" type="button" onClick={() => setExpanded((v) => !v)}>
              <i class={`bi bi-chevron-${expanded() ? 'down' : 'right'}`} />{' '}
              {t('character.risuModulesToggle', { count: modules().length })}
            </button>
          </Show>
          <button
            class="text-btn small"
            type="button"
            disabled={attaching()}
            onClick={() => fileInput?.click()}
          >
            <i class="bi bi-upload" />{' '}
            {attaching() ? t('character.risuModuleAttaching') : t('character.risuModuleAttach')}
          </button>
          <input
            ref={fileInput}
            class="hidden-file-input"
            type="file"
            accept=".risum"
            hidden
            onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              if (file) void attachFile(file);
            }}
          />
        </div>
        <Show when={attachError()}>
          <p class="hint-text text-danger">{attachError()}</p>
        </Show>
        <Show when={attachNote()}>
          <p class="hint-text">{attachNote()}</p>
        </Show>
        <Show when={modules().length > 0 && expanded()}>
          <p class="text-sm text-muted">{t('character.risuModulesDescription')}</p>
          <For each={modules()}>
              {(m) => (
                <div class="flex-col-sm">
                  <button
                    class="text-btn small"
                    type="button"
                    aria-pressed={selectedId() === m.id}
                    onClick={() => selectModule(m.id)}
                  >
                    <strong>{m.name}</strong>
                    <Show when={m.namespace}>
                      <span class="text-xs text-muted"> ({m.namespace})</span>
                    </Show>
                  </button>
                  <span class="text-xs text-muted">
                    {t('character.risuModuleCounts', {
                      triggers: m.counts.triggers,
                      regex: m.counts.regex,
                      lorebook: m.counts.lorebook,
                      assets: m.counts.assets,
                    })}
                    <Show when={m.hasLua}> · {t('character.risuModuleHasLua')}</Show>
                    <Show when={m.lowLevelAccess}> · {t('character.risuModuleLowLevel')}</Show>
                  </span>
                </div>
              )}
            </For>

            <Show when={selectedModule()}>
              {(m) => (
                <div class="risu-module-detail">
                  <div class="flex-row-sm mt-sm">
                    <For each={VIEWER_SECTIONS}>
                      {(s) => (
                        <button
                          class="text-btn small"
                          type="button"
                          aria-pressed={section() === s}
                          onClick={() => pickSection(s)}
                        >
                          {t(SECTION_LABEL_KEYS[s])}
                        </button>
                      )}
                    </For>
                  </div>
                  <Show when={sectionLoading()}>
                    <p class="hint-text">{t('character.risuModuleLoading')}</p>
                  </Show>
                  <Show when={sectionError()}>
                    <p class="hint-text text-danger">{sectionError()}</p>
                  </Show>
                  <Show when={!sectionLoading() && !sectionError() && sectionData() !== null}>
                    <Show
                      when={section() === 'triggers'}
                      fallback={
                        <pre class="font-mono text-sm" style={PRE_STYLE}>
                          {JSON.stringify(sectionData(), null, 2)}
                        </pre>
                      }
                    >
                      <For each={(sectionData() as TriggerSummary[] | null) ?? []}>
                        {(tr) => (
                          <div class="flex-between">
                            <span class="text-sm">
                              #{tr.index} {tr.type}
                              <Show when={tr.comment}> — {tr.comment}</Show>
                            </span>
                            <span class="flex-row-sm">
                              <span class="text-xs text-muted">
                                {t('character.risuModuleTriggerCounts', {
                                  effects: tr.effectCount,
                                  conditions: tr.conditionCount,
                                })}
                                <Show when={tr.hasLua}> · {t('character.risuModuleHasLua')}</Show>
                              </span>
                              <button class="text-btn small" type="button" onClick={() => void viewTrigger(tr.index)}>
                                {t('character.risuModuleViewTrigger')}
                              </button>
                            </span>
                          </div>
                        )}
                      </For>
                      <Show when={triggerDetail()}>
                        {(d) => (
                          <>
                            <span class="text-xs text-muted">
                              {t('character.risuModuleTriggerDetail', { index: d().index })}
                            </span>
                            <pre class="font-mono text-sm" style={PRE_STYLE}>
                              {JSON.stringify(d().data, null, 2)}
                            </pre>
                          </>
                        )}
                      </Show>
                    </Show>
                  </Show>
                  <span class="text-xs text-muted">{m().filePath}</span>
                </div>
              )}
            </Show>
        </Show>
      </div>
    </>
  );
}
