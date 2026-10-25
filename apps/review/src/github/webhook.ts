import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify GitHub's `X-Hub-Signature-256: sha256=<hex>` header: HMAC-SHA256 of the
 * exact raw request body, compared in constant time.
 */
export function verifyWebhookSignature(
  secret: string,
  rawBody: string | Uint8Array,
  header: string | null | undefined,
): boolean {
  if (!secret || !header) return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!m) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const given = Buffer.from(m[1]!, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function signWebhookBody(secret: string, rawBody: string | Uint8Array): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

export type ReviewTrigger = 'opened' | 'reopened' | 'synchronize' | 'ready_for_review' | 'command' | 'api';

export interface ReviewJobPayload {
  installationId: number;
  repoId: number;
  owner: string;
  repo: string;
  number: number;
  trigger: ReviewTrigger;
  /** `full` forces a full-PR review; `auto` is incremental when an earlier review exists. */
  mode: 'auto' | 'full';
  /** Head SHA seen in the event (informational — the job re-reads the PR). */
  headSha?: string;
  /** Issue comment that requested the review (gets a 👀 reaction). */
  commentId?: number;
  requestedBy?: string;
}

export const reviewJobKey = (p: { repoId: number; number: number }) => `pr:${p.repoId}#${p.number}`;

/** Explicit requests (command/API) win over automatic triggers when jobs coalesce; `full` is sticky. */
export function mergeReviewJobs(pending: ReviewJobPayload, incoming: ReviewJobPayload): ReviewJobPayload {
  const explicit = (t: ReviewTrigger) => t === 'command' || t === 'api';
  return {
    ...incoming,
    trigger: explicit(pending.trigger) && !explicit(incoming.trigger) ? pending.trigger : incoming.trigger,
    mode: pending.mode === 'full' || incoming.mode === 'full' ? 'full' : 'auto',
    commentId: incoming.commentId ?? pending.commentId,
    requestedBy: incoming.requestedBy ?? pending.requestedBy,
  };
}

export interface InstallationPayload {
  id: number;
  accountLogin: string;
  accountType: string;
  accountId: number;
}

export interface RepoPayload {
  id: number;
  fullName: string;
  private: boolean;
}

export type RoutedEvent =
  | { kind: 'review'; job: ReviewJobPayload; draft: boolean }
  | { kind: 'cancel'; repoId: number; number: number }
  | { kind: 'installation'; action: string; installation: InstallationPayload; repositories: RepoPayload[] }
  | {
      kind: 'installation_repositories';
      action: string;
      installation: InstallationPayload;
      added: RepoPayload[];
      removed: RepoPayload[];
    }
  | { kind: 'ping' }
  | { kind: 'ignore'; reason: string };

const REVIEW_ACTIONS = new Set(['opened', 'reopened', 'synchronize', 'ready_for_review']);
/** Who may trigger a (billable) review by comment: repo members, or the PR author. */
const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Recognise `/review`, `/review full`, `@<app-slug> review [full]` on their own
 * line, ignoring quoted replies and fenced code blocks.
 */
export function parseReviewCommand(body: string, slug: string | null): { full: boolean } | null {
  let inFence = false;
  const slugRe = slug
    ? new RegExp(`^@${escapeRegExp(slug)}(?:\\[bot\\])?\\s+review(?:\\s+(full))?(?:\\s|$)`, 'i')
    : null;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('```') || line.startsWith('~~~')) {
      inFence = !inFence;
      continue;
    }
    if (inFence || line.startsWith('>')) continue;
    const m = /^\/review(?:\s+(full))?(?:\s|$)/i.exec(line) ?? slugRe?.exec(line);
    if (m) return { full: Boolean(m[1]) };
  }
  return null;
}

// biome-ignore lint/suspicious/noExplicitAny: webhook payloads are untyped JSON; every field is checked below
type Json = any;

function installationOf(payload: Json): InstallationPayload | null {
  const inst = payload?.installation;
  if (!inst || typeof inst.id !== 'number') return null;
  return {
    id: inst.id,
    accountLogin: String(inst.account?.login ?? inst.account?.slug ?? ''),
    accountType: String(inst.account?.type ?? 'Organization'),
    accountId: Number(inst.account?.id ?? 0),
  };
}

function reposOf(list: Json): RepoPayload[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((r) => r && typeof r.id === 'number' && typeof r.full_name === 'string')
    .map((r) => ({ id: r.id, fullName: r.full_name, private: Boolean(r.private) }));
}

/** Decide what a webhook delivery means. Pure: no I/O, easy to test. */
export function routeEvent(event: string, payload: Json, opts: { appSlug: string | null }): RoutedEvent {
  if (event === 'ping') return { kind: 'ping' };

  if (event === 'installation') {
    const installation = installationOf(payload);
    if (!installation) return { kind: 'ignore', reason: 'installation event without installation' };
    return {
      kind: 'installation',
      action: String(payload.action),
      installation,
      repositories: reposOf(payload.repositories),
    };
  }

  if (event === 'installation_repositories') {
    const installation = installationOf(payload);
    if (!installation) return { kind: 'ignore', reason: 'installation event without installation' };
    return {
      kind: 'installation_repositories',
      action: String(payload.action),
      installation,
      added: reposOf(payload.repositories_added),
      removed: reposOf(payload.repositories_removed),
    };
  }

  const repo = payload?.repository;
  const installationId = payload?.installation?.id;
  if (event === 'pull_request') {
    const pr = payload?.pull_request;
    if (!pr || !repo || typeof installationId !== 'number')
      return { kind: 'ignore', reason: 'incomplete pull_request payload' };
    if (payload.action === 'closed') return { kind: 'cancel', repoId: repo.id, number: pr.number };
    if (!REVIEW_ACTIONS.has(payload.action))
      return { kind: 'ignore', reason: `pull_request.${payload.action} is not reviewed` };
    if (pr.state === 'closed') return { kind: 'ignore', reason: 'pull request is closed' };
    return {
      kind: 'review',
      draft: Boolean(pr.draft),
      job: {
        installationId,
        repoId: repo.id,
        owner: repo.owner?.login ?? String(repo.full_name).split('/')[0],
        repo: repo.name ?? String(repo.full_name).split('/')[1],
        number: pr.number,
        trigger: payload.action,
        mode: 'auto',
        headSha: pr.head?.sha,
      },
    };
  }

  if (event === 'issue_comment') {
    if (payload?.action !== 'created')
      return { kind: 'ignore', reason: `issue_comment.${payload?.action} is not a command` };
    const issue = payload.issue;
    const comment = payload.comment;
    if (!issue?.pull_request) return { kind: 'ignore', reason: 'comment is not on a pull request' };
    if (!comment || !repo || typeof installationId !== 'number')
      return { kind: 'ignore', reason: 'incomplete issue_comment payload' };
    if (comment.user?.type === 'Bot') return { kind: 'ignore', reason: 'comment by a bot' };
    const cmd = parseReviewCommand(String(comment.body ?? ''), opts.appSlug);
    if (!cmd) return { kind: 'ignore', reason: 'no review command' };
    const isAuthor = comment.user?.login && comment.user.login === issue.user?.login;
    if (!TRUSTED_ASSOCIATIONS.has(comment.author_association) && !isAuthor) {
      return { kind: 'ignore', reason: `commenter (${comment.author_association}) may not request reviews` };
    }
    if (issue.state === 'closed') return { kind: 'ignore', reason: 'pull request is closed' };
    return {
      kind: 'review',
      draft: false,
      job: {
        installationId,
        repoId: repo.id,
        owner: repo.owner?.login ?? String(repo.full_name).split('/')[0],
        repo: repo.name ?? String(repo.full_name).split('/')[1],
        number: issue.number,
        trigger: 'command',
        mode: cmd.full ? 'full' : 'auto',
        commentId: comment.id,
        requestedBy: comment.user?.login,
      },
    };
  }

  return { kind: 'ignore', reason: `event ${event} is not handled` };
}
