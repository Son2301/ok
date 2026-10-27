import { AppError } from '@minh/shared';
import type { Catalog } from '../catalog/catalog';
import type { Endpoint, Model } from '../catalog/types';
import type { ProviderPrefs } from '../schemas';
import { type AutoDecision, autoRoute, parseAutoModel } from './auto';
import { type HealthView, type Requirements, type Skip, selectEndpoints } from './select';

export interface PlannedAttempt {
  model: Model;
  endpoint: Endpoint;
}

/** Routing trace persisted with each request and (partly) returned to the caller. */
export interface RoutingInfo {
  requested_model: string;
  /** Candidate models in fallback order. */
  models: string[];
  sort: ProviderPrefs['sort'] | 'default';
  skipped: Skip[];
  auto?: { variant: AutoDecision['variant']; tier: AutoDecision['tier']; reason: string };
}

export interface Plan {
  attempts: PlannedAttempt[];
  routing: RoutingInfo;
}

export interface PlanInput {
  model?: string;
  models?: string[];
  provider?: ProviderPrefs;
  type: 'chat' | 'embedding';
}

export interface PlanOptions {
  maxAttempts: number;
  random?: () => number;
  /** Required for `auto`; receives the raw request for classification. */
  autoRequest?: Parameters<typeof autoRoute>[0];
}

/**
 * Expand `model` + `models[]` (and `auto*`) into an ordered attempt list:
 * every eligible endpoint of the first model, then of the next model, …
 */
export function buildPlan(
  input: PlanInput,
  catalog: Catalog,
  r: Requirements,
  health: HealthView,
  opts: PlanOptions,
): Plan {
  const requested = [input.model, ...(input.models ?? [])].filter((m): m is string => Boolean(m));
  const requestedModel = requested[0]!;
  const skipped: Skip[] = [];
  const models: Model[] = [];
  const unknown: string[] = [];
  let auto: AutoDecision | undefined;

  const addModel = (m: Model) => {
    if (!models.some((x) => x.id === m.id)) models.push(m);
  };

  for (const id of requested) {
    const variant = input.type === 'chat' ? parseAutoModel(id) : null;
    if (variant) {
      if (!opts.autoRequest) throw new Error('autoRequest is required for auto routing');
      const decision = autoRoute(opts.autoRequest, catalog, variant, r);
      auto ??= decision;
      for (const mid of decision.models) addModel(catalog.get(mid)!);
      continue;
    }
    const model = catalog.get(id);
    if (!model) {
      unknown.push(id);
      skipped.push({ endpoint: id, reason: 'unknown model' });
      continue;
    }
    if (model.type !== input.type) {
      skipped.push({ endpoint: id, reason: `not a ${input.type} model` });
      if (requested.length === 1)
        throw new AppError(
          'bad_request',
          `Model '${model.id}' is a ${model.type} model and cannot be used here`,
        );
      continue;
    }
    addModel(model);
  }

  if (!models.length) {
    if (auto)
      throw new AppError(
        'bad_request',
        `auto routing found no enabled model for this request (${auto.reason})`,
        { routing: auto.reason },
      );
    throw new AppError('not_found', `Model '${unknown[0] ?? requestedModel}' not found. See GET /v1/models.`);
  }

  const attempts: PlannedAttempt[] = [];
  let anyEnabled = false;
  for (const model of models) {
    if (model.endpoints.some((e) => e.enabled)) anyEnabled = true;
    const sel = selectEndpoints(model, r, input.provider, health, { random: opts.random });
    skipped.push(...sel.skipped);
    for (const endpoint of sel.endpoints) attempts.push({ model, endpoint });
  }

  const routing: RoutingInfo = {
    requested_model: requestedModel,
    models: models.map((m) => m.id),
    sort: input.provider?.sort ?? 'default',
    skipped,
    ...(auto ? { auto: { variant: auto.variant, tier: auto.tier, reason: auto.reason } } : {}),
  };

  if (!attempts.length) {
    if (!anyEnabled) {
      throw new AppError(
        'upstream_error',
        `No provider is configured for ${models.map((m) => m.id).join(', ')}`,
        { routing },
        503,
      );
    }
    const onlyHealth =
      skipped.length > 0 &&
      skipped.every((s) => s.reason.startsWith('unavailable') || s.reason === 'unknown model');
    if (onlyHealth) {
      throw new AppError(
        'upstream_error',
        'All endpoints for this request are temporarily unavailable',
        { routing },
        503,
      );
    }
    throw new AppError(
      'bad_request',
      'No endpoint can serve this request with the given requirements and provider preferences',
      { routing },
    );
  }

  return { attempts: attempts.slice(0, opts.maxAttempts), routing };
}
