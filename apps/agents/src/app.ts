import { type AuthEnv, authMiddleware } from '@ok/core';
import { errorHandler, notFound, requestContext } from '@ok/shared';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Platform } from './platform';
import { agentRoutes } from './routes/agents';
import { internalRoutes, mcpRoutes } from './routes/internal';
import { orgRoutes } from './routes/org';
import { publicRoutes } from './routes/public';

/** The control-plane HTTP app. Pure: all dependencies come from the platform. */
export function createApp(p: Platform): Hono {
  const app = new Hono();
  app.use('*', requestContext(p.logger));
  app.use(
    '*',
    bodyLimit({
      maxSize: 6 * 1024 * 1024,
      onError: (c) => c.json({ error: { code: 'bad_request', message: 'Request body too large' } }, 413),
    }),
  );
  app.onError(errorHandler(p.logger));
  app.notFound(notFound);

  app.route('/', publicRoutes(p));
  app.route('/internal', internalRoutes(p));
  app.route('/mcp', mcpRoutes(p));

  const v1 = new Hono<AuthEnv>();
  v1.use('*', authMiddleware(p.core, { product: 'agents', internalToken: p.config.internalToken }));
  v1.route('/agents', agentRoutes(p));
  v1.route('/', orgRoutes(p));
  app.route('/v1', v1);

  return app;
}
