import { createSignal } from 'solid-js';

/**
 * Local UI state — not synced with the server.
 * These values are per-tab and ephemeral.
 */

/** Which chat the user is currently looking at. */
export const [activeChatId, setActiveChatId] = createSignal<string | null>(null);

/** Which chat is currently loading older messages (loading spinner). */
export const [loadingOlderChatId, setLoadingOlderChatId] = createSignal<string | null>(null);

/** ID of the chat that should be auto-selected after creation. */
export const [pendingChatId, setPendingChatId] = createSignal<string | null>(null);

/** Which character is being viewed/edited. */
export const [activeCharacterId, setActiveCharacterId] = createSignal<string | null>(null);

/** Which persona is being viewed/edited. */
export const [activePersonaId, setActivePersonaId] = createSignal<string | null>(null);

/** Which world info book is being viewed/edited. */
export const [activeWorldInfoId, setActiveWorldInfoId] = createSignal<string | null>(null);

/** Which backend config is currently selected for editing. */
export const [activeBackendConfigId, setActiveBackendConfigId] = createSignal<string | null>(null);

/** Which prompt list is currently selected for editing. */
export const [activePromptListId, setActivePromptListId] = createSignal<string | null>(null);

/** Current in-chat message search query. */
export const [chatSearchQuery, setChatSearchQuery] = createSignal('');

/** Which character is selected in the sidebar to filter chats. */
export const [selectedCharacterId, setSelectedCharacterId] = createSignal<string | null>(null);

/** Whether the scene stage panel above the chat is collapsed. */
export const [sceneStageCollapsed, setSceneStageCollapsed] = createSignal(false);
