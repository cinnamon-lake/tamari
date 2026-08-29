import { For, Show, createMemo, createSignal } from 'solid-js';
import { z } from 'zod';
import { fileToBase64 } from '../lib/fileToBase64.js';
import { useI18n } from '../i18n/index.js';
import { SecretPicker } from './SecretPicker.js';
import './SchemaForm.css';

export interface SchemaFormProps {
  schema: Record<string, unknown>;
  value: Record<string, unknown>;
  onChange?: (value: Record<string, unknown>) => void;
  /** Per-field commit callback, fired (before onChange) whenever a field commits. */
  onFieldChange?: (key: string, value: unknown) => void;
  /**
   * 'default' renders the standalone schema-* layout (label above control).
   * 'inline' renders the settings-modal layout instead: labels wrap their
   * control (`field-label` / `checkbox-row` / `radio-row` hooks), hints render
   * as `hint-text`, and text-like controls (text/number/range/textarea) stage
   * edits locally on `input` and commit on `change` — so a toggle elsewhere in
   * the form cannot clobber an uncommitted draft.
   */
  variant?: 'default' | 'inline';
}

interface FieldOption {
  value: string | number;
  label: string;
}

/** Boolean predicate against the form's current value record. */
interface FieldPredicate {
  key: string;
  is: boolean;
}

/** Live value readout for range controls, e.g. `{value}x` → `1.00x`. */
interface ValueHint {
  format: string;
  decimals?: number;
  /** Shown instead of the format when the numeric value is 0 (e.g. "Off"). */
  offLabel?: string;
}

interface FieldDef {
  key: string;
  label: string;
  description: string;
  type: string;
  format: string;
  multiple: boolean;
  defaultValue: unknown;
  enumValues: (string | number)[] | undefined;
  /** Enum with display labels (inline variant selects/radios). */
  options: FieldOption[] | undefined;
  /** CSS class for rendered <option> elements (defaults to select-option). */
  optionClass: string | undefined;
  min: number | undefined;
  max: number | undefined;
  step: number | undefined;
  rows: number | undefined;
  placeholder: string | undefined;
  /** Render the hint as a sibling after the label instead of inside it. */
  hintOutside: boolean;
  disabledWhen: FieldPredicate | undefined;
  visibleWhen: FieldPredicate | undefined;
  valueHint: ValueHint | undefined;
}

const FieldOptionSchema = z.object({
  value: z.union([z.string(), z.number()]),
  label: z.string(),
});

const FieldPredicateSchema = z.object({
  key: z.string(),
  is: z.boolean(),
});

const ValueHintSchema = z.object({
  format: z.string(),
  decimals: z.number().optional(),
  offLabel: z.string().optional(),
});

// Boundary parse for the JSON-schema fragments the form understands. Fields that
// don't match are skipped rather than cast (AGENTS.md §11).
const FieldPropSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  type: z.string().optional(),
  format: z.string().optional(),
  multiple: z.boolean().optional(),
  default: z.unknown().optional(),
  enum: z.array(z.union([z.string(), z.number()])).optional(),
  options: z.array(FieldOptionSchema).optional(),
  optionClass: z.string().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  rows: z.number().optional(),
  placeholder: z.string().optional(),
  hintOutside: z.boolean().optional(),
  disabledWhen: FieldPredicateSchema.optional(),
  visibleWhen: FieldPredicateSchema.optional(),
  valueHint: ValueHintSchema.optional(),
});

const PropertiesSchema = z.record(z.string(), z.unknown());

export function SchemaForm(props: SchemaFormProps) {
  const { t } = useI18n();
  const properties = createMemo((): FieldDef[] => {
    const propsMap = PropertiesSchema.safeParse(props.schema.properties);
    if (!propsMap.success) return [];
    const fields: FieldDef[] = [];
    for (const [key, raw] of Object.entries(propsMap.data)) {
      const parsed = FieldPropSchema.safeParse(raw);
      if (!parsed.success) continue;
      const prop = parsed.data;
      fields.push({
        key,
        label: prop.title ?? key,
        description: prop.description ?? '',
        type: prop.type ?? 'string',
        format: prop.format ?? '',
        multiple: prop.multiple ?? false,
        defaultValue: prop.default,
        enumValues: prop.enum,
        options: prop.options,
        optionClass: prop.optionClass,
        min: prop.min,
        max: prop.max,
        step: prop.step,
        rows: prop.rows,
        placeholder: prop.placeholder,
        hintOutside: prop.hintOutside ?? false,
        disabledWhen: prop.disabledWhen,
        visibleWhen: prop.visibleWhen,
        valueHint: prop.valueHint,
      });
    }
    return fields;
  });

  const getValue = (key: string, def: unknown) => {
    const v = props.value[key];
    return v !== undefined ? v : def;
  };

  const setValue = (key: string, v: unknown) => {
    props.onFieldChange?.(key, v);
    props.onChange?.({ ...props.value, [key]: v });
  };

  // Inline variant: uncommitted edits for text-like controls. Committing one
  // field replaces the parent's value record, which would reset every other
  // controlled input to its last committed value — the draft record keeps
  // in-progress typing safe until `change` commits it.
  const [drafts, setDrafts] = createSignal<Record<string, string>>({});
  const displayValue = (field: FieldDef): unknown => {
    const draft = drafts()[field.key];
    return draft !== undefined ? draft : getValue(field.key, field.defaultValue);
  };
  const stage = (key: string, raw: string) => setDrafts((p) => ({ ...p, [key]: raw }));
  const commitDraft = (field: FieldDef, raw: string) => {
    setDrafts((p) => {
      const next = { ...p };
      delete next[field.key];
      return next;
    });
    const numeric = field.type === 'number' || field.type === 'integer' || field.format === 'range';
    setValue(field.key, numeric ? Number(raw) : raw);
  };

  const isDisabled = (field: FieldDef): boolean =>
    field.disabledWhen !== undefined && Boolean(props.value[field.disabledWhen.key]) === field.disabledWhen.is;
  const isVisible = (field: FieldDef): boolean =>
    field.visibleWhen === undefined || Boolean(props.value[field.visibleWhen.key]) === field.visibleWhen.is;

  // String coercion for control bindings (String(unknown) trips no-base-to-string).
  const asDisplayString = (v: unknown): string => {
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return '';
  };

  const formatValueHint = (field: FieldDef, v: unknown): string => {
    const hint = field.valueHint;
    if (!hint) return '';
    const n = Number(v);
    if (hint.offLabel !== undefined && n === 0) return hint.offLabel;
    return hint.format.replace('{value}', (Number.isNaN(n) ? 0 : n).toFixed(hint.decimals ?? 0));
  };

  // Settings-modal layout: label wraps the control so assistive tech and
  // selector-based tooling (e2e, user CSS) keep working per-field.
  const renderInlineField = (field: FieldDef) => {
    const hintInside = () =>
      field.description && !field.hintOutside ? <span class="hint-text">{field.description}</span> : null;
    const hintOutside = () =>
      field.description && field.hintOutside ? <span class="hint-text">{field.description}</span> : null;

    if (field.format === 'radio') {
      return (
        <div class="settings-radio-group">
          <span class="settings-radio-label">{field.label}</span>
          <For each={field.options ?? []}>
            {(opt) => (
              <label class="radio-row">
                <input
                  type="radio"
                  name={field.key}
                  class="radio"
                  value={String(opt.value)}
                  checked={asDisplayString(displayValue(field)) === String(opt.value)}
                  disabled={isDisabled(field)}
                  onChange={() => setValue(field.key, opt.value)}
                />
                {opt.label}
              </label>
            )}
          </For>
        </div>
      );
    }

    if (field.type === 'boolean') {
      return (
        <>
          <label class="checkbox-row">
            <input
              type="checkbox"
              class="checkbox"
              data-testid={`setting-${field.key}`}
              checked={Boolean(displayValue(field))}
              disabled={isDisabled(field)}
              onChange={(e) => setValue(field.key, e.currentTarget.checked)}
            />
            {field.label}
            {hintInside()}
          </label>
          {hintOutside()}
        </>
      );
    }

    if (field.options && field.options.length > 0) {
      return (
        <label class="field-label">
          {field.label}
          <select
            class="select"
            data-testid={`setting-${field.key}`}
            value={asDisplayString(displayValue(field))}
            disabled={isDisabled(field)}
            onChange={(e) => setValue(field.key, e.currentTarget.value)}
          >
            <For each={field.options}>
              {(opt) => (
                <option class={field.optionClass ?? 'select-option'} value={String(opt.value)}>
                  {opt.label}
                </option>
              )}
            </For>
          </select>
          {hintInside()}
        </label>
      );
    }

    if (field.format === 'range') {
      return (
        <label class="field-label">
          {field.label}
          <input
            type="range"
            class="range-input"
            data-testid={`setting-${field.key}`}
            min={field.min}
            max={field.max}
            step={field.step}
            value={asDisplayString(displayValue(field))}
            disabled={isDisabled(field)}
            onInput={(e) => stage(field.key, e.currentTarget.value)}
            onChange={(e) => commitDraft(field, e.currentTarget.value)}
          />
          <span class="hint-text">{formatValueHint(field, displayValue(field))}</span>
        </label>
      );
    }

    if (field.type === 'number' || field.type === 'integer') {
      return (
        <label class="field-label">
          {field.label}
          <input
            type="number"
            class="input"
            data-testid={`setting-${field.key}`}
            min={field.min}
            max={field.max}
            step={field.step}
            value={asDisplayString(displayValue(field))}
            disabled={isDisabled(field)}
            onInput={(e) => stage(field.key, e.currentTarget.value)}
            onChange={(e) => commitDraft(field, e.currentTarget.value)}
          />
          {hintInside()}
        </label>
      );
    }

    if (field.format === 'textarea') {
      return (
        <label class="field-label">
          {field.label}
          <textarea
            class="textarea"
            data-testid={`setting-${field.key}`}
            rows={field.rows ?? 3}
            value={asDisplayString(displayValue(field))}
            placeholder={field.placeholder}
            disabled={isDisabled(field)}
            onInput={(e) => stage(field.key, e.currentTarget.value)}
            onChange={(e) => commitDraft(field, e.currentTarget.value)}
          />
          {hintInside()}
        </label>
      );
    }

    return (
      <label class="field-label">
        {field.label}
        <input
          type="text"
          class="input"
          data-testid={`setting-${field.key}`}
          value={asDisplayString(displayValue(field))}
          placeholder={field.placeholder}
          disabled={isDisabled(field)}
          onInput={(e) => stage(field.key, e.currentTarget.value)}
          onChange={(e) => commitDraft(field, e.currentTarget.value)}
        />
        {hintInside()}
      </label>
    );
  };

  return (
    <div class={props.variant === 'inline' ? 'schema-form-inline' : 'schema-form'}>
      <For each={properties()}>
        {(field) => (
          <Show when={isVisible(field)}>
            {props.variant === 'inline' ? (
              renderInlineField(field)
            ) : (
              <div id={field.key} class="schema-field">
                <label class="schema-label">
                  {field.label}
                  <Show when={field.description}>
                    <span class="schema-desc">{field.description}</span>
                  </Show>
                </label>

                <Show
                  when={field.enumValues && field.enumValues.length > 0}
                  fallback={
                    <Show
                      when={field.type === 'boolean'}
                      fallback={
                        <Show
                          when={field.type === 'number' || field.type === 'integer'}
                          fallback={
                            <Show
                              when={field.format === 'textarea'}
                              fallback={
                                <Show
                                  when={field.format === 'file'}
                                  fallback={
                                    field.format === 'secret' ? (
                                      <span class="flex-row-sm">
                                        <input
                                          type="password"
                                          class="schema-input"
                                          value={String(getValue(field.key, field.defaultValue ?? ''))}
                                          onInput={(e) => setValue(field.key, e.currentTarget.value)}
                                        />
                                        <SecretPicker onPick={(ref) => setValue(field.key, ref)} />
                                      </span>
                                    ) : (
                                      <input
                                        type="text"
                                        class="schema-input"
                                        value={String(getValue(field.key, field.defaultValue ?? ''))}
                                        onInput={(e) => setValue(field.key, e.currentTarget.value)}
                                      />
                                    )
                                  }
                                >
                                  <Show
                                    when={field.multiple}
                                    fallback={
                                      <Show
                                        when={!getValue(field.key, field.defaultValue ?? '')}
                                        fallback={
                                          <div class="schema-file-selected">
                                            <span class="schema-file-selected-label">
                                              {t('schemaForm.fileSelected')}
                                            </span>
                                            <button
                                              type="button"
                                              class="schema-btn"
                                              onClick={() => setValue(field.key, '')}
                                            >
                                              {t('common.clear')}
                                            </button>
                                          </div>
                                        }
                                      >
                                        <input
                                          type="file"
                                          class="schema-input"
                                          onChange={async (e) => {
                                            const file = e.currentTarget.files?.[0];
                                            if (!file) return;
                                            const data = await fileToBase64(file);
                                            setValue(field.key, data);
                                          }}
                                        />
                                      </Show>
                                    }
                                  >
                                    <Show
                                      when={(getValue(field.key, field.defaultValue ?? []) as string[]).length > 0}
                                      fallback={
                                        <input
                                          type="file"
                                          multiple
                                          class="schema-input"
                                          onChange={async (e) => {
                                            const files = e.currentTarget.files;
                                            if (!files || files.length === 0) return;
                                            const current = (getValue(field.key, []) as string[]).slice();
                                            for (const file of Array.from(files)) {
                                              const data = await fileToBase64(file);
                                              current.push(data);
                                            }
                                            setValue(field.key, current);
                                          }}
                                        />
                                      }
                                    >
                                      <div class="schema-file-list">
                                        <For each={getValue(field.key, []) as string[]}>
                                          {(_item, index) => (
                                            <div class="schema-file-item">
                                              <span class="schema-file-item-label">
                                                {t('schemaForm.fileLabel', { n: index() + 1 })}
                                              </span>
                                              <button
                                                type="button"
                                                class="schema-btn"
                                                onClick={() => {
                                                  const current = (getValue(field.key, []) as string[]).slice();
                                                  current.splice(index(), 1);
                                                  setValue(field.key, current);
                                                }}
                                              >
                                                Remove
                                              </button>
                                            </div>
                                          )}
                                        </For>
                                        <input
                                          type="file"
                                          multiple
                                          class="schema-input"
                                          onChange={async (e) => {
                                            const files = e.currentTarget.files;
                                            if (!files || files.length === 0) return;
                                            const current = (getValue(field.key, []) as string[]).slice();
                                            for (const file of Array.from(files)) {
                                              const data = await fileToBase64(file);
                                              current.push(data);
                                            }
                                            setValue(field.key, current);
                                          }}
                                        />
                                      </div>
                                    </Show>
                                  </Show>
                                </Show>
                              }
                            >
                              <textarea
                                class="schema-input"
                                rows={3}
                                value={String(getValue(field.key, field.defaultValue ?? ''))}
                                onInput={(e) => setValue(field.key, e.currentTarget.value)}
                              />
                            </Show>
                          }
                        >
                          <input
                            type="number"
                            class="schema-input"
                            value={Number(getValue(field.key, field.defaultValue ?? 0))}
                            onInput={(e) => {
                              const n = e.currentTarget.valueAsNumber;
                              setValue(field.key, Number.isNaN(n) ? 0 : n);
                            }}
                          />
                        </Show>
                      }
                    >
                      <input
                        type="checkbox"
                        class="schema-checkbox"
                        checked={Boolean(getValue(field.key, field.defaultValue ?? false))}
                        onChange={(e) => setValue(field.key, e.currentTarget.checked)}
                      />
                    </Show>
                  }
                >
                  <select
                    class="schema-select"
                    value={String(getValue(field.key, field.enumValues?.[0] ?? ''))}
                    onChange={(e) => {
                      const val = e.currentTarget.value;
                      const num = Number(val);
                      setValue(field.key, Number.isNaN(num) ? val : num);
                    }}
                  >
                    <For each={field.enumValues ?? []}>
                      {(opt, index) => (
                        <option id={`enum-${index()}`} class="schema-option" value={String(opt)}>
                          {String(opt)}
                        </option>
                      )}
                    </For>
                  </select>
                </Show>
              </div>
            )}
          </Show>
        )}
      </For>
    </div>
  );
}
