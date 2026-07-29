/**
 * Data Maid — SQL orphan detection + filesystem cleanup.
 *
 * Scans for dangling foreign references and orphaned files on disk,
 * then optionally cleans them up.
 */

import type { Client } from '@libsql/client';
import { str } from '../lib/coerce.js';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FileStorage } from './FileStorage.js';

export interface SqlOrphans {
  unlinkedAttachments: string[];
  danglingAttachments: string[];
  danglingGenerations: string[];
  staleGenerations: string[];
  danglingChatMembers: Array<{ chatId: string; characterId: string }>;
  chatsWithDeletedCharacters: string[];
  messagesWithDeletedParents: string[];
}

export interface FilesystemOrphans {
  orphanedAvatarFiles: string[];
  orphanedPersonaFiles: string[];
  orphanedAttachmentFiles: string[];
}

export interface DataMaidReport {
  sqlOrphans: SqlOrphans;
  filesystemOrphans: FilesystemOrphans;
  summary: {
    totalIssues: number;
    totalSqlOrphans: number;
    totalFilesystemOrphans: number;
  };
}

export class DataMaid {
  constructor(
    private client: Client,
    private storage: FileStorage,
  ) {}

  async scan(): Promise<DataMaidReport> {
    const sqlOrphans = await this.scanSqlOrphans();
    const filesystemOrphans = await this.scanFilesystemOrphans();

    const totalSqlOrphans =
      sqlOrphans.unlinkedAttachments.length +
      sqlOrphans.danglingAttachments.length +
      sqlOrphans.danglingGenerations.length +
      sqlOrphans.staleGenerations.length +
      sqlOrphans.danglingChatMembers.length +
      sqlOrphans.chatsWithDeletedCharacters.length +
      sqlOrphans.messagesWithDeletedParents.length;

    const totalFilesystemOrphans =
      filesystemOrphans.orphanedAvatarFiles.length +
      filesystemOrphans.orphanedPersonaFiles.length +
      filesystemOrphans.orphanedAttachmentFiles.length;

    return {
      sqlOrphans,
      filesystemOrphans,
      summary: {
        totalIssues: totalSqlOrphans + totalFilesystemOrphans,
        totalSqlOrphans,
        totalFilesystemOrphans,
      },
    };
  }

  async clean(report: DataMaidReport): Promise<{ deletedSql: number; deletedFiles: number }> {
    let deletedSql = 0;
    let deletedFiles = 0;

    // SQL orphans — batch by table
    const attachmentIds = [
      ...report.sqlOrphans.unlinkedAttachments,
      ...report.sqlOrphans.danglingAttachments,
    ];
    if (attachmentIds.length > 0) {
      const placeholders = attachmentIds.map(() => '?').join(',');
      await this.client.execute({
        sql: `DELETE FROM attachments WHERE id IN (${placeholders})`,
        args: attachmentIds,
      });
      deletedSql += attachmentIds.length;
    }

    const generationIds = [
      ...report.sqlOrphans.danglingGenerations,
      ...report.sqlOrphans.staleGenerations,
    ];
    if (generationIds.length > 0) {
      const placeholders = generationIds.map(() => '?').join(',');
      await this.client.execute({
        sql: `DELETE FROM generations WHERE id IN (${placeholders})`,
        args: generationIds,
      });
      deletedSql += generationIds.length;
    }

    for (const m of report.sqlOrphans.danglingChatMembers) {
      await this.client.execute({
        sql: 'DELETE FROM chat_members WHERE chat_id = ? AND character_id = ?',
        args: [m.chatId, m.characterId],
      });
      deletedSql++;
    }

    if (report.sqlOrphans.chatsWithDeletedCharacters.length > 0) {
      const ids = report.sqlOrphans.chatsWithDeletedCharacters;
      const placeholders = ids.map(() => '?').join(',');
      await this.client.execute({
        sql: `DELETE FROM chats WHERE id IN (${placeholders})`,
        args: ids,
      });
      deletedSql += ids.length;
    }

    if (report.sqlOrphans.messagesWithDeletedParents.length > 0) {
      const ids = report.sqlOrphans.messagesWithDeletedParents;
      const placeholders = ids.map(() => '?').join(',');
      await this.client.execute({
        sql: `DELETE FROM messages WHERE id IN (${placeholders})`,
        args: ids,
      });
      deletedSql += ids.length;
    }

    // Iterative leaf-first GC for messages in deleted chats (preserves soft forks)
    const gcResult = await this.gcMessages();
    deletedSql += gcResult.deleted;

    // Filesystem orphans
    for (const f of report.filesystemOrphans.orphanedAvatarFiles) {
      this.storage.delete(f);
      deletedFiles++;
    }
    for (const f of report.filesystemOrphans.orphanedPersonaFiles) {
      this.storage.delete(f);
      deletedFiles++;
    }
    for (const f of report.filesystemOrphans.orphanedAttachmentFiles) {
      this.storage.delete(f);
      deletedFiles++;
    }

    return { deletedSql, deletedFiles };
  }

  private async scanSqlOrphans(): Promise<SqlOrphans> {
    const [
      unlinkedAttachments,
      danglingAttachments,
      danglingGenerations,
      staleGenerations,
      danglingChatMembers,
      chatsWithDeletedCharacters,
      messagesWithDeletedParents,
    ] = await Promise.all([
      this.client.execute('SELECT id FROM attachments WHERE message_id IS NULL'),
      this.client.execute(
        'SELECT a.id FROM attachments a LEFT JOIN messages m ON a.message_id = m.id WHERE a.message_id IS NOT NULL AND m.id IS NULL',
      ),
      this.client.execute('SELECT g.id FROM generations g LEFT JOIN chats c ON g.chat_id = c.id WHERE c.id IS NULL'),
      this.client.execute(
        `SELECT id FROM generations WHERE status IN ('pending', 'streaming') AND updated_at < (unixepoch() - 86400)`,
      ),
      this.client.execute(
        'SELECT cm.chat_id, cm.character_id FROM chat_members cm LEFT JOIN chats c ON cm.chat_id = c.id LEFT JOIN characters ch ON cm.character_id = ch.id WHERE c.id IS NULL OR ch.id IS NULL',
      ),
      this.client.execute(
        'SELECT c.id FROM chats c LEFT JOIN characters ch ON c.character_id = ch.id WHERE c.character_id IS NOT NULL AND ch.id IS NULL',
      ),
      this.client.execute(
        'SELECT m.id FROM messages m LEFT JOIN messages p ON m.parent_id = p.id WHERE m.parent_id IS NOT NULL AND p.id IS NULL',
      ),
    ]);

    return {
      unlinkedAttachments: unlinkedAttachments.rows.map((r) => str(r.id)),
      danglingAttachments: danglingAttachments.rows.map((r) => str(r.id)),
      danglingGenerations: danglingGenerations.rows.map((r) => str(r.id)),
      staleGenerations: staleGenerations.rows.map((r) => str(r.id)),
      danglingChatMembers: danglingChatMembers.rows.map((r) => ({
        chatId: str(r.chatId),
        characterId: str(r.characterId),
      })),
      chatsWithDeletedCharacters: chatsWithDeletedCharacters.rows.map((r) => str(r.id)),
      messagesWithDeletedParents: messagesWithDeletedParents.rows.map((r) => str(r.id)),
    };
  }

  /**
   * Iterative leaf-first GC for unreachable messages.
   *
   * Reachability is bidirectional from every chat's head and active_child:
   * - Ancestors (walk up via parent_id)
   * - Descendants (walk down to children)
   *
   * Because parent_id has no ON DELETE action, we must delete leaves first
   * and repeat until the unreachable subtree is fully removed.
   */
  async gcMessages(): Promise<{ deleted: number }> {
    let totalDeleted = 0;
    while (true) {
      const rs = await this.client.execute(`
        WITH RECURSIVE
          ancestors(id) AS (
            SELECT head_message_id FROM chats WHERE head_message_id IS NOT NULL
            UNION
            SELECT active_child_id FROM chats WHERE active_child_id IS NOT NULL
            UNION ALL
            SELECT m.parent_id FROM messages m JOIN ancestors a ON m.id = a.id WHERE m.parent_id IS NOT NULL
          ),
          reachable(id) AS (
            SELECT id FROM ancestors
            UNION ALL
            SELECT m.id FROM messages m JOIN reachable r ON m.parent_id = r.id
          )
        DELETE FROM messages
        WHERE id NOT IN (SELECT id FROM reachable)
          AND id NOT IN (SELECT parent_id FROM messages WHERE parent_id IS NOT NULL)
      `);
      const deleted = Number(rs.rowsAffected);
      if (deleted === 0) break;
      totalDeleted += deleted;
    }
    return { deleted: totalDeleted };
  }

  private async scanFilesystemOrphans(): Promise<FilesystemOrphans> {
    const [orphanedAvatarFiles, orphanedPersonaFiles, orphanedAttachmentFiles] = await Promise.all([
      this.findOrphanedFiles('avatars', 'characters', ['avatar_path', 'avatar_thumbnail_path']),
      this.findOrphanedFiles('personas', 'personas', ['avatar_path', 'avatar_thumbnail_path']),
      this.findOrphanedFiles('attachments', 'attachments', ['file_path']),
    ]);

    return { orphanedAvatarFiles, orphanedPersonaFiles, orphanedAttachmentFiles };
  }

  private walkDir(dir: string): string[] {
    const results: string[] = [];
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const nested = this.walkDir(join(dir, entry.name));
        for (const f of nested) {
          results.push(join(entry.name, f));
        }
      } else {
        results.push(entry.name);
      }
    }
    return results;
  }

  private async findOrphanedFiles(subDir: string, table: string, pathColumns: string[]): Promise<string[]> {
    const dir = this.storage.resolve(`files/${subDir}`);
    if (!statSync(dir, { throwIfNoEntry: false })) return [];

    const files = this.walkDir(dir);
    if (files.length === 0) return [];

    const knownPaths = new Set<string>();
    for (const column of pathColumns) {
      const rs = await this.client.execute({
        sql: `SELECT ${column} as path FROM ${table} WHERE ${column} IS NOT NULL`,
      });
      for (const row of rs.rows) {
        knownPaths.add(str(row.path));
      }
    }

    const orphaned: string[] = [];
    for (const file of files) {
      const relPath = `files/${subDir}/${file}`;
      if (!knownPaths.has(relPath)) {
        orphaned.push(relPath);
      }
    }
    return orphaned;
  }
}
