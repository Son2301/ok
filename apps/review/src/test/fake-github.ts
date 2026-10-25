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
} from '../github/types';

export interface FakePr {
  info: PullRequestInfo;
  diff: string;
}

export interface PostedReview {
  installationId: number;
  repo: string;
  number: number;
  input: CreateReviewInput;
  id: number;
}

/** In-memory GitHub used by tests: no network, records every write. */
export class FakeGitHub implements GitHubApp {
  readonly slug = 'ok-review';
  readonly prs = new Map<string, FakePr>();
  readonly files = new Map<string, string>();
  readonly compares = new Map<string, CompareResult>();
  readonly trees = new Map<string, string[]>();
  readonly installations = new Map<number, InstallationInfo>();
  readonly repos = new Map<number, RepoInfo[]>();
  readonly pullComments = new Map<string, PullComment[]>();

  readonly reviews: PostedReview[] = [];
  readonly issueComments: { repo: string; number: number; body: string }[] = [];
  readonly reactions: { repo: string; commentId: number; content: string }[] = [];
  readonly checkRuns: { id: number; repo: string; updates: CheckRunInput[] }[] = [];
  readonly calls: string[] = [];

  /** Reject review creation with 422 while comments are attached (simulates unplaceable comments). */
  rejectInlineComments = false;
  /** Gate getPullRequest (lets tests hold a job "running"). */
  gate: Promise<void> | null = null;
  failNext: { method: string; error: unknown } | null = null;
  oauthUsers = new Map<string, number[]>();
  private nextId = 1000;

  setPr(repo: string, info: Partial<PullRequestInfo> & { number: number; headSha: string }, diff: string) {
    this.prs.set(`${repo}#${info.number}`, {
      info: {
        title: 'Test PR',
        body: null,
        state: 'open',
        draft: false,
        merged: false,
        headRef: 'feature',
        headRepoFullName: repo,
        baseSha: 'base000',
        baseRef: 'main',
        baseRepoFullName: repo,
        authorLogin: 'author',
        htmlUrl: `https://github.com/${repo}/pull/${info.number}`,
        ...info,
      },
      diff,
    });
  }

  setFile(repo: string, ref: string, path: string, content: string) {
    this.files.set(`${repo}@${ref}:${path}`, content);
  }

  installation(installationId: number): InstallationClient {
    const self = this;
    const key = (o: string, r: string) => `${o}/${r}`;
    const maybeFail = (method: string) => {
      self.calls.push(method);
      if (self.failNext?.method === method) {
        const { error } = self.failNext;
        self.failNext = null;
        throw error;
      }
    };
    return {
      async getPullRequest(o, r, n) {
        maybeFail('getPullRequest');
        if (self.gate) await self.gate;
        const pr = self.prs.get(`${key(o, r)}#${n}`);
        if (!pr) throw Object.assign(new Error('Not Found'), { status: 404 });
        return { ...pr.info };
      },
      async getPullRequestDiff(o, r, n) {
        maybeFail('getPullRequestDiff');
        return self.prs.get(`${key(o, r)}#${n}`)?.diff ?? '';
      },
      async compareCommits(o, r, base, head) {
        maybeFail('compareCommits');
        return self.compares.get(`${key(o, r)}:${base}...${head}`) ?? null;
      },
      async getFileContent(o, r, path, ref) {
        maybeFail('getFileContent');
        return self.files.get(`${key(o, r)}@${ref}:${path}`) ?? null;
      },
      async listFiles(o, r, ref) {
        maybeFail('listFiles');
        return self.trees.get(`${key(o, r)}@${ref}`) ?? [];
      },
      async createReview(o, r, n, input) {
        maybeFail('createReview');
        if (self.rejectInlineComments && input.comments.length) {
          throw Object.assign(new Error('Unprocessable Entity: line must be part of the diff'), {
            status: 422,
          });
        }
        const id = self.nextId++;
        self.reviews.push({ installationId, repo: key(o, r), number: n, input, id });
        const list = self.pullComments.get(`${key(o, r)}#${n}`) ?? [];
        for (const c of input.comments) {
          list.push({
            id: self.nextId++,
            path: c.path,
            line: c.line,
            body: c.body,
            inReplyToId: null,
            authorLogin: 'ok-review[bot]',
            authorAssociation: 'NONE',
            authorType: 'Bot',
            thumbsDown: 0,
            reviewId: id,
          } as PullComment & { reviewId: number });
        }
        self.pullComments.set(`${key(o, r)}#${n}`, list);
        return { id };
      },
      async listReviewComments(o, r, n, reviewId) {
        maybeFail('listReviewComments');
        return (self.pullComments.get(`${key(o, r)}#${n}`) ?? []).filter(
          (c) => (c as PullComment & { reviewId?: number }).reviewId === reviewId,
        );
      },
      async listPullComments(o, r, n) {
        maybeFail('listPullComments');
        return self.pullComments.get(`${key(o, r)}#${n}`) ?? [];
      },
      async createIssueComment(o, r, n, body) {
        maybeFail('createIssueComment');
        self.issueComments.push({ repo: key(o, r), number: n, body });
        return { id: self.nextId++ };
      },
      async addReaction(o, r, commentId, content) {
        maybeFail('addReaction');
        self.reactions.push({ repo: key(o, r), commentId, content });
      },
      async createCheckRun(o, r, input) {
        maybeFail('createCheckRun');
        const id = self.nextId++;
        self.checkRuns.push({ id, repo: key(o, r), updates: [input] });
        return { id };
      },
      async updateCheckRun(_o, _r, id, input) {
        maybeFail('updateCheckRun');
        self.checkRuns.find((c) => c.id === id)?.updates.push(input);
      },
      async listRepositories() {
        maybeFail('listRepositories');
        return self.repos.get(installationId) ?? [];
      },
    };
  }

  async getInstallation(id: number) {
    return this.installations.get(id) ?? null;
  }

  async userCanAccessInstallation(code: string, installationId: number) {
    return this.oauthUsers.get(code)?.includes(installationId) ?? false;
  }

  /** Simulate a human replying to (or 👎-ing) one of our inline comments. */
  reply(
    repo: string,
    number: number,
    toCommentId: number,
    body: string,
    association = 'MEMBER',
    login = 'maintainer',
  ) {
    const list = this.pullComments.get(`${repo}#${number}`) ?? [];
    list.push({
      id: this.nextId++,
      path: '',
      line: null,
      body,
      inReplyToId: toCommentId,
      authorLogin: login,
      authorAssociation: association,
      authorType: 'User',
      thumbsDown: 0,
    });
    this.pullComments.set(`${repo}#${number}`, list);
  }

  thumbsDown(repo: string, number: number, commentId: number) {
    const c = this.pullComments.get(`${repo}#${number}`)?.find((x) => x.id === commentId);
    if (c) c.thumbsDown += 1;
  }
}
