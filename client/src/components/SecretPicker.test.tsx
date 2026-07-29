import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@solidjs/testing-library';
import { SecretPicker } from './SecretPicker.js';

describe('SecretPicker', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // @ts-expect-error restore global fetch
    globalThis.fetch = undefined;
  });

  it('renders the vault key button', () => {
    render(() => <SecretPicker onPick={() => {}} />);
    expect(screen.getByRole('button', { name: 'Use vault secret' })).toBeInTheDocument();
  });

  it('lists secrets on click and calls onPick with secret:<key>', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue([{ key: 'openai-key', value: 'sk-x', label: 'OpenAI' }]),
    });
    const onPick = vi.fn();
    render(() => <SecretPicker onPick={onPick} />);
    fireEvent.click(screen.getByRole('button', { name: 'Use vault secret' }));
    const entry = await screen.findByText('OpenAI');
    fireEvent.click(entry);
    expect(onPick).toHaveBeenCalledWith('secret:openai-key');
  });

  it('shows the no-secrets message when the vault is empty', async () => {
    fetchSpy.mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue([]) });
    render(() => <SecretPicker onPick={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Use vault secret' }));
    expect(await screen.findByText('No secrets in the vault. Add one first.')).toBeInTheDocument();
  });
});
