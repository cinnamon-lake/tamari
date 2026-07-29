/**
 * PromptList service — orchestrates prompt list lifecycle with cascading side effects.
 */

import type { IPromptListRepository } from '../repos/PromptListRepository.js';
import type { ISettingsRepository } from '../repos/SettingsRepository.js';
import { NotFoundError } from '../errors.js';

export type DeletePromptListResult =
  | {
      success: true;
      fallbackPromptListId: string | null;
    }
  | {
      success: false;
      error: { message: string; code: string };
      fallbackPromptListId: string | null;
    };

export class PromptListService {
  constructor(
    private promptLists: IPromptListRepository,
    private settings: ISettingsRepository,
  ) {}

  async deletePromptList(promptListId: string): Promise<DeletePromptListResult> {
    const count = await this.promptLists.count();
    if (count <= 1) {
      return {
        success: false,
        error: { message: 'Cannot delete the last prompt list', code: 'LAST_PROMPT_LIST' },
        fallbackPromptListId: null,
      };
    }

    const activePromptListId = await this.settings.get('activePromptListId');
    let fallbackPromptListId: string | null = null;

    if (activePromptListId === promptListId) {
      const remaining = await this.promptLists.listSummaries();
      const fallback = remaining.find((p) => p.id !== promptListId);
      if (fallback) {
        fallbackPromptListId = fallback.id;
        await this.settings.setValue('activePromptListId', fallbackPromptListId);
      }
    }

    try {
      await this.promptLists.delete(promptListId);
    } catch (err) {
      // Already gone (stale client list / racing delete) — the desired end
      // state holds, so report success rather than erroring to the user.
      if (!(err instanceof NotFoundError)) throw err;
    }

    return {
      success: true,
      fallbackPromptListId,
    };
  }
}
