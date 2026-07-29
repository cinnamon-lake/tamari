import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@solidjs/testing-library';
import type { Character } from '@tamari/types';
import { CharacterEditor } from './CharacterEditor.js';

// NB: the WebSocketBus module is intentionally NOT mocked — the global
// MockWebSocket (src/test/setup.ts) makes the real bus harmless, and mocking
// the bus module corrupts Solid's disposal tree (node.cleanups errors).
vi.mock('../../stores/popupStore.js', () => ({
  confirmPopup: vi.fn(async () => true),
  alertPopup: vi.fn(async () => undefined),
}));

function makeCharacter(overrides: Partial<Character> = {}): Character {
  return {
    id: 'char-1',
    name: 'Test Character',
    description: 'A description',
    personality: 'Brave',
    scenario: 'A scenario',
    firstMes: 'Hello!',
    mesExample: '',
    creator: 'someone',
    characterVersion: '1.0',
    tags: ['npc'],
    avatarPath: null,
    avatarThumbnailPath: null,
    creatorNotes: '',
    systemPrompt: '',
    postHistoryInstructions: '',
    alternateGreetings: ['Hi again'],
    groupOnlyGreetings: ['Group hi'],
    nickname: '',
    creatorNotesMultilingual: {},
    source: [],
    extensions: {},
    createDate: '',
    worldInfoId: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('CharacterEditor tabs', () => {
  it('shows the content tab by default with the main prompt fields', () => {
    render(() => <CharacterEditor character={makeCharacter()} onClose={() => {}} />);

    expect(screen.getByRole('tab', { name: 'Content' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByDisplayValue('A description')).toBeInTheDocument();
    expect(screen.getByDisplayValue('A scenario')).toBeInTheDocument();
    // Other tabs' content is hidden
    expect(screen.queryByText('Alternate Greetings')).toBeNull();
    expect(screen.queryByText(/Regex Scripts/)).toBeNull();
  });

  it('switches to the greetings tab with both greeting lists', () => {
    render(() => <CharacterEditor character={makeCharacter()} onClose={() => {}} />);

    screen.getByRole('tab', { name: 'Greetings' }).click();
    expect(screen.getByRole('tab', { name: 'Greetings' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Alternate Greetings')).toBeInTheDocument();
    expect(screen.getByText('Group-Only Greetings')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Hi again')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Group hi')).toBeInTheDocument();
    // Content tab fields are gone
    expect(screen.queryByDisplayValue('A description')).toBeNull();
  });

  it('switches to the logic tab with regex and backend sections', () => {
    render(() => <CharacterEditor character={makeCharacter()} onClose={() => {}} />);

    screen.getByRole('tab', { name: 'Logic & Rules' }).click();
    expect(screen.getByText(/Regex Scripts/)).toBeInTheDocument();
    expect(screen.getByText(/Backend Logic/)).toBeInTheDocument();
    expect(screen.queryByDisplayValue('A description')).toBeNull();
  });

  it('switches to the advanced tab with metadata fields', () => {
    render(() => <CharacterEditor character={makeCharacter()} onClose={() => {}} />);

    screen.getByRole('tab', { name: 'Advanced' }).click();
    expect(screen.getByText('System Prompt')).toBeInTheDocument();
    expect(screen.getByDisplayValue('someone')).toBeInTheDocument();
    expect(screen.getByDisplayValue('1.0')).toBeInTheDocument();
  });
});
