import { errorHandler, notFound, requestContext } from '@minh/shared';
import { Hono } from 'hono';
import { apiRoutes } from './routes/api';
import { githubRoutes } from './routes/github';
import type { RouteDeps } from './routes/types';

export type AppDeps = RouteDeps;

/** Pure, testable HTTP app: every dependency is injected. */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  app.use('*', requestContext(deps.logger));
  app.onError(errorHandler(deps.logger));
  app.notFound(notFound);

  app.get('/health', (c) =>
    c.json({
      ok: true,
      service: 'review',
      github: {
        configured: Boolean(deps.github && deps.webhookSecret),
        appSlug: deps.github?.slug ?? null,
        ...(deps.github && deps.webhookSecret
          ? {}
          : { note: 'GitHub App not configured: webhook endpoints answer 503 not_configured' }),
      },
      queue: deps.queue.stats,
    }),
  );
  app.route('/github', githubRoutes(deps));
  app.route('/v1', apiRoutes(deps));
  return app;
}
