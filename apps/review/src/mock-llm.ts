import { type ChatRequest, MockLlm } from '@ok/llm';
import { CRITIC_MARKER } from './prompts/critic';
import { REVIEWER_MARKER } from './prompts/reviewer';

/**
 * Deterministic, offline stand-in for both passes (CLI `--mock`, tests, demos).
 * The "Reviewer" pattern-matches added lines; the "Critic" rejects matches that
 * sit in comments or test fixtures. Not a real reviewer — it only exercises the
 * pipeline end to end without network access.
 */
interface Rule {
  re: RegExp;
  severity: 'critical' | 'high' | 'medium' | 'low';
  category: string;
  title: string;
  body: string;
  scenario: string;
  suggestion: string;
  replace?: (line: string) => string | null;
}

const RULES: Rule[] = [
  {
    // An (uppercase) SQL statement at the start of a string literal that is concatenated, or an
    // untagged template literal with interpolation. Tagged templates (sql`…`) parameterise values.
    re: /"(SELECT|INSERT|UPDATE|DELETE) [^"]*"\s*\+|'(SELECT|INSERT|UPDATE|DELETE) [^']*'\s*\+|(^|[^\w.])`(SELECT|INSERT|UPDATE|DELETE) [^`]*\$\{/,
    severity: 'critical',
    category: 'security',
    title: 'SQL query built by string interpolation',
    body: 'User-controlled values are concatenated into the SQL text instead of being passed as parameters.',
    scenario:
      'A value like `1 OR 1=1` (or `1; DROP TABLE users`) changes the query and returns or destroys every row.',
    suggestion: 'Use a parameterised query / placeholders and pass the value separately.',
  },
  {
    re: /\beval\s*\(|new Function\s*\(/,
    severity: 'high',
    category: 'security',
    title: 'Dynamic code evaluation',
    body: '`eval`/`new Function` executes arbitrary strings; if any part comes from input this is remote code execution.',
    scenario: 'Input `process.exit()` (or worse) is executed with the server’s privileges.',
    suggestion:
      'Parse the data explicitly (e.g. JSON.parse) or use a lookup table instead of evaluating code.',
  },
  {
    re: /\bexec(Sync)?\s*\(\s*(`[^`]*\$\{|[^)]*\+\s*\w)/,
    severity: 'high',
    category: 'security',
    title: 'Shell command built from interpolated input',
    body: 'The command string is assembled from variables and run through a shell.',
    scenario: 'A file name like `x; rm -rf ~` runs an extra command.',
    suggestion: 'Use execFile/spawn with an argument array and no shell.',
  },
  {
    re: /catch\s*(\([^)]*\))?\s*\{\s*\}/,
    severity: 'medium',
    category: 'error-handling',
    title: 'Error is silently swallowed',
    body: 'The empty catch block hides failures, so callers continue with missing or partial state.',
    scenario:
      'When the call throws (network blip, bad input) the code proceeds as if it succeeded and later fails far from the cause.',
    suggestion: 'Handle the error, log it with context, or rethrow.',
  },
  {
    re: /(token|secret|password|nonce|otp)\w*\s*[:=][^;]*Math\.random\(\)/i,
    severity: 'high',
    category: 'security',
    title: 'Predictable randomness used for a secret',
    body: '`Math.random()` is not cryptographically secure; values can be predicted.',
    scenario: 'An attacker who observes a few tokens can predict the next password-reset token.',
    suggestion: 'Use crypto.randomBytes / crypto.randomUUID.',
  },
  {
    re: /(api[_-]?key|secret|password|token)\s*[:=]\s*['"][A-Za-z0-9_-]{16,}['"]/i,
    severity: 'high',
    category: 'security',
    title: 'Hard-coded credential',
    body: 'A credential-looking literal is committed to the repository.',
    scenario: 'Anyone with read access to the repo (or its history) can use the credential.',
    suggestion: 'Load it from configuration / a secret manager and rotate the exposed value.',
  },
  {
    re: /\.forEach\(\s*async\b/,
    severity: 'medium',
    category: 'concurrency',
    title: 'Async callback inside forEach is not awaited',
    body: '`forEach` ignores returned promises, so the surrounding function continues before the work finishes and rejections go unhandled.',
    scenario:
      'The function returns (and e.g. closes the DB connection) while writes are still in flight; a failing write crashes the process with an unhandled rejection.',
    suggestion: 'Use `for…of` with `await`, or `await Promise.all(items.map(async …))`.',
  },
  {
    re: /\binnerHTML\s*=\s*(?!['"`]\s*['"`])/,
    severity: 'medium',
    category: 'security',
    title: 'Unescaped HTML assignment (XSS)',
    body: 'Assigning dynamic strings to innerHTML renders attacker-controlled markup.',
    scenario:
      'A name like `<img src=x onerror=alert(document.cookie)>` runs script in other users’ browsers.',
    suggestion: 'Use textContent or a sanitizer.',
  },
  {
    re: /\bconsole\.log\(/,
    severity: 'low',
    category: 'other',
    title: 'Debug logging left in code',
    body: 'console.log in production paths adds noise and may leak data.',
    scenario: 'Request payloads containing personal data end up in shared logs.',
    suggestion: 'Remove it or use the structured logger at debug level.',
  },
];

const text = (req: ChatRequest, i: number) => String(req.messages[i]?.content ?? '');

function reviewerReply(req: ChatRequest): string {
  const prompt = text(req, 1);
  const findings: Record<string, unknown>[] = [];
  let path = '';
  for (const raw of prompt.split('\n')) {
    const file = /^=== FILE: (.+?) \((added|deleted|modified|renamed|copied)/.exec(raw);
    if (file) {
      path = file[1]!;
      continue;
    }
    const row = /^\s*(\d+) \+ (.*)$/.exec(raw);
    if (!row || !path) continue;
    const [, num, code] = row;
    for (const rule of RULES) {
      if (!rule.re.test(code!)) continue;
      findings.push({
        path,
        line: Number(num),
        severity: rule.severity,
        category: rule.category,
        title: rule.title,
        body: rule.body,
        failureScenario: rule.scenario,
        suggestion: rule.suggestion,
        confidence: rule.severity === 'low' ? 0.6 : 0.85,
      });
      break;
    }
  }
  return JSON.stringify({ findings });
}

function criticReply(req: ChatRequest): string {
  const prompt = text(req, 1);
  const verdicts: Record<string, unknown>[] = [];
  for (const block of prompt.split(/^### Finding /m).slice(1)) {
    const id = /^(F\d+)/.exec(block)?.[1];
    if (!id) continue;
    const path = /^path: (.+)$/m.exec(block)?.[1] ?? '';
    const line = /^cited lines: (\d+)/m.exec(block)?.[1];
    const code = line ? (new RegExp(`^\\s*${line} [+ ·] (.*)$`, 'm').exec(block)?.[1] ?? '') : '';
    const trimmed = code.trim();
    if (/^(\/\/|#|\*|\/\*)/.test(trimmed)) {
      verdicts.push({
        id,
        verdict: 'rejected',
        reason: 'The match is inside a comment, not executable code.',
      });
    } else if (/\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(__tests__|fixtures?)\//.test(path)) {
      verdicts.push({ id, verdict: 'rejected', reason: 'This is test/fixture code, not a production path.' });
    } else if (/(^|[^\\])\/.*\\b|new RegExp|re:\s*\//.test(trimmed)) {
      verdicts.push({
        id,
        verdict: 'rejected',
        reason: 'The pattern appears inside a regular expression literal, not as a real call.',
      });
    } else if (/okreview:ignore/.test(code)) {
      verdicts.push({ id, verdict: 'rejected', reason: 'Explicitly marked okreview:ignore by the author.' });
    } else {
      verdicts.push({
        id,
        verdict: 'confirmed',
        reason: `Line ${line} contains the construct described and nothing in the excerpt guards it.`,
      });
    }
  }
  return JSON.stringify({ verdicts });
}

export function createHeuristicMockLlm(): MockLlm {
  return new MockLlm((req) => {
    const system = text(req, 0);
    if (system.includes(REVIEWER_MARKER)) return reviewerReply(req);
    if (system.includes(CRITIC_MARKER)) return criticReply(req);
    return '{}';
  });
}
