import { type ChatRequest, MockLlm } from '@minh/llm';
import { AppError } from '@minh/shared';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type RepoConfig } from '../config';
import { parseUnifiedDiff } from '../diff/parse';
import { CRITIC_MARKER } from '../prompts/critic';
import { REVIEWER_MARKER } from '../prompts/reviewer';
import { fingerprint, snippetHash } from './fingerprint';
import { runPipeline } from './run';

// New file has 40 lines; the diff touches lines 10..16 (adds 12-13) and 30..33 (adds 31).
const content = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`)
  .map((l, i) =>
    i === 11 ? 'const q = "SELECT * FROM users WHERE id = " + id;' : i === 12 ? 'db.query(q);' : l,
  )
  .join('\n');
const DIFF = `diff --git a/src/users.ts b/src/users.ts
--- a/src/users.ts
+++ b/src/users.ts
@@ -10,5 +10,7 @@ export function find(id) {
 line 10
 line 11
+const q = "SELECT * FROM users WHERE id = " + id;
+db.query(q);
 line 14
 line 15
 line 16
@@ -28,4 +30,4 @@
 line 30
-old 31
+line 31
 line 32
 line 33
`;
const file = parseUnifiedDiff(DIFF)[0]!;

const sysText = (req: ChatRequest) => String(req.messages[0]?.content ?? '');
const isReviewer = (req: ChatRequest) => sysText(req).includes(REVIEWER_MARKER);
const isCritic = (req: ChatRequest) => sysText(req).includes(CRITIC_MARKER);

interface F {
  line: number;
  endLine?: number;
  severity?: string;
  title: string;
  category?: string;
  confidence?: number;
  path?: string;
  replacement?: string;
}
const finding = (f: F) => ({
  path: f.path ?? 'src/users.ts',
  line: f.line,
  endLine: f.endLine,
  severity: f.severity ?? 'high',
  category: f.category ?? 'security',
  title: f.title,
  body: `Body of ${f.title}`,
  failureScenario: `Scenario for ${f.title}`,
  suggestion: 'Fix it',
  replacement: f.replacement,
  confidence: f.confidence ?? 0.9,
});

type V = { verdict: string; reason?: string; correctedLine?: number; correctedSeverity?: string };

/** Mock that answers reviewer calls with `findings` and critic calls via `verdictFor(title)`. */
function mockLlm(findings: F[], verdictFor: (title: string, id: string) => V) {
  return new MockLlm((req) => {
    if (isReviewer(req)) return JSON.stringify({ findings: findings.map(finding) });
    if (isCritic(req)) {
      const user = String(req.messages[1]?.content ?? '');
      const verdicts = [...user.matchAll(/### Finding (F\d+)[\s\S]*?<<<CLAIM_F\d+\n(.*)\n/g)].map((m) => ({
        id: m[1],
        reason: 'checked',
        ...verdictFor(m[2]!, m[1]!),
      }));
      return JSON.stringify({ verdicts });
    }
    throw new Error('unexpected call');
  });
}

function run(
  llm: MockLlm,
  config: Partial<RepoConfig> = {},
  extra: Partial<Parameters<typeof runPipeline>[0]> = {},
) {
  return runPipeline({
    llm,
    config: { ...DEFAULT_CONFIG, ...config },
    units: [{ file, hunks: file.hunks, content }],
    diffFiles: new Map([[file.path, file]]),
    contents: new Map([[file.path, content]]),
    mode: 'full',
    pr: { title: 'Add user lookup' },
    ...extra,
  });
}

const byTitle = (r: Awaited<ReturnType<typeof runPipeline>>, title: string) =>
  r.findings.find((f) => f.title === title)!;

describe('reviewer → critic pipeline', () => {
  it('drops rejected findings, keeps confirmed/plausible and routes unanchorable ones to the summary', async () => {
    const llm = mockLlm(
      [
        {
          line: 12,
          title: 'SQL injection via string concatenation',
          replacement: 'const q = "SELECT * FROM users WHERE id = $1";',
        },
        { line: 13, title: 'Query result is ignored', severity: 'medium', category: 'correctness' },
        {
          line: 31,
          title: 'Off by one in pagination',
          severity: 'medium',
          category: 'correctness',
          confidence: 0.7,
        },
        { line: 25, title: 'Missing index for lookup', severity: 'medium', category: 'performance' },
      ],
      (title) =>
        title.startsWith('Query result')
          ? { verdict: 'rejected', reason: 'The result is returned on the next line.' }
          : title.startsWith('Off by one')
            ? { verdict: 'plausible' }
            : { verdict: 'confirmed' },
    );
    const r = await run(llm);
    expect(r.batches).toBe(1);
    expect(llm.calls.filter(isReviewer)).toHaveLength(1);
    expect(llm.calls.filter(isCritic)).toHaveLength(1);

    const sql = byTitle(r, 'SQL injection via string concatenation');
    expect(sql).toMatchObject({
      status: 'posted',
      verdict: 'confirmed',
      anchored: true,
      line: 12,
      moved: false,
    });
    expect(sql.codeLines).toEqual(['const q = "SELECT * FROM users WHERE id = " + id;']);
    expect(sql.fingerprint).toBe(fingerprint('src/users.ts', sql.title, snippetHash(sql.codeLines)));

    expect(byTitle(r, 'Query result is ignored')).toMatchObject({
      status: 'rejected',
      criticReason: 'The result is returned on the next line.',
    });
    expect(byTitle(r, 'Off by one in pagination')).toMatchObject({ status: 'posted', verdict: 'plausible' });
    // Line 25 is 5 lines from the second hunk (30..33) → moved onto line 30.
    expect(byTitle(r, 'Missing index for lookup')).toMatchObject({ status: 'posted', line: 30, moved: true });
  });

  it('puts findings far from any hunk into the summary as general findings', async () => {
    const llm = mockLlm(
      [{ line: 22, title: 'Shared cache is mutated without a lock', category: 'concurrency' }],
      () => ({ verdict: 'confirmed' }),
    );
    const r = await run(llm);
    expect(r.findings[0]).toMatchObject({
      status: 'general',
      anchored: false,
      statusReason: 'line is not part of the diff',
    });
  });

  it('accepts critic line corrections only onto commentable lines', async () => {
    const llm = mockLlm(
      [
        { line: 14, title: 'Unparameterized query executed' },
        { line: 31, title: 'Wrong default page size', severity: 'medium', category: 'correctness' },
      ],
      (title) =>
        title.startsWith('Unparameterized')
          ? { verdict: 'confirmed', correctedLine: 13 }
          : { verdict: 'confirmed', correctedLine: 22 },
    );
    const r = await run(llm);
    expect(byTitle(r, 'Unparameterized query executed')).toMatchObject({
      line: 13,
      lineCorrected: true,
      originalLine: 14,
      rangeChanged: true,
    });
    const page = byTitle(r, 'Wrong default page size');
    expect(page).toMatchObject({ line: 31, lineCorrected: false });
    expect(page.criticReason).toContain('line correction to 22 ignored');
  });

  it('applies critic severity corrections before the threshold', async () => {
    const llm = mockLlm([{ line: 12, title: 'Possible injection' }], () => ({
      verdict: 'confirmed',
      correctedSeverity: 'low',
    }));
    const r = await run(llm);
    expect(r.findings[0]).toMatchObject({ severity: 'low', originalSeverity: 'high', status: 'filtered' });
    expect(r.findings[0]!.statusReason).toContain('severityThreshold');
  });

  it('dedupes near-duplicates and keeps the highest-ranked one', async () => {
    const llm = mockLlm(
      [
        { line: 12, title: 'SQL injection in user lookup query', severity: 'critical' },
        { line: 13, title: 'SQL injection in lookup query', severity: 'high' },
        { line: 31, title: 'Unrelated pagination bug', severity: 'medium', category: 'correctness' },
      ],
      () => ({ verdict: 'confirmed' }),
    );
    const r = await run(llm);
    expect(byTitle(r, 'SQL injection in user lookup query').status).toBe('posted');
    expect(byTitle(r, 'SQL injection in lookup query')).toMatchObject({
      status: 'duplicate',
      statusReason: 'duplicate of F1',
    });
    expect(byTitle(r, 'Unrelated pagination bug').status).toBe('posted');
  });

  it('caps inline comments by maxComments and per-severity limits', async () => {
    const llm = mockLlm(
      [
        { line: 10, title: 'Alpha race on balance', severity: 'high', category: 'concurrency' },
        { line: 12, title: 'Bravo injection', severity: 'critical' },
        { line: 14, title: 'Charlie leak of tokens', severity: 'high' },
        { line: 31, title: 'Delta overflow in totals', severity: 'medium', category: 'correctness' },
      ],
      () => ({ verdict: 'confirmed' }),
    );
    const r = await run(llm, { maxComments: 2 });
    expect(r.findings.filter((f) => f.status === 'posted').map((f) => f.title)).toEqual([
      'Alpha race on balance',
      'Bravo injection',
    ]);
    expect(r.findings.filter((f) => f.status === 'capped')).toHaveLength(2);

    const r2 = await run(
      mockLlm(
        [
          { line: 10, title: 'Alpha one', severity: 'medium', category: 'correctness' },
          { line: 14, title: 'Bravo two', severity: 'medium', category: 'performance' },
          { line: 31, title: 'Charlie three', severity: 'medium', category: 'api' },
        ],
        () => ({ verdict: 'confirmed' }),
      ),
      {},
      { options: { severityCaps: { critical: 5, high: 5, medium: 2 } } },
    );
    expect(r2.findings.filter((f) => f.status === 'posted')).toHaveLength(2);
    expect(r2.findings.find((f) => f.status === 'capped')?.statusReason).toContain('medium cap');
  });

  it('respects keepPlausible and the plausible confidence floor', async () => {
    const findings = [
      { line: 12, title: 'Plausible confident issue', confidence: 0.8 },
      { line: 31, title: 'Plausible shaky issue', severity: 'medium', confidence: 0.3 },
    ];
    const r = await run(mockLlm(findings, () => ({ verdict: 'plausible' })));
    expect(byTitle(r, 'Plausible confident issue').status).toBe('posted');
    expect(byTitle(r, 'Plausible shaky issue').status).toBe('filtered');
    const r2 = await run(
      mockLlm(findings, () => ({ verdict: 'plausible' })),
      { keepPlausible: false },
    );
    expect(r2.findings.every((f) => f.status === 'filtered')).toBe(true);
  });

  it('collects low-severity findings in a digest only when the threshold enables them', async () => {
    const findings = [
      { line: 12, title: 'Minor: redundant query copy', severity: 'low', category: 'performance' },
    ];
    expect((await run(mockLlm(findings, () => ({ verdict: 'confirmed' })))).findings[0]!.status).toBe(
      'filtered',
    );
    const r = await run(
      mockLlm(findings, () => ({ verdict: 'confirmed' })),
      { severityThreshold: 'low' },
    );
    expect(r.findings[0]!.status).toBe('digest');
  });

  it('skips already-posted and team-suppressed fingerprints', async () => {
    const findings = [
      { line: 12, title: 'SQL injection via string concatenation' },
      { line: 31, title: 'Pagination skips the last page', severity: 'medium', category: 'correctness' },
    ];
    const first = await run(mockLlm(findings, () => ({ verdict: 'confirmed' })));
    const sql = byTitle(first, 'SQL injection via string concatenation');
    const page = byTitle(first, 'Pagination skips the last page');
    const ref = (f: typeof sql) => ({
      fingerprint: f.fingerprint,
      path: f.path,
      snippetHash: f.snippetHash,
      title: f.title,
    });

    // Re-run with differently worded titles: same code + similar wording still matches.
    const reworded = [
      { line: 12, title: 'SQL injection through string concatenation' },
      { line: 31, title: 'Pagination skips the final page', severity: 'medium', category: 'correctness' },
    ];
    const second = await run(
      mockLlm(reworded, () => ({ verdict: 'confirmed' })),
      {},
      { previous: [ref(sql)], suppressed: [ref(page)] },
    );
    expect(second.findings.map((f) => f.status)).toEqual(['already_posted', 'suppressed']);
  });

  it('treats findings as unverified-plausible when the critic fails, but propagates payment errors', async () => {
    const llm = new MockLlm((req) => {
      if (isReviewer(req)) return JSON.stringify({ findings: [finding({ line: 12, title: 'Injection' })] });
      return 'not json at all';
    });
    const r = await run(llm);
    expect(r.findings[0]).toMatchObject({ verdict: 'plausible', status: 'posted' });
    expect(r.findings[0]!.criticReason).toContain('Critic unavailable');
    expect(r.warnings.some((w) => w.includes('Critic call failed'))).toBe(true);

    const broke = new MockLlm(() => {
      throw new AppError('payment_required', 'Insufficient balance');
    });
    await expect(run(broke)).rejects.toMatchObject({ code: 'payment_required' });
  });

  it('throws when every reviewer batch fails so the job can retry', async () => {
    const llm = new MockLlm(() => {
      throw new AppError('upstream_error', 'gateway down');
    });
    await expect(run(llm)).rejects.toMatchObject({ code: 'upstream_error' });
  });

  it('drops malformed findings individually and resolves sloppy paths', async () => {
    const llm = new MockLlm((req) => {
      if (isReviewer(req))
        return JSON.stringify({
          findings: [
            {
              path: 'users.ts',
              line: '12',
              severity: 'HIGH',
              category: 'Security',
              title: 'Injection',
              body: 'b',
              failureScenario: 's',
              confidence: '0.9',
            },
            { path: 'src/users.ts', line: 'twelve', severity: 'high', title: 'Broken' },
            {
              path: 'src/other.ts',
              line: 3,
              severity: 'high',
              category: 'security',
              title: 'Elsewhere',
              body: 'b',
              failureScenario: 's',
              confidence: 1,
            },
          ],
        });
      return JSON.stringify({ verdicts: [{ id: 'F1', verdict: 'confirmed', reason: 'ok' }] });
    });
    const r = await run(llm);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({
      path: 'src/users.ts',
      line: 12,
      severity: 'high',
      category: 'security',
      status: 'posted',
    });
    expect(r.warnings.join('\n')).toMatch(/malformed/);
    expect(r.warnings.join('\n')).toMatch(/outside its batch/);
  });

  it('uses configured models, language and team instructions in the prompts', async () => {
    const llm = mockLlm([{ line: 12, title: 'Injection' }], () => ({ verdict: 'confirmed' }));
    await run(llm, {
      language: 'vi',
      models: { reviewer: 'big-model', critic: 'small-model' },
      instructions: 'Money is integer cents.',
    });
    const reviewer = llm.calls.find(isReviewer)!;
    const critic = llm.calls.find(isCritic)!;
    expect(reviewer.model).toBe('big-model');
    expect(critic.model).toBe('small-model');
    expect(sysText(reviewer)).toContain('Vietnamese');
    expect(sysText(critic)).toContain('Vietnamese');
    expect(String(reviewer.messages[1]?.content)).toContain('Money is integer cents.');
    expect(String(reviewer.messages[1]?.content)).toContain('12 + const q');
    expect(reviewer.response_format).toEqual({ type: 'json_object' });
    // The critic sees the exact code around the cited line, with markers.
    expect(String(critic.messages[1]?.content)).toMatch(/12 \+ const q = "SELECT/);
  });

  it('makes no LLM calls when there is nothing to review', async () => {
    const llm = new MockLlm([]);
    const r = await runPipeline({
      llm,
      config: DEFAULT_CONFIG,
      units: [],
      diffFiles: new Map(),
      contents: new Map(),
      mode: 'full',
    });
    expect(r).toMatchObject({ findings: [], batches: 0 });
    expect(llm.calls).toHaveLength(0);
  });
});
