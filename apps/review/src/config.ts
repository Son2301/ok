import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];
export const SEVERITY_RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3, critical: 4 };

export const CATEGORIES = [
  'correctness',
  'security',
  'concurrency',
  'performance',
  'api',
  'error-handling',
  'data-loss',
  'other',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const LANGUAGES = ['en', 'vi'] as const;
export type Language = (typeof LANGUAGES)[number];

export const CONFIG_FILENAMES = ['.minh-review.yml', '.minh-review.yaml'] as const;
const MAX_CONFIG_BYTES = 64 * 1024;

const globList = z.array(z.string().min(1).max(300)).max(200);
const modelName = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[\w.:/@+-]+$/, 'model names may only contain letters, digits and . : / @ + - _');

/**
 * `.minh-review.yml` schema. Every key is optional; unknown keys are rejected so a
 * typo (`severityTreshold`) is reported instead of silently ignored.
 */
export const repoConfigSchema = z.strictObject({
  /** Language for findings and the summary. */
  language: z.enum(LANGUAGES).default('en'),
  paths: z
    .strictObject({
      include: globList.default([]),
      exclude: globList.default([]),
      /** Review matching files even if a built-in filter (generated, vendored, lockfile…) would skip them. */
      force: globList.default([]),
    })
    .prefault({}),
  /** Findings below this severity are dropped. `low` enables a collapsed digest of minor issues. */
  severityThreshold: z.enum(SEVERITIES).default('medium'),
  /** Maximum inline comments per review. */
  maxComments: z.number().int().min(0).max(50).default(15),
  reviewDrafts: z.boolean().default(false),
  /** Check run conclusion becomes `failure` when a posted finding is at least this severe. */
  failOn: z.enum(['none', ...SEVERITIES]).default('none'),
  models: z
    .strictObject({
      reviewer: modelName.default('auto:best'),
      critic: modelName.default('auto'),
    })
    .prefault({}),
  /** Free-text team rules appended to the prompts. */
  instructions: z.string().max(4000).default(''),
  /** Keep findings the Critic rated `plausible` (not only `confirmed`). */
  keepPlausible: z.boolean().default(true),
  /** On new pushes, review only the new commits. */
  incremental: z.boolean().default(true),
  limits: z
    .strictObject({
      maxFiles: z.number().int().min(1).max(300).default(50),
      maxChangedLines: z.number().int().min(50).max(50_000).default(4000),
      maxFileChangedLines: z.number().int().min(50).max(20_000).default(1500),
      contextLines: z.number().int().min(0).max(50).default(10),
    })
    .prefault({}),
});

export type RepoConfig = z.output<typeof repoConfigSchema>;
export type RepoConfigInput = z.input<typeof repoConfigSchema>;

export const DEFAULT_CONFIG: RepoConfig = repoConfigSchema.parse({});

export function formatZodIssues(err: z.ZodError, max = 5): string {
  return err.issues
    .slice(0, max)
    .map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`)
    .join('; ');
}

/** Parse `.minh-review.yml` text into a raw object. Errors are human-readable. */
export function parseConfigText(text: string): { raw: Record<string, unknown>; error?: string } {
  if (Buffer.byteLength(text, 'utf8') > MAX_CONFIG_BYTES)
    return { raw: {}, error: `config file is larger than ${MAX_CONFIG_BYTES / 1024} KB` };
  let doc: unknown;
  try {
    doc = parseYaml(text, { maxAliasCount: 50, uniqueKeys: true });
  } catch (err) {
    const msg = (err as Error).message.split('\n')[0] ?? 'invalid YAML';
    return { raw: {}, error: `invalid YAML: ${msg}` };
  }
  if (doc === null || doc === undefined) return { raw: {} };
  if (typeof doc !== 'object' || Array.isArray(doc))
    return { raw: {}, error: 'the top level must be a mapping (key: value pairs)' };
  const check = repoConfigSchema.safeParse(doc);
  if (!check.success) return { raw: {}, error: formatZodIssues(check.error) };
  return { raw: doc as Record<string, unknown> };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep merge for config objects: nested objects merge per key, arrays/scalars replace. */
export function mergeConfig(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v === undefined) continue;
    out[k] =
      isPlainObject(v) && isPlainObject(out[k]) ? mergeConfig(out[k] as Record<string, unknown>, v) : v;
  }
  return out;
}

export interface ResolvedConfig {
  config: RepoConfig;
  /** Set when `.minh-review.yml` was present but invalid (defaults were used for it). */
  error?: string;
  /** Where values came from, for the summary. */
  sources: ('defaults' | 'repo-file' | 'console')[];
}

/**
 * Effective config = defaults ← `.minh-review.yml` ← console override (stored in DB).
 * An invalid file is ignored (with `error` set) so the review still runs on defaults.
 */
export function resolveRepoConfig(
  fileText: string | null | undefined,
  override?: Record<string, unknown> | null,
): ResolvedConfig {
  const sources: ResolvedConfig['sources'] = ['defaults'];
  let raw: Record<string, unknown> = {};
  let error: string | undefined;
  if (fileText != null) {
    const parsed = parseConfigText(fileText);
    if (parsed.error) error = parsed.error;
    else {
      raw = parsed.raw;
      sources.push('repo-file');
    }
  }
  if (override && Object.keys(override).length) {
    const merged = mergeConfig(raw, override);
    const res = repoConfigSchema.safeParse(merged);
    if (res.success) return { config: res.data, error, sources: [...sources, 'console'] };
  }
  return { config: repoConfigSchema.parse(raw), error, sources };
}

/** Validate a console override (partial config). Throws ZodError on invalid input. */
export function validateOverride(input: unknown): Record<string, unknown> {
  if (!isPlainObject(input))
    throw new z.ZodError([{ code: 'custom', path: [], message: 'settings must be an object', input }]);
  repoConfigSchema.parse(input);
  return input;
}
