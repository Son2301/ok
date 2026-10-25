/** Response shapes of the review console API (see apps/review/README.md). */

export type Severity = 'low' | 'medium' | 'high' | 'critical';
export const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low'];

export interface ReviewRepoRef {
  id: number;
  fullName: string;
  private: boolean;
  active: boolean;
}

export interface ReviewInstallation {
  id: number;
  account: string;
  accountType: string | null;
  status: string;
  linkedAt: string | null;
  repos: ReviewRepoRef[];
}

export interface RepoConfig {
  language: 'en' | 'vi';
  paths: { include: string[]; exclude: string[]; force: string[] };
  severityThreshold: Severity;
  maxComments: number;
  reviewDrafts: boolean;
  failOn: 'none' | Severity;
  models: { reviewer: string; critic: string };
  instructions: string;
  keepPlausible: boolean;
  incremental: boolean;
  limits: { maxFiles: number; maxChangedLines: number; maxFileChangedLines: number; contextLines: number };
}

export type RepoSettingsOverride = Partial<Omit<RepoConfig, 'paths' | 'models' | 'limits'>> & {
  paths?: Partial<RepoConfig['paths']>;
  models?: Partial<RepoConfig['models']>;
  limits?: Partial<RepoConfig['limits']>;
};

export interface ReviewRepo extends ReviewRepoRef {
  installationId: number;
  settings: RepoSettingsOverride | null;
}

export type ReviewStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'quota_exceeded'
  | 'insufficient_balance'
  | 'not_linked';

export interface ReviewSummary {
  id: string;
  repo: string;
  prNumber: number;
  prTitle: string | null;
  status: ReviewStatus | string;
  statusReason: string | null;
  mode: 'full' | 'incremental' | string;
  trigger: string;
  headSha: string | null;
  fromSha: string | null;
  findings: Record<Severity, number>;
  findingsCount: number;
  costMicros: number;
  durationMs: number | null;
  billedTo: 'org' | 'platform' | string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface ReviewStats {
  filesReviewed: number;
  skipped: { path: string; reason: string }[];
  candidates: number;
  confirmed: number;
  plausible: number;
  rejected: number;
  batches: number;
  resolved: number;
  stillOpen: number;
  warnings: string[];
  inlineFallback?: boolean;
}

export type FindingStatus =
  | 'posted'
  | 'general'
  | 'digest'
  | 'rejected'
  | 'filtered'
  | 'duplicate'
  | 'capped'
  | 'already_posted'
  | 'suppressed';

export interface ReviewFinding {
  id: string;
  localId: string;
  path: string;
  line: number;
  endLine: number | null;
  originalLine: number;
  severity: Severity;
  originalSeverity: Severity;
  category: string;
  title: string;
  body: string;
  failureScenario: string;
  suggestion: string | null;
  replacement: string | null;
  confidence: number;
  verdict: 'confirmed' | 'plausible' | 'rejected';
  criticReason: string | null;
  lineCorrected: boolean;
  anchored: boolean;
  status: FindingStatus | string;
  statusReason: string | null;
  fingerprint: string;
  githubCommentId: number | null;
  open: boolean;
  resolvedInReviewId: string | null;
  dismissedReason: string | null;
}

export interface ReviewDetail {
  review: ReviewSummary & {
    stats: ReviewStats | null;
    error: string | null;
    configError: string | null;
    models: { reviewer: string; critic: string } | null;
    githubReviewId: number | null;
  };
  findings: ReviewFinding[];
}

export interface ReviewUsage {
  period: string;
  installations: number;
  reviews: number;
  costMicros: number;
}

export interface InstallUrl {
  state: string;
  expiresAt: string;
  url: string | null;
  configured: boolean;
}

export interface RepoSettingsResponse {
  repo: string;
  settings: RepoSettingsOverride;
  defaults: RepoConfig;
}

export interface ReviewHealth {
  ok: boolean;
  service: string;
  github: { configured: boolean; appSlug: string | null; note?: string };
}
