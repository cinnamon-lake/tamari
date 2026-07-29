import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@solidjs/testing-library';
import { SchemaForm } from './SchemaForm.js';
import { fileToBase64 } from '../lib/fileToBase64.js';

vi.mock('../lib/fileToBase64.js', () => ({
  fileToBase64: vi.fn(async (file: File) => `b64:${file.name}`),
}));

const renderForm = (schema: Record<string, unknown>, value: Record<string, unknown> = {}) => {
  const onChange = vi.fn();
  const utils = render(() => <SchemaForm schema={schema} value={value} onChange={onChange} />);
  return { onChange, ...utils };
};

const setFiles = (input: HTMLInputElement, files: unknown) => {
  Object.defineProperty(input, 'files', { value: files, configurable: true });
};

describe('SchemaForm', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  describe('properties memo', () => {
    it('renders an empty form when the schema has no properties', () => {
      const { container } = renderForm({});
      expect(container.querySelector('.schema-form')).toBeInTheDocument();
      expect(container.querySelector('.schema-field')).not.toBeInTheDocument();
    });

    it('falls back to the key as label and hides the description when absent', () => {
      const { container } = renderForm({ properties: { api_key: { type: 'string' } } });
      expect(screen.getByText('api_key')).toBeInTheDocument();
      expect(container.querySelector('.schema-desc')).not.toBeInTheDocument();
    });
  });

  describe('string fields', () => {
    const schema = {
      properties: {
        host: { title: 'Host', description: 'Server host', type: 'string', default: 'localhost' },
      },
    };

    it('renders label, description and a text input with the schema default', () => {
      renderForm(schema);
      expect(screen.getByText('Host')).toBeInTheDocument();
      expect(screen.getByText('Server host')).toBeInTheDocument();
      expect(screen.getByDisplayValue('localhost')).toBeInTheDocument();
    });

    it('prefers the explicit value over the schema default', () => {
      renderForm(schema, { host: 'example.com' });
      expect(screen.getByDisplayValue('example.com')).toBeInTheDocument();
    });

    it('emits a merged object when the text input is edited', () => {
      const { onChange, container } = renderForm(schema, { other: 1 });
      const input = container.querySelector('#host input')!;
      fireEvent.input(input, { target: { value: 'new-host' } });
      expect(onChange).toHaveBeenCalledWith({ other: 1, host: 'new-host' });
    });
  });

  describe('number fields', () => {
    const schema = {
      properties: {
        timeout: { title: 'Timeout', type: 'number', default: 30 },
        retries: { title: 'Retries', type: 'integer' },
      },
    };

    it('renders number inputs with defaults applied', () => {
      const { container } = renderForm(schema);
      expect(container.querySelector<HTMLInputElement>('#timeout input')!.value).toBe('30');
      expect(container.querySelector<HTMLInputElement>('#retries input')!.value).toBe('0');
    });

    it('emits a number when edited', () => {
      const { onChange, container } = renderForm(schema);
      fireEvent.input(container.querySelector('#timeout input')!, { target: { value: '42.5' } });
      expect(onChange).toHaveBeenCalledWith({ timeout: 42.5 });
    });

    it('emits 0 when the input cannot be parsed as a number', () => {
      const { onChange, container } = renderForm(schema);
      fireEvent.input(container.querySelector('#retries input')!, { target: { value: '' } });
      expect(onChange).toHaveBeenCalledWith({ retries: 0 });
    });
  });

  describe('boolean fields', () => {
    const schema = {
      properties: {
        enabled: { title: 'Enabled', type: 'boolean', default: true },
        verbose: { title: 'Verbose', type: 'boolean' },
      },
    };

    it('renders checkboxes with defaults applied', () => {
      const { container } = renderForm(schema);
      expect(container.querySelector<HTMLInputElement>('#enabled input')!.checked).toBe(true);
      expect(container.querySelector<HTMLInputElement>('#verbose input')!.checked).toBe(false);
    });

    it('prefers the explicit value over the default', () => {
      const { container } = renderForm(schema, { enabled: false });
      expect(container.querySelector<HTMLInputElement>('#enabled input')!.checked).toBe(false);
    });

    it('emits the checked state when toggled', () => {
      const { onChange, container } = renderForm(schema);
      fireEvent.click(container.querySelector('#verbose input')!);
      expect(onChange).toHaveBeenCalledWith({ verbose: true });
    });
  });

  describe('textarea fields', () => {
    const schema = { properties: { notes: { title: 'Notes', format: 'textarea' } } };

    it('renders a textarea', () => {
      const { container } = renderForm(schema, { notes: 'hello' });
      const area = container.querySelector('#notes textarea');
      expect(area).toBeInTheDocument();
      expect((area as HTMLTextAreaElement).value).toBe('hello');
    });

    it('emits edits from the textarea', () => {
      const { onChange, container } = renderForm(schema);
      fireEvent.input(container.querySelector('#notes textarea')!, { target: { value: 'multi\nline' } });
      expect(onChange).toHaveBeenCalledWith({ notes: 'multi\nline' });
    });
  });

  describe('enum fields', () => {
    const schema = {
      properties: {
        mode: { title: 'Mode', enum: ['fast', 'slow'] },
        level: { title: 'Level', type: 'integer', enum: [1, 2, 3] },
        broken: { title: 'Broken', enum: [] },
      },
    };

    it('renders a select with one option per enum value and defaults to the first', () => {
      const { container } = renderForm(schema);
      const select = container.querySelector<HTMLSelectElement>('#mode select')!;
      expect(select.value).toBe('fast');
      expect(container.querySelectorAll('#mode option')).toHaveLength(2);
      expect(screen.getByText('slow')).toBeInTheDocument();
    });

    it('shows the current value when set', () => {
      const { container } = renderForm(schema, { mode: 'slow' });
      expect(container.querySelector<HTMLSelectElement>('#mode select')!.value).toBe('slow');
    });

    it('emits the raw string for string enums', () => {
      const { onChange, container } = renderForm(schema);
      fireEvent.change(container.querySelector('#mode select')!, { target: { value: 'slow' } });
      expect(onChange).toHaveBeenCalledWith({ mode: 'slow' });
    });

    it('coerces numeric-looking values to numbers', () => {
      const { onChange, container } = renderForm(schema);
      fireEvent.change(container.querySelector('#level select')!, { target: { value: '2' } });
      expect(onChange).toHaveBeenCalledWith({ level: 2 });
    });

    it('falls back to a text input when the enum list is empty', () => {
      const { container } = renderForm(schema);
      expect(container.querySelector('#broken select')).not.toBeInTheDocument();
      expect(container.querySelector('#broken input[type="text"]')).toBeInTheDocument();
    });
  });

  describe('secret fields', () => {
    const schema = { properties: { token: { title: 'Token', format: 'secret' } } };

    it('renders a password input with the current value', () => {
      const { container } = renderForm(schema, { token: 'sk-123' });
      const input = container.querySelector<HTMLInputElement>('#token input[type="password"]')!;
      expect(input).toBeInTheDocument();
      expect(input.value).toBe('sk-123');
    });

    it('emits edits from the password input', () => {
      const { onChange, container } = renderForm(schema);
      fireEvent.input(container.querySelector('#token input[type="password"]')!, { target: { value: 'sk-9' } });
      expect(onChange).toHaveBeenCalledWith({ token: 'sk-9' });
    });

    it('emits a secret:<key> reference when picked from the vault', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: vi.fn().mockResolvedValue([{ key: 'openai-key', value: 'sk-x', label: 'OpenAI' }]),
        })
      );
      const { onChange } = renderForm(schema);
      fireEvent.click(screen.getByRole('button', { name: 'Use vault secret' }));
      fireEvent.click(await screen.findByText('OpenAI'));
      expect(onChange).toHaveBeenCalledWith({ token: 'secret:openai-key' });
    });
  });

  describe('single file fields', () => {
    const schema = { properties: { avatar: { title: 'Avatar', format: 'file' } } };

    it('renders a file input when no file is selected', () => {
      const { container } = renderForm(schema);
      const input = container.querySelector<HTMLInputElement>('#avatar input[type="file"]')!;
      expect(input).toBeInTheDocument();
      expect(input.multiple).toBe(false);
    });

    it('converts the chosen file to base64 and emits it', async () => {
      const { onChange, container } = renderForm(schema);
      const input = container.querySelector('#avatar input[type="file"]')!;
      fireEvent.change(input, { target: { files: [new File(['x'], 'doc.txt', { type: 'text/plain' })] } });
      await waitFor(() => expect(onChange).toHaveBeenCalledWith({ avatar: 'b64:doc.txt' }));
      expect(fileToBase64).toHaveBeenCalled();
    });

    it('does nothing when the change event carries no file', () => {
      const { onChange, container } = renderForm(schema);
      const input = container.querySelector<HTMLInputElement>('#avatar input[type="file"]')!;
      setFiles(input, null);
      fireEvent.change(input);
      expect(onChange).not.toHaveBeenCalled();
    });

    it('shows the selected state and clears it', () => {
      const { onChange, container } = renderForm(schema, { avatar: 'data:image/png;base64,AA' });
      expect(screen.getByText('File selected')).toBeInTheDocument();
      expect(container.querySelector('#avatar input[type="file"]')).not.toBeInTheDocument();
      fireEvent.click(screen.getByText('Clear'));
      expect(onChange).toHaveBeenCalledWith({ avatar: '' });
    });
  });

  describe('multiple file fields', () => {
    const schema = { properties: { docs: { title: 'Docs', format: 'file', multiple: true } } };

    it('renders a multiple file input when the list is empty', () => {
      const { container } = renderForm(schema);
      const input = container.querySelector<HTMLInputElement>('#docs input[type="file"]')!;
      expect(input).toBeInTheDocument();
      expect(input.multiple).toBe(true);
    });

    it('converts all chosen files and emits the array', async () => {
      const { onChange, container } = renderForm(schema);
      const input = container.querySelector('#docs input[type="file"]')!;
      fireEvent.change(input, {
        target: {
          files: [new File(['a'], 'a.txt'), new File(['b'], 'b.txt')],
        },
      });
      await waitFor(() => expect(onChange).toHaveBeenCalledWith({ docs: ['b64:a.txt', 'b64:b.txt'] }));
    });

    it('does nothing when the change event carries an empty file list', () => {
      const { onChange, container } = renderForm(schema);
      const input = container.querySelector<HTMLInputElement>('#docs input[type="file"]')!;
      setFiles(input, []);
      fireEvent.change(input);
      expect(onChange).not.toHaveBeenCalled();
    });

    it('lists existing files and removes one by index', () => {
      const { onChange, container } = renderForm(schema, { docs: ['x', 'y'] });
      expect(screen.getByText('File 1')).toBeInTheDocument();
      expect(screen.getByText('File 2')).toBeInTheDocument();
      const removeButtons = container.querySelectorAll('.schema-file-item .schema-btn');
      expect(removeButtons).toHaveLength(2);
      fireEvent.click(removeButtons[0]!);
      expect(onChange).toHaveBeenCalledWith({ docs: ['y'] });
    });

    it('ignores a null file list on the append input', () => {
      const { onChange, container } = renderForm(schema, { docs: ['x'] });
      const input = container.querySelector<HTMLInputElement>('.schema-file-list input[type="file"]')!;
      setFiles(input, null);
      fireEvent.change(input);
      expect(onChange).not.toHaveBeenCalled();
    });

    it('appends files through the input rendered below the list', async () => {
      const { onChange, container } = renderForm(schema, { docs: ['x'] });
      const input = container.querySelector('.schema-file-list input[type="file"]')!;
      fireEvent.change(input, { target: { files: [new File(['c'], 'c.txt')] } });
      await waitFor(() => expect(onChange).toHaveBeenCalledWith({ docs: ['x', 'b64:c.txt'] }));
    });
  });
});
