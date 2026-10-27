import { AppError } from '@minh/shared';
import { z } from 'zod';
import { hmacSha256Hex } from '../lib/crypto';
import { truncate } from '../lib/text';
import { describeLocalTime, isValidTimeZone, localParts } from '../lib/time';
import { defineIntegration, type ToolContext, toolBuilder } from './types';

// ------------------------------------------------------------------ core

const coreTool = toolBuilder<ToolContext<Record<string, never>, Record<string, never>>>();

export const coreIntegration = defineIntegration({
  id: 'core',
  name: 'Core tools',
  category: 'core',
  description: 'Knowledge base search and current time. Always enabled.',
  verified: true,
  status: 'available',
  alwaysEnabled: true,
  authSchema: z.object({}),
  tools: [
    coreTool({
      name: 'search_knowledge',
      description:
        "Search the company's knowledge base (uploaded documents: products, prices, policies, FAQs). Returns the most relevant passages with citations like [1]. Works with or without Vietnamese diacritics.",
      args: z.object({
        query: z.string().min(1).max(500).describe('What to look for, in the user’s words'),
        limit: z.number().int().min(1).max(10).default(5).describe('Maximum passages to return'),
      }),
      risk: 'read',
      handler: async (ctx, args) => {
        const hits = await ctx.services.knowledge.search({
          orgId: ctx.orgId,
          agentId: ctx.agent.id,
          query: args.query,
          limit: args.limit,
        });
        if (!hits.length) return { results: [], note: 'No matching passages in the knowledge base.' };
        return {
          results: hits.map((h, i) => ({
            citation: `[${i + 1}]`,
            documentId: h.documentId,
            title: h.title,
            source: h.source,
            chunk: h.ordinal,
            score: Number(h.score.toFixed(4)),
            content: truncate(h.content, 1500),
          })),
          note: 'Cite passages you use with their citation marker, e.g. [1].',
        };
      },
    }),
    coreTool({
      name: 'get_current_time',
      description: 'Get the current date and time (default time zone Asia/Ho_Chi_Minh).',
      args: z.object({
        timezone: z.string().max(64).optional().describe('IANA time zone, e.g. Asia/Ho_Chi_Minh'),
      }),
      risk: 'read',
      handler: async (ctx, args) => {
        const tz = args.timezone && isValidTimeZone(args.timezone) ? args.timezone : ctx.timezone;
        const now = ctx.now();
        const p = localParts(now, tz);
        return {
          iso: now.toISOString(),
          timezone: tz,
          local: describeLocalTime(now, tz),
          weekday: p.weekday,
          hour: p.hour,
        };
      },
    }),
  ],
});

// ------------------------------------------------------------------ http_request

const httpConfig = z.object({
  /** Hosts the agent may call: `api.example.com`, `*.example.com`, or `*` for any public host. */
  allowedHosts: z.array(z.string().min(1).max(253)).max(100).default([]),
  allowedMethods: z.array(z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'])).default(['GET']),
  maxResponseBytes: z.number().int().min(1024).max(5_000_000).default(500_000),
  timeoutMs: z.number().int().min(1000).max(30_000).default(15_000),
});
const httpAuth = z.object({
  /** Secret headers added to every request (e.g. an API key for an allowed host). */
  headers: z.record(z.string(), z.string()).optional(),
});
const httpTool = toolBuilder<ToolContext<z.output<typeof httpAuth>, z.output<typeof httpConfig>>>();

export const httpIntegration = defineIntegration({
  id: 'http',
  name: 'HTTP requests',
  category: 'developer',
  description:
    'Let the agent call HTTP APIs on an allowlist of hosts. SSRF-protected: private/loopback/link-local addresses are always blocked after DNS resolution.',
  verified: true,
  status: 'available',
  authSchema: httpAuth,
  configSchema: httpConfig,
  tools: [
    httpTool({
      name: 'http_request',
      description:
        'Make an HTTP request to an allowed public API and return the status and (truncated) body.',
      args: z.object({
        url: z.string().url().max(2048),
        method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
        headers: z.record(z.string(), z.string()).optional(),
        body: z
          .union([z.string().max(100_000), z.record(z.string(), z.unknown()), z.array(z.unknown())])
          .optional(),
      }),
      risk: (args) =>
        args.method === 'GET' || args.method === 'HEAD' || args.method === undefined
          ? 'read'
          : 'external_write',
      handler: async (ctx, args) => {
        const config = httpConfig.parse(ctx.config ?? {});
        if (!config.allowedHosts.length) {
          throw new AppError(
            'forbidden',
            'http_request has no allowed hosts configured for this agent (integration config `allowedHosts`).',
          );
        }
        if (!config.allowedMethods.includes(args.method)) {
          throw new AppError(
            'forbidden',
            `Method ${args.method} is not allowed (allowed: ${config.allowedMethods.join(', ')})`,
          );
        }
        const headers: Record<string, string> = {
          ...(args.headers ?? {}),
          ...(ctx.credentials.headers ?? {}),
        };
        let body: string | undefined;
        if (args.body !== undefined && args.method !== 'GET' && args.method !== 'HEAD') {
          if (typeof args.body === 'string') body = args.body;
          else {
            body = JSON.stringify(args.body);
            if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type'))
              headers['content-type'] = 'application/json';
          }
        }
        const res = await ctx.services.safeFetch(args.url, {
          method: args.method,
          headers,
          body,
          allowedHosts: config.allowedHosts,
          maxBytes: config.maxResponseBytes,
          timeoutMs: config.timeoutMs,
          signal: ctx.signal,
        });
        const text = res.body.toString('utf8');
        return {
          status: res.status,
          url: res.url,
          contentType: res.headers['content-type'] ?? null,
          body: truncate(text, 20_000),
          truncated: res.truncated || text.length > 20_000,
        };
      },
    }),
  ],
});

// ------------------------------------------------------------------ send_webhook

const webhookConfig = z.object({
  url: z
    .string()
    .url()
    .max(2048)
    .refine((u) => /^https?:\/\//i.test(u), 'must be http(s)'),
});
const webhookAuth = z.object({ signingSecret: z.string().min(8).max(256).optional() });
const webhookTool = toolBuilder<ToolContext<z.output<typeof webhookAuth>, z.output<typeof webhookConfig>>>();

/** Signature header value for an outgoing webhook: `sha256=HMAC(secret, "<timestamp>.<body>")`. */
export function signWebhook(secret: string, timestamp: string, body: string): string {
  return `sha256=${hmacSha256Hex(secret, `${timestamp}.${body}`)}`;
}

export const webhookIntegration = defineIntegration({
  id: 'webhook',
  name: 'Webhook',
  category: 'developer',
  description:
    'Send events to your own endpoint (Zapier, n8n, Make, your backend). The URL is set by the owner, never by the model. Optionally HMAC-signed.',
  verified: true,
  status: 'available',
  authSchema: webhookAuth,
  configSchema: webhookConfig,
  tools: [
    webhookTool({
      name: 'send_webhook',
      description:
        "Send a JSON event to the business's configured webhook endpoint (e.g. a new lead, a booking request, an escalation).",
      args: z.object({
        event: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[a-zA-Z0-9_.:-]+$/)
          .describe('Event name, e.g. lead.created'),
        payload: z.record(z.string(), z.unknown()).describe('Event data'),
      }),
      risk: 'external_write',
      handler: async (ctx, args) => {
        const config = webhookConfig.safeParse(ctx.config ?? {});
        if (!config.success)
          throw new AppError(
            'bad_request',
            'Webhook URL is not configured for this agent (integration config `url`).',
          );
        const timestamp = String(Math.floor(ctx.now().getTime() / 1000));
        const body = JSON.stringify({
          event: args.event,
          payload: args.payload,
          agentId: ctx.agent.id,
          sentAt: ctx.now().toISOString(),
        });
        const headers: Record<string, string> = {
          'content-type': 'application/json',
          'x-minh-event': args.event,
          'x-minh-timestamp': timestamp,
        };
        if (ctx.credentials.signingSecret)
          headers['x-minh-signature'] = signWebhook(ctx.credentials.signingSecret, timestamp, body);
        const res = await ctx.services.safeFetch(config.data.url, {
          method: 'POST',
          headers,
          body,
          maxBytes: 50_000,
          timeoutMs: 10_000,
          maxRedirects: 0,
          signal: ctx.signal,
        });
        if (res.status >= 400)
          throw new AppError('upstream_error', `Webhook endpoint answered ${res.status}`);
        return { delivered: true, status: res.status };
      },
    }),
  ],
});
