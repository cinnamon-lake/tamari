# Assets

tamari works with two kinds of files: **character assets**, which belong to a character card and travel with it when you export, and **chat attachments**, which belong to a single message. This page covers how each kind is stored, served, embedded in text, and sent to the model.

## The Two Kinds of Files

| | Character assets | Chat attachments |
|---|---|---|
| Scope | A character card | A single message |
| Stored at | `character_assets/<characterId>/` under your data dir | `attachments/` under your data dir |
| Metadata | `character_assets` table (name, type, ext) | `attachments` table (MIME type, message link) |
| Served from | `GET /api/characters/<id>/assets/<assetId>.<ext>` | `GET /api/attachments/<id>` |
| Embed in text | `{{img::name}}` or `<img src="name.png">` | `{{attachment::id}}` |
| Exported with card | Yes (CharX) | No |

> **Note:** Attachment downloads are public (no auth) so inline images load in the browser. Character asset URLs sit behind the API auth middleware, which also accepts a `?token=` query parameter.

## Character Assets

Character assets are the images (and other files) bundled with a card — emotion sprites, alternate portraits, background art, sound packs.

### Viewing Assets in the Editor

Open a character in the **Character Editor** and expand the **Assets (N)** toggle under the Advanced section. Assets are grouped by type (`icon`, `emotion`, `background`, `other`, …) with thumbnails. This view is read-only — adding and removing assets happens through import or the workbench (see below).

### How Assets Get Attached

There is no manual "upload asset" button. Assets arrive with the card:

- **CharX import** — **Import card** in the sidebar accepts `.charx` files (ZIP-based). Every file in the archive's asset section is extracted to `character_assets/<characterId>/` and registered under a sanitized name (characters outside `a-zA-Z0-9._-` become `_`). The card's `icon` asset becomes the avatar. An embedded `module.risum` is preserved as a Risu module (see below).
- **PNG import** — V2/V3 PNG cards (`chara` / `ccv3` metadata chunks) carry no assets; the PNG itself becomes the avatar.
- **`.risum` module attach** — see "Risu Modules" below.
- **Workbench** — the LLM can import a chat attachment as a card asset (see "Managing Assets from the Workbench").

### Export Behavior

From the Character Editor's export dropdown:

- **Export PNG** — embeds the card JSON into the avatar PNG (`ccv3` chunk for V3, `chara` for V2). Assets are **not** included.
- **Export CharX** — only shown when the character has assets. Produces a ZIP with `card.json` plus each asset at `<type>s/<name>.<ext>`, with asset URIs in the form `embeded://<type>s/<name>.<ext>` (the spec's misspelling, kept for compatibility).

The same formats are available over REST at `GET /api/characters/<id>/export?format=v3|v2|charx`.

### Risu Modules

RisuAI `.risum` modules can be attached to a card for the porting workflow. In the Character Editor, expand **RisuAI modules (imported)** and click **Attach .risum…**.

Two things happen on attach:

1. The module JSON (triggers, regex, lorebook) is stored verbatim under `character_modules/<characterId>/` — tamari does not execute it; it is a read-only reference for porting, browsable in the module viewer by section (Info, Triggers, Regex, Lorebook, Assets).
2. The module's asset payloads are **flattened into the card's ordinary assets** (type `other`), so you can serve, export, and reference them with `{{img::}}` like any CharX asset.

> **Warning:** Module assets become the card's assets at attach time. Deleting the module afterwards leaves them behind, and if a module asset name collides with an existing asset, both remain — `{{img::}}` name matching may pick either.

REST endpoints: `POST /api/characters/<id>/risu-module`, `GET /api/characters/<id>/risu-modules`, `GET .../risu-modules/<moduleId>?section=…`, `DELETE .../risu-module/<moduleId>`.

## Embedding Media in Text

Both embed macros are **display-time only**: they resolve when a message is rendered for you, not when the prompt is built. Stored card and message text keeps the original markup, and the model never sees the resolved URL.

### `{{img::name}}` — Character Assets

```
{{img::portrait.png}}   →   ![portrait.png](/api/characters/<id>/assets/<assetId>.png)
```

The name is looked up in the current character's asset list. If the exact name misses, tamari retries with a sanitized version (spaces and other unsafe characters become `_`), matching how names are sanitized on import. If nothing matches, the macro degrades to `![name]` — a broken image, not an error.

### Plain Filenames in HTML

Raw HTML image tags in card content also resolve at display time:

```html
<img src="Marisa Kirisame.png">
```

The filename is fuzzy-matched against the character's assets (sanitized names; assets whose name starts with `Normal_` win ties). Only `png`, `jpg`/`jpeg`, `gif`, `webp`, and `bmp` sources are rewritten. CharX-style `embeded://` URIs (both the misspelled and the correct `embedded://` spelling) in `src` attributes resolve the same way.

### `{{attachment::id}}` — Chat Attachments

```
{{attachment::a1b2c3d4-…}}
```

Resolves to inline media HTML based on the attachment's MIME type:

- `audio/*` → `<audio class="message-inline-audio" controls …>`
- `video/*` → `<video class="message-inline-video" controls …>`
- anything else → `<img class="message-inline-img" …>`

An unknown ID is left as literal `{{attachment::id}}` text. You rarely write this macro yourself — media tools (such as image generation) return it in their results and the model includes it in its reply to display the file. See [Macros](./macros.md) for the full macro system.

## Chat Attachments

### Uploading

Click the paperclip (**Attach file**) button in the message input, or drop files onto the chat area. Files upload as base64 JSON to `POST /api/attachments`, appear as previews above the input, and are linked to your message when you send it.

### MIME Allowlist

Uploads are restricted to types that are safe to store and serve:

- `image/*`, `audio/*`, `video/*`
- `text/plain`, `text/markdown`
- `application/pdf`, `application/json`, `application/octet-stream`

Anything else (notably `text/html` — an XSS vector) is rejected with `Unsupported MIME type`. Downloads of non-media types are served with `Content-Disposition: attachment` so the browser saves them instead of rendering them.

### Media in Prompts

When a message with attachments enters the context window, tamari converts them to media parts for the model:

- Images become image parts when the active backend config has **Supports images** on (default).
- Audio becomes audio parts when **Supports audio** is on; video likewise with **Supports video**.

These are capability flags on the backend config (Backend Config modal), because not every provider accepts every modality.

**When a capability is off**, the attachment is silently dropped from the prompt — unless you enable **Verbose media mode** in **Settings**, which instead substitutes a text placeholder so the model knows a file was there:

| Attachment | Placeholder |
|---|---|
| Image | `[Attached image]` |
| Audio | `[Attached audio]` |
| Video | `[Attached video]` |

## Limits and Environment Variables

| Setting | Default | What it caps |
|---|---|---|
| `HTTP_JSON_LIMIT` | `5mb` | JSON body size — governs base64 attachment uploads |
| `AVATAR_MAX_FILE_SIZE_BYTES` | `52428800` (50 MB) | Persona avatar uploads |
| `DATA_DIR` | `./data-v2` | Root of all file storage (`attachments/`, `character_assets/`, `avatars/`, …) |

Hard-coded limits to be aware of:

- Attachment upload `data` field: 15,000,000 base64 characters (~10 MB of binary) — but the default 5 MB `HTTP_JSON_LIMIT` will reject large uploads first, so raise it if you attach big files.
- Character import, avatar, and `.risum` uploads: 512 MB, buffered in memory (asset packs routinely run 140–170 MB).

> **Note:** `AVATAR_MAX_FILE_SIZE_BYTES` currently applies to persona avatars only. Character avatar uploads share the 512 MB import limit.

## Managing Assets from the Workbench

If you let the model use the workbench (see [Workbench](./workbench.md)), it can manage assets through the virtual filesystem:

- `ls /characters/<id>/assets/` — list a card's assets
- `read /characters/<id>/assets/<assetId>.json` — asset metadata (the binary itself is not readable)
- `write /characters/<id>/assets/new.json` with `{ "attachmentId": "…", "name": "…", "type": "…" }` — import a chat attachment as a card asset
- `rm /characters/<id>/assets/<assetId>.json` — delete an asset
- `ls` / `read` / `rm` under `/characters/<id>/modules/` — inspect and remove Risu modules (read-only otherwise)

Relevant `run` verbs:

| Verb | Args | Effect |
|---|---|---|
| `set_avatar` | `{characterId, attachmentId? \| sourceCharacterId?}` | Set avatar from an attachment image or another card |
| `copy_assets` | `{characterId, sourceCharacterId, assetId?}` | Copy one asset, or all when `assetId` is omitted |
| `copy_module_assets` | `{characterId, sourceCharacterId, moduleId}` | Copy a Risu module's stored assets onto a card |
| `clone_character` | `{sourceCharacterId, name?}` | Deep-copy a card including assets and avatar |

## Letting the LLM List Assets

The builtin `assets` tool template ("Asset Lister") exposes one tool:

- `list_assets` — lists the current character's assets as `- name (type)` lines. Optional `limit` argument (default 10, clamped to 1–50).

Add the `assets` template to an enabled toolset and the model can discover which sprites or images a card has before referencing them with `{{img::name}}`.

## Tips & Gotchas

- **Name your assets plainly.** `{{img::}}` matching is name-based and sanitized — `happy face.png` and `happy_face.png` are the same asset as far as the macro is concerned. Names starting with `Normal_` win fuzzy ties in `<img src>` resolution, which is handy for default emotion sprites.
- **A broken `{{img::}}` is silent.** If the name matches nothing you get `![name]` with no error. Check the **Assets (N)** section of the Character Editor for the exact stored (sanitized) name.
- **Export CharX, not PNG, if the assets matter.** PNG export drops them.
- **Removed modules keep their assets.** Flattened `.risum` payloads survive module deletion; remove them individually if you don't want them.
- **Big uploads need config.** Attaching files larger than ~5 MB requires raising `HTTP_JSON_LIMIT`, since uploads travel as base64 JSON.
