/** Reference doc for the `chats` topic, served by the Docs tool. */
export const CHATS_DOC = `# Chats

A chat is a **tree** of messages, not a flat list: each message has a \`parentId\`, and siblings are alternative branches — "swipes" are the sibling children of one parent. The **active branch** is the path from root to the currently selected head; everything (prompt building, tool state, WI activation history, macro variables) is computed along the active branch, which is why swipes and forks keep independent state.

## Chat model

- \`characterId\` — the chat's character; \`personaId\` — the user's persona for this chat (defaults to the first persona).
- Messages: \`{ id, parentId, role: user|assistant|system|tool, content, extra, createdAt }\`. \`extra\` carries attachments, reasoning, macro variables (\`macroVars\`), tool state (\`_toolState\`), WI activations (\`_wiActivations\`).
- **Greetings** are virtual until first send: the character's \`firstMes\` + \`alternateGreetings\` then materialize as sibling root messages.
- **Hidden** messages are excluded from prompts and macro context but stay in the tree.
- **Forks:** soft-fork (\`st.branch\`/\`st.checkpoint\`) shares history and diverges; hard-fork copies it.

## Group chats

A chat can have multiple character members. One backend runs per generation; the speaking character's card (and its contextual backend, if enabled) applies per speaker. Per-character logic inside custom backends branches on \`ctx.characterId\` / speaker name.

## Chat Workbench

- \`chat_list_members\` — members of a chat (defaults to the current chat).
- \`chat_add_member\` — add a character to the group.
- \`chat_remove_member\` — remove one.

## The interaction protocol (buttons and forms)

Message HTML may include \`<button data-post-response="some command">Label</button>\`. A click posts the attribute value as the user's next message and triggers generation — an ordinary, visible user message (no hidden IPC). Cards and scripts use recognizable protocol strings (\`gensonet:post:42\`) that a custom backend interprets on the next turn, or quick replies / the seeded \`present_choices\` tool for model-generated choices. Buttons survive the default (permissive) sanitization; the strict-sanitization setting strips them.

Message HTML may also include a **response form**: \`<form data-post-response="action">\` with named fields (\`input\`/\`select\`/\`textarea\`) and a submit button. Submitting serializes the fields to a flat XML block — root named by the attribute, one child element per field \`name\`, values entity-escaped — wrapped in an \`\`\`xml fence and posted as the user's next message: same channel, same honesty. Checkboxes/radios appear only when checked, empty fields emit empty elements, \`file\`/\`password\` inputs are ignored. A custom backend parses the block with the recipe in topic \`custom_backends\` ("Parsing response forms"). Forms survive the default (permissive) sanitization (\`form\`/\`input\`/\`select\`/\`option\`/\`textarea\`/\`label\`/\`fieldset\` and \`name\`/\`type\`/\`value\`/\`placeholder\`/\`checked\`/\`selected\`/\`for\`/\`rows\` are whitelisted; \`action\`/\`method\`/\`formaction\`/event handlers deliberately are not); strict sanitization strips them.

## What tools should NOT do

- Don't rewrite old messages' content to change what the user saw — displayed history is immutable by design. Prefer appending a new message or adding a swipe (\`st.add_swipe\`).
- Don't store world state in chat metadata or meta state if it should follow swipes/branches — use \`{{setvar}}\` variables or tool \`_toolState\`, which fork with the branch.
`;
