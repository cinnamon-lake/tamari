export interface QuickReply {
  id: string;
  scope: 'global' | 'character' | 'chat';
  scopeId: string;
  label: string;
  icon: string;
  color: string;
  script: string;
  language: string;
  autoExecute: number;
  orderIndex: number;
  createdAt: number;
  updatedAt: number;
}

export type QuickReplyInsert = Omit<QuickReply, 'id' | 'createdAt' | 'updatedAt'>;
export type QuickReplyUpdate = Partial<Omit<QuickReply, 'id' | 'createdAt' | 'updatedAt'>>;

export const QuickReplyAutoExecute = {
  NONE: 0,
  STARTUP: 1 << 0,
  USER_MESSAGE: 1 << 1,
  AI_MESSAGE: 1 << 2,
  CHAT_CHANGE: 1 << 3,
  NEW_CHAT: 1 << 4,
  BEFORE_GENERATION: 1 << 5,
} as const;
