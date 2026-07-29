import { createResource, Show, For } from 'solid-js';
import { apiFetch } from '../lib/apiFetch.js';
import { useI18n } from '../i18n/index.js';
import { trapFocus, saveFocus, restoreFocus } from '../lib/focusUtils.js';
import './StatsModal.css';

interface GlobalStats {
  totalCharacters: number;
  totalChats: number;
  totalMessages: number;
  totalGenerations: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  chats: Array<{ chatId: string; chatName: string; messageCount: number; lastActivity: number | null }>;
  characters: Array<{ characterId: string; characterName: string; chatCount: number; totalMessages: number }>;
}

export function StatsModal(props: { onClose: () => void }) {
  const { t } = useI18n();
  saveFocus();

  const close = () => {
    restoreFocus();
    props.onClose();
  };

  const [stats] = createResource(async () => {
    const res = await apiFetch('/api/stats');
    if (!res.ok) throw new Error('Failed to load stats');
    return res.json() as Promise<GlobalStats>;
  });

  const formatDate = (ts: number | null) => {
    if (!ts) return t('stats.never');
    return new Date(ts * 1000).toLocaleDateString();
  };

  return (
    <div class="modal-overlay" onClick={close}>
      <div class="modal stats-modal" role="dialog" aria-modal="true" aria-label={t('stats.ariaLabel')} onKeyDown={(e) => trapFocus(e.currentTarget, e)} onClick={(e) => e.stopPropagation()}>
        <h2 class="modal-title">
          <i class="bi bi-bar-chart" /> {t('stats.title')}
        </h2>

        <Show when={stats.loading}>
          <p class="loading-text">{t('common.loading')}</p>
        </Show>

        <Show when={Boolean(stats.error)}>
          <p class="error">{t('stats.failedToLoad')}</p>
        </Show>

        <Show when={stats()}>
          {(s) => (
            <>
              <div class="stats-grid">
                <div class="stat-card">
                  <span class="stat-value">{s().totalCharacters}</span>
                  <span class="stat-label">{t('stats.characters')}</span>
                </div>
                <div class="stat-card">
                  <span class="stat-value">{s().totalChats}</span>
                  <span class="stat-label">{t('stats.chats')}</span>
                </div>
                <div class="stat-card">
                  <span class="stat-value">{s().totalMessages}</span>
                  <span class="stat-label">{t('stats.messages')}</span>
                </div>
                <div class="stat-card">
                  <span class="stat-value">{s().totalGenerations}</span>
                  <span class="stat-label">{t('stats.generations')}</span>
                </div>
                <div class="stat-card">
                  <span class="stat-value">{s().totalPromptTokens.toLocaleString()}</span>
                  <span class="stat-label">{t('stats.promptTokens')}</span>
                </div>
                <div class="stat-card">
                  <span class="stat-value">{s().totalCompletionTokens.toLocaleString()}</span>
                  <span class="stat-label">{t('stats.completionTokens')}</span>
                </div>
              </div>

              <h3 class="section-heading">{t('stats.characters')}</h3>
              <div class="stats-table-wrapper" tabindex="0">
                <table class="stats-table">
                  <thead class="table-head">
                    <tr class="table-row">
                      <th class="table-header-cell">{t('common.name')}</th>
                      <th class="table-header-cell">{t('stats.chats')}</th>
                      <th class="table-header-cell">{t('stats.messages')}</th>
                    </tr>
                  </thead>
                  <tbody class="table-body">
                    <For each={s().characters}>
                      {(char) => (
                        <tr id={char.characterId} class="table-row">
                          <td class="table-cell">{char.characterName}</td>
                          <td class="table-cell">{char.chatCount}</td>
                          <td class="table-cell">{char.totalMessages}</td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>

              <h3 class="section-heading">{t('stats.chats')}</h3>
              <div class="stats-table-wrapper" tabindex="0">
                <table class="stats-table">
                  <thead class="table-head">
                    <tr class="table-row">
                      <th class="table-header-cell">{t('common.name')}</th>
                      <th class="table-header-cell">{t('stats.messages')}</th>
                      <th class="table-header-cell">{t('stats.lastActive')}</th>
                    </tr>
                  </thead>
                  <tbody class="table-body">
                    <For each={s().chats}>
                      {(chat) => (
                        <tr id={chat.chatId} class="table-row">
                          <td class="table-cell">{chat.chatName}</td>
                          <td class="table-cell">{chat.messageCount}</td>
                          <td class="table-cell">{formatDate(chat.lastActivity)}</td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Show>

        <div class="modal-actions">
          <button class="btn" onClick={close}>{t('common.close')}</button>
        </div>
      </div>
    </div>
  );
}
