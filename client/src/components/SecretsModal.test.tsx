import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@solidjs/testing-library';
import { SecretsModal } from './SecretsModal.js';

describe('SecretsModal', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as typeof fetch;
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue([]),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // @ts-expect-error restore global fetch
    globalThis.fetch = undefined;
  });

  it('renders the modal title and fetches the vault on mount', () => {
    render(() => <SecretsModal onClose={() => {}} />);
    expect(screen.getByRole('heading', { level: 2, name: 'Secrets' })).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledWith('/api/secrets', expect.anything());
  });

  it('shows the empty state when the vault has no entries', async () => {
    render(() => <SecretsModal onClose={() => {}} />);
    expect(await screen.findByText('No secrets stored yet.')).toBeInTheDocument();
  });

  it('displays secret entries from the vault', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue([{ key: 'openai-key', value: 'sk-resolved', label: 'OpenAI' }]),
    });
    render(() => <SecretsModal onClose={() => {}} />);
    expect(await screen.findByText('OpenAI')).toBeInTheDocument();
    expect(screen.getByText('openai-key')).toBeInTheDocument();
  });

  it('adds a secret via the form (POST)', async () => {
    render(() => <SecretsModal onClose={() => {}} />);
    fireEvent.click(screen.getByText('Add Secret'));
    fireEvent.input(screen.getByPlaceholderText('openai-key'), { target: { value: 'new-key' } });
    fireEvent.input(screen.getByPlaceholderText('OpenAI – Work'), { target: { value: 'My Key' } });
    fireEvent.input(screen.getByPlaceholderText('sk-...'), { target: { value: 'sk-new' } });
    fireEvent.click(screen.getByText('Save'));
    await vi.waitFor(() => {
      const post = fetchSpy.mock.calls.find((c) => (c[1] as RequestInit)?.method === 'POST');
      expect(post).toBeDefined();
      const body = JSON.parse((post![1] as RequestInit).body as string);
      expect(body).toEqual({ key: 'new-key', value: 'sk-new', label: 'My Key' });
    });
  });

  it('reveals a secret value on toggle', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue([{ key: 'k1', value: 'secret-value', label: 'K1' }]),
    });
    render(() => <SecretsModal onClose={() => {}} />);
    await screen.findByText('K1');
    expect(screen.queryByText('secret-value')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Reveal'));
    expect(screen.getByText('secret-value')).toBeInTheDocument();
  });
});
