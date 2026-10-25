import type { Category, Severity } from '../config';

export type Verdict = 'confirmed' | 'plausible' | 'rejected';

/**
 * Where a finding ended up:
 *  - posted: inline review comment
 *  - general: listed in the summary (could not be anchored to a changed line)
 *  - digest: low-severity note collected in the summary's collapsed digest
 *  - rejected: refuted by the Critic
 *  - filtered: dropped by a deterministic rule (threshold, plausible disabled, low confidence) — see statusReason
 *  - duplicate / capped / already_posted / suppressed: see statusReason
 */
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

export const VISIBLE_STATUSES: readonly FindingStatus[] = ['posted', 'general', 'digest'];

export interface Finding {
  /** Stable within one review: F1, F2, … */
  id: string;
  batchId: string;
  path: string;
  /** Final anchored line (or the cited/corrected line when not anchored). */
  line: number;
  endLine: number | null;
  originalLine: number;
  originalEndLine: number | null;
  severity: Severity;
  originalSeverity: Severity;
  category: Category;
  title: string;
  body: string;
  failureScenario: string;
  suggestion: string | null;
  /** Exact replacement code for line..endLine proposed by the Reviewer. */
  replacement: string | null;
  confidence: number;
  verdict: Verdict;
  criticReason: string | null;
  /** The Critic corrected the line and the correction was accepted. */
  lineCorrected: boolean;
  anchored: boolean;
  /** Anchoring moved the start line. */
  moved: boolean;
  /** Final range differs from the range the Reviewer proposed the replacement for. */
  rangeChanged: boolean;
  status: FindingStatus;
  statusReason: string | null;
  fingerprint: string;
  snippetHash: string;
  /** Code of the final line range (used for suggestion blocks). */
  codeLines: string[];
}

export interface UsageTotals {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  costMicros: number;
}

export const emptyUsage = (): UsageTotals => ({
  calls: 0,
  promptTokens: 0,
  completionTokens: 0,
  costMicros: 0,
});
