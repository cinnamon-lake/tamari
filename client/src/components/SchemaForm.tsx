import { For, Show, createMemo } from 'solid-js';
import { z } from 'zod';
import { fileToBase64 } from '../lib/fileToBase64.js';
import { useI18n } from '../i18n/index.js';
import { SecretPicker } from './SecretPicker.js';
import './SchemaForm.css';

export interface SchemaFormProps {
  schema: Record<string, unknown>;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
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
}

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
      });
    }
    return fields;
  });

  const getValue = (key: string, def: unknown) => {
    const v = props.value[key];
    return v !== undefined ? v : def;
  };

  const setValue = (key: string, v: unknown) => {
    props.onChange({ ...props.value, [key]: v });
  };

  return (
    <div class="schema-form">
      <For each={properties()}>
        {(field) => (
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
                                        <span class="schema-file-selected-label">{t('schemaForm.fileSelected')}</span>
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
                                  when={
                                    (getValue(field.key, field.defaultValue ?? []) as string[])
                                      .length > 0
                                  }
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
                                    <For
                                      each={getValue(field.key, []) as string[]}
                                    >
                                      {(_item, index) => (
                                        <div class="schema-file-item">
                                          <span class="schema-file-item-label">{t('schemaForm.fileLabel', { n: index() + 1 })}</span>
                                          <button
                                            type="button"
                                            class="schema-btn"
                                            onClick={() => {
                                              const current = (
                                                getValue(field.key, []) as string[]
                                              ).slice();
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
                                        const current = (
                                          getValue(field.key, []) as string[]
                                        ).slice();
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
                  {(opt, index) => <option id={`enum-${index()}`} class="schema-option" value={String(opt)}>{String(opt)}</option>}
                </For>
              </select>
            </Show>
          </div>
        )}
      </For>
    </div>
  );
}
