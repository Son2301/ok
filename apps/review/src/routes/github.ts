import { AppError } from '@ok/shared';
import { Hono } from 'hono';
import { reviewJobKey, routeEvent, verifyWebhookSignature } from '../github/webhook';
import { linkInstallation } from '../linking';
import type { RouteDeps } from './types';

/** Remembers recent delivery ids so GitHub redeliveries/retries are processed once. */
class RecentIds {
  private readonly ids = new Set<string>();
  constructor(private readonly max = 5000) {}
  seen(id: string): boolean {
    if (this.ids.has(id)) return true;
    this.ids.add(id);
    if (this.ids.size > this.max) this.ids.delete(this.ids.values().next().value as string);
    return false;
  }
}

const MAX_WEBHOOK_BYTES = 25 * 1024 * 1024;

export const notConfigured = {
  error: {
    code: 'not_configured',
    message:
      'The GitHub App is not configured on this server (set GITHUB_APP_ID, GITHUB_PRIVATE_KEY and GITHUB_WEBHOOK_SECRET).',
  },
};

export function githubRoutes(deps: RouteDeps) {
  const app = new Hono();
  const deliveries = new RecentIds();

  /** GitHub webhook receiver: verify, route, enqueue, answer fast. */
  app.post('/webhook', async (c) => {
    if (!deps.github || !deps.webhookSecret) return c.json(notConfigured, 503);
    // GitHub caps payloads at 25 MB; refuse bigger bodies before buffering them (unauthenticated input).
    if (Number(c.req.header('content-length') ?? 0) > MAX_WEBHOOK_BYTES)
      throw new AppError('bad_request', 'Payload too large', undefined, 413);
    const raw = Buffer.from(await c.req.arrayBuffer());
    if (raw.byteLength > MAX_WEBHOOK_BYTES)
      throw new AppError('bad_request', 'Payload too large', undefined, 413);
    const signature = c.req.header('x-hub-signature-256');
    if (!signature) throw new AppError('unauthorized', 'Missing X-Hub-Signature-256 header');
    if (!verifyWebhookSignature(deps.webhookSecret, raw, signature))
      throw new AppError('unauthorized', 'Invalid webhook signature');

    const event = c.req.header('x-github-event') ?? '';
    const delivery = c.req.header('x-github-delivery');
    if (delivery && deliveries.seen(delivery)) return c.json({ ok: true, duplicate: true });

    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new AppError('bad_request', 'Webhook body must be JSON');
    }

    const routed = routeEvent(event, payload, { appSlug: deps.github.slug });
    const { store, queue, logger } = deps;
    switch (routed.kind) {
      case 'ping':
        return c.json({ ok: true, pong: true });
      case 'installation': {
        const now = new Date(deps.now());
        const inst = routed.installation;
        if (routed.action === 'deleted') await store.setInstallationStatus(inst.id, 'deleted', now);
        else if (routed.action === 'suspend') await store.setInstallationStatus(inst.id, 'suspended', now);
        else {
          await store.upsertInstallation({
            id: inst.id,
            accountLogin: inst.accountLogin,
            accountType: inst.accountType,
            accountId: inst.accountId,
            status: 'active',
            eventAt: now,
          });
          await store.upsertRepos(inst.id, routed.repositories);
        }
        logger.info('installation event', { action: routed.action, installation: inst.id });
        return c.json({ ok: true, action: `installation.${routed.action}` });
      }
      case 'installation_repositories': {
        const inst = routed.installation;
        await store.upsertInstallation({
          id: inst.id,
          accountLogin: inst.accountLogin,
          accountType: inst.accountType,
          accountId: inst.accountId,
          eventAt: new Date(deps.now()),
        });
        await store.upsertRepos(inst.id, routed.added);
        await store.deactivateRepos(routed.removed.map((r) => r.id));
        return c.json({ ok: true, added: routed.added.length, removed: routed.removed.length });
      }
      case 'review': {
        const key = reviewJobKey(routed.job);
        const result = queue.enqueue(key, routed.job);
        logger.info('review queued', { key, trigger: routed.job.trigger, result });
        return c.json({ accepted: true, key, queue: result }, 202);
      }
      case 'cancel': {
        const cancelled = queue.cancel(reviewJobKey(routed));
        return c.json({ ok: true, cancelled });
      }
      default:
        return c.json({ ok: true, ignored: routed.reason });
    }
  });

  /**
   * GitHub App "Setup URL": GitHub redirects here after installation with
   * `installation_id`, `setup_action` and the `state` we put in the install URL
   * (plus `code` when "Request user authorization during installation" is on).
   */
  app.get('/setup', async (c) => {
    const installationId = Number(c.req.query('installation_id'));
    if (!Number.isSafeInteger(installationId) || installationId <= 0)
      throw new AppError('bad_request', 'installation_id is required');
    const state = deps.linkSigner.verify(c.req.query('state'));
    if (!state) {
      throw new AppError(
        'bad_request',
        'Missing or expired setup state. Start the installation from the console so it can be linked to your account.',
      );
    }
    await linkInstallation(
      { store: deps.store, github: deps.github },
      { installationId, orgId: state.orgId, oauthCode: c.req.query('code') },
      { linkWindowMs: deps.linkWindowMs, now: deps.now },
    );
    deps.logger.info('installation linked via setup callback', { installationId, orgId: state.orgId });
    if (deps.consoleUrl)
      return c.redirect(`${deps.consoleUrl.replace(/\/$/, '')}/review?linked=${installationId}`, 302);
    return c.json({ ok: true, installationId, orgId: state.orgId });
  });

  return app;
}
