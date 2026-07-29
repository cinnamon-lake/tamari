/** Reference doc for the `quick_replies` topic, served by the Docs tool. */
export const QUICK_REPLIES_DOC = `# Quick Replies & the \`st\` API

Quick replies are labeled buttons that run Lua scripts, scoped **global**, **per-character**, or **per-chat**. Scripts run in the context of the current chat; only one script or generation runs on a chat at a time. Sandbox: Lua 5.4 via WASM, 5s timeout, no \`io\`/\`os\`/\`debug\`/\`require\`. Functions marked async return promises — await with \`st.await(fn())\` or use the pre-wrapped ones.

## Editing via the Workbench

Quick replies live in the \`workbench\` template's filesystem at \`/quickreplies/<scope>/<scopeId>/<id>.json\` (scope \`global\`/\`character\`/\`chat\`; the global scope uses scopeId \`_\`). \`ls\`/\`read\` the scoped collection, \`write .../new.json\` to create (the real path comes back in the result), \`write\` again to replace label + Lua source. No delete and no execute — the user clicks the button. See topic \`workbench\`.

## \`st\` API overview (canonical snake_case names)

**Chat actions:** \`st.send(text)\`, \`st.trigger()\`, \`st.continue()\`, \`st.regenerate()\`, \`st.impersonate()\`, \`st.stop()\`, \`st.swipe("left"|"right")\`, \`st.cut(n)\`, \`st.reset_chat()\`, \`st.delay(ms)\`, \`st.rename_chat(name)\`, \`st.delete_chat()\`, \`st.new_chat(name?)\`, \`st.branch(messageId, name?)\` (soft-fork, shared history), \`st.checkpoint(name?)\`, \`st.hard_fork(messageId, name?)\` (copies history)

**Send as other roles:** \`st.send_as(name, content)\`, \`st.send_narrator([name,] content)\`, \`st.comment(content)\` (hidden)

**Message editing:** \`st.edit(id, content)\`, \`st.delete(id)\`, \`st.hide(id)\` / \`st.unhide(id)\`, \`st.set_message_role(id, role)\`, \`st.add_swipe(content, switchTo?)\`, \`st.set_active_child(id)\`, \`st.set_message_extra(id, key, value)\` / \`st.get_message_extra(id, key)\`

**Queries:** \`st.get_messages(limit?)\`, \`st.get_chat()\`, \`st.get_last_message()\`, \`st.get_message_by_id(id)\`, \`st.get_children(id)\`, \`st.get_swipes()\`, \`st.get_message_at(index)\` (negative = from end), \`st.find_message_by_content(s)\`, \`st.messages_as_text(sep?)\`, \`st.get_message_texts()\` — message shape: \`{ id, parentId, role, content, extra, createdAt }\`

**Characters & personas:** \`st.get_characters()\`, \`st.find_character(name)\`, \`st.get_character(id)\`, \`st.get_character_id()\`, \`st.create_character(data)\` / \`st.update_character(id, patch)\` (name-uniqueness enforced), \`st.set_character(id)\`, \`st.get_personas()\`, \`st.set_persona(id)\`, \`st.set_system_prompt(id, text)\` / \`st.get_system_prompt(id)\`, \`st.add_chat_member(id)\` / \`st.remove_chat_member(id)\`, tags: \`st.tag_add/remove/list(id, tag)\`

**Settings & model:** \`st.get_setting(key)\` / \`st.set_setting(key, v)\`, \`st.get_model()\` / \`st.set_model(name)\`, \`st.get_temperature()\` / \`st.set_temperature(v)\` (active backend config), \`st.set_maxTokens(v)\`, \`st.set_contextLength(v)\`, \`st.get_apiUrl()\` / \`st.set_apiUrl(url)\`

**Variables (chat-scoped, branch-forking):** \`st.setvar(name, v)\` / \`st.getvar(name)\`, \`st.get_variables()\`, \`st.clear_variables()\`

**Meta state (out-of-fiction, does NOT fork with branches):** \`st.set_state(ns, data)\` / \`st.get_state(ns)\` / \`st.delete_state(ns)\` (chat-scoped, 64KB cap), \`st.set_global_state(ns, data)\` / \`st.get_global_state(ns)\`

**Author's Note:** \`st.set_author_note(content, { depth=4, interval=1, position="in_chat", role="system" })\`, \`st.get_author_note()\`

**World Info (chat's character's book):** \`st.wi_list()\`, \`st.wi_get(key)\`, \`st.wi_add(keys_csv, content)\`, \`st.wi_remove(key)\`

**Misc:** \`st.substitute_macros(text)\`, \`st.toast(msg, level?)\`, \`st.token_count(text)\`, \`st.trim_tokens(text, limit)\`, string helpers (\`st.replace\`, \`st.replace_regex\`, \`st.match\`, \`st.split\`, \`st.join\`, …), \`st.random(min?, max?)\`, \`st.now()\`, \`st.json_encode/decode\`, \`st.set_chat_metadata(key, v)\` / \`st.get_chat_metadata(key)\`, reasoning: \`st.get_reasoning(id)\` / \`st.set_reasoning(id, text)\`

## Common patterns

\`\`\`lua
-- Send and reply
st.send("*looks around nervously*")
st.trigger()

-- Branching story state (branch-aware)
local choice = st.getvar("story_branch")
if choice == nil then
  st.send("Left or right?")
  st.setvar("story_branch", "pending")
end

-- Switch model mid-chat
st.set_model("claude-opus-4")
st.set_temperature(0.8)
st.trigger()
\`\`\`
`;
