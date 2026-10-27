/**
 * GitHub App adapter on top of @octokit/rest + @octokit/auth-app.
 *
 * verified: false — implemented against GitHub's public REST docs and unit-tested
 * with recorded-shape fixtures (see octokit.test.ts); not yet exercised against
 * the real api.github.com.
 *
 * Auth: the app signs a short-lived JWT (RS256, GITHUB_APP_ID + GITHUB_PRIVATE_KEY)
 * and exchanges it for installation tokens, which @octokit/auth-app caches until
 * shortly before they expire (tokens live 1 hour).
 */
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import type {
  CheckRunInput,
  CompareResult,
  CreateReviewInput,
  GitHubApp,
  InstallationClient,
  InstallationInfo,
  PullComment,
  PullRequestInfo,
  RepoInfo,
} from './types';

export interface GitHubAppOptions {
  appId: string | number;
  privateKey: string;
  slug?: string | null;
  /** Override for GitHub Enterprise Server, e.g. https://ghe.example.com/api/v3 */
  baseUrl?: string;
  clientId?: string;
  clientSecret?: string;
  /** Injected fetch (tests). */
  fetch?: typeof fetch;
  userAgent?: string;
}

/** Accept PEM with real newlines, `\n`-escaped newlines (env vars) or base64-encoded PEM. */
export function normalizePrivateKey(raw: string): string {
  const key = raw.replace(/\\n/g, '\n').trim();
  if (key.includes('-----BEGIN')) return key;
  const decoded = Buffer.from(key, 'base64').toString('utf8');
  return decoded.includes('-----BEGIN') ? decoded.trim() : key;
}

const statusOf = (err: unknown) => (err as { status?: number })?.status;

function toText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data))
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  return '';
}

export function createGitHubApp(opts: GitHubAppOptions): GitHubApp {
  const privateKey = normalizePrivateKey(opts.privateKey);
  const request = opts.fetch ? { fetch: opts.fetch } : undefined;
  const common = { baseUrl: opts.baseUrl, request, userAgent: opts.userAgent ?? 'minh-review' };
  const appOctokit = new Octokit({
    ...common,
    authStrategy: createAppAuth,
    auth: { appId: opts.appId, privateKey },
  });
  const clients = new Map<number, InstallationClient>();

  const app: GitHubApp = {
    slug: opts.slug ?? null,
    installation(installationId) {
      let client = clients.get(installationId);
      if (!client) {
        // One Octokit per installation: its auth strategy caches that installation's token.
        const octokit = new Octokit({
          ...common,
          authStrategy: createAppAuth,
          auth: { appId: opts.appId, privateKey, installationId },
        });
        client = new OctokitInstallationClient(octokit);
        clients.set(installationId, client);
      }
      return client;
    },
    async getInstallation(installationId): Promise<InstallationInfo | null> {
      try {
        const { data } = await appOctokit.rest.apps.getInstallation({ installation_id: installationId });
        const account = data.account as { login?: string; slug?: string; type?: string; id?: number } | null;
        return {
          id: data.id,
          accountLogin: account?.login ?? account?.slug ?? '',
          accountType: account?.type ?? 'Organization',
          accountId: account?.id ?? 0,
          createdAt: data.created_at,
        };
      } catch (err) {
        if (statusOf(err) === 404) return null;
        throw err;
      }
    },
  };

  if (opts.clientId && opts.clientSecret) {
    const { clientId, clientSecret } = opts;
    app.userCanAccessInstallation = async (code, installationId) => {
      const auth = createAppAuth({
        appId: opts.appId,
        privateKey,
        clientId,
        clientSecret,
        request: appOctokit.request,
      });
      const { token } = (await auth({ type: 'oauth-user', code })) as { token: string };
      const user = new Octokit({ ...common, auth: token });
      const installs = await user.paginate(user.rest.apps.listInstallationsForAuthenticatedUser, {
        per_page: 100,
      });
      return installs.some((i) => i.id === installationId);
    };
  }
  return app;
}

interface RawFile {
  filename: string;
  previous_filename?: string;
  status: string;
  patch?: string;
}

/**
 * Rebuild a unified diff from GitHub's file list (`pulls.listFiles` / compare).
 * Used when the diff media type is refused (too large) and for compare results.
 * Files without a patch (binary or too large) become `Binary files … differ`.
 */
export function synthesizeDiff(files: RawFile[]): string {
  const out: string[] = [];
  for (const f of files) {
    const oldPath = f.previous_filename ?? f.filename;
    out.push(`diff --git a/${oldPath} b/${f.filename}`);
    if (f.status === 'added') out.push('new file mode 100644');
    if (f.status === 'removed') out.push('deleted file mode 100644');
    if (f.status === 'renamed' || (f.previous_filename && f.previous_filename !== f.filename)) {
      out.push(`rename from ${oldPath}`, `rename to ${f.filename}`);
    }
    if (f.patch) {
      out.push(f.status === 'added' ? '--- /dev/null' : `--- a/${oldPath}`);
      out.push(f.status === 'removed' ? '+++ /dev/null' : `+++ b/${f.filename}`);
      out.push(f.patch.replace(/\n$/, ''));
    } else if (f.status !== 'renamed') {
      out.push(
        `Binary files ${f.status === 'added' ? '/dev/null' : `a/${oldPath}`} and ${f.status === 'removed' ? '/dev/null' : `b/${f.filename}`} differ`,
      );
    }
  }
  return out.length ? `${out.join('\n')}\n` : '';
}

interface RawComment {
  id: number;
  path: string;
  line?: number | null;
  original_line?: number | null;
  body: string;
  in_reply_to_id?: number;
  author_association?: string;
  user?: { login?: string; type?: string } | null;
  reactions?: { '-1'?: number };
}

function toPullComment(c: RawComment): PullComment {
  return {
    id: c.id,
    path: c.path,
    line: c.line ?? c.original_line ?? null,
    body: c.body,
    inReplyToId: c.in_reply_to_id ?? null,
    authorLogin: c.user?.login ?? '',
    authorAssociation: c.author_association ?? 'NONE',
    authorType: c.user?.type ?? 'User',
    thumbsDown: c.reactions?.['-1'] ?? 0,
  };
}

export class OctokitInstallationClient implements InstallationClient {
  constructor(private readonly o: Octokit) {}

  async getPullRequest(owner: string, repo: string, number: number): Promise<PullRequestInfo> {
    const { data } = await this.o.rest.pulls.get({ owner, repo, pull_number: number });
    return {
      number: data.number,
      title: data.title,
      body: data.body ?? null,
      state: data.state === 'closed' ? 'closed' : 'open',
      draft: Boolean(data.draft),
      merged: Boolean(data.merged),
      headSha: data.head.sha,
      headRef: data.head.ref,
      headRepoFullName: data.head.repo?.full_name ?? null,
      baseSha: data.base.sha,
      baseRef: data.base.ref,
      baseRepoFullName: data.base.repo.full_name,
      authorLogin: data.user?.login ?? '',
      htmlUrl: data.html_url,
    };
  }

  async getPullRequestDiff(owner: string, repo: string, number: number): Promise<string> {
    try {
      const res = await this.o.rest.pulls.get({
        owner,
        repo,
        pull_number: number,
        mediaType: { format: 'diff' },
      });
      return toText(res.data);
    } catch (err) {
      // 406: "diff too large" — rebuild from the paginated file list (up to 3000 files).
      if (statusOf(err) !== 406 && statusOf(err) !== 422) throw err;
      const files = await this.o.paginate(this.o.rest.pulls.listFiles, {
        owner,
        repo,
        pull_number: number,
        per_page: 100,
      });
      return synthesizeDiff(files);
    }
  }

  async compareCommits(
    owner: string,
    repo: string,
    base: string,
    head: string,
  ): Promise<CompareResult | null> {
    try {
      const { data } = await this.o.rest.repos.compareCommitsWithBasehead({
        owner,
        repo,
        basehead: `${base}...${head}`,
      });
      const files = (data.files ?? []) as RawFile[];
      return { status: data.status, diff: synthesizeDiff(files), truncated: files.length >= 300 };
    } catch (err) {
      if (statusOf(err) === 404) return null;
      throw err;
    }
  }

  async getFileContent(owner: string, repo: string, path: string, ref: string): Promise<string | null> {
    try {
      const res = await this.o.rest.repos.getContent({
        owner,
        repo,
        path,
        ref,
        mediaType: { format: 'raw' },
      });
      // Directories come back as JSON arrays even with the raw media type.
      return Array.isArray(res.data) ? null : toText(res.data);
    } catch (err) {
      if (statusOf(err) === 404) return null;
      throw err;
    }
  }

  async listFiles(owner: string, repo: string, ref: string): Promise<string[]> {
    const { data } = await this.o.rest.git.getTree({ owner, repo, tree_sha: ref, recursive: 'true' });
    return data.tree.filter((t) => t.type === 'blob' && t.path).map((t) => t.path!);
  }

  async createReview(
    owner: string,
    repo: string,
    number: number,
    input: CreateReviewInput,
  ): Promise<{ id: number }> {
    const { data } = await this.o.rest.pulls.createReview({
      owner,
      repo,
      pull_number: number,
      commit_id: input.commitId,
      body: input.body,
      event: input.event,
      comments: input.comments,
    });
    return { id: data.id };
  }

  async listReviewComments(
    owner: string,
    repo: string,
    number: number,
    reviewId: number,
  ): Promise<PullComment[]> {
    const data = await this.o.paginate(this.o.rest.pulls.listCommentsForReview, {
      owner,
      repo,
      pull_number: number,
      review_id: reviewId,
      per_page: 100,
    });
    return (data as unknown as RawComment[]).map(toPullComment);
  }

  async listPullComments(owner: string, repo: string, number: number): Promise<PullComment[]> {
    const data = await this.o.paginate(this.o.rest.pulls.listReviewComments, {
      owner,
      repo,
      pull_number: number,
      per_page: 100,
    });
    return (data as unknown as RawComment[]).map(toPullComment);
  }

  async createIssueComment(
    owner: string,
    repo: string,
    number: number,
    body: string,
  ): Promise<{ id: number }> {
    const { data } = await this.o.rest.issues.createComment({ owner, repo, issue_number: number, body });
    return { id: data.id };
  }

  async addReaction(
    owner: string,
    repo: string,
    commentId: number,
    content: 'eyes' | '+1' | 'confused',
  ): Promise<void> {
    await this.o.rest.reactions.createForIssueComment({ owner, repo, comment_id: commentId, content });
  }

  async createCheckRun(owner: string, repo: string, input: CheckRunInput): Promise<{ id: number }> {
    const { data } = await this.o.rest.checks.create({
      owner,
      repo,
      name: input.name,
      head_sha: input.headSha,
      status: input.status,
      ...(input.status === 'completed'
        ? { conclusion: input.conclusion ?? 'neutral', completed_at: new Date().toISOString() }
        : {}),
      started_at: new Date().toISOString(),
      details_url: input.detailsUrl,
      output: { title: input.title, summary: input.summary.slice(0, 65_000) },
    });
    return { id: data.id };
  }

  async updateCheckRun(owner: string, repo: string, checkRunId: number, input: CheckRunInput): Promise<void> {
    await this.o.rest.checks.update({
      owner,
      repo,
      check_run_id: checkRunId,
      status: input.status,
      ...(input.status === 'completed'
        ? { conclusion: input.conclusion ?? 'neutral', completed_at: new Date().toISOString() }
        : {}),
      details_url: input.detailsUrl,
      output: { title: input.title, summary: input.summary.slice(0, 65_000) },
    });
  }

  async listRepositories(): Promise<RepoInfo[]> {
    const repos = await this.o.paginate(this.o.rest.apps.listReposAccessibleToInstallation, {
      per_page: 100,
    });
    return (repos as unknown as { id: number; full_name: string; private: boolean }[]).map((r) => ({
      id: r.id,
      fullName: r.full_name,
      private: r.private,
    }));
  }
}
