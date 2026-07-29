import { describe, expect, it } from 'vitest';
import { escapeXml, serializeResponseForm, toXmlName } from './responseForm';

function makeForm(innerHtml: string, root = 'action'): HTMLFormElement {
  const form = document.createElement('form');
  form.setAttribute('data-post-response', root);
  form.innerHTML = innerHtml;
  return form;
}

describe('toXmlName', () => {
  it('passes valid names through and coerces invalid ones', () => {
    expect(toXmlName('target')).toBe('target');
    expect(toXmlName('my-field_2.0')).toBe('my-field_2.0');
    expect(toXmlName('my field!')).toBe('my_field_');
    expect(toXmlName('9lives')).toBe('_9lives');
    expect(toXmlName('')).toBe('_');
  });
});

describe('escapeXml', () => {
  it('escapes all five predefined entities, & first', () => {
    expect(escapeXml(`a & b <c> "d" 'e'`)).toBe('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;');
    expect(escapeXml('&lt;')).toBe('&amp;lt;');
  });
});

describe('serializeResponseForm', () => {
  it('serializes text, textarea and select in DOM order inside a fenced block', () => {
    const form = makeForm(`
      <input name="target" type="text" value="the goblin">
      <textarea name="flourish">from the shadows</textarea>
      <select name="weapon">
        <option value="sword">Sword</option>
        <option value="bow" selected>Bow</option>
      </select>
    `);
    expect(serializeResponseForm(form)).toBe(
      '```xml\n' +
        '<action>\n' +
        '  <target>the goblin</target>\n' +
        '  <flourish>from the shadows</flourish>\n' +
        '  <weapon>bow</weapon>\n' +
        '</action>\n' +
        '```',
    );
  });

  it('defaults the root element to "response" and coerces a custom root', () => {
    const plain = serializeResponseForm(makeForm('<input name="a" value="1">', ''));
    expect(plain).toContain('<response>');
    const weird = serializeResponseForm(makeForm('<input name="a" value="1">', 'my root'));
    expect(weird).toContain('<my_root>');
  });

  it('emits empty elements for empty values (presence is information)', () => {
    const form = makeForm('<input name="note" type="text" value="">');
    expect(serializeResponseForm(form)).toContain('<note></note>');
  });

  it('emits checkboxes and radios only when checked, valueless as true', () => {
    const form = makeForm(`
      <input type="checkbox" name="sneak" value="yes" checked>
      <input type="checkbox" name="shield" value="yes">
      <input type="checkbox" name="bonus" checked>
      <input type="radio" name="stance" value="aggressive">
      <input type="radio" name="stance" value="defensive" checked>
    `);
    const xml = serializeResponseForm(form)!;
    expect(xml).toContain('<sneak>yes</sneak>');
    expect(xml).not.toContain('shield');
    expect(xml).toContain('<bonus>true</bonus>');
    expect(xml).not.toContain('aggressive');
    expect(xml).toContain('<stance>defensive</stance>');
  });

  it('emits repeated elements for repeated names and multi-selects', () => {
    const form = makeForm(`
      <input type="checkbox" name="tag" value="a" checked>
      <input type="checkbox" name="tag" value="b" checked>
      <select name="pick" multiple>
        <option value="x" selected>x</option>
        <option value="y" selected>y</option>
        <option value="z">z</option>
      </select>
    `);
    const xml = serializeResponseForm(form)!;
    expect(xml).toContain('<tag>a</tag>\n  <tag>b</tag>');
    expect(xml).toContain('<pick>x</pick>\n  <pick>y</pick>');
    expect(xml).not.toContain('<pick>z</pick>');
  });

  it('escapes free text so closing tags stay unambiguous', () => {
    const form = makeForm('<textarea name="flourish">he said "</flourish>" & <b>ran</b></textarea>');
    const xml = serializeResponseForm(form)!;
    expect(xml).toContain(
      '<flourish>he said &quot;&lt;/flourish&gt;&quot; &amp; &lt;b&gt;ran&lt;/b&gt;</flourish>',
    );
  });

  it('coerces invalid field names to valid XML names', () => {
    const form = makeForm('<input name="my field!" value="v">');
    expect(serializeResponseForm(form)).toContain('<my_field_>v</my_field_>');
  });

  it('skips unnamed, disabled, file/password and button-type controls', () => {
    const form = makeForm(`
      <input type="text" value="no-name">
      <input type="text" name="off" value="x" disabled>
      <input type="password" name="secret" value="hunter2">
      <input type="file" name="upload">
      <input type="text" name="kept" value="v">
      <button type="submit" name="btn" value="go">Go</button>
    `);
    const xml = serializeResponseForm(form)!;
    expect(xml).toContain('<kept>v</kept>');
    for (const absent of ['no-name', 'off', 'secret', 'upload', 'btn']) {
      expect(xml).not.toContain(absent);
    }
  });

  it('returns null when no field emitted a value', () => {
    expect(serializeResponseForm(makeForm('<input type="text" value="no-name">'))).toBeNull();
    expect(serializeResponseForm(makeForm('<input type="checkbox" name="c">'))).toBeNull();
    expect(serializeResponseForm(makeForm(''))).toBeNull();
  });
});
