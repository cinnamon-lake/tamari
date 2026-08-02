import { describe, it, expect } from 'vitest';
import { DocsTemplate } from './DocsTemplate.js';
import { DOCS_CONTENT, DOCS_TOPICS } from './docs/index.js';

const EXPECTED_ANCHORS: Record<(typeof DOCS_TOPICS)[number], string> = {
  characters: '# Characters',
  backends: '# Backend Configs',
  workbench: '# Workbench',
  custom_backends: '# Custom Backends',
  request_scripts: '# Request Scripts',
  macros: '# Macros',
  regexes: '# Regex Rules',
  lorebooks: '# Lorebooks',
  prompt_lists: '# Prompt Lists',
  toolsets: '# Toolsets',
  quick_replies: '# Quick Replies',
  chats: '# Chats',
  game_cards: '# Game Cards',
  game_cards_factory: '# The Sunken Crypt',
  game_cards_events: '# The Guildhall',
};

describe('DocsTemplate', () => {
  const template = new DocsTemplate();

  it('exposes a single docs tool with the topic enum', () => {
    const def = template.getDefinition();
    expect(def.stateKey).toBe('docs');
    expect(def.tools).toHaveLength(1);
    const tool = def.tools[0]!;
    expect(tool.name).toBe('docs');
    expect(tool.endsTurn).toBeUndefined();
    const props = (tool.parameters as { properties: { topic: { enum: string[] } } }).properties;
    expect(props.topic.enum).toEqual([...DOCS_TOPICS]);
    expect(tool.description).toContain('characters');
    expect(tool.description).toContain('chats');
  });

  it('keeps topics and content in sync', () => {
    expect(Object.keys(DOCS_CONTENT).sort()).toEqual([...DOCS_TOPICS].sort());
    expect(Object.keys(EXPECTED_ANCHORS).sort()).toEqual([...DOCS_TOPICS].sort());
  });

  it.each([...DOCS_TOPICS])('returns markdown for topic "%s"', async (topic) => {
    const result = await template.execute('docs', { topic });
    expect(typeof result.content).toBe('string');
    const content = result.content as string;
    expect(content.length).toBeGreaterThan(500);
    expect(content).toContain(EXPECTED_ANCHORS[topic]);
  });

  it('rejects an unknown topic listing the valid ones', async () => {
    const result = await template.execute('docs', { topic: 'nonsense' });
    expect(result.content).toContain('Error');
    expect(result.content).toContain('characters');
    expect(result.content).toContain('custom_backends');
  });

  it('rejects missing args', async () => {
    const result = await template.execute('docs', {});
    expect(result.content).toContain('Error');
  });

  it('is stateless', () => {
    expect(template.serialize()).toBe('');
    expect(() => template.deserialize('anything')).not.toThrow();
  });
});
