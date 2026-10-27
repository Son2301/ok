#!/usr/bin/env node
/**
 * minh-review CLI — two-pass (Reviewer + Critic) review of local changes.
 *
 *   pnpm --filter @minh/review cli -- --base main [--json] [--fail-on high] [--mock]
 *
 * Uses any OpenAI-compatible endpoint: MINH_REVIEW_BASE_URL, MINH_REVIEW_API_KEY,
 * MINH_REVIEW_MODEL / MINH_REVIEW_CRITIC_MODEL (defaults come from .minh-review.yml).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLlmClient, type LlmClient } from '@minh/llm';
import {
  CONFIG_FILENAMES,
  LANGUAGES,
  type Language,
  type RepoConfig,
  resolveRepoConfig,
  SEVERITIES,
  SEVERITY_RANK,
  type Severity,
} from './config';
import { buildFileMap, type ReviewUnit } from './diff/chunk';
import { filterFiles, SKIP_REASON_TEXT, type SkippedFile } from './diff/filter';
import { parseUnifiedDiff } from './diff/parse';
import { prioritize } from './diff/prioritize';
import { createHeuristicMockLlm } from './mock-llm';
import { runPipeline } from './pipeline/run';
import type { Finding } from './pipeline/types';
import { errorMessage, formatCost, formatDuration } from './util';

export interface CliArgs {
  base: string | null;
  head: string;
  json: boolean;
  failOn: Severity | 'none' | null;
  mock: boolean;
  model: string | null;
  criticModel: string | null;
  lang: Language | null;
  diff: string | null;
  config: string | null;
  color: boolean | null;
  help: boolean;
}

export const USAGE = `minh-review — two-pass AI code review of your local changes

Usage: minh-review [--base <ref>] [options]

  --base <ref>          Compare <ref>...HEAD (default: main, master or origin/main)
  --head <ref>          Head ref (default: HEAD)
  --diff <file|->       Review a unified diff from a file or stdin instead of git
  --json                Machine-readable output
  --fail-on <severity>  Exit 1 if a finding is at least: critical | high | medium | low | none
  --model <name>        Reviewer model (env MINH_REVIEW_MODEL, else .minh-review.yml)
  --critic-model <name> Critic model (env MINH_REVIEW_CRITIC_MODEL, else .minh-review.yml)
  --lang <en|vi>        Output language
  --config <path>       Config file (default: .minh-review.yml at the repo root)
  --mock                Offline demo mode: heuristic reviewer/critic, no network
  --no-color / --color  Force colours off/on
  -h, --help            Show this help

Environment: MINH_REVIEW_BASE_URL (default https://api.openai.com/v1), MINH_REVIEW_API_KEY.
Exit codes: 0 ok, 1 --fail-on threshold met, 2 usage/configuration error.`;

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    base: null,
    head: 'HEAD',
    json: false,
    failOn: null,
    mock: false,
    model: null,
    criticModel: null,
    lang: null,
    diff: null,
    config: null,
    color: null,
    help: false,
  };
  const list = argv[0] === '--' ? argv.slice(1) : argv;
  for (let i = 0; i < list.length; i++) {
    const raw = list[i]!;
    if (raw === '--') continue;
    const [flag, inline] =
      raw.startsWith('--') && raw.includes('=')
        ? [raw.slice(0, raw.indexOf('=')), raw.slice(raw.indexOf('=') + 1)]
        : [raw, undefined];
    const value = () => {
      const v = inline ?? list[++i];
      if (v === undefined || (inline === undefined && v.startsWith('--')))
        throw new Error(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case '--base':
        args.base = value();
        break;
      case '--head':
        args.head = value();
        break;
      case '--json':
        args.json = true;
        break;
      case '--fail-on': {
        const v = value().toLowerCase();
        if (v !== 'none' && !(SEVERITIES as readonly string[]).includes(v))
          throw new Error(`--fail-on must be one of none, ${SEVERITIES.join(', ')}`);
        args.failOn = v as Severity | 'none';
        break;
      }
      case '--mock':
        args.mock = true;
        break;
      case '--model':
        args.model = value();
        break;
      case '--critic-model':
        args.criticModel = value();
        break;
      case '--lang': {
        const v = value();
        if (!(LANGUAGES as readonly string[]).includes(v)) throw new Error('--lang must be en or vi');
        args.lang = v as Language;
        break;
      }
      case '--diff':
        args.diff = value();
        break;
      case '--config':
        args.config = value();
        break;
      case '--color':
        args.color = true;
        break;
      case '--no-color':
        args.color = false;
        break;
      case '-h':
      case '--help':
        args.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${raw}`);
    }
  }
  return args;
}

export interface CliIo {
  cwd: string;
  env: Record<string, string | undefined>;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  readStdin: () => string;
  isTTY: boolean;
  /** Injected LLM (tests); otherwise built from env / --mock. */
  llm?: LlmClient;
}

const git = (cwd: string, args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const tryGit = (cwd: string, args: string[]) => {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
};

function palette(enabled: boolean) {
  const wrap = (code: string) => (s: string) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : s);
  return {
    bold: wrap('1'),
    dim: wrap('2'),
    red: wrap('31'),
    green: wrap('32'),
    yellow: wrap('33'),
    blue: wrap('34'),
    magenta: wrap('35'),
    cyan: wrap('36'),
  };
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    io.stderr(`minh-review: ${errorMessage(err)}\n\n${USAGE}\n`);
    return 2;
  }
  if (args.help) {
    io.stdout(`${USAGE}\n`);
    return 0;
  }
  const started = Date.now();
  const cwd = io.cwd;
  const repoRoot = tryGit(cwd, ['rev-parse', '--show-toplevel'])?.trim() ?? cwd;

  // 1. Diff
  let diffText: string;
  let range: string;
  if (args.diff) {
    diffText = args.diff === '-' ? io.readStdin() : readFileSync(resolve(cwd, args.diff), 'utf8');
    range = args.diff === '-' ? 'stdin' : args.diff;
  } else {
    const base =
      args.base ??
      ['main', 'master', 'origin/main', 'origin/master'].find(
        (r) => tryGit(cwd, ['rev-parse', '--verify', '--quiet', r]) !== null,
      );
    if (!base) {
      io.stderr('minh-review: could not find a base branch; pass --base <ref>\n');
      return 2;
    }
    range = `${base}...${args.head}`;
    try {
      diffText = git(repoRoot, ['diff', '--no-color', '--no-ext-diff', '-M', range]);
    } catch (err) {
      io.stderr(`minh-review: git diff ${range} failed: ${errorMessage(err).split('\n')[0]}\n`);
      return 2;
    }
  }

  // 2. Config (+ CLI/env overrides)
  const configPath = args.config
    ? resolve(cwd, args.config)
    : CONFIG_FILENAMES.map((n) => join(repoRoot, n)).find((p) => existsSync(p));
  const { config: fileConfig, error: configError } = resolveRepoConfig(
    configPath ? readFileSync(configPath, 'utf8') : null,
  );
  if (configError) io.stderr(`minh-review: ${configPath} is invalid (${configError}); using defaults\n`);
  const config: RepoConfig = {
    ...fileConfig,
    language: args.lang ?? fileConfig.language,
    models: {
      reviewer: args.model ?? io.env.MINH_REVIEW_MODEL ?? fileConfig.models.reviewer,
      critic:
        args.criticModel ??
        io.env.MINH_REVIEW_CRITIC_MODEL ??
        io.env.MINH_REVIEW_MODEL ??
        fileConfig.models.critic,
    },
  };
  const failOn = args.failOn ?? config.failOn;

  // 3. LLM
  let llm = io.llm;
  if (!llm) {
    if (args.mock) llm = createHeuristicMockLlm();
    else if (io.env.MINH_REVIEW_API_KEY) {
      llm = createLlmClient({
        baseUrl: io.env.MINH_REVIEW_BASE_URL ?? 'https://api.openai.com/v1',
        apiKey: io.env.MINH_REVIEW_API_KEY,
        timeoutMs: 180_000,
      });
    } else {
      io.stderr(
        'minh-review: set MINH_REVIEW_API_KEY (plus MINH_REVIEW_BASE_URL / MINH_REVIEW_MODEL for non-default endpoints), or run with --mock\n',
      );
      return 2;
    }
  }

  // 4. Filter, prioritise, load context
  const files = parseUnifiedDiff(diffText);
  const { kept, skipped: filtered } = filterFiles(files, {
    ...config.paths,
    maxFileChangedLines: config.limits.maxFileChangedLines,
  });
  const pri = prioritize(kept, {
    maxFiles: config.limits.maxFiles,
    maxChangedLines: config.limits.maxChangedLines,
  });
  const skipped: SkippedFile[] = [
    ...filtered,
    ...pri.deferred.map((d) => ({ path: d.file.path, reason: 'budget' as const })),
  ];
  const headRef = args.diff ? null : args.head;
  const contents = new Map<string, string>();
  const units: ReviewUnit[] = pri.selected.map(({ file, risk }) => {
    const content = headRef
      ? tryGit(repoRoot, ['show', `${headRef}:${file.path}`])
      : existsSync(join(repoRoot, file.path))
        ? readFileSync(join(repoRoot, file.path), 'utf8')
        : null;
    if (content !== null && content.length <= 512 * 1024) contents.set(file.path, content);
    return { file, hunks: file.hunks, content: contents.get(file.path) ?? null, risk };
  });
  const tree =
    (headRef
      ? tryGit(repoRoot, ['ls-tree', '-r', '--name-only', headRef])
      : tryGit(repoRoot, ['ls-files'])) ?? '';
  const fileMap = buildFileMap(
    tree.split('\n').filter(Boolean),
    units.map((u) => u.file.path),
  );

  // 5. Two-pass review
  let result: Awaited<ReturnType<typeof runPipeline>>;
  try {
    result = await runPipeline({
      llm,
      config,
      units,
      diffFiles: new Map(files.map((f) => [f.path, f])),
      contents,
      fileMap,
      mode: 'full',
    });
  } catch (err) {
    io.stderr(`minh-review: review failed: ${errorMessage(err)}\n`);
    return 2;
  }
  for (const p of result.overflow) skipped.push({ path: p, reason: 'budget' });
  const durationMs = Date.now() - started;
  const visible = result.findings.filter(
    (f) => f.status === 'posted' || f.status === 'general' || f.status === 'digest' || f.status === 'capped',
  );
  const failed = failOn !== 'none' && visible.some((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[failOn]);

  if (args.json) {
    io.stdout(
      `${JSON.stringify(
        {
          range,
          findings: visible.map(publicFinding),
          rejected: result.findings
            .filter((f) => f.verdict === 'rejected')
            .map((f) => ({
              path: f.path,
              line: f.originalLine,
              title: f.title,
              criticReason: f.criticReason,
            })),
          filtered: result.findings
            .filter((f) => f.status === 'filtered' || f.status === 'duplicate')
            .map((f) => ({ path: f.path, line: f.line, title: f.title, reason: f.statusReason })),
          skipped,
          stats: {
            files: files.length,
            reviewed: units.length - result.overflow.length,
            candidates: result.findings.length,
            batches: result.batches,
          },
          usage: result.usage,
          warnings: result.warnings,
          durationMs,
          failOn,
          failed,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    io.stdout(
      formatHuman({
        range,
        files: files.length,
        reviewed: units.length - result.overflow.length,
        result,
        visible,
        skipped,
        durationMs,
        failOn,
        failed,
        color: args.color ?? (io.isTTY && !io.env.NO_COLOR),
      }),
    );
  }
  return failed ? 1 : 0;
}

function publicFinding(f: Finding) {
  return {
    path: f.path,
    line: f.line,
    endLine: f.endLine,
    severity: f.severity,
    category: f.category,
    title: f.title,
    body: f.body,
    failureScenario: f.failureScenario,
    suggestion: f.suggestion,
    replacement: f.replacement,
    confidence: f.confidence,
    verdict: f.verdict,
    criticReason: f.criticReason,
    placement: f.status === 'posted' || f.status === 'capped' ? 'inline' : f.status,
  };
}

function formatHuman(x: {
  range: string;
  files: number;
  reviewed: number;
  result: Awaited<ReturnType<typeof runPipeline>>;
  visible: Finding[];
  skipped: SkippedFile[];
  durationMs: number;
  failOn: Severity | 'none';
  failed: boolean;
  color: boolean;
}): string {
  const c = palette(x.color);
  const sevColor: Record<Severity, (s: string) => string> = {
    critical: (s) => c.bold(c.red(s)),
    high: c.red,
    medium: c.yellow,
    low: c.blue,
  };
  const out: string[] = [];
  out.push(c.bold(`minh-review · two-pass review of ${x.range}`));
  out.push(
    c.dim(
      `${x.files} files changed · ${x.reviewed} reviewed · ${x.skipped.length} skipped · ${x.result.batches} batch(es)`,
    ),
  );
  out.push('');

  const byFile = new Map<string, Finding[]>();
  const sorted = [...x.visible].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  for (const f of sorted) byFile.set(f.path, [...(byFile.get(f.path) ?? []), f]);
  for (const [path, list] of byFile) {
    out.push(c.bold(c.cyan(path)));
    for (const f of list) {
      const loc = `${f.line}${f.endLine ? `-${f.endLine}` : ''}`.padEnd(8);
      const tag = f.status === 'general' ? c.dim(' (not on a changed line)') : '';
      out.push(
        `  ${c.dim(loc)}${sevColor[f.severity](f.severity.toUpperCase().padEnd(9))}${c.magenta(f.category.padEnd(15))}${c.bold(f.title)}${tag}`,
      );
      const pad = ' '.repeat(10);
      out.push(`${pad}${f.body}`);
      out.push(`${pad}${c.bold('Failure:')} ${f.failureScenario}`);
      if (f.suggestion) out.push(`${pad}${c.bold('Fix:')} ${f.suggestion}`);
      if (f.replacement)
        for (const l of f.replacement.replace(/\n$/, '').split('\n')) out.push(`${pad}${c.green(`+ ${l}`)}`);
      out.push(`${pad}${c.dim(`Critic: ${f.verdict}${f.criticReason ? ` — ${f.criticReason}` : ''}`)}`);
    }
    out.push('');
  }

  const counts = (['critical', 'high', 'medium', 'low'] as const)
    .map((s) => [s, x.visible.filter((f) => f.severity === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${s}`);
  const rejected = x.result.findings.filter((f) => f.verdict === 'rejected').length;
  const head = x.visible.length
    ? c.yellow(`✖ ${x.visible.length} finding(s) (${counts.join(', ')})`)
    : c.green('✔ No verified issues');
  out.push(
    `${head} · ${x.result.findings.length} candidate(s), ${rejected} rejected by the Critic · ${formatDuration(x.durationMs)} · ${formatCost(x.result.usage.costMicros)}`,
  );
  if (x.skipped.length) {
    const shown = x.skipped.slice(0, 12).map((s) => `${s.path} (${SKIP_REASON_TEXT[s.reason].en})`);
    out.push(
      c.dim(
        `Skipped: ${shown.join(', ')}${x.skipped.length > 12 ? `, … +${x.skipped.length - 12} more` : ''}`,
      ),
    );
  }
  for (const w of x.result.warnings.slice(0, 5)) out.push(c.yellow(`⚠ ${w}`));
  if (x.failOn !== 'none')
    out.push(
      x.failed ? c.red(`Failing: findings at or above "${x.failOn}"`) : c.dim(`fail-on ${x.failOn}: passed`),
    );
  return `${out.join('\n')}\n`;
}

const invokedDirectly = (() => {
  try {
    return (
      process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
    );
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  runCli(process.argv.slice(2), {
    // pnpm runs package scripts from the package dir; INIT_CWD is where the user ran pnpm.
    cwd: process.env.INIT_CWD ?? process.cwd(),
    env: process.env,
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    readStdin: () => readFileSync(0, 'utf8'),
    isTTY: Boolean(process.stdout.isTTY),
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`minh-review: ${errorMessage(err)}\n`);
      process.exitCode = 2;
    },
  );
}
