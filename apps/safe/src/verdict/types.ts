import { z } from 'zod';

export const CHECK_KINDS = [
  'url',
  'text',
  'phone',
  'bank_account',
  'email',
  'image',
  'video',
  'audio',
  'ai_text',
] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];
export const MEDIA_KINDS: readonly CheckKind[] = ['image', 'video', 'audio'];

export const LEVELS = ['safe', 'low', 'medium', 'high', 'critical', 'unknown'] as const;
export type Level = (typeof LEVELS)[number];

export const localized = z.object({ vi: z.string(), en: z.string() }).strict();
export type Localized = z.infer<typeof localized>;

export const signalSchema = z
  .object({
    /** Stable machine id, e.g. `url.brand_impersonation`, `text.rule.fake_police`. */
    id: z.string(),
    label: localized,
    /**
     * Risk contribution in percent (−100…100). Positive = raises risk, negative = trust evidence,
     * 0 = informational. See README "Scoring". Signals with source `llm` are additive points.
     */
    weight: z.number().min(-100).max(100),
    evidence: z.string().optional(),
    source: z.string(),
  })
  .strict();
export type Signal = z.infer<typeof signalSchema>;

export const sourceStatusSchema = z
  .object({
    name: z.string(),
    status: z.enum(['ok', 'skipped', 'error']),
    detail: z.string().optional(),
  })
  .strict();
export type SourceStatus = z.infer<typeof sourceStatusSchema>;

export const bankAccountEntitySchema = z
  .object({
    accountNumber: z.string(),
    bankCode: z.string().optional(),
    bankName: z.string().optional(),
    accountName: z.string().optional(),
  })
  .strict();
export type BankAccountEntity = z.infer<typeof bankAccountEntitySchema>;

export const entitiesSchema = z
  .object({
    urls: z.array(z.string()),
    phones: z.array(z.string()),
    bankAccounts: z.array(bankAccountEntitySchema),
    emails: z.array(z.string()),
  })
  .strict();
export type Entities = z.infer<typeof entitiesSchema>;

export const verdictSchema = z
  .object({
    id: z.string().regex(/^chk_/),
    kind: z.enum(CHECK_KINDS),
    /** Normalized input (for text/media: a short, privacy-safe description unless the caller opted in). */
    input: z.string(),
    score: z.number().int().min(0).max(100),
    level: z.enum(LEVELS),
    summary: localized,
    signals: z.array(signalSchema),
    entities: entitiesSchema.optional(),
    recommendations: z.object({ vi: z.array(z.string()), en: z.array(z.string()) }).strict(),
    /** First-hour steps for victims who already paid / shared details. Present on high & critical verdicts. */
    ifAlreadyPaid: z
      .object({ vi: z.array(z.string()), en: z.array(z.string()) })
      .strict()
      .optional(),
    /** Short, forwardable card (e.g. a parent forwarding the result to family on Zalo). */
    shareText: localized,
    sources: z.array(sourceStatusSchema),
    /** Kind-specific structured details (carrier, redirect chain, metadata…). Documented per kind. */
    details: z.record(z.string(), z.unknown()).optional(),
    checkedAt: z.string(),
    cached: z.boolean(),
  })
  .strict();
export type Verdict = z.infer<typeof verdictSchema>;
