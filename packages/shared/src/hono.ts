import type { Context, ErrorHandler, MiddlewareHandler, NotFoundHandler } from 'hono';
import { ZodError } from 'zod';
import { AppError } from './errors';
import { randomId } from './ids';
import type { Logger } from './logger';

/** Assigns/propagates `x-request-id` and logs one line per request. */
export function requestContext(logger: Logger): MiddlewareHandler {
  return async (c, next) => {
    const id = c.req.header('x-request-id') ?? `req_${randomId(16)}`;
    c.set('requestId' as never, id as never);
    c.header('x-request-id', id);
    const started = performance.now();
    await next();
    logger.info('request', {
      id,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Math.round(performance.now() - started),
    });
  };
}

/** Uniform JSON error envelope: `{ error: { code, message, details? } }`. */
export function errorHandler(logger: Logger): ErrorHandler {
  return (err, c) => {
    if (err instanceof AppError) return c.json(err.toJSON(), err.status as never);
    if (err instanceof ZodError) {
      return c.json(new AppError('bad_request', 'Invalid request', err.issues).toJSON(), 400);
    }
    const status = (err as { status?: number }).status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return c.json({ error: { code: 'bad_request', message: err.message } }, status as never);
    }
    logger.error('unhandled', { err: err instanceof Error ? (err.stack ?? err.message) : String(err), path: c.req.path });
    return c.json({ error: { code: 'internal', message: 'Internal server error' } }, 500);
  };
}

export const notFound: NotFoundHandler = (c) => c.json({ error: { code: 'not_found', message: `No route for ${c.req.method} ${c.req.path}` } }, 404);

/** Parse a JSON body with a zod schema, throwing AppError on failure. */
export async function parseJson<T>(c: Context, schema: { parse: (v: unknown) => T }): Promise<T> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new AppError('bad_request', 'Body must be valid JSON');
  }
  return schema.parse(body);
}
