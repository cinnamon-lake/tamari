/**
 * Unpacked card loader — scans and watches `<dataDir>/unpacked-cards/` and
 * keeps thin handle rows (id + name) in `characters` in sync with the folders
 * on disk, so FKs from chats/messages/chat_members keep working while card
 * content is read through from disk (see overlay.ts + the ReadThrough*
 * repository wrappers).
 *
 * Owns the INNER repositories: handle-row writes and delete-time cleanup must
 * bypass the write-rejecting wrappers. Everything else in the server gets the
 * wrappers (wired in main.ts).
 *
 * Feature-gated on the `unpackedCards.enabled` setting: when false, start() is
 * a no-op — no scan, no watcher. The gate is applied at start() only; there is
 * no server-side settings-changed hook (settings.changed is a client-bound bus
 * broadcast, CachedSettings has no listener API), so flipping the setting at
 * runtime takes effect on the next restart.
 */

import { watch, type FSWatcher } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Character } from '@tamari/types';
import type { EventBus } from '../../bus/EventBus.js';
import type { ICharacterRepository } from '../../repos/CharacterRepository.js';
import type { ICharacterAssetRepository } from '../../repos/CharacterAssetRepository.js';
import type { IQuickReplyRepository } from '../../repos/QuickReplyRepository.js';
import type { ISettingsRepository } from '../../repos/SettingsRepository.js';
import { getLogger } from '../../lib/logger.js';
import { toCharacterSummary, withCharacterAssets, withCharacterAvatar } from '../../lib/summaries.js';
import { setCharacterAvatarFromBuffer } from '../characterAvatar.js';
import { broadcastQuickReplyList } from '../quickReplyBroadcast.js';
import type { FileStorage } from '../FileStorage.js';
import type { RAGService } from '../RAGService.js';
import { parseCardFolder, type ParsedCard } from './cardFolderParser.js';
import { overlayCharacter, overlayCharacterSummary } from './overlay.js';
import { isUnpackedCardId, unpackedCardId, unpackedWorldInfoId } from './unpackedIds.js';

const log = getLogger('unpacked-cards');

export const UNPACKED_CARDS_DIRNAME = 'unpacked-cards';
const WATCH_DEBOUNCE_MS = 300;
const WATCH_RETRY_BASE_MS = 1000;
const WATCH_RETRY_MAX_MS = 30_000;

/** Public registry record: the last good parse of a folder plus where it lives. */
export interface UnpackedCardEntry {
  parsed: ParsedCard;
  /** Absolute folder path. */
  dir: string;
}

/** The slice of the service the read-through wrappers depend on. */
export interface UnpackedCardRegistry {
  get(cardId: string): UnpackedCardEntry | undefined;
  has(cardId: string): boolean;
  /** Known card ids (registry keys). */
  list(): string[];
}

export interface UnpackedCardServiceDeps {
  /** INNER character repo — the read-through wrapper would reject these writes. */
  characters: ICharacterRepository;
  characterAssets: ICharacterAssetRepository;
  quickReplies: IQuickReplyRepository;
  storage: FileStorage;
  bus: EventBus;
  settings: ISettingsRepository;
  dataDir: string;
  ragService?: Pick<RAGService, 'indexWorldInfoEntries' | 'deleteWorldInfoIndex'>;
  /** Avatar pipeline override (tests); defaults to setCharacterAvatarFromBuffer over the inner repos. */
  setAvatar?: (character: Character, buffer: Buffer) => Promise<unknown>;
  /** Set false to skip the fs watcher (tests drive scans directly). */
  watch?: boolean;
}

interface RegistryState {
  /** Last good parse; `errors` reflects the latest parse attempt. */
  parsed: ParsedCard;
  dir: string;
  /** mtime of the avatar.png we last pushed through the avatar pipeline. */
  avatarMtimeMs: number | null;
  lorebookSignature: string;
  /** Content signature of the last broadcast, to suppress redundant ones. */
  signature: string;
}

function contentSignature(parsed: ParsedCard): string {
  return JSON.stringify([
    parsed.name,
    parsed.textFields,
    parsed.tags,
    parsed.alternateGreetings,
    parsed.regexRules,
    parsed.backendLogic ?? null,
    parsed.errors,
  ]);
}

export class UnpackedCardService implements UnpackedCardRegistry {
  private registry = new Map<string, RegistryState>();
  private watcher: FSWatcher | null = null;
  private watcherRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private watcherRetryDelayMs = WATCH_RETRY_BASE_MS;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Serializes all scan work so watcher events and explicit rescans can't interleave. */
  private chain: Promise<void> = Promise.resolve();

  constructor(private deps: UnpackedCardServiceDeps) {}

  get rootDir(): string {
    return path.join(this.deps.dataDir, UNPACKED_CARDS_DIRNAME);
  }

  get(cardId: string): UnpackedCardEntry | undefined {
    const state = this.registry.get(cardId);
    return state ? { parsed: state.parsed, dir: state.dir } : undefined;
  }

  has(cardId: string): boolean {
    return this.registry.has(cardId);
  }

  list(): string[] {
    return [...this.registry.keys()];
  }

  /** Apply the settings gate; when enabled, create the dir, scan once, and start watching. */
  async start(): Promise<void> {
    const enabled = (await this.deps.settings.getTyped())['unpackedCards.enabled'];
    if (!enabled) {
      log.info('unpacked cards disabled (unpackedCards.enabled=false)');
      return;
    }
    await fs.mkdir(this.rootDir, { recursive: true });
    await this.scanAll();
    if (this.deps.watch !== false) this.startWatcher();
    log.info({ dir: this.rootDir, cards: this.registry.size }, 'unpacked cards loaded');
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.watcherRetryTimer) {
      clearTimeout(this.watcherRetryTimer);
      this.watcherRetryTimer = null;
    }
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
  }

  /** Rescan every folder; reconcile removals and orphan handle rows. */
  async scanAll(): Promise<void> {
    return this.enqueue(async () => {
      await fs.mkdir(this.rootDir, { recursive: true });
      const dirs: string[] = [];
      for (const name of (await fs.readdir(this.rootDir)).sort()) {
        const dir = path.join(this.rootDir, name);
        try {
          if ((await fs.stat(dir)).isDirectory()) dirs.push(dir);
        } catch {
          // Raced away between readdir and stat — treated as removed below.
        }
      }
      const live = new Set(dirs);
      for (const dir of dirs) await this.syncFolder(dir);

      // Folders removed while we were offline (or between scans).
      for (const [cardId, state] of [...this.registry]) {
        if (!live.has(state.dir)) await this.removeFolder(cardId);
      }
      // Orphan handle rows: unpacked/-prefixed rows with no live folder.
      const rows = await this.deps.characters.list();
      for (const row of rows.items) {
        if (isUnpackedCardId(row.id) && !this.registry.has(row.id)) {
          await this.removeFolder(row.id);
        }
      }
    });
  }

  /** Rescan one folder (watcher + tests). */
  async scanFolder(dir: string): Promise<void> {
    return this.enqueue(() => this.syncFolder(dir));
  }

  // ---------- Internals (always called inside the serialized chain) ----------

  private enqueue(job: () => Promise<void>): Promise<void> {
    const run = this.chain.then(job, job);
    // Keep the chain alive after a failure; the caller still sees the rejection.
    this.chain = run.catch(() => {});
    return run;
  }

  private findByDir(dir: string): { cardId: string; state: RegistryState } | undefined {
    for (const [cardId, state] of this.registry) {
      if (state.dir === dir) return { cardId, state };
    }
    return undefined;
  }

  private async syncFolder(dir: string): Promise<void> {
    const parsed = await parseCardFolder(dir);
    const cardId = unpackedCardId(parsed.id);

    // Fatal parse (missing/invalid meta.json, no name): keep the last good
    // version if we have one, with the fresh errors attached for the overlay.
    if (parsed.name.length === 0) {
      const prev = this.registry.get(cardId) ?? this.findByDir(dir)?.state;
      if (prev) {
        prev.parsed = { ...prev.parsed, errors: parsed.errors };
        log.warn({ dir, errors: parsed.errors }, 'unpacked card: meta.json invalid — keeping last good parse');
      } else {
        log.warn({ dir, errors: parsed.errors }, 'unpacked card: skipping folder (invalid meta.json)');
      }
      return;
    }

    // Duplicate meta.id across folders: the first folder loaded (incumbent)
    // wins; the newcomer is ignored entirely. The error rides on the
    // incumbent's parsed.errors so it surfaces via extensions.unpackedErrors
    // and the content signature (one broadcast, no registry flapping).
    const incumbent = this.registry.get(cardId);
    if (incumbent && incumbent.dir !== dir) {
      const message = `duplicate meta.id "${parsed.id}": also used by ${incumbent.dir} — this folder (${dir}) is ignored`;
      if (!incumbent.parsed.errors.includes(message)) {
        incumbent.parsed = { ...incumbent.parsed, errors: [...incumbent.parsed.errors, message] };
      }
      const signature = contentSignature(incumbent.parsed);
      if (signature !== incumbent.signature) {
        incumbent.signature = signature;
        await this.broadcastSnapshot(cardId, incumbent.parsed);
        await this.broadcastList();
      }
      log.warn({ dir, incumbentDir: incumbent.dir, cardId }, 'unpacked card: duplicate meta.id — keeping the first folder');
      return;
    }

    // Slug changed (meta.id edit): the old card id is a removal.
    const byDir = this.findByDir(dir);
    if (byDir && byDir.cardId !== cardId) await this.removeFolder(byDir.cardId);

    const signature = contentSignature(parsed);
    const state: RegistryState =
      this.registry.get(cardId) ?? { parsed, dir, avatarMtimeMs: null, lorebookSignature: '', signature: '' };
    state.parsed = parsed;
    state.dir = dir;
    this.registry.set(cardId, state);

    // Upsert the thin handle row (id + name + tags) via the INNER repo. Collision
    // with a pre-existing row of the same id is accepted — the `unpacked/`
    // prefix namespaces handle rows away from real (uuid) character ids. Tags
    // must live on the row too: SQL tag filtering (CharacterRepository.list)
    // runs before the read-through overlay.
    const existing = await this.deps.characters.getById(cardId);
    if (!existing) {
      await this.deps.characters.create(cardId, { name: parsed.name, tags: parsed.tags });
    } else if (existing.name !== parsed.name || JSON.stringify(existing.tags) !== JSON.stringify(parsed.tags)) {
      await this.deps.characters.update(cardId, { name: parsed.name, tags: parsed.tags });
    }

    await this.syncAvatar(cardId, parsed, state);

    // Keep the semantic-search index in sync for changed lorebooks (same as
    // the dispatcher/workbench paths do for DB-backed books).
    const lorebookSignature = JSON.stringify(parsed.lorebookEntries);
    if (lorebookSignature !== state.lorebookSignature) {
      state.lorebookSignature = lorebookSignature;
      if (this.deps.ragService && parsed.lorebookEntries.length > 0) {
        this.deps.ragService
          .indexWorldInfoEntries(unpackedWorldInfoId(cardId), parsed.lorebookEntries)
          .catch((err) => log.warn({ err, cardId }, 'rag index failed'));
      }
    }

    if (signature !== state.signature) {
      state.signature = signature;
      await this.broadcastSnapshot(cardId, parsed);
      await this.broadcastList();
    }
  }

  private async syncAvatar(cardId: string, parsed: ParsedCard, state: RegistryState): Promise<void> {
    let mtimeMs: number | null = null;
    if (parsed.avatarFile !== undefined) {
      try {
        mtimeMs = (await fs.stat(parsed.avatarFile)).mtimeMs;
      } catch {
        // Vanished between parse and sync — treated as removed below.
      }
    }
    const avatarFile = mtimeMs === null ? undefined : parsed.avatarFile;
    if (avatarFile === undefined || mtimeMs === null) {
      // avatar.png removed from the folder: clear the synced avatar files too.
      const character = await this.deps.characters.getById(cardId);
      if (!character?.avatarPath) return;
      this.deps.storage.delete(character.avatarPath);
      if (character.avatarThumbnailPath) this.deps.storage.delete(character.avatarThumbnailPath);
      await this.deps.characters.update(cardId, { avatarPath: null, avatarThumbnailPath: null });
      state.avatarMtimeMs = null;
      return;
    }
    if (state.avatarMtimeMs === mtimeMs) return;
    const character = await this.deps.characters.getById(cardId);
    if (!character) return;
    try {
      const buffer = await fs.readFile(avatarFile);
      const setAvatar =
        this.deps.setAvatar ??
        ((char: Character, buf: Buffer) =>
          setCharacterAvatarFromBuffer(
            {
              characters: this.deps.characters,
              characterAssets: this.deps.characterAssets,
              storage: this.deps.storage,
              bus: this.deps.bus,
            },
            char,
            buf,
          ));
      await setAvatar(character, buffer);
      state.avatarMtimeMs = mtimeMs;
    } catch (err) {
      log.warn({ err, cardId }, 'unpacked card: avatar sync failed');
    }
  }

  /** Folder removed (runtime or between runs): delete the handle row + cleanup. */
  private async removeFolder(cardId: string): Promise<void> {
    this.registry.delete(cardId);
    await this.deleteHandleRow(cardId);
    void this.deps.ragService
      ?.deleteWorldInfoIndex(unpackedWorldInfoId(cardId))
      .catch((err) => log.warn({ err, cardId }, 'rag index delete failed'));
    this.deps.bus.broadcast({ type: 'character.deleted', characterId: cardId });
    await this.broadcastList();
    // Character-scoped quick replies went with the row — converge QR lists (§5).
    await broadcastQuickReplyList(this.deps.bus, this.deps.quickReplies);
  }

  /** Same cleanup as the character.delete WS handler (dispatch/characterHandlers.ts). */
  private async deleteHandleRow(cardId: string): Promise<void> {
    const { characters, characterAssets, quickReplies, storage } = this.deps;
    const char = await characters.getById(cardId);
    if (!char) return;
    if (char.avatarPath) storage.delete(char.avatarPath);
    const assetList = await characterAssets.listForCharacter(cardId);
    for (const asset of assetList) {
      if (asset.filePath) storage.delete(asset.filePath);
    }
    await quickReplies.deleteByScope('character', cardId);
    await characters.delete(cardId);
    if (char.avatarThumbnailPath) storage.delete(char.avatarThumbnailPath);
  }

  /** character.listed, overlaid — mirrors broadcastCharacterList (characterMutations.ts). */
  private async broadcastList(): Promise<void> {
    const list = await this.deps.characters.listSummaries();
    this.deps.bus.broadcast({
      type: 'character.listed',
      characters: list.items.map((item) => {
        const entry = this.get(item.id);
        return toCharacterSummary(entry ? overlayCharacterSummary(item, entry.parsed) : item);
      }),
    });
  }

  /** character.snapshot for one card — mirrors the character.select handler. */
  private async broadcastSnapshot(cardId: string, parsed: ParsedCard): Promise<void> {
    const row = await this.deps.characters.getById(cardId);
    if (!row) return;
    const enriched = withCharacterAssets(
      withCharacterAvatar(overlayCharacter(row, parsed)),
      await this.deps.characterAssets.listForCharacter(cardId),
    );
    this.deps.bus.broadcast({ type: 'character.snapshot', character: enriched });
  }

  // ---------- Watcher ----------

  private startWatcher(): void {
    try {
      // Recursive watch is supported on Linux since Node 19.1 (engines: >=24).
      this.watcher = watch(this.rootDir, { recursive: true }, (_event, filename) => this.onWatchEvent(filename));
      this.watcherRetryDelayMs = WATCH_RETRY_BASE_MS;
      this.watcher.on('error', (err) => {
        // A dead watcher never recovers on its own — retry with capped
        // exponential backoff instead of silently losing live-reload.
        log.warn({ err, retryInMs: this.watcherRetryDelayMs }, 'unpacked-cards watcher error — will retry');
        this.watcher?.close();
        this.watcher = null;
        this.scheduleWatcherRetry();
      });
    } catch (err) {
      log.warn({ err }, 'fs.watch unavailable — unpacked cards will not live-reload');
    }
  }

  private scheduleWatcherRetry(): void {
    if (this.watcherRetryTimer) return;
    const delay = this.watcherRetryDelayMs;
    this.watcherRetryDelayMs = Math.min(delay * 2, WATCH_RETRY_MAX_MS);
    this.watcherRetryTimer = setTimeout(() => {
      this.watcherRetryTimer = null;
      this.startWatcher();
    }, delay);
  }

  private onWatchEvent(filename: string | null): void {
    const folder = filename !== null && filename.length > 0 ? filename.split(path.sep)[0] : null;
    const key = folder ?? '*';
    const existing = this.debounceTimers.get(key);
    if (existing) clearTimeout(existing);
    this.debounceTimers.set(
      key,
      setTimeout(() => {
        this.debounceTimers.delete(key);
        this.rescan(key).catch((err) => log.warn({ err, folder: key }, 'unpacked-cards rescan failed'));
      }, WATCH_DEBOUNCE_MS),
    );
  }

  private async rescan(folder: string): Promise<void> {
    if (folder === '*') return this.scanAll();
    const dir = path.join(this.rootDir, folder);
    try {
      if ((await fs.stat(dir)).isDirectory()) return this.scanFolder(dir);
    } catch {
      // Folder is gone — fall through to removal.
    }
    return this.enqueue(async () => {
      for (const [cardId, state] of [...this.registry]) {
        if (state.dir === dir) await this.removeFolder(cardId);
      }
      // A folder that never parsed successfully has no registry entry but may
      // still have a handle row from an earlier run (folder named == slug).
      const cardId = unpackedCardId(folder);
      if (await this.deps.characters.getById(cardId)) await this.removeFolder(cardId);
    });
  }
}
