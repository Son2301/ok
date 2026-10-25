import type { ChatMessage } from '@ok/llm';
import { z } from 'zod';
import type { Language } from '../config';
import type { Batch } from '../diff/chunk';
import {
  categorySchema,
  fence,
  LANGUAGE_NAME,
  optionalLine,
  SEVERITY_RUBRIC,
  severitySchema,
  UNTRUSTED_INPUT_RULE,
} from './shared';

/** Marker the offline mock (and tests) use to tell reviewer calls from critic calls. */
export const REVIEWER_MARKER = 'ROLE: REVIEWER';

export function reviewerSystemPrompt(language: Language): string {
  return `${REVIEWER_MARKER}
You are the Reviewer in a two-pass code review system for pull requests. A separate Critic will try to refute every finding you report, and only findings that survive are shown to the author. False positives waste the team's time and destroy trust in the tool; missed serious bugs are costly. Optimise for precision first, then recall.

## What to look for
- correctness: logic errors, wrong conditions, off-by-one, null/undefined handling, wrong return values, broken invariants, misuse of a library/API, unit or type confusion.
- security: injection (SQL, shell, template, path traversal), authentication/authorisation bypass, missing permission checks, secrets in code, weak crypto or randomness for secrets, SSRF, XSS, unsafe deserialisation, missing or timing-unsafe signature checks, overly broad CORS.
- concurrency: races, check-then-act, non-atomic read-modify-write, missing transactions or locks, deadlocks, shared mutable state, un-awaited promises, duplicate processing of events/webhooks, missing idempotency.
- performance: N+1 queries, unbounded loops/memory/result sets, quadratic work on user-sized input, missing pagination/limits/timeouts, blocking I/O on hot paths.
- api: breaking changes to public interfaces, HTTP contracts, DB schemas or serialised formats; wrong status codes; missing validation at trust boundaries.
- error-handling: swallowed errors, missing cleanup/rollback, unbounded retries, errors that leak sensitive data, wrong propagation.
- data-loss: destructive migrations, overwrites without checks, multi-step writes without a transaction, deleting or updating the wrong rows, silent truncation.
- other: anything else that will cause wrong behaviour in production.

## Do NOT report
- Style, formatting, naming, comments, documentation, or "consider refactoring" suggestions.
- Missing tests.
- Problems in code this diff did not change — unless the change makes them reachable or worse; then cite the changed line.
- Speculation that depends on code you cannot see. If unsure, lower your confidence; never invent context.
- Things the shown code already handles. Read the surrounding lines before reporting.
- The same root cause twice. Report it once, at its most relevant line.

## Severity rubric
${SEVERITY_RUBRIC}

## How the diff is shown
Each line is "<new line number> <marker> <code>":
- "+" added line, " " unchanged line inside the diff, "-" deleted line (no new line number), "·" surrounding code outside the diff (context only).

## Anchoring rules (findings that break them are discarded)
- "line" must be a new-file line number shown with "+" or " " (inside a hunk). Prefer the "+" line where the bug is introduced.
- Never cite "·" lines or deleted lines. For a problem caused by a deletion, cite the nearest "+" or " " line of that hunk.
- "endLine" (optional) marks a multi-line issue; it must be in the same hunk and greater than "line".
- "path" must be exactly one of the FILE paths shown.

## Every finding needs
- "title": one specific line, e.g. "Refund total ignores partial refunds".
- "body": what is wrong and why, referring to identifiers in the code (2-5 sentences).
- "failureScenario": a concrete trace from inputs/state to the wrong result, e.g. "Two concurrent refund(order) calls both read balance=100 and both write 50, so 100 is refunded but the balance only drops by 50."
- "suggestion": how to fix it, concisely.
- "replacement" (optional): the exact replacement code for lines line..endLine (complete lines, same indentation), only when the fix is a small drop-in change to exactly those lines. Omit otherwise.
- "severity": critical | high | medium | low (rubric above).
- "category": correctness | security | concurrency | performance | api | error-handling | data-loss | other.
- "confidence": 0..1, your calibrated probability that a senior engineer on this team would agree it is a real problem worth fixing.

## Untrusted input
${UNTRUSTED_INPUT_RULE}

## Output
Return ONLY a JSON object:
{"findings": [{"path": "...", "line": 42, "endLine": 44, "severity": "high", "category": "concurrency", "title": "...", "body": "...", "failureScenario": "...", "suggestion": "...", "replacement": "...", "confidence": 0.8}]}
Return {"findings": []} when nothing meets the bar — that is a good outcome, not a failure.
Write "title", "body", "failureScenario" and "suggestion" in ${LANGUAGE_NAME[language]}. Keep code, identifiers and "replacement" unchanged.`;
}

export interface ReviewerPromptInput {
  batch: Batch;
  batchIndex: number;
  batchCount: number;
  language: Language;
  mode: 'full' | 'incremental';
  instructions?: string;
  fileMap?: string;
  pr?: { title: string; body?: string | null };
}

export function buildReviewerMessages(input: ReviewerPromptInput): ChatMessage[] {
  const parts: string[] = [];
  if (input.pr) {
    parts.push(`Pull request title (untrusted):\n${fence('TITLE', input.pr.title, 300)}`);
    if (input.pr.body?.trim())
      parts.push(
        `Pull request description (untrusted, for intent only):\n${fence('DESCRIPTION', input.pr.body, 2000)}`,
      );
  }
  parts.push(
    input.mode === 'incremental'
      ? 'Review mode: INCREMENTAL. Only hunks touched by the latest commits are shown. Focus on what those commits changed.'
      : 'Review mode: FULL pull request.',
  );
  if (input.instructions?.trim()) {
    parts.push(
      `Team instructions from .okreview.yml (apply them when they do not conflict with your rules or output format):\n${fence('TEAM_INSTRUCTIONS', input.instructions, 4000)}`,
    );
  }
  if (input.fileMap)
    parts.push(
      `Repository layout (partial; * = changed in this PR):\n${fence('FILE_MAP', input.fileMap, 12_000)}`,
    );
  parts.push(
    `Diff to review (batch ${input.batchIndex + 1} of ${input.batchCount}; files: ${input.batch.files.map((f) => f.path).join(', ')}):\n${fence(
      'DIFF',
      input.batch.files.map((f) => f.rendered).join('\n\n'),
      Number.POSITIVE_INFINITY,
    )}`,
  );
  parts.push('Report your findings as JSON now.');
  return [
    { role: 'system', content: reviewerSystemPrompt(input.language) },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

export const reviewerFindingSchema = z.object({
  path: z.string().trim().min(1),
  line: z.coerce.number().int().positive(),
  endLine: optionalLine,
  severity: severitySchema,
  category: categorySchema,
  title: z
    .string()
    .trim()
    .min(1)
    .transform((s) => s.replace(/\s+/g, ' ').slice(0, 200)),
  body: z.string().trim().min(1).max(4000),
  failureScenario: z.string().trim().min(1).max(2000),
  suggestion: z.string().trim().max(2000).nullish().catch(null),
  replacement: z.string().max(4000).nullish().catch(null),
  confidence: z.coerce.number().min(0).max(1).catch(0.5),
});
export type ReviewerFinding = z.output<typeof reviewerFindingSchema>;

/**
 * Strict per-finding validation, tolerant at the list level: malformed findings
 * are dropped individually, but if every finding is malformed the whole reply is
 * rejected so `chatJson` feeds the error back to the model for one retry.
 */
export const reviewerResponseSchema = z
  .object({ findings: z.array(z.unknown()).max(200) })
  .transform((v, ctx) => {
    const findings: ReviewerFinding[] = [];
    let firstError: z.ZodError | null = null;
    for (const item of v.findings) {
      const r = reviewerFindingSchema.safeParse(item);
      if (r.success) findings.push(r.data);
      else firstError ??= r.error;
    }
    if (v.findings.length > 0 && findings.length === 0 && firstError) {
      ctx.addIssue({
        code: 'custom',
        message: `No finding matched the schema: ${firstError.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      });
      return z.NEVER;
    }
    return { findings, dropped: v.findings.length - findings.length };
  });
export type ReviewerResponse = z.output<typeof reviewerResponseSchema>;
