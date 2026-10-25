import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { type CustomProviderInput, hasRealProvider, type ProviderSpec } from '../providers/config';
import type { Capabilities, CatalogEndpoint, CatalogModel, Endpoint, Model } from './types';
import { TIERS } from './types';

// ------------------------------------------------------------ override file

const priceSchema = z.object({ input: z.number().min(0), output: z.number().min(0) });
const capsSchema = z
  .object({ tools: z.boolean(), vision: z.boolean(), json: z.boolean(), streaming: z.boolean() })
  .partial();
const quirksSchema = z.object({
  dropParams: z.array(z.string()).optional(),
  noForcedToolChoice: z.boolean().optional(),
});

const endpointOverrideSchema = z.object({
  provider: z.string().min(1),
  upstreamModel: z.string().min(1).optional(),
  price: priceSchema.optional(),
  cost: priceSchema.optional(),
  contextLength: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  capabilities: capsSchema.optional(),
  quirks: quirksSchema.optional(),
  verified: z.boolean().optional(),
  /** Remove this provider's endpoint from the model. */
  remove: z.boolean().optional(),
});

const modelOverrideSchema = z.object({
  id: z.string().regex(/^[a-z0-9][\w.-]*\/[\w.:-]+$/i, 'model ids look like `vendor/model`'),
  name: z.string().optional(),
  type: z.enum(['chat', 'embedding']).optional(),
  description: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  auto: z
    .object({
      tiers: z.array(z.enum(TIERS as [string, ...string[]])),
      quality: z.number().min(0).max(100),
      strengths: z
        .array(z.enum(['code', 'math', 'multilingual', 'vision', 'long_context', 'tools']))
        .optional(),
    })
    .optional(),
  /** Replace the endpoint list instead of merging by provider. */
  replaceEndpoints: z.boolean().optional(),
  endpoints: z.array(endpointOverrideSchema).optional(),
});

export const catalogFileSchema = z.object({
  providers: z
    .record(
      z.string(),
      z.object({
        name: z.string().optional(),
        kind: z.enum(['openai-compatible', 'azure-openai', 'anthropic', 'google', 'mock']),
        baseUrl: z.string().url().optional(),
        apiKeyEnv: z.string().optional(),
        apiVersion: z.string().optional(),
        headers: z.record(z.string(), z.string()).optional(),
        supportsStreamUsage: z.boolean().optional(),
        keyless: z.boolean().optional(),
      }),
    )
    .optional(),
  models: z.array(modelOverrideSchema).optional(),
  /** Model ids to drop from the catalog. */
  remove: z.array(z.string()).optional(),
});

export type CatalogFile = z.infer<typeof catalogFileSchema>;

export function loadCatalogFile(path: string): CatalogFile {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read CATALOG_PATH ${path}: ${(err as Error).message}`);
  }
  const parsed = catalogFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid catalog file ${path}:\n${issues}`);
  }
  return parsed.data;
}

export function customProviders(file?: CatalogFile): Record<string, CustomProviderInput> {
  return (file?.providers ?? {}) as Record<string, CustomProviderInput>;
}

const DEFAULT_CAPS: Capabilities = { tools: false, vision: false, json: false, streaming: true };

function completeEndpoint(modelId: string, o: z.infer<typeof endpointOverrideSchema>): CatalogEndpoint {
  if (!o.upstreamModel || !o.price || !o.contextLength) {
    throw new Error(
      `Catalog: new endpoint ${modelId}@${o.provider} needs upstreamModel, price and contextLength`,
    );
  }
  return {
    provider: o.provider,
    upstreamModel: o.upstreamModel,
    price: o.price,
    cost: o.cost ?? o.price,
    contextLength: o.contextLength,
    ...(o.maxOutputTokens ? { maxOutputTokens: o.maxOutputTokens } : {}),
    capabilities: { ...DEFAULT_CAPS, ...o.capabilities },
    ...(o.quirks ? { quirks: o.quirks } : {}),
    verified: o.verified ?? false,
  };
}

/** Apply a catalog override file to a base catalog (pure; inputs are not mutated). */
export function mergeCatalog(base: CatalogModel[], file: CatalogFile): CatalogModel[] {
  const byId = new Map(base.map((m) => [m.id, structuredClone(m)]));
  for (const id of file.remove ?? []) byId.delete(id);

  for (const o of file.models ?? []) {
    const existing = byId.get(o.id);
    if (!existing) {
      if (!o.name || !o.endpoints?.length)
        throw new Error(`Catalog: new model ${o.id} needs a name and endpoints`);
      byId.set(o.id, {
        id: o.id,
        name: o.name,
        type: o.type ?? 'chat',
        ...(o.description ? { description: o.description } : {}),
        ...(o.aliases ? { aliases: o.aliases } : {}),
        ...(o.auto ? { auto: o.auto as CatalogModel['auto'] } : {}),
        endpoints: o.endpoints.filter((e) => !e.remove).map((e) => completeEndpoint(o.id, e)),
      });
      continue;
    }
    if (o.name) existing.name = o.name;
    if (o.type) existing.type = o.type;
    if (o.description) existing.description = o.description;
    if (o.aliases) existing.aliases = o.aliases;
    if (o.auto) existing.auto = o.auto as CatalogModel['auto'];
    if (o.endpoints) {
      if (o.replaceEndpoints) existing.endpoints = [];
      for (const e of o.endpoints) {
        const idx = existing.endpoints.findIndex((x) => x.provider === e.provider);
        if (e.remove) {
          if (idx >= 0) existing.endpoints.splice(idx, 1);
          continue;
        }
        if (idx < 0) {
          existing.endpoints.push(completeEndpoint(o.id, e));
          continue;
        }
        const cur = existing.endpoints[idx]!;
        const { remove: _r, capabilities, quirks, ...rest } = e;
        existing.endpoints[idx] = {
          ...cur,
          ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)),
          capabilities: { ...cur.capabilities, ...capabilities },
          ...(quirks ? { quirks: { ...cur.quirks, ...quirks } } : {}),
        } as CatalogEndpoint;
      }
    }
  }
  return [...byId.values()];
}

// ------------------------------------------------------------------ catalog

/**
 * `auto`   – add mock endpoints only when no real provider has credentials (default)
 * `always` – add mock endpoints to every model (dev: exercise routing offline)
 * `never`  – never synthesize mock endpoints (production)
 */
export type MockMode = 'auto' | 'always' | 'never';

export interface CatalogOptions {
  mockMode?: MockMode;
  /** Azure deployment names keyed by model id, overriding `upstreamModel` for `azure` endpoints. */
  azureDeployments?: Record<string, string>;
}

/** The resolved, immutable model catalog: models × provider credentials. */
export class Catalog {
  private readonly models = new Map<string, Model>();
  private readonly aliases = new Map<string, string>();
  private readonly endpoints = new Map<string, Endpoint>();
  /** True when mock endpoints were synthesized for every model. */
  readonly mockFallback: boolean;

  constructor(
    models: CatalogModel[],
    readonly providers: Map<string, ProviderSpec>,
    opts: CatalogOptions = {},
  ) {
    const mode = opts.mockMode ?? 'auto';
    this.mockFallback = mode === 'always' || (mode === 'auto' && !hasRealProvider(providers));

    for (const m of models) {
      if (this.models.has(m.id)) throw new Error(`Catalog: duplicate model id ${m.id}`);
      const endpoints: Endpoint[] = m.endpoints.map((e) => {
        const provider = providers.get(e.provider);
        if (!provider) throw new Error(`Catalog: model ${m.id} references unknown provider "${e.provider}"`);
        const upstreamModel =
          e.provider === 'azure' ? (opts.azureDeployments?.[m.id] ?? e.upstreamModel) : e.upstreamModel;
        return { ...e, upstreamModel, id: `${m.id}@${e.provider}`, modelId: m.id, enabled: provider.enabled };
      });
      if (this.mockFallback && !endpoints.some((e) => e.provider === 'mock') && endpoints.length) {
        endpoints.push(this.mockEndpointFor(m.id, m.type, endpoints));
      }
      const model: Model = { ...m, endpoints };
      this.models.set(m.id, model);
      for (const e of endpoints) this.endpoints.set(e.id, e);
    }

    // Aliases: explicit ones win; the bare model name (after the vendor slash) is added when unambiguous.
    const suffixCount = new Map<string, number>();
    for (const id of this.models.keys()) {
      const s = id.split('/').pop()!.toLowerCase();
      suffixCount.set(s, (suffixCount.get(s) ?? 0) + 1);
    }
    for (const [id, m] of this.models) {
      const s = id.split('/').pop()!.toLowerCase();
      if (suffixCount.get(s) === 1 && !this.models.has(s)) this.aliases.set(s, id);
      for (const a of m.aliases ?? []) this.aliases.set(a.toLowerCase(), id);
    }
  }

  private mockEndpointFor(modelId: string, type: CatalogModel['type'], endpoints: Endpoint[]): Endpoint {
    const first = endpoints[0]!;
    const caps = endpoints.reduce<Capabilities>(
      (acc, e) => ({
        tools: acc.tools || e.capabilities.tools,
        vision: acc.vision || e.capabilities.vision,
        json: acc.json || e.capabilities.json,
        streaming: acc.streaming || e.capabilities.streaming,
      }),
      { tools: false, vision: false, json: false, streaming: type === 'chat' },
    );
    return {
      provider: 'mock',
      upstreamModel: type === 'embedding' ? 'embed' : 'echo',
      // Bill like the real model so the billing pipeline behaves realistically offline.
      price: first.price,
      cost: { input: 0, output: 0 },
      contextLength: Math.max(...endpoints.map((e) => e.contextLength)),
      ...(first.maxOutputTokens ? { maxOutputTokens: first.maxOutputTokens } : {}),
      capabilities: caps,
      verified: true,
      id: `${modelId}@mock`,
      modelId,
      enabled: true,
    };
  }

  /** Look up a model by id or alias (case-insensitive). */
  get(idOrAlias: string): Model | undefined {
    const direct = this.models.get(idOrAlias);
    if (direct) return direct;
    const key = idOrAlias.toLowerCase();
    for (const [id, m] of this.models) if (id.toLowerCase() === key) return m;
    const alias = this.aliases.get(key);
    return alias ? this.models.get(alias) : undefined;
  }

  endpoint(id: string): Endpoint | undefined {
    return this.endpoints.get(id);
  }

  /** All models; by default only those with at least one enabled endpoint. */
  list(opts: { type?: CatalogModel['type']; includeDisabled?: boolean } = {}): Model[] {
    return [...this.models.values()].filter(
      (m) =>
        (!opts.type || m.type === opts.type) && (opts.includeDisabled || m.endpoints.some((e) => e.enabled)),
    );
  }

  allEndpoints(opts: { includeDisabled?: boolean } = {}): Endpoint[] {
    return [...this.endpoints.values()].filter((e) => opts.includeDisabled || e.enabled);
  }

  isAvailable(m: Model): boolean {
    return m.endpoints.some((e) => e.enabled);
  }
}
