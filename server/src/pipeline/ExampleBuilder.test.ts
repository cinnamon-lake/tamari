import { describe, it, expect } from 'vitest';
import { ExampleBuilder } from './ExampleBuilder.js';

describe('ExampleBuilder', () => {
  const builder = new ExampleBuilder();

  it('returns empty array for empty string', () => {
    expect(builder.build('')).toEqual([]);
    expect(builder.build('   ')).toEqual([]);
  });

  it('parses simple user/char exchange', () => {
    const result = builder.build('{{user}}: Hello\n{{char}}: Hi there!');
    expect(result).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ]);
  });

  it('parses multi-line messages', () => {
    const result = builder.build('{{user}}: Hello\nHow are you?\n{{char}}: I am fine,\nthanks!');
    expect(result).toEqual([
      { role: 'user', content: 'Hello\nHow are you?' },
      { role: 'assistant', content: 'I am fine,\nthanks!' },
    ]);
  });

  it('turns <START> into a system message', () => {
    const result = builder.build('<START>\n{{user}}: Hello\n{{char}}: Hi');
    expect(result).toEqual([
      { role: 'system', content: '' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ]);
  });

  it('keeps text after <START> on the same line', () => {
    const result = builder.build('<START> Example dialogue\n{{user}}: Hello');
    expect(result).toEqual([
      { role: 'system', content: 'Example dialogue' },
      { role: 'user', content: 'Hello' },
    ]);
  });

  it('handles multiple <START> blocks', () => {
    const result = builder.build('<START>\n{{user}}: Hello\n{{char}}: Hi\n<START>\n{{user}}: Bye\n{{char}}: See ya');
    expect(result).toEqual([
      { role: 'system', content: '' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
      { role: 'system', content: '' },
      { role: 'user', content: 'Bye' },
      { role: 'assistant', content: 'See ya' },
    ]);
  });

  it('ignores leading lines before first speaker', () => {
    const result = builder.build('Some random header\n{{user}}: Hello\n{{char}}: Hi');
    expect(result).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ]);
  });

  it('normalises \\r\\n line endings', () => {
    const result = builder.build('{{user}}: Hello\r\n{{char}}: Hi');
    expect(result).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ]);
  });

  it('is case-insensitive for <START>', () => {
    const result = builder.build('<start>\n{{user}}: Hello');
    expect(result).toEqual([
      { role: 'system', content: '' },
      { role: 'user', content: 'Hello' },
    ]);
  });

  it('is case-insensitive for {{user}} and {{char}}', () => {
    const result = builder.build('{{USER}}: Hello\n{{CHAR}}: Hi');
    expect(result).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ]);
  });

  it('preserves macros in content', () => {
    const result = builder.build('{{user}}: Hello {{char}}!\n{{char}}: Hi {{user}}!');
    expect(result).toEqual([
      { role: 'user', content: 'Hello {{char}}!' },
      { role: 'assistant', content: 'Hi {{user}}!' },
    ]);
  });
});
