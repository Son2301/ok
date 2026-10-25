import { AppError, type ProductId } from '@ok/shared';
import type { Context, MiddlewareHandler } from 'hono';
import type { ApiKeyRecord, Core } from './core';
import { API_KEY_PREFIX, safeEqual } from './crypto';
import { RateLimiter } from './rate-limit';

export interface AuthContext {
  orgId: string;
  /** How the caller authenticated. `internal` = trusted platform service (e.g. the web console). */
  via: 'api_key' | 'internal';
  apiKey?: ApiKeyRecord;
}

export type AuthEnv = { Variables: { auth: AuthContext } };

export interface AuthOptions {
  product: ProductId;
  internalToken: string;
  /** If true, unauthenticated requests pass through with no `auth` set. */
  optional?: boolean;
}

/**
 * Accepts either:
 *  - `Authorization: Bearer sk-ok-…` (customer API key scoped to this product), or
 *  - `Authorization: Bearer <INTERNAL_TOKEN>` + `X-Org-Id: org_…` (platform-internal calls).
 */
export function authMiddleware<E extends AuthEnv = AuthEnv>(
  core: Core,
  opts: AuthOptions,
): MiddlewareHandler<E> {
  const limiter = new RateLimiter();
  return async (ctx, next) => {
    const c = ctx as unknown as Context<AuthEnv>;
    const header = c.req.header('authorization') ?? '';
    const token = header.replace(/^Bearer\s+/i, '').trim() || c.req.header('x-api-key')?.trim() || '';
    if (!token) {
      if (opts.optional) return next();
      throw new AppError('unauthorized', 'Missing API key. Send `Authorization: Bearer sk-ok-…`.');
    }

    if (token.startsWith(API_KEY_PREFIX)) {
      const key = await core.verifyApiKey(token);
      if (!key) throw new AppError('unauthorized', 'Invalid or revoked API key');
      if (!key.scopes.includes('*') && !key.scopes.includes(opts.product)) {
        throw new AppError('forbidden', `This API key is not allowed to use ${opts.product}`);
      }
      if (key.spendLimitMicros != null && key.spentMicros >= key.spendLimitMicros) {
        throw new AppError('payment_required', 'This API key has reached its spend limit');
      }
      if (key.rateLimitRpm && !limiter.take(key.id, key.rateLimitRpm)) {
        throw new AppError('rate_limited', `Rate limit of ${key.rateLimitRpm} requests/minute exceeded`);
      }
      c.set('auth', { orgId: key.orgId, via: 'api_key', apiKey: key });
      return next();
    }

    if (safeEqual(token, opts.internalToken)) {
      const orgId = c.req.header('x-org-id');
      if (!orgId) throw new AppError('bad_request', 'Internal calls must include X-Org-Id');
      c.set('auth', { orgId, via: 'internal' });
      return next();
    }

    throw new AppError('unauthorized', 'Invalid API key');
  };
}

export function getAuth(c: Context): AuthContext {
  const auth = c.get('auth') as AuthContext | undefined;
  if (!auth) throw new AppError('unauthorized', 'Authentication required');
  return auth;
}
