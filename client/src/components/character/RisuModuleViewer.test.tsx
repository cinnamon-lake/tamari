import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@solidjs/testing-library';
import { RisuModuleViewer } from './RisuModuleViewer.js';

const MODULE_META = {
  id: 'mod-1',
  name: 'Porting Reference',
  namespace: 'risu-ns',
  source: 'attached',
  filePath: 'character_modules/char-1/mod-1.json',
  counts: { triggers: 2, regex: 1, lorebook: 3, assets: 4 },
  hasLua: true,
  lowLevelAccess: false,
};

const INFO_SECTION = { name: 'Porting Reference', description: 'a module', namespace: 'risu-ns' };

const TRIGGERS_SECTION = [
  { index: 0, type: 'start', comment: 'on start', effectCount: 2, conditionCount: 0, hasLua: true },
  { index: 1, type: 'output', comment: '', effectCount: 1, conditionCount: 1, hasLua: false },
];

const TRIGGER_DETAIL = { type: 'start', conditions: [], effect: [{ type: 'triggerlua', code: 'x = 1' }] };

function jsonResponse(body: unknown) {
  return { ok: true, json: () => Promise.resolve(body) } as Response;
}

function mockFetch(listBody: unknown) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('section=trigger&')) return Promise.resolve(jsonResponse(TRIGGER_DETAIL));
    if (url.includes('section=triggers')) return Promise.resolve(jsonResponse(TRIGGERS_SECTION));
    if (url.includes('section=info')) return Promise.resolve(jsonResponse(INFO_SECTION));
    if (url.endsWith('/risu-modules')) return Promise.resolve(jsonResponse(listBody));
    if (url.endsWith('/risu-module')) {
      // POST /characters/:id/risu-module (direct attach)
      return Promise.resolve(jsonResponse({ success: true, module: MODULE_META, assetsStored: 2 }));
    }
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) } as Response);
  });
}

describe('RisuModuleViewer', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch({ total: 1, modules: [MODULE_META] }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const expand = async () => {
    const toggle = await screen.findByText('RisuAI modules (imported) (1)');
    fireEvent.click(toggle);
  };

  it('shows only the attach control when the character has no modules', async () => {
    vi.stubGlobal('fetch', mockFetch({ total: 0, modules: [] }));
    render(() => <RisuModuleViewer characterId="char-1" />);
    // Give the list fetch a tick to resolve.
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(screen.queryByText(/RisuAI modules \(imported\)/)).not.toBeInTheDocument();
    expect(screen.getByText('Attach .risum…')).toBeInTheDocument();
  });

  it('attaches a .risum file directly to the character and refreshes the list', async () => {
    const fetchMock = mockFetch({ total: 0, modules: [] });
    vi.stubGlobal('fetch', fetchMock);
    render(() => <RisuModuleViewer characterId="char-1" />);
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    fireEvent.change(input, { target: { files: [new File(['x'], 'mod.risum')] } });

    // POST went to the direct attach route with multipart form data…
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/characters/char-1/risu-module'),
        expect.objectContaining({ method: 'POST', body: expect.any(FormData) }),
      ),
    );
    // …and the success note renders with the attached module's name.
    await screen.findByText(/Attached "Porting Reference"/);
  });

  it('shows the server error when attach fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/risu-module')) {
          return Promise.resolve({
            ok: false,
            status: 400,
            json: () => Promise.resolve({ error: 'Not a .risum file: bad magic byte' }),
          } as Response);
        }
        if (url.endsWith('/risu-modules')) return Promise.resolve(jsonResponse({ total: 0, modules: [] }));
        return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) } as Response);
      }),
    );
    render(() => <RisuModuleViewer characterId="char-1" />);
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'], 'bad.risum')] } });
    await screen.findByText(/bad magic byte/);
  });

  it('lists modules with namespace and count badges', async () => {
    render(() => <RisuModuleViewer characterId="char-1" />);
    await expand();
    expect(screen.getByText('Porting Reference')).toBeInTheDocument();
    expect(screen.getByText(/risu-ns/)).toBeInTheDocument();
    expect(screen.getByText(/2 triggers · 1 regex · 3 lorebook · 4 assets/)).toBeInTheDocument();
    expect(screen.getByText(/· Lua/)).toBeInTheDocument();
  });

  it('shows the info section as pretty-printed JSON after selecting a module', async () => {
    render(() => <RisuModuleViewer characterId="char-1" />);
    await expand();
    fireEvent.click(screen.getByText('Porting Reference'));
    await screen.findByText(/"description": "a module"/);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/characters/char-1/risu-modules/mod-1?section=info'),
      expect.anything(),
    );
  });

  it('shows trigger summaries and loads a full trigger by index', async () => {
    render(() => <RisuModuleViewer characterId="char-1" />);
    await expand();
    fireEvent.click(screen.getByText('Porting Reference'));
    await screen.findByText(/"description": "a module"/);

    fireEvent.click(screen.getByText('Triggers'));
    await screen.findByText('#0 start — on start');
    expect(screen.getByText('#1 output')).toBeInTheDocument();
    expect(screen.getByText(/2 effects · 0 conditions/)).toBeInTheDocument();

    fireEvent.click(screen.getAllByText('View')[0]!);
    await screen.findByText(/"type": "triggerlua"/);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('section=trigger&index=0'),
      expect.anything(),
    );
  });

  it('switches to the regex section and pretty-prints it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('section=regex')) return Promise.resolve(jsonResponse([{ in: 'a', out: 'b' }]));
        if (url.includes('section=info')) return Promise.resolve(jsonResponse(INFO_SECTION));
        if (url.endsWith('/risu-modules')) return Promise.resolve(jsonResponse({ total: 1, modules: [MODULE_META] }));
        return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) } as Response);
      }),
    );
    render(() => <RisuModuleViewer characterId="char-1" />);
    await expand();
    fireEvent.click(screen.getByText('Porting Reference'));
    await screen.findByText(/"description": "a module"/);

    fireEvent.click(screen.getByText('Regex'));
    await screen.findByText(/"in": "a"/);
  });
});
