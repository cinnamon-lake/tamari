/**
 * The typed knobs of a provider params blob.
 *
 * A params blob (`openai.params`, `claude.params`, … in the settings map,
 * merged with the BackendConfig samplers and `Prompt.params`) carries two
 * kinds of keys:
 *
 *  - TYPED KNOBS — the fields declared here. Adapters map them onto their
 *    request struct field by field (`body.top_p = params.topP`).
 *  - PROVIDER-NATIVE OVERRIDES — arbitrary other keys, already in the
 *    provider's language (`dry_multiplier`, `response_format`, …), copied
 *    onto the body verbatim. Catchall keeps them through validation.
 *
 * The schema is the single source of truth for the type (`z.infer`), and it
 * validates at the one untrusted boundary where a blob leaves the settings
 * map (`factory.ts parseParams`): a wrong-typed knob is dropped, everything
 * else survives.
 */

import { z } from 'zod';

export const GenerationParamsSchema = z
  .looseObject({
    temperature: z.number().optional().catch(undefined),
    topP: z.number().optional().catch(undefined),
    topK: z.number().optional().catch(undefined),
    minP: z.number().optional().catch(undefined),
    topA: z.number().optional().catch(undefined),
    repetitionPenalty: z.number().optional().catch(undefined),
    frequencyPenalty: z.number().optional().catch(undefined),
    presencePenalty: z.number().optional().catch(undefined),
    logitBias: z
      .union([z.record(z.string(), z.number()), z.array(z.tuple([z.number(), z.number()]))])
      .optional()
      .catch(undefined),
    stop: z.array(z.string()).optional().catch(undefined),
    seed: z.number().optional().catch(undefined),
    /** Claude/OpenRouter prompt-caching TTL (consumed explicitly, never a wire field). */
    cacheTTL: z.string().optional().catch(undefined),
    /** Claude per-tool strict schema mode (consumed explicitly, never a wire field). */
    strictTools: z.boolean().optional().catch(undefined),
  })
  .catch({});

export type GenerationParams = z.infer<typeof GenerationParamsSchema>;
