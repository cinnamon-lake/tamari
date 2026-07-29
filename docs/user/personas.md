# Personas

A persona is **your** identity in a chat — the name the character calls you, a description of who you are, and an avatar shown next to your messages. You can keep several personas (a knight for fantasy chats, yourself for assistant chats) and pick a different one per chat.

## What a Persona Contains

- **Name** — becomes `{{user}}` everywhere macros are resolved: character cards, prompts, World Info, and your own messages.
- **Description** — a short "who you are" text. It becomes the `{{persona}}` macro and is also injected into the prompt on its own (see [How Personas Reach the Prompt](#how-personas-reach-the-prompt)).
- **Avatar** — an image shown on your messages and in the persona list.

tamari always has at least one persona: a fresh install starts with one named **User**, and the last remaining persona can't be deleted.

## Creating & Managing Personas

Open the **Personas** modal (sidebar → **Personas**). The list shows every persona with its avatar, name, and a description preview.

- **New Persona** creates a persona named "New Persona" and opens it in the editor.
- The **pencil** button on a list entry opens that persona in the editor, where you can change its **Name** and **Description** and upload an avatar.
- Edits **save automatically** — there is no save button. A brief **Saved** indicator confirms each write. Closing the editor also flushes any pending edit, so nothing is lost.
- **Delete** (with confirmation) removes the persona. Any chats that used it are automatically reassigned to another persona — the most recently updated remaining one.

> **Note:** You can't delete the last persona. tamari refuses with "Cannot delete the last persona" — create a replacement first, then delete the old one.

## Per-Chat Persona Selection

Persona selection is **per chat**, stored as `persona_id` on the chat. In the Personas modal, **clicking a persona's card selects it for the current chat** — the entry gets a check icon ("Selected for this chat"). Different chats can use different personas at the same time, and switching personas mid-chat only affects what happens from then on.

New chats are created with a default persona: the first persona in your list (the most recently updated one). If you mostly use one identity, keep it fresh by editing it — it stays the default.

> **Warning:** Switching a chat's persona does not rewrite history. Your past messages keep the name they were written with — each user message records the persona it was sent under (`personaId` in the message metadata), which is what drives the displayed name and avatar. The new persona applies to the next prompt and your next messages.

## How Personas Reach the Prompt

Two macros expose the active chat's persona when the prompt is built:

- `{{user}}` — the persona **name**
- `{{persona}}` — the persona **description**

These work anywhere macros are resolved — character card fields, preset prompts, World Info, Author's Note — and in your own messages at write time. Full details and examples: [Macro System](./macros.md).

```
{{char}} greets {{user}} warmly.
{% if {{? {{equal::{{user}}::Alice}} }} %}
  ({{char}} has known Alice for years.)
{% endif %}
```

The description doesn't need an explicit macro to reach the model: the default prompt list includes a **Persona Description** entry (the `personaDescription` marker) that injects the active persona's description into the system prompt. If you move or disable that entry, `{{persona}}` still works wherever you place it yourself.

If a chat somehow has no persona at all, `{{user}}` falls back to the legacy `userName` setting (settable with the `/name` slash command — see [Slash Commands](./slash-commands.md)), then to plain `User`.

## Avatar Uploads

In the persona editor, click the image button ("Choose avatar image") and pick a file. Unless you've enabled the **Never resize avatars (skip crop dialog)** setting (`neverResizeAvatars`), a crop dialog lets you frame the image first.

Server side, the upload goes to `POST /api/personas/:id/avatar` and is processed as follows:

- Accepted types: PNG, JPEG, WebP — anything else is rejected with a 400.
- The image is resized to fit **512×512** and stored as PNG, plus a **96×96** thumbnail for lists and message headers.
- Upload size is capped by the `AVATAR_MAX_FILE_SIZE_BYTES` environment variable (default 50 MB).

The avatar appears on your messages in chat and next to the persona in the Personas list.

## Tips & Gotchas

- **Name = identity.** `{{user}}` is just the persona name — renaming a persona renames you in every future prompt that uses it, across all chats bound to that persona.
- **Description is optional.** Leave it empty if you don't want the model to know anything about you; the Persona Description prompt entry then injects nothing.
- **One persona, many chats.** Binding is per chat, so you can test how a character treats different identities by opening two chats and selecting a different persona in each.
- **The list order matters.** New chats default to the first persona (most recently updated). If a chat keeps opening with the wrong identity, edit your preferred persona once — any small edit bumps it to the top.
- **Deleted personas don't orphan chats.** Chats are silently moved to a fallback persona; check them afterwards if the fallback isn't what you wanted.

## See Also

- [Macro System](./macros.md) — `{{user}}`, `{{persona}}`, and where macros resolve
- [Characters](./characters.md) — the other side of the conversation
- [Getting Started](./getting-started.md) — first-run setup
