import { createSignal, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { bus } from '../bus/WebSocketBus.js';
import type { QuickReply, QuickReplyInsert } from '@tamari/types';
import { QuickReplyAutoExecute } from '@tamari/types';
import { useI18n } from '../i18n/index.js';
import { trapFocus, saveFocus, restoreFocus } from '../lib/focusUtils.js';
import './QuickReplyEditor.css';

interface Props {
  qr?: QuickReply;
  chatId: string;
  characterId: string;
  onClose: () => void;
}

export function QuickReplyEditor(props: Props) {
  const { t } = useI18n();
  saveFocus();

  const close = () => {
    restoreFocus();
    props.onClose();
  };

  const [label, setLabel] = createSignal(props.qr?.label ?? '');
  const [script, setScript] = createSignal(props.qr?.script ?? '');
  const [color, setColor] = createSignal(props.qr?.color ?? '');
  const [icon, setIcon] = createSignal(props.qr?.icon ?? '');
  const [scope, setScope] = createSignal<'global' | 'character' | 'chat'>(props.qr?.scope ?? 'global');
  const [autoExecute, setAutoExecute] = createSignal(props.qr?.autoExecute ?? 0);
  const [orderIndex, setOrderIndex] = createSignal(props.qr?.orderIndex ?? 0);

  const toggleAutoExecute = (bit: number) => {
    setAutoExecute((current) => (current & bit ? current & ~bit : current | bit));
  };

  const save = () => {
    const data: QuickReplyInsert = {
      scope: scope(),
      scopeId: scope() === 'chat' ? props.chatId : scope() === 'character' ? props.characterId : '',
      label: label(),
      script: script(),
      color: color(),
      icon: icon(),
      language: 'lua',
      autoExecute: autoExecute(),
      orderIndex: orderIndex(),
    };

    if (props.qr) {
      bus.send({ type: 'quickreply.update', id: props.qr.id, patch: data });
    } else {
      bus.send({ type: 'quickreply.create', data });
    }
    close();
  };

  const deleteQr = () => {
    if (props.qr) {
      bus.send({ type: 'quickreply.delete', id: props.qr.id });
    }
    close();
  };

  return (
    <Portal mount={document.body}>
      <div class="modal-overlay" onClick={(e) => e.target === e.currentTarget && close()}>
        <div class="modal-content qr-modal" role="dialog" aria-modal="true" aria-label={props.qr ? t('quickReply.editQuickReply') : t('quickReply.newQuickReply')} onKeyDown={(e) => trapFocus(e.currentTarget, e)}>
          <h3 class="modal-title">{props.qr ? t('quickReply.editQuickReply') : t('quickReply.newQuickReply')}</h3>

          <div class="form-row">
            <label class="field-label" for="qr-label">{t('quickReply.label')}</label>
            <input id="qr-label" class="input" type="text" value={label()} onInput={(e) => setLabel(e.currentTarget.value)} />
          </div>

          <div class="form-row">
            <label class="field-label" for="qr-icon">{t('quickReply.iconEmoji')}</label>
            <input id="qr-icon" class="input" type="text" value={icon()} onInput={(e) => setIcon(e.currentTarget.value)} />
          </div>

          <div class="form-row">
            <label class="field-label" for="qr-color">{t('quickReply.color')}</label>
            <input id="qr-color" class="input" type="color" value={color() || '#4f46e5'} onInput={(e) => setColor(e.currentTarget.value)} />
          </div>

          <Show when={!props.qr}>
            <div class="form-row">
              <label class="field-label" for="qr-scope">{t('quickReply.scope')}</label>
              <select id="qr-scope" class="select"
                value={scope()}
                onChange={(e) => setScope(e.currentTarget.value as 'global' | 'character' | 'chat')}
              >
                <option class="select-option" value="global">{t('quickReply.scopeGlobal')}</option>
                <Show when={props.characterId}>
                  <option class="select-option" value="character">{t('quickReply.scopeCharacter')}</option>
                </Show>
                <Show when={props.chatId}>
                  <option class="select-option" value="chat">{t('quickReply.scopeChat')}</option>
                </Show>
              </select>
            </div>
          </Show>

          <div class="form-row">
            <label class="field-label" for="qr-script">{t('quickReply.scriptLua')}</label>
            <textarea
              id="qr-script"
              value={script()}
              onInput={(e) => setScript(e.currentTarget.value)}
              rows={10}
              class="qr-script-textarea font-mono w-full"
              placeholder="st.send('Hello')"
            />
          </div>

          <div class="form-row">
            <label class="field-label" for="qr-order">{t('quickReply.order')}</label>
            <input
              id="qr-order"
              class="input"
              type="number"
              value={orderIndex()}
              onInput={(e) => setOrderIndex(Number(e.currentTarget.value) || 0)}
            />
          </div>

          <div class="form-row">
            <span class="field-label">{t('quickReply.autoExecute')}</span>
            <div class="qr-auto-execute-grid">
              <label class="qr-checkbox">
                <input
                  class="qr-checkbox-input"
                  type="checkbox"
                  checked={Boolean(autoExecute() & QuickReplyAutoExecute.STARTUP)}
                  onChange={() => toggleAutoExecute(QuickReplyAutoExecute.STARTUP)}
                />
                {t('quickReply.autoExecuteStartup')}
              </label>
              <label class="qr-checkbox">
                <input
                  class="qr-checkbox-input"
                  type="checkbox"
                  checked={Boolean(autoExecute() & QuickReplyAutoExecute.USER_MESSAGE)}
                  onChange={() => toggleAutoExecute(QuickReplyAutoExecute.USER_MESSAGE)}
                />
                {t('quickReply.autoExecuteUserMessage')}
              </label>
              <label class="qr-checkbox">
                <input
                  class="qr-checkbox-input"
                  type="checkbox"
                  checked={Boolean(autoExecute() & QuickReplyAutoExecute.AI_MESSAGE)}
                  onChange={() => toggleAutoExecute(QuickReplyAutoExecute.AI_MESSAGE)}
                />
                {t('quickReply.autoExecuteAiMessage')}
              </label>
              <label class="qr-checkbox">
                <input
                  class="qr-checkbox-input"
                  type="checkbox"
                  checked={Boolean(autoExecute() & QuickReplyAutoExecute.CHAT_CHANGE)}
                  onChange={() => toggleAutoExecute(QuickReplyAutoExecute.CHAT_CHANGE)}
                />
                {t('quickReply.autoExecuteChatChange')}
              </label>
              <label class="qr-checkbox">
                <input
                  class="qr-checkbox-input"
                  type="checkbox"
                  checked={Boolean(autoExecute() & QuickReplyAutoExecute.NEW_CHAT)}
                  onChange={() => toggleAutoExecute(QuickReplyAutoExecute.NEW_CHAT)}
                />
                {t('quickReply.autoExecuteNewChat')}
              </label>
              <label class="qr-checkbox">
                <input
                  class="qr-checkbox-input"
                  type="checkbox"
                  checked={Boolean(autoExecute() & QuickReplyAutoExecute.BEFORE_GENERATION)}
                  onChange={() => toggleAutoExecute(QuickReplyAutoExecute.BEFORE_GENERATION)}
                />
                {t('quickReply.autoExecuteBeforeGeneration')}
              </label>
            </div>
          </div>

          <div class="qr-actions">
            <button class="btn btn-primary" onClick={save}>{t('common.save')}</button>
            <button class="btn btn-ghost" onClick={close}>{t('common.cancel')}</button>
            <Show when={props.qr}>
              <button class="btn btn-danger" onClick={deleteQr}>
                {t('common.delete')}
              </button>
            </Show>
          </div>
        </div>
      </div>
    </Portal>
  );
}
