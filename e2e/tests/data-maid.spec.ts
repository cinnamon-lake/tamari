/**
 * Data Maid REST coverage — server/src/api/maid.ts + services/DataMaid.ts
 * (+ the /health route in main.ts).
 *
 * All assertions go through page.request with the Bearer token (the e2e
 * webServer pins TAMARI_SECRET=e2e-test-secret), except the UI-driven
 * orphan setup (upload an attachment without sending the message), which
 * produces a real unlinkedAttachments orphan (POST /api/attachments creates
 * the row with message_id NULL) and, after the row is cleaned, an
 * orphanedAttachmentFiles filesystem orphan. The chatsWithDeletedCharacters
 * category is NOT reachable via the UI: chats.character_id is
 * ON DELETE CASCADE with PRAGMA foreign_keys=ON.
 *
 * Verified response shapes (server/src/services/DataMaid.ts):
 *   GET  /api/maid/scan  → DataMaidReport { sqlOrphans{7 arrays},
 *                          filesystemOrphans{3 arrays},
 *                          summary{totalIssues,totalSqlOrphans,totalFilesystemOrphans} }
 *   POST /api/maid/clean → { ok:true, deletedSql:number, deletedFiles:number, report }
 */
import { test, expect } from '../fixtures/base.js';
import type { APIRequestContext } from '@playwright/test';
import { login } from '../helpers/auth.js';
import { App } from '../helpers/app.js';

const AUTH = { Authorization: 'Bearer e2e-test-secret' };

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

// Minimal 1x1 transparent PNG (same fixture as attachments.spec.ts).
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

interface MaidReport {
  sqlOrphans: {
    unlinkedAttachments: string[];
    danglingAttachments: string[];
    danglingGenerations: string[];
    staleGenerations: string[];
    danglingChatMembers: Array<{ chatId: string; characterId: string }>;
    chatsWithDeletedCharacters: string[];
    messagesWithDeletedParents: string[];
  };
  filesystemOrphans: {
    orphanedAvatarFiles: string[];
    orphanedPersonaFiles: string[];
    orphanedAttachmentFiles: string[];
  };
  summary: { totalIssues: number; totalSqlOrphans: number; totalFilesystemOrphans: number };
}

async function scan(request: APIRequestContext): Promise<MaidReport> {
  const res = await request.get('/api/maid/scan', { headers: AUTH });
  expect(res.ok()).toBe(true);
  return (await res.json()) as MaidReport;
}

test.describe('Data Maid', () => {
  test('GET /health returns 200', async ({ request }) => {
    const res = await request.get('/health');
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { status?: string };
    expect(body.status).toBe('ok');
  });

  test('GET /api/maid/scan without a token is rejected', async ({ request }) => {
    const res = await request.get('/api/maid/scan');
    expect([401, 403]).toContain(res.status());
  });

  test('GET /api/maid/scan returns the documented report shape', async ({ request }) => {
    const report = await scan(request);

    for (const key of [
      'unlinkedAttachments',
      'danglingAttachments',
      'danglingGenerations',
      'staleGenerations',
      'danglingChatMembers',
      'chatsWithDeletedCharacters',
      'messagesWithDeletedParents',
    ] as const) {
      expect(Array.isArray(report.sqlOrphans[key]), `sqlOrphans.${key} is an array`).toBe(true);
    }
    for (const key of ['orphanedAvatarFiles', 'orphanedPersonaFiles', 'orphanedAttachmentFiles'] as const) {
      expect(Array.isArray(report.filesystemOrphans[key]), `filesystemOrphans.${key} is an array`).toBe(true);
    }
    expect(typeof report.summary.totalIssues).toBe('number');
    expect(typeof report.summary.totalSqlOrphans).toBe('number');
    expect(typeof report.summary.totalFilesystemOrphans).toBe('number');
    expect(report.summary.totalIssues).toBe(report.summary.totalSqlOrphans + report.summary.totalFilesystemOrphans);
  });

  test('unlinked attachments and their orphan files are scanned, cleaned, and gone', async ({ page, request }) => {
    await login(page);
    const app = new App(page);
    const charName = uniqueName('Maid Char');
    await app.createCharacterAndChat({ name: charName, firstMes: `I am ${charName}.` });

    // Earlier specs (attachments, audio-attachments, …) can leave unlinked
    // attachments / orphan files behind, and /api/maid/clean is GLOBAL — it
    // would wipe those leftovers too, breaking any baseline-relative count
    // assertion below. Establish a true zero baseline first (their leftovers
    // are exactly the orphans clean exists to remove), then every assertion
    // can stay exact instead of relative.
    for (let i = 0; i < 5; i++) {
      const pre = await scan(request);
      if (pre.summary.totalIssues === 0) break;
      const res = await request.post('/api/maid/clean', { headers: AUTH });
      expect(res.ok()).toBe(true);
    }
    const baseline = await scan(request);
    expect(baseline.summary.totalIssues).toBe(0);

    // Upload an attachment but never send it → attachments row with message_id NULL.
    const fileInput = page.locator('.message-input-area .hidden-file-input');
    await fileInput.setInputFiles({
      name: 'maid-orphan.png',
      mimeType: 'image/png',
      buffer: Buffer.from(PNG_BASE64, 'base64'),
    });
    await expect(page.locator('.attachment-previews .attachment-preview')).toBeVisible({ timeout: 5000 });

    // Scan: the unlinked attachment is reported.
    const dirty = await scan(request);
    expect(dirty.sqlOrphans.unlinkedAttachments.length).toBe(
      baseline.sqlOrphans.unlinkedAttachments.length + 1,
    );

    // Clean: the row is deleted and the response reports the counts.
    const cleanRes = await request.post('/api/maid/clean', { headers: AUTH });
    expect(cleanRes.ok()).toBe(true);
    const clean = (await cleanRes.json()) as {
      ok: boolean;
      deletedSql: number;
      deletedFiles: number;
      report: MaidReport;
    };
    expect(clean.ok).toBe(true);
    expect(typeof clean.deletedSql).toBe('number');
    expect(typeof clean.deletedFiles).toBe('number');
    expect(clean.deletedSql).toBeGreaterThanOrEqual(1);
    expect(clean.report.sqlOrphans.unlinkedAttachments.length).toBe(
      dirty.sqlOrphans.unlinkedAttachments.length,
    );

    // Re-scan: the SQL orphan is gone. The uploaded file is now unreferenced,
    // so it shows up as a filesystem orphan (clean uses a single pre-scan
    // report — the file isn't orphaned at scan time).
    const after = await scan(request);
    expect(after.sqlOrphans.unlinkedAttachments.length).toBe(
      baseline.sqlOrphans.unlinkedAttachments.length,
    );
    expect(after.filesystemOrphans.orphanedAttachmentFiles.length).toBe(
      baseline.filesystemOrphans.orphanedAttachmentFiles.length + 1,
    );

    // A second clean removes the orphan file, exercising deletedFiles.
    const clean2Res = await request.post('/api/maid/clean', { headers: AUTH });
    expect(clean2Res.ok()).toBe(true);
    const clean2 = (await clean2Res.json()) as { ok: boolean; deletedSql: number; deletedFiles: number };
    expect(clean2.deletedFiles).toBeGreaterThanOrEqual(1);

    const final = await scan(request);
    expect(final.filesystemOrphans.orphanedAttachmentFiles.length).toBe(
      baseline.filesystemOrphans.orphanedAttachmentFiles.length,
    );
    expect(final.summary.totalIssues).toBe(baseline.summary.totalIssues);
  });
});
