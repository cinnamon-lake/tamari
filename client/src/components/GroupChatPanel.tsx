import { For, Show, createSignal, createMemo } from 'solid-js';
import { str } from '../lib/coerce.js';
import { SafeImage } from './SafeImage.js';
import { state } from '../stores/serverStore.js';
import { bus } from '../bus/WebSocketBus.js';
import { confirmPopup } from '../stores/popupStore.js';
import { useI18n } from '../i18n/index.js';
import { trapFocus, saveFocus, restoreFocus } from '../lib/focusUtils.js';
import type { ActivationStrategy } from '@tamari/types';
import './GroupChatPanel.css';

export interface GroupChatPanelProps {
  chatId: string;
  onClose: () => void;
}

export function GroupChatPanel(props: GroupChatPanelProps) {
  const { t } = useI18n();
  const [showAddMember, setShowAddMember] = createSignal(false);

  saveFocus();

  const close = () => {
    restoreFocus();
    props.onClose();
  };

  const members = () => state.chatMembers[props.chatId] ?? [];

  const activeChat = () => state.activeChat;

  const groupSettings = createMemo(() => {
    const meta = (activeChat()?.metadata ?? {});
    return (meta.groupChatSettings ?? {}) as Record<string, unknown>;
  });

  const activationStrategy = () => str(groupSettings().activationStrategy, 'NATURAL') as ActivationStrategy;

  const availableCharacters = () => {
    const memberIds = new Set(members().map((m) => m.characterId));
    return state.characters.filter((c) => !memberIds.has(c.id));
  };

  const addMember = (characterId: string) => {
    bus.send({ type: 'group.member.add', chatId: props.chatId, characterId });
    // Deliberately keep the dropdown open: adding several members in a row
    // shouldn't require re-opening it each time.
  };

  const removeMember = async (characterId: string) => {
    if (!(await confirmPopup(t('groupChat.removeMemberConfirm')))) return;
    bus.send({ type: 'group.member.remove', chatId: props.chatId, characterId });
  };

  const toggleEnabled = (characterId: string, enabled: boolean) => {
    bus.send({
      type: 'group.member.update',
      chatId: props.chatId,
      characterId,
      patch: { enabled: !enabled },
    });
  };

  const updateTalkativeness = (characterId: string, value: number) => {
    bus.send({
      type: 'group.member.update',
      chatId: props.chatId,
      characterId,
      patch: { talkativeness: value },
    });
  };

  const updateStrategy = (strategy: ActivationStrategy) => {
    const chat = activeChat();
    if (!chat) return;
    const meta = (chat.metadata ?? {});
    const settings = (meta.groupChatSettings ?? {}) as Record<string, unknown>;
    bus.send({
      type: 'chat.update',
      chatId: props.chatId,
      patch: {
        metadata: {
          ...meta,
          groupChatSettings: { ...settings, activationStrategy: strategy },
        },
      },
    });
  };

  return (
    <div class="group-panel-overlay" onClick={close}>
      <div class="group-panel" role="dialog" aria-modal="true" aria-labelledby="group-panel-title" onKeyDown={(e) => trapFocus(e.currentTarget, e)} onClick={(e) => e.stopPropagation()}>
        <div class="group-panel-header">
          <h2 class="panel-title" id="group-panel-title">{t('groupChat.membersTitle')}</h2>
          <button class="icon-btn" onClick={close} aria-label={t('common.close')} type="button">
            <i class="bi bi-x-lg" />
          </button>
        </div>

        <div class="group-panel-content">
          {/* Activation Strategy */}
          <div class="group-setting">
            <label class="field-label">{t('groupChat.activationStrategy')}</label>
            <select class="select" value={activationStrategy()} onChange={(e) => updateStrategy(e.currentTarget.value as ActivationStrategy)}>
              <option class="select-option" value="NATURAL">{t('groupChat.strategyNatural')}</option>
              <option class="select-option" value="LIST">{t('groupChat.strategyList')}</option>
              <option class="select-option" value="MANUAL">{t('groupChat.strategyManual')}</option>
              <option class="select-option" value="POOLED">{t('groupChat.strategyPooled')}</option>
            </select>
          </div>

          {/* Member List */}
          <div class="group-members-list">
            <For each={members()}>
              {(member) => {
                return (
                  <div id={member.characterId} class="group-member-item">
                    <div class="group-member-info">
                      <SafeImage
                        class="group-member-avatar"
                        src={(member.characterThumbnailUrl ?? member.characterAvatarUrl) ?? undefined}
                        alt={member.characterName}
                        loading="lazy"
                      />
                      <span class="group-member-name">{member.characterName}</span>
                    </div>

                    <div class="group-member-controls">
                      <label class="toggle-label">
                        <input
                          type="checkbox"
                          class="toggle-input"
                          checked={member.enabled}
                          onChange={() => toggleEnabled(member.characterId, member.enabled)}
                        />
                        {t('groupChat.active')}
                      </label>

                      <div class="talkativeness-control">
                        <label class="field-label">{t('groupChat.talkativeness')}</label>
                        <input
                          class="range-input"
                          type="range"
                          min="0.1"
                          max="5"
                          step="0.1"
                          value={member.talkativeness}
                          onChange={(e) => updateTalkativeness(member.characterId, Number(e.currentTarget.value))}
                        />
                        <span class="talkativeness-value">{member.talkativeness.toFixed(1)}</span>
                      </div>

                      <button
                        class="icon-btn small danger"
                        onClick={() => removeMember(member.characterId)}
                        title={t('groupChat.removeMemberTitle')} aria-label={t('groupChat.removeMemberTitle')}
                        type="button"
                      >
                        <i class="bi bi-trash" />
                      </button>
                    </div>
                  </div>
                );
              }}
            </For>
          </div>

          {/* Add Member */}
          <Show
            when={showAddMember()}
            fallback={
              <button class="text-btn" onClick={() => setShowAddMember(true)} type="button">
                <i class="bi bi-plus-lg" /> {t('groupChat.addMember')}
              </button>
            }
          >
            <div class="add-member-dropdown">
              <select
                class="select"
                onChange={(e) => {
                  if (e.currentTarget.value) {
                    addMember(e.currentTarget.value);
                    // Reset to the placeholder so the same member could be
                    // re-picked and the next pick is always a real change.
                    e.currentTarget.value = '';
                  }
                }}
              >
                <option class="select-option" value="">{t('groupChat.selectCharacter')}</option>
                <For each={availableCharacters()}>{(char) => <option id={char.id} class="select-option" value={char.id}>{char.name}</option>}</For>
              </select>
              <button class="text-btn" onClick={() => setShowAddMember(false)}>
                {t('common.cancel')}
              </button>
            </div>
          </Show>

          <Show when={members().length === 0}>
            <p class="empty-state">{t('groupChat.noMembers')}</p>
          </Show>
        </div>
      </div>
    </div>
  );
}
