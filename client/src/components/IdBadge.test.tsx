import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@solidjs/testing-library';
import { IdBadge } from './IdBadge.js';

describe('IdBadge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the full id', () => {
    render(() => <IdBadge id="df8a976c-db3b-4f1a-97fa-5a76d65c7c0b" />);
    expect(screen.getByText('df8a976c-db3b-4f1a-97fa-5a76d65c7c0b')).toBeInTheDocument();
  });

  it('copies the id to the clipboard on click and shows feedback', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    render(() => <IdBadge id="abc-123" />);
    screen.getByTitle('Copy ID').click();

    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('abc-123'));
    await screen.findByText('Copied!');
  });

  it('iconOnly hides the id text and exposes it in the tooltip', () => {
    render(() => <IdBadge id="abc-123" iconOnly />);
    expect(screen.queryByText('abc-123')).not.toBeInTheDocument();
    expect(screen.getByTitle('Copy ID: abc-123')).toBeInTheDocument();
  });

  it('does not propagate clicks to a surrounding clickable region', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const parentClick = vi.fn();

    render(() => (
      <div onClick={parentClick}>
        <IdBadge id="abc-123" iconOnly />
      </div>
    ));
    screen.getByTitle('Copy ID: abc-123').click();

    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('abc-123'));
    expect(parentClick).not.toHaveBeenCalled();
  });
});
