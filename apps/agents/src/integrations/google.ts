import { AppError } from '@ok/shared';
import { z } from 'zod';
import { type FetchLike, qs, requestJson, UpstreamError } from '../lib/http';
import { defineIntegration, singleLine, type ToolContext, toolBuilder } from './types';

/**
 * Google Calendar v3 and Gmail v1 with an OAuth 2.0 access token.
 * Docs: https://developers.google.com/calendar/api/v3/reference, https://developers.google.com/gmail/api/reference/rest
 * verified: false. If a refresh token + client id/secret are stored, a 401
 * triggers one token refresh (https://oauth2.googleapis.com/token) and the new
 * access token is persisted (encrypted).
 */
export const googleAuth = z.object({
  accessToken: z.string().min(10).describe('OAuth 2.0 access token'),
  refreshToken: z.string().min(10).optional().describe('Refresh token (enables automatic refresh)'),
  clientId: z.string().min(10).optional(),
  clientSecret: z.string().min(6).optional(),
});
type GoogleCreds = z.output<typeof googleAuth>;
type GoogleCtx = {
  fetch: FetchLike;
  credentials: GoogleCreds;
  signal?: AbortSignal;
  saveCredentials(p: Partial<GoogleCreds>): Promise<void>;
};

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export async function googleRequest<T>(
  ctx: GoogleCtx,
  url: string,
  init: { method?: string; body?: unknown; service: string },
): Promise<T> {
  const doCall = (token: string) =>
    requestJson<T>(ctx.fetch, url, {
      method: init.method ?? 'GET',
      headers: { Authorization: `Bearer ${token}` },
      body: init.body,
      service: init.service,
      signal: ctx.signal,
    });
  try {
    return await doCall(ctx.credentials.accessToken);
  } catch (err) {
    const c = ctx.credentials;
    if (
      !(
        err instanceof UpstreamError &&
        err.httpStatus === 401 &&
        c.refreshToken &&
        c.clientId &&
        c.clientSecret
      )
    )
      throw err;
    const res = await requestJson<{ access_token?: string }>(ctx.fetch, GOOGLE_TOKEN_URL, {
      method: 'POST',
      body: new URLSearchParams({
        client_id: c.clientId,
        client_secret: c.clientSecret,
        refresh_token: c.refreshToken,
        grant_type: 'refresh_token',
      }),
      service: 'Google OAuth',
    });
    if (!res.access_token) throw new AppError('upstream_error', 'Google token refresh failed');
    await ctx.saveCredentials({ accessToken: res.access_token });
    return doCall(res.access_token);
  }
}

// ---------------------------------------------------------------- Calendar

export const calendarConfig = z.object({
  calendarId: z.string().min(1).max(300).default('primary'),
  timezone: z.string().default('Asia/Ho_Chi_Minh'),
});
type CalendarConfig = z.output<typeof calendarConfig>;
const CAL = 'https://www.googleapis.com/calendar/v3';

interface GEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  status?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: { email: string; responseStatus?: string }[];
}
export const mapEvent = (e: GEvent) => ({
  id: e.id,
  summary: e.summary ?? '(no title)',
  start: e.start?.dateTime ?? e.start?.date ?? null,
  end: e.end?.dateTime ?? e.end?.date ?? null,
  location: e.location ?? null,
  description: e.description ?? null,
  attendees: (e.attendees ?? []).map((a) => ({ email: a.email, response: a.responseStatus ?? null })),
  link: e.htmlLink ?? null,
});

const calTool = toolBuilder<ToolContext<GoogleCreds, CalendarConfig>>();

export const googleCalendarIntegration = defineIntegration({
  id: 'google_calendar',
  name: 'Google Calendar',
  category: 'productivity',
  description: 'Check availability and book appointments on a Google Calendar.',
  verified: false,
  status: 'available',
  docsUrl: 'https://developers.google.com/calendar/api/v3/reference',
  authSchema: googleAuth,
  configSchema: calendarConfig,
  tools: [
    calTool({
      name: 'gcal_list_events',
      description: 'List calendar events in a time range (defaults to the next 7 days).',
      args: z.object({
        timeMin: z.string().datetime({ offset: true }).optional(),
        timeMax: z.string().datetime({ offset: true }).optional(),
        query: z.string().max(200).optional().describe('Free-text search'),
        maxResults: z.number().int().min(1).max(50).default(20),
      }),
      risk: 'read',
      handler: async (ctx, args) => {
        const cfg = calendarConfig.parse(ctx.config ?? {});
        const now = ctx.now();
        const timeMin = args.timeMin ?? now.toISOString();
        const timeMax = args.timeMax ?? new Date(new Date(timeMin).getTime() + 7 * 86_400_000).toISOString();
        const res = await googleRequest<{ items?: GEvent[] }>(
          ctx,
          `${CAL}/calendars/${encodeURIComponent(cfg.calendarId)}/events${qs({ timeMin, timeMax, q: args.query, maxResults: args.maxResults, singleEvents: true, orderBy: 'startTime', timeZone: cfg.timezone })}`,
          { service: 'Google Calendar' },
        );
        return { events: (res.items ?? []).map(mapEvent) };
      },
    }),
    calTool({
      name: 'gcal_create_event',
      description:
        'Create a calendar event (appointment/booking). Times are ISO 8601; the calendar time zone is used if no offset.',
      args: z.object({
        summary: z.string().min(1).max(300),
        start: z.string().min(10).max(40),
        end: z.string().min(10).max(40),
        description: z.string().max(4000).optional(),
        location: z.string().max(500).optional(),
        attendees: z.array(z.string().email()).max(20).optional(),
      }),
      risk: 'external_write',
      handler: async (ctx, args) => {
        const cfg = calendarConfig.parse(ctx.config ?? {});
        const event = await googleRequest<GEvent>(
          ctx,
          `${CAL}/calendars/${encodeURIComponent(cfg.calendarId)}/events`,
          {
            method: 'POST',
            service: 'Google Calendar',
            body: buildCalendarEvent(args, cfg.timezone),
          },
        );
        return { event: mapEvent(event) };
      },
    }),
  ],
});

export function buildCalendarEvent(
  args: {
    summary: string;
    start: string;
    end: string;
    description?: string;
    location?: string;
    attendees?: string[];
  },
  timeZone: string,
) {
  return {
    summary: args.summary,
    ...(args.description ? { description: args.description } : {}),
    ...(args.location ? { location: args.location } : {}),
    start: { dateTime: args.start, timeZone },
    end: { dateTime: args.end, timeZone },
    ...(args.attendees?.length ? { attendees: args.attendees.map((email) => ({ email })) } : {}),
  };
}

// ---------------------------------------------------------------- Gmail

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

const encodeHeader = (s: string) =>
  /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;

/** Build an RFC 2822 message (UTF-8, base64 body) and return Gmail's base64url `raw`. */
export function buildRawEmail(msg: {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  from?: string;
  replyTo?: string;
}): string {
  for (const v of [...msg.to, ...(msg.cc ?? []), msg.subject, msg.from ?? '', msg.replyTo ?? '']) {
    if (/[\r\n]/.test(v)) throw new AppError('bad_request', 'Header values must not contain line breaks');
  }
  const headers = [
    ...(msg.from ? [`From: ${msg.from}`] : []),
    `To: ${msg.to.join(', ')}`,
    ...(msg.cc?.length ? [`Cc: ${msg.cc.join(', ')}`] : []),
    ...(msg.replyTo ? [`Reply-To: ${msg.replyTo}`] : []),
    `Subject: ${encodeHeader(msg.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  ];
  const body = Buffer.from(msg.body, 'utf8')
    .toString('base64')
    .replace(/.{76}(?=.)/g, '$&\r\n');
  return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}`, 'utf8').toString('base64url');
}

const gmailTool = toolBuilder<ToolContext<GoogleCreds, { fromName?: string }>>();

export const gmailIntegration = defineIntegration({
  id: 'gmail',
  name: 'Gmail',
  category: 'productivity',
  description: 'Search the mailbox and send emails from the connected Gmail account.',
  verified: false,
  status: 'available',
  docsUrl: 'https://developers.google.com/gmail/api/reference/rest',
  authSchema: googleAuth,
  configSchema: z.object({ fromName: singleLine(100).optional() }),
  tools: [
    gmailTool({
      name: 'gmail_search',
      description:
        'Search emails using Gmail search syntax (e.g. "from:an@example.com newer_than:7d"). Returns subject, sender, date and snippet.',
      args: z.object({
        query: z.string().min(1).max(500),
        maxResults: z.number().int().min(1).max(20).default(5),
      }),
      risk: 'read',
      handler: async (ctx, args) => {
        const list = await googleRequest<{ messages?: { id: string; threadId: string }[] }>(
          ctx,
          `${GMAIL}/messages${qs({ q: args.query, maxResults: args.maxResults })}`,
          {
            service: 'Gmail',
          },
        );
        const messages = await Promise.all(
          (list.messages ?? []).map(async (m) => {
            const full = await googleRequest<{
              id: string;
              threadId: string;
              snippet?: string;
              payload?: { headers?: { name: string; value: string }[] };
            }>(
              ctx,
              `${GMAIL}/messages/${encodeURIComponent(m.id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
              { service: 'Gmail' },
            );
            const h = (name: string) =>
              full.payload?.headers?.find((x) => x.name.toLowerCase() === name.toLowerCase())?.value ?? null;
            return {
              id: full.id,
              threadId: full.threadId,
              subject: h('Subject'),
              from: h('From'),
              date: h('Date'),
              snippet: full.snippet ?? '',
            };
          }),
        );
        return { messages };
      },
    }),
    gmailTool({
      name: 'gmail_send',
      description: 'Send a plain-text email from the connected Gmail account.',
      args: z.object({
        to: z.array(z.string().email()).min(1).max(20),
        cc: z.array(z.string().email()).max(20).optional(),
        subject: singleLine(300),
        body: z.string().min(1).max(50_000),
      }),
      risk: 'external_write',
      handler: async (ctx, args) => {
        const raw = buildRawEmail({ ...args });
        const res = await googleRequest<{ id: string; threadId: string }>(ctx, `${GMAIL}/messages/send`, {
          method: 'POST',
          service: 'Gmail',
          body: { raw },
        });
        return { sent: true, id: res.id, threadId: res.threadId };
      },
    }),
  ],
});
