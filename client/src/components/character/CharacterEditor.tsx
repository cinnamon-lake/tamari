import { createSignal, Show, For, createEffect, onMount, onCleanup } from 'solid-js';
import { bus } from '../../bus/WebSocketBus.js';
import { state } from '../../stores/serverStore.js';
import { confirmPopup, alertPopup } from '../../stores/popupStore.js';
import { apiFetch, authenticatedUrl } from '../../lib/apiFetch.js';
import { useI18n } from '../../i18n/index.js';
import { trapFocus, saveFocus, restoreFocus } from '../../lib/focusUtils.js';
import { AUTOSAVE_DEBOUNCE_MS } from '../../timing.js';
import type { Character, RegexRule } from '@tamari/types';
import { CropModal } from '../CropModal.js';
import { SafeImage } from '../SafeImage.js';
import { CharacterRegexEditor } from './CharacterRegexEditor.js';
import {
  CharacterBackendEditor,
  parseCharacterBackendLogic,
  type CharacterBackendLogic,
} from './CharacterBackendEditor.js';
import { RisuModuleViewer } from './RisuModuleViewer.js';
import { PromptTextarea } from './PromptTextarea.js';
import { GreetingsEditor } from './GreetingsEditor.js';
import { IdBadge } from '../IdBadge.js';
import './CharacterEditor.css';

/** Tolerant parse of scoped regex rules out of a character's extensions blob. */
function parseScopedRegexRules(extensions: Record<string, unknown> | undefined): RegexRule[] {
  const raw = extensions?.['regexScripts'];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is RegexRule => !!r && typeof r === 'object' && typeof (r as RegexRule).findRegex === 'string')
    .map((r) => ({
      id: r.id || crypto.randomUUID(),
      name: r.name ?? '',
      findRegex: r.findRegex,
      replaceString: r.replaceString ?? '',
      ...(typeof r.replaceLua === 'string' && r.replaceLua.length > 0 ? { replaceLua: r.replaceLua } : {}),
      disabled: Boolean(r.disabled),
      userInput: Boolean(r.userInput),
      aiOutput: Boolean(r.aiOutput),
      prompt: r.prompt === undefined ? true : Boolean(r.prompt),
      display: r.display === undefined ? true : Boolean(r.display),
    }));
}

export interface CharacterEditorProps {
  character: Character;
  onClose: () => void;
}

const EDITOR_TABS = ['content', 'greetings', 'logic', 'advanced'] as const;
type EditorTab = (typeof EDITOR_TABS)[number];

export function CharacterEditor(props: CharacterEditorProps) {
  const { t } = useI18n();
  // t() narrows literal keys but returns `unknown` for dynamically-built key
  // paths (@solid-primitives/i18n); coerce the tab-label lookups.
  const td = (key: string): string => t(key) as string;
  const char = props.character;

  // Unpacked (on-disk) cards are read-only: disk is the source of truth and
  // the server rejects all mutations — mirror that here by blocking every
  // local edit path (save, autosave, delete, avatar upload, field inputs).
  const isExternal = () => props.character.external === true;
  const unpackedSlug = () =>
    props.character.id.startsWith('unpacked/')
      ? props.character.id.slice('unpacked/'.length)
      : props.character.id;
  const unpackedErrors = (): string[] => {
    const raw = props.character.extensions['unpackedErrors'];
    return Array.isArray(raw) ? raw.filter((e): e is string => typeof e === 'string') : [];
  };

  const close = () => {
    restoreFocus();
    props.onClose();
  };

  // Basic fields
  const [name, setName] = createSignal(char.name ?? '');
  const [description, setDescription] = createSignal(char.description ?? '');
  const [personality, setPersonality] = createSignal(char.personality ?? '');
  const [scenario, setScenario] = createSignal(char.scenario ?? '');
  const [firstMes, setFirstMes] = createSignal(char.firstMes ?? '');
  const [mesExample, setMesExample] = createSignal(char.mesExample ?? '');
  const [creator, setCreator] = createSignal(char.creator ?? '');
  const [version, setVersion] = createSignal(char.characterVersion ?? '');

  // Tags
  const [tags, setTags] = createSignal<string[]>([...(char.tags ?? [])]);
  const [tagInput, setTagInput] = createSignal('');
  const [showTagSuggestions, setShowTagSuggestions] = createSignal(false);

  // Advanced V2/V3 fields
  const [creatorNotes, setCreatorNotes] = createSignal(char.creatorNotes ?? '');
  const [systemPrompt, setSystemPrompt] = createSignal(char.systemPrompt ?? '');
  const [postHistoryInstructions, setPostHistoryInstructions] = createSignal(char.postHistoryInstructions ?? '');
  const [alternateGreetings, setAlternateGreetings] = createSignal<string[]>([...(char.alternateGreetings ?? [])]);
  const [worldInfoId, setWorldInfoId] = createSignal(char.worldInfoId ?? null);

  // V3 fields
  const [nickname, setNickname] = createSignal(char.nickname ?? '');
  const [groupOnlyGreetings, setGroupOnlyGreetings] = createSignal<string[]>([...(char.groupOnlyGreetings ?? [])]);
  const [creatorNotesMultilingual, setCreatorNotesMultilingual] = createSignal<Record<string, string>>(
    char.creatorNotesMultilingual ?? {},
  );
  const [source, setSource] = createSignal<string[]>([...(char.source ?? [])]);
  const [regexRules, setRegexRules] = createSignal<RegexRule[]>(parseScopedRegexRules(char.extensions));
  const [backendLogic, setBackendLogic] = createSignal<CharacterBackendLogic>(
    parseCharacterBackendLogic(char.extensions),
  );

  const [activeTab, setActiveTab] = createSignal<EditorTab>('content');
  const [showAssets, setShowAssets] = createSignal(false);
  const [avatarBust, setAvatarBust] = createSignal(Date.now());

  onMount(() => {
    saveFocus();
    bus.send({ type: 'worldinfo.list' });
  });

  const [savedIndicator, setSavedIndicator] = createSignal(false);
  const [loadedCharId, setLoadedCharId] = createSignal<string | null>(null);
  let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;

  // Re-sync local signals only when the *character* changes, not when the
  // same character is updated by a server broadcast. This prevents local
  // edits from being stomped by our own auto-save response.
  createEffect(() => {
    const c = props.character;
    if (c.id === loadedCharId()) return;
    setName(c.name ?? '');
    setDescription(c.description ?? '');
    setPersonality(c.personality ?? '');
    setScenario(c.scenario ?? '');
    setFirstMes(c.firstMes ?? '');
    setMesExample(c.mesExample ?? '');
    setCreator(c.creator ?? '');
    setVersion(c.characterVersion ?? '');
    setTags([...(c.tags ?? [])]);
    setCreatorNotes(c.creatorNotes ?? '');
    setSystemPrompt(c.systemPrompt ?? '');
    setPostHistoryInstructions(c.postHistoryInstructions ?? '');
    setAlternateGreetings([...(c.alternateGreetings ?? [])]);
    setWorldInfoId(c.worldInfoId ?? null);
    setNickname(c.nickname ?? '');
    setGroupOnlyGreetings([...(c.groupOnlyGreetings ?? [])]);
    setCreatorNotesMultilingual(c.creatorNotesMultilingual ?? {});
    setSource([...(c.source ?? [])]);
    setRegexRules(parseScopedRegexRules(c.extensions));
    setBackendLogic(parseCharacterBackendLogic(c.extensions));
    setLoadedCharId(c.id);
  });

  const allTags = () => {
    const set = new Set<string>();
    for (const c of state.characters) {
      for (const t of c.tags ?? []) {
        if (t) set.add(t);
      }
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  };

  const tagSuggestions = () => {
    const input = tagInput().trim().toLowerCase();
    if (!input) return [];
    const current = new Set(tags());
    return allTags()
      .filter((t) => !current.has(t) && t.toLowerCase().includes(input))
      .slice(0, 8);
  };

  const addTag = (t: string) => {
    const trimmed = t.trim();
    if (!trimmed) return;
    setTags((prev) => (prev.includes(trimmed) ? prev : [...prev, trimmed]));
    setTagInput('');
    setShowTagSuggestions(false);
    scheduleAutoSave();
  };

  const removeTag = (t: string) => {
    setTags((prev) => prev.filter((x) => x !== t));
    scheduleAutoSave();
  };

  const buildPayload = () => {
    return {
      name: name(),
      description: description(),
      personality: personality(),
      scenario: scenario(),
      firstMes: firstMes(),
      mesExample: mesExample(),
      creator: creator(),
      characterVersion: version(),
      tags: tags(),
      creatorNotes: creatorNotes(),
      systemPrompt: systemPrompt(),
      postHistoryInstructions: postHistoryInstructions(),
      alternateGreetings: alternateGreetings(),
      groupOnlyGreetings: groupOnlyGreetings(),
      nickname: nickname(),
      creatorNotesMultilingual: creatorNotesMultilingual(),
      source: source(),
      // Spread the LATEST prop extensions (not the stale load-time capture) so
      // tool-side extension edits (e.g. model-added regex rules) survive our
      // auto-save; only the regexScripts and contextualBackend keys are editor-owned.
      extensions: {
        ...props.character.extensions,
        regexScripts: regexRules(),
        contextualBackend: backendLogic(),
      },
      worldInfoId: worldInfoId(),
    };
  };

  const doSave = (closeAfter = false) => {
    if (isExternal()) return;
    if (!name().trim()) return;

    bus.send({
      type: 'character.update',
      characterId: char.id,
      patch: buildPayload(),
    });

    setSavedIndicator(true);
    setTimeout(() => setSavedIndicator(false), 1200);
    if (closeAfter) close();
  };

  const scheduleAutoSave = () => {
    if (isExternal()) return;
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => doSave(false), AUTOSAVE_DEBOUNCE_MS);
  };

  // Flush a pending auto-save on unmount so closing the editor within the
  // debounce window doesn't silently lose the edit.
  onCleanup(() => {
    if (autoSaveTimer) {
      clearTimeout(autoSaveTimer);
      doSave();
    }
  });

  const exportCard = (format: 'png' | 'charx' = 'png') => {
    const url = format === 'charx' ? char.charxUrl : char.exportUrl;
    if (!url) return;
    const a = document.createElement('a');
    a.href = authenticatedUrl(url);
    a.download = `${char.name}.${format === 'charx' ? 'charx' : 'png'}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const deleteCharacter = async () => {
    if (isExternal()) return;
    if (
      !(await confirmPopup(t('character.deleteConfirm', { name: char.name })))
    )
      return;
    bus.send({ type: 'character.delete', characterId: char.id });
    close();
  };

  const [showCropModal, setShowCropModal] = createSignal(false);
  const [cropImageUrl, setCropImageUrl] = createSignal<string>('');

  const handleAvatarUpload = (e: Event) => {
    if (isExternal()) return;
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    if (state.settings['neverResizeAvatars']) {
      void uploadAvatarFile(file);
      return;
    }

    const url = URL.createObjectURL(file);
    setCropImageUrl(url);
    setShowCropModal(true);
  };

  const uploadAvatarFile = async (file: File) => {
    if (isExternal()) return;
    const formData = new FormData();
    formData.append('avatar', file);

    try {
      if (!char.avatarUploadUrl) throw new Error('No avatar upload URL');
      const res = await apiFetch(char.avatarUploadUrl, {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) throw new Error('Upload failed');
      setAvatarBust(Date.now());
    } catch (err) {
      console.error('Avatar upload failed:', err);
      await alertPopup(t('character.avatarUploadFailed'));
    }
  };

  const applyCroppedAvatar = async (blob: Blob) => {
    setShowCropModal(false);
    URL.revokeObjectURL(cropImageUrl());
    await uploadAvatarFile(new File([blob], 'avatar.png', { type: 'image/png' }));
  };

  const assetGroups = () => {
    const groups: Record<string, typeof char.assets> = {};
    for (const asset of char.assets ?? []) {
      const type = asset.type || 'other';
      if (!groups[type]) groups[type] = [];
      groups[type].push(asset);
    }
    return groups;
  };

  return (
    <div class="modal-overlay" onClick={close}>
      <div class="modal character-editor-modal" role="dialog" aria-modal="true" aria-label={t('character.modalAriaLabel')} onKeyDown={(e) => trapFocus(e.currentTarget, e)} onClick={(e) => e.stopPropagation()}>
        <div class="modal-header-row">
          <h2 class="modal-title">{char.name}</h2>
          <IdBadge id={char.id} />
          <button class="icon-btn" onClick={close} title={t('common.close')} aria-label={t('common.close')} type="button">
            <i class="bi bi-x-lg" />
          </button>
        </div>

        <Show when={isExternal()}>
          <div class="external-banner" role="status">
            <i class="bi bi-hdd" />
            <div class="external-banner-body">
              <span>{t('character.externalBanner', { slug: unpackedSlug() })}</span>
              <Show when={unpackedErrors().length > 0}>
                <ul class="external-banner-errors">
                  <For each={unpackedErrors()}>{(err) => <li>{err}</li>}</For>
                </ul>
              </Show>
            </div>
          </div>
        </Show>

        <div class="editor-tabs" role="tablist" aria-label={t('character.modalAriaLabel')}>
          <For each={EDITOR_TABS}>
            {(tab) => (
              <button
                type="button"
                role="tab"
                aria-selected={activeTab() === tab}
                class={`editor-tab${activeTab() === tab ? ' active' : ''}`}
                id={`editor-tab-${tab}`}
                onClick={() => setActiveTab(tab)}
              >
                {td(`character.tab${tab[0]!.toUpperCase()}${tab.slice(1)}`)}
              </button>
            )}
          </For>
        </div>

        {/* ---- Content: identity + prompt fields ---- */}
        <Show when={activeTab() === 'content'}>
          <div class="editor-tab-panel" role="tabpanel"><fieldset class="editor-fieldset" disabled={isExternal()}>
            <div class="avatar-upload">
              <SafeImage
                class="editor-avatar"
                src={`${char.avatarUrl}?t=${avatarBust()}`}
                alt={char.name}
                loading="lazy"
              />
              <label class="file-input-label">
                {t('character.changeAvatar')}
                <input class="hidden-file-input" type="file" accept="image/*" onChange={handleAvatarUpload} hidden />
              </label>
            </div>

            <label class="field-label">
              {t('character.nameLabel')}
              <input class="text-input"
                value={name()}
                required
                aria-required="true"
                autocomplete="off"
                onInput={(e) => {
                  setName(e.currentTarget.value);
                  scheduleAutoSave();
                }}
              />
            </label>

            <label class="field-label">
              {t('character.nicknameLabel')}
              <input class="text-input"
                value={nickname()}
                onInput={(e) => {
                  setNickname(e.currentTarget.value);
                  scheduleAutoSave();
                }}
              />
            </label>

            <PromptTextarea label={t('character.descriptionLabel')} value={description()} onInput={(v) => { setDescription(v); scheduleAutoSave(); }} rows={5} />
            <PromptTextarea label={t('character.personalityLabel')} value={personality()} onInput={(v) => { setPersonality(v); scheduleAutoSave(); }} />
            <PromptTextarea label={t('character.scenarioLabel')} value={scenario()} onInput={(v) => { setScenario(v); scheduleAutoSave(); }} />
            <PromptTextarea label={t('character.firstMessageLabel')} value={firstMes()} onInput={(v) => { setFirstMes(v); scheduleAutoSave(); }} rows={5} />
            <PromptTextarea label={t('character.messageExampleLabel')} value={mesExample()} onInput={(v) => { setMesExample(v); scheduleAutoSave(); }} rows={4} />

            {/* Tags */}
            <div class="tag-editor">
              <span class="tag-label">{t('character.tagsLabel')}</span>
              <div class="tag-list">
                <For each={tags()}>
                  {(tag, index) => (
                    <span class="tag-chip" id={`tag-${index()}`}>
                      {tag}
                      <button class="tag-remove" onClick={() => removeTag(tag)} type="button" aria-label={t('character.removeTag')}>
                        <i class="bi bi-x" />
                      </button>
                    </span>
                  )}
                </For>
              </div>
              <div class="tag-input-wrap">
                <input class="tag-input"
                  value={tagInput()}
                  onInput={(e) => {
                    setTagInput(e.currentTarget.value);
                    setShowTagSuggestions(true);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addTag(tagInput());
                    }
                  }}
                  onBlur={() => setTimeout(() => setShowTagSuggestions(false), 150)}
                  placeholder={t('character.addTagPlaceholder')}
                />
                <Show when={showTagSuggestions() && tagSuggestions().length > 0}>
                  <div class="tag-suggestions">
                    <For each={tagSuggestions()}>
                      {(suggestion, index) => (
                        <button class="tag-suggestion" id={`tag-suggestion-${index()}`} onClick={() => addTag(suggestion)}>
                          {suggestion}
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            </div>

            {/* Linked Lorebook */}
            <div class="lorebook-selector">
              <span class="tag-label">{t('character.linkedLorebookLabel')}</span>
              <Show
                when={state.worldInfo.length > 0}
                fallback={
                  <div class="empty-state">
                    <i class="bi bi-journal-bookmark" />
                    <div class="empty-state-text">{t('character.noLorebooks')}</div>
                    <div class="hint">{t('character.createLorebookHint')}</div>
                  </div>
                }
              >
                <select
                  class="select"
                  aria-label={t('character.linkedLorebookLabel')}
                  value={worldInfoId() ?? ''}
                  onChange={(e) => {
                    const val = e.currentTarget.value;
                    setWorldInfoId(val || null);
                    scheduleAutoSave();
                  }}
                >
                  <option class="lorebook-option" value="">{t('character.noneOption')}</option>
                  <For each={state.worldInfo}>
                    {(book) => (
                      <option class="lorebook-option" value={book.id} id={book.id}>
                        {t('character.lorebookOptionLabel', { name: book.name, count: book.entries.length })}
                      </option>
                    )}
                  </For>
                </select>
              </Show>
            </div>
          </fieldset></div>
        </Show>

        {/* ---- Greetings: first-message variants ---- */}
        <Show when={activeTab() === 'greetings'}>
          <div class="editor-tab-panel" role="tabpanel"><fieldset class="editor-fieldset" disabled={isExternal()}>
            <GreetingsEditor
              label={t('character.alternateGreetingsLabel')}
              items={alternateGreetings()}
              onChange={(next) => {
                setAlternateGreetings(next);
                scheduleAutoSave();
              }}
            />
            <GreetingsEditor
              label={t('character.groupOnlyGreetingsLabel')}
              items={groupOnlyGreetings()}
              onChange={(next) => {
                setGroupOnlyGreetings(next);
                scheduleAutoSave();
              }}
            />
          </fieldset></div>
        </Show>

        {/* ---- Logic: regex, backend Lua, imported modules ---- */}
        <Show when={activeTab() === 'logic'}>
          <div class="editor-tab-panel" role="tabpanel"><fieldset class="editor-fieldset" disabled={isExternal()}>
            <div class="character-regex-section">
              <h3 class="section-heading">{t('character.regexHeading')}</h3>
              <p class="text-sm text-muted">{t('character.regexDescription')}</p>
              <CharacterRegexEditor
                rules={regexRules()}
                onChange={(next) => {
                  setRegexRules(next);
                  scheduleAutoSave();
                }}
              />
            </div>

            <div class="character-backend-section">
              <h3 class="section-heading">{t('character.backendHeading')}</h3>
              <p class="text-sm text-muted">{t('character.backendDescription')}</p>
              <CharacterBackendEditor
                value={backendLogic()}
                characterId={char.id}
                onChange={(next) => {
                  setBackendLogic(next);
                  scheduleAutoSave();
                }}
              />
            </div>

            {/* Imported RisuAI (.risum) modules — read-only porting reference.
                Renders nothing when the character has no modules. */}
            <RisuModuleViewer characterId={char.id} />
          </fieldset></div>
        </Show>

        {/* ---- Advanced: metadata + prompt overrides + assets ---- */}
        <Show when={activeTab() === 'advanced'}>
          <div class="editor-tab-panel" role="tabpanel"><fieldset class="editor-fieldset" disabled={isExternal()}>
            <PromptTextarea label={t('character.creatorNotesLabel')} value={creatorNotes()} onInput={(v) => { setCreatorNotes(v); scheduleAutoSave(); }} />
            <PromptTextarea label={t('character.systemPromptLabel')} value={systemPrompt()} onInput={(v) => { setSystemPrompt(v); scheduleAutoSave(); }} rows={4} />
            <PromptTextarea label={t('character.postHistoryLabel')} value={postHistoryInstructions()} onInput={(v) => { setPostHistoryInstructions(v); scheduleAutoSave(); }} rows={4} />

            <label class="field-label">
              {t('character.creatorLabel')}
              <input class="text-input"
                value={creator()}
                onInput={(e) => {
                  setCreator(e.currentTarget.value);
                  scheduleAutoSave();
                }}
              />
            </label>

            <label class="field-label">
              {t('character.versionLabel')}
              <input class="text-input"
                value={version()}
                onInput={(e) => {
                  setVersion(e.currentTarget.value);
                  scheduleAutoSave();
                }}
              />
            </label>

            <label class="field-label">
              {t('character.sourceLabel')}
              <textarea
                class="textarea-input"
                rows={2}
                value={source().join('\n')}
                onInput={(e) => {
                  const lines = e.currentTarget.value.split('\n').map((s) => s.trim()).filter(Boolean);
                  setSource(lines);
                  scheduleAutoSave();
                }}
              />
            </label>

            {/* Assets (V3) */}
            <Show when={(char.assets?.length ?? 0) > 0}>
              <button class="advanced-toggle" onClick={() => setShowAssets((v) => !v)} type="button">
                <i class={`bi bi-chevron-${showAssets() ? 'down' : 'right'}`} /> {t('character.assetsToggle', { count: char.assets?.length ?? 0 })}
              </button>
              <Show when={showAssets()}>
                <div class="assets-section">
                  <For each={Object.entries(assetGroups())}>
                    {([type, items], index) => (
                      <div class="asset-group" id={`asset-group-${index()}`}>
                        <span class="asset-type-label">{type}</span>
                        <div class="asset-grid">
                          <For each={items}>
                            {(asset) => (
                              <div class="asset-item" id={asset.id} title={asset.name}>
                                <Show
                                  when={asset.assetUrl}
                                  fallback={<div class="asset-placeholder">{asset.ext}</div>}
                                >
                                  <SafeImage
                                    class="asset-thumb"
                                    src={`${asset.assetUrl}?t=${asset.updatedAt}`}
                                    alt={asset.name}
                                    loading="lazy"
                                  />
                                </Show>
                                <span class="asset-name">{asset.name || asset.id.slice(0, 8)}</span>
                              </div>
                            )}
                          </For>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </Show>
          </fieldset></div>
        </Show>

        <div class="modal-actions">
          <Show when={!isExternal()}>
            <button class="btn btn-danger danger-btn" onClick={deleteCharacter}>
              {t('common.delete')}
            </button>
          </Show>
          <div class="modal-actions-spacer" />
          <Show when={savedIndicator()}>
            <span class="save-indicator">{t('character.saved')}</span>
          </Show>
          <div class="export-dropdown">
            <button class="export-btn" onClick={() => exportCard('png')}>{t('character.exportPng')}</button>
            <Show when={(char.assets?.length ?? 0) > 0}>
              <button class="export-btn" onClick={() => exportCard('charx')}>{t('character.exportCharx')}</button>
            </Show>
          </div>
        </div>
      </div>

      <Show when={showCropModal()}>
        <CropModal
          imageUrl={cropImageUrl()}
          onConfirm={applyCroppedAvatar}
          onCancel={() => {
            setShowCropModal(false);
            URL.revokeObjectURL(cropImageUrl());
          }}
        />
      </Show>
    </div>
  );
}
