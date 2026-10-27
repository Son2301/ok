import { describe, expect, it } from 'vitest';
import type { Finding } from '../pipeline/types';
import {
  canUseSuggestionBlock,
  checkConclusion,
  checkTitle,
  formatConfigErrorComment,
  formatInlineComment,
  formatSummary,
  type SummaryInput,
  sanitizeText,
  toReviewComment,
} from './format';

function f(over: Partial<Finding> = {}): Finding {
  return {
    id: 'F1',
    batchId: 'B1',
    path: 'src/users.ts',
    line: 12,
    endLine: null,
    originalLine: 12,
    originalEndLine: null,
    severity: 'high',
    originalSeverity: 'high',
    category: 'security',
    title: 'SQL injection via string concatenation',
    body: 'The id is concatenated into the query.',
    failureScenario: 'id = "1 OR 1=1" returns every user.',
    suggestion: 'Use a parameterized query.',
    replacement: 'const q = "SELECT * FROM users WHERE id = $1";',
    confidence: 0.9,
    verdict: 'confirmed',
    criticReason: 'Line 12 concatenates the raw id; no validation above.',
    lineCorrected: false,
    anchored: true,
    moved: false,
    rangeChanged: false,
    status: 'posted',
    statusReason: null,
    fingerprint: 'fp',
    snippetHash: 'sh',
    codeLines: ['const q = "SELECT * FROM users WHERE id = " + id;'],
    ...over,
  };
}

describe('inline comments', () => {
  it('renders severity, explanation, failure scenario, suggestion block, critic note and footer', () => {
    const body = formatInlineComment(f(), 'en');
    expect(body).toMatch(/^🟠 \*\*High · Security\*\* — SQL injection via string concatenation/);
    expect(body).toContain('The id is concatenated into the query.');
    expect(body).toContain('**Failure scenario:** id = "1 OR 1=1" returns every user.');
    expect(body).toContain('**Suggested fix:** Use a parameterized query.');
    expect(body).toContain('```suggestion\nconst q = "SELECT * FROM users WHERE id = $1";\n```');
    expect(body).toContain('<details><summary>Why this was flagged</summary>');
    expect(body).toContain('Confirmed by the Critic: Line 12 concatenates the raw id');
    expect(body).toMatch(/<sub>.*Review · two-pass review/);
  });

  it('falls back to a plain code block when the replacement no longer matches the commented lines', () => {
    for (const over of [
      { moved: true },
      { rangeChanged: true },
      { lineCorrected: true },
      { endLine: 30, codeLines: ['a'] },
    ]) {
      const finding = f(over);
      expect(canUseSuggestionBlock(finding)).toBe(false);
      const body = formatInlineComment(finding, 'en');
      expect(body).not.toContain('```suggestion');
      expect(body).toContain('```ts\nconst q');
    }
  });

  it('never emits no-op or oversized suggestion blocks', () => {
    expect(
      canUseSuggestionBlock(f({ replacement: '  const q = "SELECT * FROM users WHERE id = " + id;  ' })),
    ).toBe(false);
    expect(canUseSuggestionBlock(f({ replacement: Array.from({ length: 20 }, () => 'x').join('\n') }))).toBe(
      false,
    );
    expect(canUseSuggestionBlock(f({ replacement: 'a ``` b' }))).toBe(false);
    expect(canUseSuggestionBlock(f({ replacement: null }))).toBe(false);
    const multi = f({ endLine: 13, codeLines: ['a', 'b'], replacement: 'c\nd\n' });
    expect(canUseSuggestionBlock(multi)).toBe(true);
  });

  it('builds single- and multi-line GitHub review comments on the RIGHT side', () => {
    expect(toReviewComment(f(), 'en')).toMatchObject({ path: 'src/users.ts', line: 12, side: 'RIGHT' });
    expect(toReviewComment(f(), 'en')).not.toHaveProperty('start_line');
    expect(toReviewComment(f({ endLine: 14, codeLines: ['a', 'b', 'c'] }), 'en')).toMatchObject({
      start_line: 12,
      start_side: 'RIGHT',
      line: 14,
      side: 'RIGHT',
    });
  });

  it('localizes to Vietnamese and defuses @mentions', () => {
    const body = formatInlineComment(f({ body: 'Ping @octocat and @org/team, mail a@b.com' }), 'vi');
    expect(body).toContain('**Cao · Bảo mật**');
    expect(body).toContain('**Kịch bản lỗi:**');
    expect(body).toContain('Vì sao bị gắn cờ');
    expect(body).toContain('@​octocat');
    expect(body).toContain('a@b.com');
    expect(sanitizeText('`@x`')).toBe('`@x`');
  });
});

describe('summary', () => {
  const base: SummaryInput = {
    language: 'en',
    mode: 'full',
    headSha: 'def5678abcdef',
    findings: [],
    filesReviewed: 3,
    skipped: [],
    resolved: [],
    stillOpen: 0,
    durationMs: 12_300,
    costMicros: 12_345,
    models: { reviewer: 'auto:best', critic: 'auto' },
    warnings: [],
  };

  it('says "no verified issues" with the number of rejected candidates when nothing survives', () => {
    const body = formatSummary({
      ...base,
      findings: [
        f({ verdict: 'rejected', status: 'rejected' }),
        f({ id: 'F2', verdict: 'rejected', status: 'rejected' }),
      ],
    });
    expect(body).toContain('No verified issues (2 candidate findings rejected by the Critic).');
    expect(body).not.toContain('| Severity |');
    expect(body).toContain('⏱ 12.3s');
    expect(body).toContain('💰 $0.0123');
    expect(formatSummary(base)).toContain('No issues found in the changed code.');
  });

  it('renders the verdict table, scope, two-pass stats, general findings, digest, resolved and skipped files', () => {
    const body = formatSummary({
      ...base,
      mode: 'incremental',
      fromSha: 'abc1234ffff',
      findings: [
        f(),
        f({
          id: 'F2',
          title: 'Unanchored race',
          status: 'general',
          anchored: false,
          severity: 'medium',
          line: 99,
        }),
        f({ id: 'F3', title: 'Tiny nit', status: 'digest', severity: 'low' }),
        f({ id: 'F4', status: 'rejected', verdict: 'rejected' }),
        f({ id: 'F5', status: 'capped' }),
      ],
      skipped: [
        { path: 'pnpm-lock.yaml', reason: 'lockfile' },
        { path: 'a|b.ts', reason: 'budget' },
      ],
      resolved: [{ title: 'Old bug', path: 'src/old.ts', line: 3 }],
      stillOpen: 2,
      warnings: ['Reviewer batch B2 failed: timeout'],
      configError: 'language: Invalid option',
    });
    expect(body).toContain('— 3 issues found');
    expect(body).toContain('| 🟠 High | 1 |'); // the capped high finding is not counted as shown
    expect(body).toContain('| 🟡 Medium | 1 |');
    expect(body).toContain('| 🔵 Low | 1 |');
    expect(body).toContain('Incremental review of `abc1234..def5678`');
    expect(body).toContain('5 candidates from the Reviewer → Critic confirmed 4, plausible 0, rejected 1');
    expect(body).toContain('#### Findings not tied to a commentable line');
    expect(body).toContain('Unanchored race** — `src/users.ts:99`');
    expect(body).toContain('<details><summary>🔵 Minor notes (1)</summary>');
    expect(body).toContain('~~Old bug~~ — `src/old.ts`');
    expect(body).toContain('2 earlier findings are still open');
    expect(body).toContain('1 more finding not shown');
    expect(body).toContain('| `pnpm-lock.yaml` | lockfile |');
    expect(body).toContain('`a\\|b.ts`');
    expect(body).toContain('`.minh-review.yml` is invalid (language: Invalid option)');
    expect(body).toContain('Reviewer batch B2 failed');
  });

  it('lists posted findings in the body when inline comments could not be placed', () => {
    const body = formatSummary({ ...base, findings: [f()], inlineFallback: true });
    expect(body).toContain('Inline comments could not be placed');
    expect(body).toContain('_Failure scenario:_');
  });
});

describe('check run + misc comments', () => {
  it('never fails by default and fails only at/above failOn', () => {
    expect(checkConclusion([], 'none')).toBe('success');
    expect(checkConclusion([f()], 'none')).toBe('neutral');
    expect(checkConclusion([f()], 'high')).toBe('failure');
    expect(checkConclusion([f({ severity: 'medium' })], 'high')).toBe('neutral');
    expect(checkConclusion([f({ status: 'rejected' })], 'low')).toBe('success');
    expect(checkTitle([f(), f({ severity: 'medium' })], 'en')).toBe('2 issues found (1 high, 1 medium)');
  });

  it('explains invalid config briefly', () => {
    expect(formatConfigErrorComment('maxComments: expected number', 'en')).toContain(
      '`.minh-review.yml` is invalid — maxComments: expected number',
    );
  });
});
