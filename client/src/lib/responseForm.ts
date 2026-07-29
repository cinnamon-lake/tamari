// Layer-3 form protocol (docs/design/scriptable-layers.md §4 "Forms"):
// a <form data-post-response="root"> inside message HTML serializes its fields
// to a flat, elements-only XML profile on submit, wrapped in an ```xml fence,
// and the result is posted as the user's next message — the chat log is the
// IPC channel (honest text, principle 3).
//
// Two invariants keep the output trivially parseable in Lua (the doc ships a
// 6-line gmatch recipe): every value is entity-escaped, so a closing tag is
// unambiguous; and the profile is flat — one level of elements, no attributes,
// no nesting, repeated siblings for multi-value fields.

const XML_NAME_INVALID = /[^A-Za-z0-9_.-]/g;

/** Coerce an arbitrary string into a valid XML element name. */
export function toXmlName(name: string): string {
  const cleaned = name.replace(XML_NAME_INVALID, '_');
  if (!cleaned) return '_';
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `_${cleaned}`;
}

/** Escape the five XML predefined entities (& first, obviously). */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Input types that never contribute a field value.
const SKIPPED_INPUT_TYPES = new Set(['file', 'password', 'submit', 'button', 'reset', 'image']);

function fieldValues(el: Element): string[] | null {
  if (el instanceof HTMLInputElement) {
    const type = el.type.toLowerCase();
    if (SKIPPED_INPUT_TYPES.has(type)) return null;
    if (type === 'checkbox' || type === 'radio') {
      if (!el.checked) return null;
      // A valueless checked control still records its presence.
      return [el.value && el.value !== 'on' ? el.value : 'true'];
    }
    return [el.value];
  }
  if (el instanceof HTMLTextAreaElement) return [el.value];
  if (el instanceof HTMLSelectElement) {
    return Array.from(el.selectedOptions).map((opt) => opt.value);
  }
  return null;
}

/**
 * Serialize a marked response form to the message content to post:
 * a fenced ```xml block with the attribute value as root element
 * ('response' when empty). Returns null when no field emitted a value —
 * the caller then sends nothing.
 */
export function serializeResponseForm(form: HTMLFormElement): string | null {
  const rawRoot = form.getAttribute('data-post-response') ?? '';
  const root = rawRoot ? toXmlName(rawRoot) : 'response';
  const lines: string[] = [];
  // querySelectorAll, not form.elements: with SANITIZE_DOM off (see
  // DisplayRenderer.ts) a field literally named "elements" would clobber the
  // form's built-in .elements collection.
  for (const el of Array.from(form.querySelectorAll('input, select, textarea'))) {
    const name = el.getAttribute('name');
    if (!name) continue;
    if ('disabled' in el && (el as HTMLInputElement).disabled) continue;
    const values = fieldValues(el);
    if (!values) continue;
    const tag = toXmlName(name);
    for (const value of values) {
      lines.push(`  <${tag}>${escapeXml(value)}</${tag}>`);
    }
  }
  if (lines.length === 0) return null;
  return '```xml\n' + `<${root}>\n${lines.join('\n')}\n</${root}>\n` + '```';
}
