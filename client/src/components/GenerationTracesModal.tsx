import { Show, For, createSignal, createEffect } from 'solid-js';
import type { Generation, GenerationMeta, TraceError } from '@tamari/types';
import { state } from '../stores/serverStore.js';
import { apiFetch } from '../lib/apiFetch.js';
import { useI18n } from '../i18n/index.js';
import { trapFocus, saveFocus, restoreFocus } from '../lib/focusUtils.js';
import './GenerationTracesModal.css';

type TFunc = ReturnType<typeof useI18n>['t'];

export interface GenerationTracesModalProps {
  open: boolean;
  onClose: () => void;
}

/** Render a TraceError chain — mirrors server/src/generation/trace.ts. */
function renderTraceError(err: TraceError): string {
  const layers: string[] = [];
  let node: TraceError | undefined = err;
  let innermost: TraceError = err;
  while (node) {
    layers.push(node.layer);
    innermost = node;
    node = node.cause;
  }
  return `${layers.join(' → ')}: ${innermost.code}: ${innermost.message}`;
}

function relativeTime(createdAt: number, t: TFunc): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - createdAt));
  if (seconds < 60) return t('generationTraces.timeJustNow');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('generationTraces.timeMinutesAgo', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('generationTraces.timeHoursAgo', { count: hours });
  return t('generationTraces.timeDaysAgo', { count: Math.floor(hours / 24) });
}

const STATUS_ICON: Record<Generation['status'], string> = {
  complete: 'bi-check-circle-fill',
  error: 'bi-x-circle-fill',
  aborted: 'bi-slash-circle',
  pending: 'bi-clock',
  streaming: 'bi-broadcast',
};

function kindLabel(kind: Generation['kind'], t: TFunc): string {
  switch (kind) {
    case 'send': return t('generationTraces.kindSend');
    case 'regenerate': return t('generationTraces.kindRegenerate');
    case 'continue': return t('generationTraces.kindContinue');
    case 'impersonate': return t('generationTraces.kindImpersonate');
    case 'quiet': return t('generationTraces.kindQuiet');
    case 'genraw': return t('generationTraces.kindGenraw');
    case 'subagent': return t('generationTraces.kindSubagent');
  }
}

function statusLabel(status: Generation['status'], t: TFunc): string {
  switch (status) {
    case 'complete': return t('generationTraces.statusComplete');
    case 'error': return t('generationTraces.statusError');
    case 'aborted': return t('generationTraces.statusAborted');
    case 'pending': return t('generationTraces.statusPending');
    case 'streaming': return t('generationTraces.statusStreaming');
  }
}

export function GenerationTracesModal(props: GenerationTracesModalProps) {
  const { t } = useI18n();
  const [rows, setRows] = createSignal<Generation[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [loadError, setLoadError] = createSignal(false);

  createEffect(() => {
    if (!props.open) return;
    saveFocus();
    const chatId = state.activeChat?.id;
    if (!chatId) return;
    setLoading(true);
    setLoadError(false);
    void apiFetch(`/api/chats/${chatId}/generations`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { items: Generation[] };
        setRows(body.items);
      })
      .catch(() => {
        setRows([]);
        setLoadError(true);
      })
      .finally(() => setLoading(false));
  });

  const close = () => {
    restoreFocus();
    props.onClose();
  };

  /** Roots in server order (newest first); children nested under their parent. */
  const tree = () => {
    const children = new Map<string, Generation[]>();
    const roots: Generation[] = [];
    const ids = new Set(rows().map((r) => r.id));
    for (const row of rows()) {
      if (row.parentId && ids.has(row.parentId)) {
        const list = children.get(row.parentId) ?? [];
        list.push(row);
        children.set(row.parentId, list);
      } else {
        roots.push(row);
      }
    }
    return { roots, children };
  };

  const rounds = (meta?: GenerationMeta | null) => {
    if (meta?.rounds === undefined) return null;
    return meta.rounds === 1
      ? t('generationTraces.roundsOne')
      : t('generationTraces.rounds', { count: meta.rounds });
  };

  const toolNames = (meta?: GenerationMeta | null) => {
    const names = meta?.toolCalls?.map((c) => (c.isError ? `${c.name}!` : c.name)) ?? [];
    return names.length > 0 ? t('generationTraces.toolCalls', { names: names.join(', ') }) : null;
  };

  const traceText = (row: Generation): string | null => {
    if (row.meta?.traceError) return renderTraceError(row.meta.traceError);
    return row.errorMessage;
  };

  return (
    <Show when={props.open}>
      <div class="modal-overlay" onClick={(e) => e.target === e.currentTarget && close()}>
        <div class="modal settings-modal generation-traces-modal" role="dialog" aria-modal="true" aria-labelledby="generation-traces-title" onKeyDown={(e) => trapFocus(e.currentTarget, e)}>
          <h2 class="generation-traces-title" id="generation-traces-title">
            <i class="bi bi-diagram-3" /> {t('generationTraces.title')}
          </h2>

          <div class="generation-traces-body">
            <Show when={loading()}>
              <p class="generation-traces-note">{t('generationTraces.loading')}</p>
            </Show>
            <Show when={!loading() && loadError()}>
              <p class="generation-traces-note generation-traces-error">{t('generationTraces.loadError')}</p>
            </Show>
            <Show when={!loading() && !loadError() && rows().length === 0}>
              <p class="generation-traces-note">{t('generationTraces.empty')}</p>
            </Show>

            <Show when={!loading() && !loadError() && rows().length > 0}>
              <ul class="generation-traces-list">
                <For each={tree().roots}>
                  {(row) => (
                    <TraceRow row={row} children={tree().children.get(row.id) ?? []} rounds={rounds} toolNames={toolNames} traceText={traceText} />
                  )}
                </For>
              </ul>
            </Show>
          </div>

          <div class="modal-actions">
            <button class="generation-traces-close-btn" type="button" onClick={close}>
              {t('common.close')}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}

function TraceRow(props: {
  row: Generation;
  children: Generation[];
  rounds: (meta?: GenerationMeta | null) => string | null;
  toolNames: (meta?: GenerationMeta | null) => string | null;
  traceText: (row: Generation) => string | null;
}) {
  const chain = () => props.traceText(props.row);
  const hasPrompt = () => props.row.meta?.prompt !== undefined;

  return (
    <li class="generation-trace-row">
      <TraceLine row={props.row} nested={false} rounds={props.rounds} toolNames={props.toolNames} chain={chain()} hasPrompt={hasPrompt()} />
      <For each={props.children}>
        {(child) => (
          <div class="generation-trace-child">
            <span class="generation-trace-child-marker" aria-hidden="true">↳</span>
            <TraceLine row={child} nested rounds={props.rounds} toolNames={props.toolNames} chain={props.traceText(child)} hasPrompt={child.meta?.prompt !== undefined} />
          </div>
        )}
      </For>
    </li>
  );
}

function TraceLine(props: {
  row: Generation;
  nested: boolean;
  rounds: (meta?: GenerationMeta | null) => string | null;
  toolNames: (meta?: GenerationMeta | null) => string | null;
  chain: string | null;
  hasPrompt: boolean;
}) {
  const { t } = useI18n();

  return (
    <div class={`generation-trace-line ${props.nested ? 'nested' : ''} status-${props.row.status}`}>
      <div class="generation-trace-head">
        <i class={`generation-trace-status bi ${STATUS_ICON[props.row.status]}`} title={statusLabel(props.row.status, t)} aria-label={statusLabel(props.row.status, t)} />
        <span class="generation-trace-kind">{kindLabel(props.row.kind, t)}</span>
        <span class="generation-trace-backend">{props.row.backend}</span>
        <span class="generation-trace-time">{relativeTime(props.row.createdAt, t)}</span>
      </div>
      <div class="generation-trace-meta">
        <Show when={props.rounds(props.row.meta)}>
          <span class="generation-trace-rounds">{props.rounds(props.row.meta)}</span>
        </Show>
        <Show when={props.toolNames(props.row.meta)}>
          <span class="generation-trace-tools">{props.toolNames(props.row.meta)}</span>
        </Show>
        <Show when={props.row.promptTokens !== null || props.row.completionTokens !== null}>
          <span class="generation-trace-tokens">
            {t('generationTraces.tokens', { prompt: props.row.promptTokens ?? 0, completion: props.row.completionTokens ?? 0 })}
          </span>
        </Show>
      </div>
      <Show when={props.chain !== null}>
        <details class="generation-trace-expand generation-trace-chain">
          <summary class="generation-trace-expand-summary">{t('generationTraces.errorChain')}</summary>
          <pre class="generation-trace-pre">{props.chain}</pre>
        </details>
      </Show>
      <Show when={props.hasPrompt}>
        <details class="generation-trace-expand generation-trace-prompt">
          <summary class="generation-trace-expand-summary">{t('generationTraces.promptSnapshot')}</summary>
          <ul class="generation-trace-prompt-messages">
            <For each={props.row.meta!.prompt!.messages}>
              {(msg) => (
                <li class="generation-trace-prompt-message">
                  <span class="generation-trace-prompt-role">{msg.role}</span>
                  <pre class="generation-trace-pre">{typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)}</pre>
                </li>
              )}
            </For>
          </ul>
        </details>
      </Show>
    </div>
  );
}
