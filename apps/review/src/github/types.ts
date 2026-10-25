/**
 * The narrow GitHub surface the Review service needs. Production uses the Octokit
 * adapter (`octokit.ts`); tests use an in-memory fake, so nothing hits api.github.com.
 */

export interface PullRequestInfo {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  draft: boolean;
  merged: boolean;
  headSha: string;
  headRef: string;
  /** Null when the head repository (fork) was deleted. */
  headRepoFullName: string | null;
  baseSha: string;
  baseRef: string;
  baseRepoFullName: string;
  authorLogin: string;
  htmlUrl: string;
}

export interface ReviewCommentInput {
  path: string;
  /** Last line of the range (RIGHT side). */
  line: number;
  side: 'RIGHT';
  /** First line for multi-line comments. */
  start_line?: number;
  start_side?: 'RIGHT';
  body: string;
}

export interface CreateReviewInput {
  commitId: string;
  body: string;
  event: 'COMMENT';
  comments: ReviewCommentInput[];
}

export interface PullComment {
  id: number;
  path: string;
  line: number | null;
  body: string;
  inReplyToId: number | null;
  authorLogin: string;
  authorAssociation: string;
  authorType: string;
  /** Number of 👎 reactions. */
  thumbsDown: number;
}

export interface CompareResult {
  status: 'ahead' | 'behind' | 'identical' | 'diverged';
  /** Unified diff of base...head. */
  diff: string;
  /** True when GitHub capped the file list, so the diff may be incomplete. */
  truncated: boolean;
}

export type CheckConclusion = 'success' | 'neutral' | 'failure';

export interface CheckRunInput {
  name: string;
  headSha: string;
  status: 'in_progress' | 'completed';
  conclusion?: CheckConclusion;
  title: string;
  summary: string;
  detailsUrl?: string;
}

export interface RepoInfo {
  id: number;
  fullName: string;
  private: boolean;
}

export interface InstallationInfo {
  id: number;
  accountLogin: string;
  accountType: string;
  accountId: number;
  createdAt?: string;
}

export interface InstallationClient {
  getPullRequest(owner: string, repo: string, number: number): Promise<PullRequestInfo>;
  /** Unified diff of the PR (base...head), as GitHub renders it. */
  getPullRequestDiff(owner: string, repo: string, number: number): Promise<string>;
  /** null when either commit is unknown (e.g. force-pushed away and garbage-collected). */
  compareCommits(owner: string, repo: string, base: string, head: string): Promise<CompareResult | null>;
  /** Raw file content at `ref`, or null if it does not exist. */
  getFileContent(owner: string, repo: string, path: string, ref: string): Promise<string | null>;
  /** File paths of the repository tree at `ref` (may be truncated for huge repos). */
  listFiles(owner: string, repo: string, ref: string): Promise<string[]>;
  createReview(
    owner: string,
    repo: string,
    number: number,
    input: CreateReviewInput,
  ): Promise<{ id: number }>;
  /** Comments belonging to one review (to learn the ids of comments we just posted). */
  listReviewComments(owner: string, repo: string, number: number, reviewId: number): Promise<PullComment[]>;
  /** Every review comment on the PR, including replies (to detect dismissals). */
  listPullComments(owner: string, repo: string, number: number): Promise<PullComment[]>;
  createIssueComment(owner: string, repo: string, number: number, body: string): Promise<{ id: number }>;
  addReaction(
    owner: string,
    repo: string,
    commentId: number,
    content: 'eyes' | '+1' | 'confused',
  ): Promise<void>;
  createCheckRun(owner: string, repo: string, input: CheckRunInput): Promise<{ id: number }>;
  updateCheckRun(owner: string, repo: string, checkRunId: number, input: CheckRunInput): Promise<void>;
  listRepositories(): Promise<RepoInfo[]>;
}

export interface GitHubApp {
  /** App slug (for `@slug review` commands and the install URL). */
  readonly slug: string | null;
  installation(installationId: number): InstallationClient;
  /** App-level (JWT) lookup; null if GitHub does not know the installation. */
  getInstallation(installationId: number): Promise<InstallationInfo | null>;
  /**
   * Strong ownership check for the setup callback: exchange the OAuth `code` and
   * confirm the user can access the installation. Only available when the app's
   * OAuth client id/secret are configured.
   */
  userCanAccessInstallation?(code: string, installationId: number): Promise<boolean>;
}
