import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@solidjs/testing-library';
import { ErrorBoundary } from 'solid-js';
import { StatsModal } from './StatsModal.js';

describe('StatsModal', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const mockStats = {
    totalCharacters: 5,
    totalChats: 12,
    totalMessages: 340,
    totalGenerations: 120,
    totalPromptTokens: 45000,
    totalCompletionTokens: 12000,
    chats: [
      { chatId: 'c1', chatName: 'Chat One', messageCount: 50, lastActivity: 1700000000 },
      { chatId: 'c2', chatName: 'Chat Two', messageCount: 30, lastActivity: null },
    ],
    characters: [
      { characterId: 'ch1', characterName: 'Alice', chatCount: 3, totalMessages: 80 },
      { characterId: 'ch2', characterName: 'Bob', chatCount: 2, totalMessages: 45 },
    ],
  };

  it('shows loading state initially', () => {
    (globalThis.fetch as any).mockImplementation(() => new Promise(() => {}));
    render(() => <StatsModal onClose={() => {}} />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('renders stats after loading', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(mockStats),
    });

    render(() => <StatsModal onClose={() => {}} />);

    // Wait for createResource to resolve
    await screen.findByText('5');

    expect(screen.getAllByText('Characters').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('340')).toBeInTheDocument();
    expect(screen.getByText('120')).toBeInTheDocument();
  });

  it('renders character and chat tables', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(mockStats),
    });

    render(() => <StatsModal onClose={() => {}} />);
    await screen.findByText('Alice');

    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('Chat One')).toBeInTheDocument();
    expect(screen.getByText('Chat Two')).toBeInTheDocument();
  });

  it('shows error state when fetch fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve({ ok: false, status: 500 } as Response)
    );

    render(() => (
      <ErrorBoundary fallback={<p class="error">Failed to load stats</p>}>
        <StatsModal onClose={() => {}} />
      </ErrorBoundary>
    ));
    await new Promise((r) => setTimeout(r, 50));

    expect(screen.getByText('Failed to load stats')).toBeInTheDocument();
  });

  it('calls onClose when close button clicked', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(mockStats),
    });

    const onClose = vi.fn();
    render(() => <StatsModal onClose={onClose} />);
    await screen.findByText('Close');

    screen.getByText('Close').click();
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onClose when overlay clicked', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(mockStats),
    });

    const onClose = vi.fn();
    const { container } = render(() => <StatsModal onClose={onClose} />);
    await screen.findByText('5');

    const overlay = container.querySelector('.modal-overlay')!;
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalled();
  });

  it('formats dates correctly', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(mockStats),
    });

    render(() => <StatsModal onClose={() => {}} />);
    await screen.findByText('Chat One');

    const dateStr = new Date(1700000000 * 1000).toLocaleDateString();
    expect(screen.getByText(dateStr)).toBeInTheDocument();
    expect(screen.getAllByText('Never').length).toBeGreaterThanOrEqual(1);
  });
});
