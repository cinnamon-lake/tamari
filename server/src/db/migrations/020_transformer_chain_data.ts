/**
 * 020 — convert the removed global request-transform settings
 * (`whitespaceMode`, `reasoningAddToPrompts`) into a seeded "Default"
 * transformer chain, point every existing backend config at it, and delete
 * the old keys.
 *
 * The values are read from the RAW settings blob (mirroring 017): the current
 * AppSettingsSchema no longer declares these keys, and migration code should
 * not depend on schema catchall behavior for deleted keys.
 *
 * Chain contents:
 *   - `whitespace` with mode mapped from the old whitespaceMode enum
 *     ('essential' → 'trim'; 'full' → 'full'; anything else → 'none').
 *   - `strip-reasoning` — only when the blob actually carries
 *     `reasoningAddToPrompts` (existing installs; the old default `false`
 *     meant "strip", so enabled = value === false). Fresh installs have no
 *     such key and get no strip step at all: the new default is that full
 *     thinking blocks are always sent.
 *   `squash-system` is deliberately NOT seeded: the renderer still performs
 *   its group-local squash (groups straddling chat history never merge),
 *   which a post-render whole-array squash step would not reproduce.
 *
 * Idempotent: the seeded chain has the fixed id `default` (re-runs find it
 * and skip creation), the config link only touches rows whose
 * transformer_chain_id IS NULL, and the legacy keys are deleted only when
 * present (so a fresh install never gets a settings row materialized as a
 * side effect).
 */

import type { TransformerStep } from '@tamari/types';
import { str } from '../../lib/coerce.js';
import { getLogger } from '../../lib/logger.js';
import { TransformerChainRepository } from '../../repos/TransformerChainRepository.js';
import { SettingsRepository } from '../../repos/SettingsRepository.js';
import type { Migration } from '../runMigrations.js';

const log = getLogger('db/migrations/020_transformer_chain_data');

const DEFAULT_CHAIN_ID = 'default';

function mapWhitespaceMode(raw: unknown): 'none' | 'trim' | 'full' {
  if (raw === 'full') return 'full';
  if (raw === 'essential' || raw === 'trim') return 'trim';
  return 'none';
}

const migration: Migration = {
  async up({ db }) {
    const chains = new TransformerChainRepository(db);
    const settings = new SettingsRepository(db);

    const row = await db.execute('SELECT blob FROM settings WHERE id = 0');
    const raw = (row.rows.length > 0 ? JSON.parse(str(row.rows[0]?.blob, '{}')) : {}) as Record<string, unknown>;

    const existing = await chains.getById(DEFAULT_CHAIN_ID);
    if (!existing) {
      const steps: TransformerStep[] = [
        {
          kind: 'builtin',
          id: 'whitespace',
          enabled: true,
          params: { mode: mapWhitespaceMode(raw['whitespaceMode']) },
        },
      ];
      if ('reasoningAddToPrompts' in raw) {
        steps.push({
          kind: 'builtin',
          id: 'strip-reasoning',
          enabled: raw['reasoningAddToPrompts'] === false,
        });
      }
      await chains.create(DEFAULT_CHAIN_ID, {
        name: 'Default',
        description: 'Seeded by migration 020 from the former global whitespaceMode / reasoningAddToPrompts settings.',
        steps,
      });
      log.info('seeded Default transformer chain');
    }

    // Point every unlinked backend config at the Default chain.
    await db.execute({
      sql: 'UPDATE backend_configs SET transformer_chain_id = ? WHERE transformer_chain_id IS NULL',
      args: [DEFAULT_CHAIN_ID],
    });

    // Delete the legacy keys — only when the blob actually carries them, so a
    // fresh install (no settings row) doesn't get one materialized as a
    // side effect.
    if ('whitespaceMode' in raw || 'reasoningAddToPrompts' in raw) {
      await settings.delete('whitespaceMode');
      await settings.delete('reasoningAddToPrompts');
    }
  },
};

export default migration;
