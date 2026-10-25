import type { DiffFile } from './types';

export type FileKind = 'source' | 'test' | 'config' | 'infra' | 'docs';

const TEST_PATH =
  /(^|\/)(__tests__|__mocks__|tests?|spec|e2e|fixtures?|testdata)\/|\.(test|spec|e2e)\.[cm]?[jt]sx?$|_test\.(go|py|rb|exs?)$|(^|\/)test_[^/]+\.py$|Tests?\.(cs|java|kt|swift)$|_spec\.rb$/i;
const DOCS_PATH =
  /\.(md|mdx|rst|txt|adoc)$|(^|\/)(docs?|documentation)\/|(^|\/)(LICENSE|CHANGELOG|AUTHORS)(\.|$)/i;
const INFRA_PATH =
  /(^|\/)\.github\/workflows\/|(^|\/)Dockerfile|docker-compose|\.tf$|\.tfvars$|(^|\/)k8s\/|(^|\/)helm\/|(^|\/)charts\/|Jenkinsfile|\.gitlab-ci\.yml$|(^|\/)nginx[^/]*\.conf$/i;
const CONFIG_PATH = /\.(json|ya?ml|toml|ini|cfg|conf|properties|env(\.[a-z]+)?|xml|plist)$/i;

/** Paths that usually guard money, identity, secrets or data integrity. */
const SECURITY_PATH =
  /(auth|login|logout|session|token|jwt|oauth|saml|sso|passw|credential|secret|crypt|cipher|hash|sign(ature|ing)?|key(s|store)?|permission|acl|rbac|polic(y|ies)|role|access|guard|middleware|security|sanitiz|escap|csrf|cors|xss|payment|billing|invoice|checkout|wallet|charge|refund|stripe|paypal|ledger|balance|transfer|webhook|upload|admin)/i;
const MIGRATION_PATH = /\.sql$|(^|\/)migrations?\//i;
const DATA_PATH = /(^|\/)db\/|schema|repositor(y|ies)|(^|\/)models?\/|query|dao/i;

/** Risky constructs in added lines (each distinct hit adds a little risk). */
const RISKY_CONTENT: RegExp[] = [
  /\beval\s*\(|new Function\s*\(/,
  /child_process|\bexec(Sync|File)?\s*\(|\bspawn\s*\(|os\.system|subprocess\./,
  /innerHTML|dangerouslySetInnerHTML|v-html/,
  /\b(SELECT|INSERT|UPDATE|DELETE)\b[^;]*(\$\{|\+\s*\w|%s|format\()/i,
  /\b(password|secret|api[_-]?key|private[_-]?key|token)\b/i,
  /createHash\(['"](md5|sha1)['"]\)|Math\.random\(\)/,
  /\b(mutex|lock|semaphore|atomic|synchronized|Promise\.all|go func|goroutine|thread|race)\b/i,
  /\b(transaction|BEGIN|COMMIT|ROLLBACK|FOR UPDATE)\b/,
  /\bunsafe\b|\bdeserializ|pickle\.loads|yaml\.load\(|JSON\.parse\(/,
  /\b(redirect|cookie|setHeader|res\.header|Access-Control-Allow)/i,
];

export function fileKind(path: string): FileKind {
  if (TEST_PATH.test(path)) return 'test';
  if (DOCS_PATH.test(path)) return 'docs';
  if (INFRA_PATH.test(path)) return 'infra';
  if (CONFIG_PATH.test(path)) return 'config';
  return 'source';
}

export interface RiskAssessment {
  score: number;
  kind: FileKind;
  reasons: string[];
}

/**
 * Risk score used to order files when a PR exceeds the review budget.
 * Guarantees: security-sensitive source > other source > tests/docs, and within a
 * class larger logic changes rank higher (log-scaled so size never trumps class).
 */
export function assessRisk(file: DiffFile): RiskAssessment {
  const kind = fileKind(file.path);
  const changed = file.additions + file.deletions;
  const size = Math.min(40, 6 * Math.log2(1 + changed));
  const reasons: string[] = [kind];

  if (kind === 'docs') return { score: 2 + size * 0.1, kind, reasons };
  if (kind === 'test') return { score: 10 + size * 0.5, kind, reasons };

  let score = kind === 'source' ? 50 : kind === 'infra' ? 40 : 25;
  score += kind === 'source' ? size : size * 0.5;
  // Tier bonus (100) exceeds the maximum spread of everything else in a class
  // (size 40 + data 20 + content 30), so tiers never interleave.
  if (SECURITY_PATH.test(file.path) || MIGRATION_PATH.test(file.path)) {
    score += 100;
    reasons.push(MIGRATION_PATH.test(file.path) ? 'sql/migration' : 'security-sensitive path');
  } else if (DATA_PATH.test(file.path)) {
    score += 20;
    reasons.push('data-access path');
  }
  let hits = 0;
  for (const re of RISKY_CONTENT) {
    if (file.hunks.some((h) => h.lines.some((l) => l.type === 'add' && re.test(l.content)))) hits++;
  }
  if (hits) {
    score += Math.min(30, hits * 6);
    reasons.push(`${hits} risky construct${hits > 1 ? 's' : ''}`);
  }
  return { score, kind, reasons };
}

export interface Budget {
  maxFiles: number;
  maxChangedLines: number;
}

export interface Prioritized {
  selected: { file: DiffFile; risk: RiskAssessment }[];
  deferred: { file: DiffFile; risk: RiskAssessment }[];
}

/**
 * Pick the riskiest files that fit the budget. Greedy by score: a file that does
 * not fit the remaining line budget is deferred but smaller files may still fit.
 * The first (riskiest) file is always selected, even if it alone exceeds the line budget.
 */
export function prioritize(files: DiffFile[], budget: Budget): Prioritized {
  const ranked = files
    .map((file) => ({ file, risk: assessRisk(file) }))
    .sort((a, b) => b.risk.score - a.risk.score || a.file.path.localeCompare(b.file.path));
  const selected: Prioritized['selected'] = [];
  const deferred: Prioritized['deferred'] = [];
  let lines = 0;
  for (const item of ranked) {
    const size = item.file.additions + item.file.deletions;
    const fits =
      selected.length < budget.maxFiles && (selected.length === 0 || lines + size <= budget.maxChangedLines);
    if (fits) {
      selected.push(item);
      lines += size;
    } else {
      deferred.push(item);
    }
  }
  return { selected, deferred };
}
