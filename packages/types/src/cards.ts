import { z } from 'zod';

// ---------------------------------------------------------------------------
// Character Card Spec Types (non-strict Zod schemas)
//
// These represent the EXTERNAL on-the-wire formats for V2 and V3 cards.
// All field names are snake_case to match the spec exactly.
// Schemas use .passthrough() so cards with extra fields (extensions,
// forward-compatible additions, tool-specific metadata) still import cleanly.
// ---------------------------------------------------------------------------

export const CharacterBookEntrySchema = z
  .object({
    keys: z.array(z.string()),
    content: z.string(),
    extensions: z.record(z.string(), z.unknown()).default({}),
    enabled: z.boolean(),
    insertion_order: z.number(),
    case_sensitive: z.boolean().optional(),
    name: z.string().optional(),
    priority: z.number().optional(),
    id: z.union([z.number(), z.string()]).optional(),
    comment: z.string().optional(),
    selective: z.boolean().optional(),
    secondary_keys: z.array(z.string()).optional(),
    constant: z.boolean().optional(),
    position: z.enum(['before_char', 'after_char', 'top', 'bottom', 'atDepth']).optional(),
    depth: z.number().optional(),
    role: z.string().optional(),
    // V3 additions
    use_regex: z.boolean().optional(),
    // ST-specific extensions (preserved via passthrough)
  })
  .passthrough();

export const CharacterBookSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    scan_depth: z.number().optional(),
    token_budget: z.number().optional(),
    recursive_scanning: z.boolean().optional(),
    extensions: z.record(z.string(), z.unknown()).default({}),
    entries: z.array(CharacterBookEntrySchema),
  })
  .passthrough();

export const CardAssetSchema = z
  .object({
    type: z.string(),
    uri: z.string(),
    name: z.string(),
    ext: z.string(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// V2 Data
// ---------------------------------------------------------------------------

export const TavernCardV2DataSchema = z
  .object({
    name: z.string(),
    description: z.string().default(''),
    personality: z.string().default(''),
    scenario: z.string().default(''),
    first_mes: z.string().default(''),
    mes_example: z.string().default(''),
    creator_notes: z.string().default(''),
    system_prompt: z.string().default(''),
    post_history_instructions: z.string().default(''),
    alternate_greetings: z.array(z.string()).default([]),
    character_book: CharacterBookSchema.optional(),
    tags: z.array(z.string()).default([]),
    creator: z.string().default(''),
    character_version: z.string().default(''),
    extensions: z.record(z.string(), z.unknown()).default({}),
  })
  .passthrough();

export const TavernCardV2Schema = z
  .object({
    spec: z.literal('chara_card_v2'),
    spec_version: z.literal('2.0'),
    data: TavernCardV2DataSchema,
  })
  .passthrough();

// ---------------------------------------------------------------------------
// V3 Data (extends V2)
// ---------------------------------------------------------------------------

export const TavernCardV3DataSchema = TavernCardV2DataSchema.extend({
  group_only_greetings: z.array(z.string()).default([]),
  nickname: z.string().optional(),
  creator_notes_multilingual: z.record(z.string(), z.string()).optional(),
  source: z.array(z.string()).optional(),
  assets: z.array(CardAssetSchema).optional(),
  creation_date: z.number().optional(),
  modification_date: z.number().optional(),
}).passthrough();

export const TavernCardV3Schema = z
  .object({
    spec: z.literal('chara_card_v3'),
    spec_version: z.literal('3.0'),
    data: TavernCardV3DataSchema,
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Union / helpers
// ---------------------------------------------------------------------------

export const TavernCardSchema = z.union([TavernCardV2Schema, TavernCardV3Schema]);

/** Loose schema that accepts any card shape for backfill / V1 compatibility. */
export const LooseCardSchema = z
  .object({
    spec: z.string().optional(),
    spec_version: z.string().optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

/**
 * Lenient unix-timestamp field for loose imports. The spec says number
 * (seconds), but real-world cards in the wild ship numeric strings or ISO
 * date strings; coerce those to seconds and drop unparseable values.
 */
const LooseTimestampSchema = z.preprocess((value) => {
  if (typeof value === 'string') {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) return asNumber;
    const asDate = Date.parse(value);
    if (!Number.isNaN(asDate)) return Math.floor(asDate / 1000);
    return undefined;
  }
  return value;
}, z.number().optional());

/**
 * Loose schema for the card `data` object itself.
 * All fields are optional so cards with missing / extra keys import cleanly.
 * Unknown fields are preserved (looseObject behaviour).
 */
export const LooseCardDataSchema = z.looseObject({
  name: z.string().optional(),
  description: z.string().optional(),
  personality: z.string().optional(),
  scenario: z.string().optional(),
  first_mes: z.string().optional(),
  mes_example: z.string().optional(),
  creator_notes: z.string().optional(),
  system_prompt: z.string().optional(),
  post_history_instructions: z.string().optional(),
  alternate_greetings: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  creator: z.string().optional(),
  character_version: z.string().optional(),
  extensions: z.record(z.string(), z.unknown()).optional(),
  // v3
  group_only_greetings: z.array(z.string()).optional(),
  nickname: z.string().optional(),
  creator_notes_multilingual: z.record(z.string(), z.string()).optional(),
  source: z.array(z.string()).optional(),
  assets: z.array(CardAssetSchema).optional(),
  character_book: z.unknown().optional(),
  creation_date: LooseTimestampSchema,
  modification_date: LooseTimestampSchema,
  create_date: z.string().optional(),
});

export type LooseCardData = z.infer<typeof LooseCardDataSchema>;

// ---------------------------------------------------------------------------
// Inferred TypeScript types
// ---------------------------------------------------------------------------

export type TavernCardV2 = z.infer<typeof TavernCardV2Schema>;
export type TavernCardV2Data = z.infer<typeof TavernCardV2DataSchema>;
export type TavernCardV3 = z.infer<typeof TavernCardV3Schema>;
export type TavernCardV3Data = z.infer<typeof TavernCardV3DataSchema>;
export type TavernCard = z.infer<typeof TavernCardSchema>;
export type CharacterBook = z.infer<typeof CharacterBookSchema>;
export type CharacterBookEntry = z.infer<typeof CharacterBookEntrySchema>;
export type CardAsset = z.infer<typeof CardAssetSchema>;

/**
 * Build a spec-compliant card object from raw data.
 * Returns the card wrapped in the correct V2 or V3 envelope.
 */
export function buildTavernCard(
  format: 'v2' | 'v3',
  data: TavernCardV2Data | TavernCardV3Data,
  opts?: { create_date?: string },
): TavernCard {
  const card: TavernCard =
    format === 'v2'
      ? { spec: 'chara_card_v2', spec_version: '2.0', data: data }
      : { spec: 'chara_card_v3', spec_version: '3.0', data: data as TavernCardV3Data };

  if (opts?.create_date) {
    (card as Record<string, unknown>).create_date = opts.create_date;
  }

  return card;
}
