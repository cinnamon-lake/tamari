import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { zipSync, unzipSync, strFromU8 } from 'fflate';
import { TestHarness } from '../testing/TestHarness.js';
import { createCharacterRouter, createPngWithMetadata } from './characters.js';
import { buildRisum } from '../lib/risum.js';

const minimalPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

function binaryParser(res: any, callback: (err: any, body: Buffer) => void) {
  res.setEncoding('binary');
  let data = '';
  res.on('data', (chunk: string) => {
    data += chunk;
  });
  res.on('end', () => {
    callback(null, Buffer.from(data, 'binary'));
  });
}

function createApp(harness: TestHarness) {
  const app = express();
  app.use(
    '/characters',
    createCharacterRouter(
      harness.deps.characters,
      harness.deps.characterAssets,
      harness.deps.worldInfo,
      harness.deps.storage,
      harness.bus,
    ),
  );
  return app;
}

describe('createCharacterRouter', () => {
  let h: TestHarness;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    h = new TestHarness();
    await h.initSchema();
    app = createApp(h);
  });

  afterEach(async () => {
    await h.teardown();
  });

  describe('POST /characters/:id/avatar', () => {
    it('uploads an avatar and updates the character', async () => {
      const character = await h.deps.characters.create('char-1', { name: 'Avatar Test' });

      const res = await request(app)
        .post(`/characters/${character.id}/avatar`)
        .attach('avatar', minimalPng, 'avatar.png')
        .expect(200);

      expect(res.body).toEqual({ success: true });

      const updated = await h.deps.characters.getById(character.id);
      expect(updated?.avatarPath).toBeTruthy();
      expect(updated?.avatarThumbnailPath).toBeTruthy();
      expect(h.deps.storage.exists(updated!.avatarPath!)).toBe(true);
    });

    it('returns 404 for a missing character', async () => {
      await request(app)
        .post('/characters/nonexistent/avatar')
        .attach('avatar', minimalPng, 'avatar.png')
        .expect(404);
    });

    it('returns 400 when no file is sent', async () => {
      const character = await h.deps.characters.create('char-2', { name: 'No File' });
      await request(app).post(`/characters/${character.id}/avatar`).expect(400);
    });
  });

  describe('GET /characters/:id/assets/:assetId', () => {
    it('serves an asset from the direct filesystem path', async () => {
      const character = await h.deps.characters.create('char-assets', { name: 'Asset Test' });
      h.deps.storage.write(
        `character_assets/${character.id}`,
        'logo.png',
        new Uint8Array(minimalPng),
      );

      const res = await request(app)
        .get(`/characters/${character.id}/assets/logo.png`)
        .expect(200)
        .expect('Content-Type', 'image/png');

      expect(res.body).toEqual(minimalPng);
    });

    it('falls back to the asset record for extension-less URLs', async () => {
      const character = await h.deps.characters.create('char-assets-db', { name: 'Asset DB Test' });
      const relPath = h.deps.storage.write(
        `character_assets/${character.id}`,
        'asset-id.png',
        new Uint8Array(minimalPng),
      );
      const asset = await h.deps.characterAssets.create(character.id, {
        id: 'asset-id',
        name: 'asset',
        type: 'image',
        ext: 'png',
        filePath: relPath,
        meta: {},
      });

      const res = await request(app)
        .get(`/characters/${character.id}/assets/${asset.id}`)
        .expect(200)
        .expect('Content-Type', 'image/png');

      expect(res.body).toEqual(minimalPng);
    });

    it('returns 404 when the asset is missing', async () => {
      const character = await h.deps.characters.create('char-missing-asset', { name: 'Missing' });
      await request(app).get(`/characters/${character.id}/assets/nope.png`).expect(404);
    });
  });

  describe('POST /characters/import', () => {
    it('imports a JSON character card', async () => {
      const card = {
        data: {
          name: 'Imported JSON',
          description: 'From test',
          first_mes: 'Hello from JSON',
        },
      };

      const res = await request(app)
        .post('/characters/import')
        .attach('file', Buffer.from(JSON.stringify(card)), 'test.json')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.character.name).toBe('Imported JSON');

      const fromDb = await h.deps.characters.getById(res.body.character.id);
      expect(fromDb).toBeDefined();
    });

    it('imports a PNG character card', async () => {
      const cardJson = JSON.stringify({
        data: {
          name: 'Imported PNG',
          first_mes: 'Hello from PNG',
        },
      });
      const pngWithMeta = createPngWithMetadata(cardJson, 'v3');

      const res = await request(app)
        .post('/characters/import')
        .attach('file', pngWithMeta, 'test.png')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.character.name).toBe('Imported PNG');
    });

    it('imports a card with string creation/modification dates', async () => {
      const card = {
        data: {
          name: 'String Dates',
          creation_date: '1699564800',
          modification_date: '2023-11-10T12:00:00Z',
        },
      };

      const res = await request(app)
        .post('/characters/import')
        .attach('file', Buffer.from(JSON.stringify(card)), 'test.json')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.character.name).toBe('String Dates');
    });

    it('returns 400 when no file is uploaded', async () => {
      await request(app).post('/characters/import').expect(400);
    });

    it('returns 400 for an unsupported file format', async () => {
      await request(app)
        .post('/characters/import')
        .attach('file', Buffer.from('not a card'), 'test.txt')
        .expect(400);
    });
  });

  describe('GET /characters/:id/export', () => {
    it('exports a v3 PNG with embedded metadata', async () => {
      const avatarPath = h.deps.storage.write('avatars', 'test.png', new Uint8Array(minimalPng));
      const character = await h.deps.characters.create('char-export', {
        name: 'Export Test',
        avatarPath,
      });

      const res = await request(app)
        .get(`/characters/${character.id}/export?format=v3`)
        .buffer(true)
        .parse(binaryParser)
        .expect(200)
        .expect('Content-Type', 'image/png')
        .expect('Content-Disposition', /Export_Test\.png/);

      expect(res.body.length).toBeGreaterThan(0);
    });

    it('exports a CharX zip archive', async () => {
      const character = await h.deps.characters.create('char-charx', { name: 'CharX Test' });
      const relPath = h.deps.storage.write(
        `character_assets/${character.id}`,
        'asset-id.png',
        new Uint8Array(minimalPng),
      );
      await h.deps.characterAssets.create(character.id, {
        id: 'asset-id',
        name: 'logo',
        type: 'image',
        ext: 'png',
        filePath: relPath,
        meta: {},
      });

      const res = await request(app)
        .get(`/characters/${character.id}/export?format=charx`)
        .buffer(true)
        .parse(binaryParser)
        .expect(200)
        .expect('Content-Type', 'application/zip')
        .expect('Content-Disposition', /CharX_Test\.charx/);

      expect(res.body.length).toBeGreaterThan(0);
    });

    it('exports v2 PNG when requested', async () => {
      const character = await h.deps.characters.create('char-v2', { name: 'V2 Test' });
      await request(app)
        .get(`/characters/${character.id}/export?format=v2`)
        .expect(200)
        .expect('Content-Type', 'image/png');
    });

    it('returns 404 for a missing character', async () => {
      await request(app).get('/characters/nonexistent/export').expect(404);
    });

    it('preserves contextualBackend (luaSource + VFS files) through CharX export', async () => {
      // Multi-file backend_logic must survive card export — a script that
      // silently loses its modules on export is a terrible bug. The files map
      // rides extensions wholesale; this pins that.
      const contextualBackend = {
        enabled: true,
        luaSource: "local util = require('lib/util')\nfunction generate(p, c) return util.reply() end",
        files: { 'lib/util.lua': "local M = {}\nfunction M.reply() return 'ok' end\nreturn M" },
      };
      const character = await h.deps.characters.create('char-backend-export', {
        name: 'Backend Export Test',
        extensions: { contextualBackend },
      });

      const res = await request(app)
        .get(`/characters/${character.id}/export?format=charx`)
        .buffer(true)
        .parse(binaryParser)
        .expect(200);

      const entries = unzipSync(new Uint8Array(res.body));
      const cardEntry = Object.keys(entries).find((k) => k.toLowerCase() === 'card.json');
      expect(cardEntry).toBeDefined();
      const card = JSON.parse(strFromU8(entries[cardEntry!]!)) as {
        data: { extensions: Record<string, unknown> };
      };
      expect(card.data.extensions['contextualBackend']).toEqual(contextualBackend);
    });
  });

  describe('POST /characters/import (CharX)', () => {
    it('imports the character book from data.character_book', async () => {
      const card = {
        spec: 'chara_card_v3',
        spec_version: '3.0',
        data: {
          name: 'CharX Book Test',
          character_book: {
            name: 'Shrine Maiden Book',
            entries: [
              {
                keys: ['reimu', 'hakurei'],
                content: 'Reimu Hakurei is the shrine maiden of the Hakurei Shrine.',
                enabled: true,
                insertion_order: 100,
              },
            ],
          },
        },
      };
      const zipData = zipSync({
        'card.json': new Uint8Array(Buffer.from(JSON.stringify(card))),
      });

      const res = await request(app)
        .post('/characters/import')
        .attach('file', Buffer.from(zipData), 'card.charx')
        .expect(200);

      expect(res.body.success).toBe(true);
      const character = await h.deps.characters.getById(res.body.character.id);
      expect(character?.worldInfoId).toBeTruthy();

      const book = await h.deps.worldInfo.getById(character!.worldInfoId!);
      expect(book?.name).toBe('Shrine Maiden Book');
      expect(book?.entries).toHaveLength(1);
      expect(book?.entries[0]?.keys).toEqual(['reimu', 'hakurei']);
      expect(book?.entries[0]?.content).toContain('shrine maiden');
    });

    it('stores the embedded module.risum as raw module metadata', async () => {
      const card = { spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'CharX Module Test' } };
      const risum = buildRisum({
        name: 'Embedded Module',
        namespace: 'emb',
        trigger: [{ comment: '', type: 'start', effect: [{ type: 'triggerlua', code: 'print(1)' }] }],
        lorebook: [{ key: 'a', content: 'b' }],
      });
      const zipData = zipSync({
        'card.json': new Uint8Array(Buffer.from(JSON.stringify(card))),
        'module.risum': new Uint8Array(risum),
      });

      const res = await request(app)
        .post('/characters/import')
        .attach('file', Buffer.from(zipData), 'card.charx')
        .expect(200);

      expect(res.body.success).toBe(true);
      const character = await h.deps.characters.getById(res.body.character.id);
      const metas = (character!.extensions.risuModules as Array<Record<string, unknown>>) ?? [];
      expect(metas).toHaveLength(1);
      expect(metas[0]).toMatchObject({
        name: 'Embedded Module',
        namespace: 'emb',
        source: 'embedded',
        hasLua: true,
        counts: { triggers: 1, regex: 0, lorebook: 1, assets: 0 },
      });
      expect(h.deps.storage.exists(metas[0]!.filePath as string)).toBe(true);
    });

    it('still imports the card when the embedded module.risum is corrupt', async () => {
      const card = { spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'Corrupt Module Test' } };
      const zipData = zipSync({
        'card.json': new Uint8Array(Buffer.from(JSON.stringify(card))),
        'module.risum': new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
      });

      const res = await request(app)
        .post('/characters/import')
        .attach('file', Buffer.from(zipData), 'card.charx')
        .expect(200);

      expect(res.body.success).toBe(true);
      const character = await h.deps.characters.getById(res.body.character.id);
      expect(character).toBeTruthy();
      expect(character!.extensions.risuModules).toBeUndefined();
    });
  });

  describe('POST/DELETE /characters/:id/risu-module', () => {
    it('attaches a standalone .risum to an existing character', async () => {
      const character = await h.deps.characters.create('char-attach', { name: 'Attach Test' });
      const risum = buildRisum({
        name: 'External Module',
        regex: [{ in: 'a', out: 'b' }],
        assets: [['song', '', 'mp3']],
      });

      const res = await request(app)
        .post(`/characters/${character.id}/risu-module`)
        .attach('file', risum, 'module.risum')
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.module).toMatchObject({
        name: 'External Module',
        source: 'attached',
        counts: { triggers: 0, regex: 1, lorebook: 0, assets: 1 },
      });

      const updated = await h.deps.characters.getById(character.id);
      const metas = updated!.extensions.risuModules as Array<Record<string, unknown>>;
      expect(metas).toHaveLength(1);
      expect(h.deps.storage.exists(metas[0]!.filePath as string)).toBe(true);
    });

    it('imports asset payloads as character assets on attach', async () => {
      const character = await h.deps.characters.create('char-attach-assets', { name: 'Asset Attach' });
      const risum = buildRisum(
        { name: 'Asset Pack', assets: [['song', '', 'mp3']] },
        [Buffer.from('FAKE-MP3')],
      );

      const res = await request(app)
        .post(`/characters/${character.id}/risu-module`)
        .attach('file', risum, 'module.risum')
        .expect(200);
      expect(res.body.assetsStored).toBe(1);

      const assetList = await h.deps.characterAssets.listForCharacter(character.id);
      expect(assetList).toHaveLength(1);
      expect(assetList[0]).toMatchObject({ name: 'song', ext: 'mp3' });
      expect(assetList[0]!.meta['origin']).toBe('risu-module');
      expect(h.deps.storage.read(assetList[0]!.filePath!).toString()).toBe('FAKE-MP3');
    });

    it('rejects a non-.risum file with 400', async () => {
      const character = await h.deps.characters.create('char-attach-bad', { name: 'Bad Attach' });
      const res = await request(app)
        .post(`/characters/${character.id}/risu-module`)
        .attach('file', Buffer.from('not a risum at all'), 'module.risum')
        .expect(400);
      expect(res.body.error).toMatch(/magic|short/i);
    });

    it('returns 404 when attaching to a missing character', async () => {
      const risum = buildRisum({ name: 'M' });
      await request(app)
        .post('/characters/nonexistent/risu-module')
        .attach('file', risum, 'module.risum')
        .expect(404);
    });

    it('deletes an attached module', async () => {
      const character = await h.deps.characters.create('char-detach', { name: 'Detach Test' });
      const risum = buildRisum({ name: 'To Delete' });
      const attachRes = await request(app)
        .post(`/characters/${character.id}/risu-module`)
        .attach('file', risum, 'module.risum')
        .expect(200);
      const moduleId = attachRes.body.module.id as string;
      const filePath = attachRes.body.module.filePath as string;

      const res = await request(app)
        .delete(`/characters/${character.id}/risu-module/${moduleId}`)
        .expect(200);
      expect(res.body).toEqual({ success: true, removed: moduleId });

      const updated = await h.deps.characters.getById(character.id);
      expect(updated!.extensions.risuModules).toEqual([]);
      expect(h.deps.storage.exists(filePath)).toBe(false);
    });

    it('returns 404 when deleting a missing module', async () => {
      const character = await h.deps.characters.create('char-detach-missing', { name: 'Detach Missing' });
      await request(app)
        .delete(`/characters/${character.id}/risu-module/nope`)
        .expect(404);
    });
  });

  describe('GET /characters/:id/risu-modules (read endpoints)', () => {
    const attachModule = async (characterId: string): Promise<string> => {
      const risum = buildRisum({
        name: 'Readable Module',
        namespace: 'rm',
        trigger: [{ comment: 'main', type: 'start', effect: [{ type: 'triggerlua', code: 'return 1' }] }],
        regex: [{ in: 'a', out: 'b' }],
        lorebook: [{ key: 'k', content: 'v' }],
      });
      const res = await request(app)
        .post(`/characters/${characterId}/risu-module`)
        .attach('file', risum, 'module.risum')
        .expect(200);
      return res.body.module.id as string;
    };

    it('lists module metadata for a character', async () => {
      const character = await h.deps.characters.create('char-read-1', { name: 'Read List' });
      const moduleId = await attachModule(character.id);

      const res = await request(app).get(`/characters/${character.id}/risu-modules`).expect(200);
      expect(res.body.total).toBe(1);
      expect(res.body.modules[0]).toMatchObject({
        id: moduleId,
        name: 'Readable Module',
        namespace: 'rm',
        counts: { triggers: 1, regex: 1, lorebook: 1, assets: 0 },
        hasLua: true,
      });
    });

    it('reads the info, triggers, trigger, regex, and lorebook sections', async () => {
      const character = await h.deps.characters.create('char-read-2', { name: 'Read Sections' });
      const moduleId = await attachModule(character.id);
      const base = `/characters/${character.id}/risu-modules/${moduleId}`;

      const info = await request(app).get(`${base}?section=info`).expect(200);
      expect(info.body).toMatchObject({ name: 'Readable Module', namespace: 'rm' });

      const triggers = await request(app).get(`${base}?section=triggers`).expect(200);
      expect(triggers.body).toEqual([
        { index: 0, type: 'start', comment: 'main', effectCount: 1, conditionCount: 0, hasLua: true },
      ]);

      const trigger = await request(app).get(`${base}?section=trigger&index=0`).expect(200);
      expect(trigger.body.effect[0]).toMatchObject({ type: 'triggerlua', code: 'return 1' });

      const regex = await request(app).get(`${base}?section=regex`).expect(200);
      expect(regex.body).toEqual([{ in: 'a', out: 'b' }]);

      const lorebook = await request(app).get(`${base}?section=lorebook`).expect(200);
      expect(lorebook.body).toEqual([{ key: 'k', content: 'v' }]);
    });

    it('400s on an unknown section and on trigger without index', async () => {
      const character = await h.deps.characters.create('char-read-3', { name: 'Read Errors' });
      const moduleId = await attachModule(character.id);
      const base = `/characters/${character.id}/risu-modules/${moduleId}`;

      await request(app).get(`${base}?section=bogus`).expect(400);
      const noIndex = await request(app).get(`${base}?section=trigger`).expect(400);
      expect(noIndex.body.error).toContain('requires an index');
    });

    it('404s for a missing character or module', async () => {
      const character = await h.deps.characters.create('char-read-4', { name: 'Read 404' });
      await request(app).get('/characters/nonexistent/risu-modules').expect(404);
      await request(app).get(`/characters/${character.id}/risu-modules/nope`).expect(404);
    });
  });
});
