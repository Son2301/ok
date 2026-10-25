import type { Catalog } from '../catalog/catalog';
import type { Model, Strength, Tier } from '../catalog/types';
import type { ChatCompletionRequest } from '../schemas';
import { capabilityMismatch, type Requirements } from './select';
import { messageText } from './tokens';

/*
 * `model: "auto"` — a fast, deterministic request classifier (no extra LLM call).
 * It extracts cheap lexical signals, maps them to a tier, then picks concrete
 * enabled catalog models for that tier. Same input ⇒ same decision.
 */

export type AutoVariant = 'default' | 'cheap' | 'best';

/** `auto`, `auto:cheap`, `auto:best` (case-insensitive); null for regular model ids. */
export function parseAutoModel(id: string | undefined): AutoVariant | null {
  const v = id?.trim().toLowerCase();
  if (v === 'auto') return 'default';
  if (v === 'auto:cheap') return 'cheap';
  if (v === 'auto:best') return 'best';
  return null;
}

export const isAutoModel = (id: string | undefined) => parseAutoModel(id) !== null;

export interface Signals {
  promptTokens: number;
  codeScore: number;
  hasCode: boolean;
  mathScore: number;
  reasoningCue: boolean;
  complexityScore: number;
  tools: boolean;
  images: boolean;
  json: boolean;
  vietnamese: boolean;
  turns: number;
  greeting: boolean;
}

const count = (text: string, re: RegExp) => text.match(re)?.length ?? 0;

/** Code *syntax* (not just words like "class" or "return" that also occur in prose). */
const CODE_PATTERNS = new RegExp(
  [
    String.raw`\bdef \w+\(`,
    String.raw`\bclass \w+\s*[:({]`,
    String.raw`\bimport\s+[\w{}*,\s]+\s+from\s+['"]`,
    String.raw`^\s*(?:import|from) [\w.]+(?: import \w+)?\s*$`,
    String.raw`\b(?:const|let|var)\s+\w+\s*=`,
    String.raw`\bfunction\s*\w*\s*\(`,
    String.raw`=>\s*[{(\w]`,
    String.raw`#include\s*<`,
    String.raw`\bfn main\b|\bpackage main\b|\bpublic static void\b`,
    String.raw`console\.log\(|System\.out\.|\bprintf?\(`,
    String.raw`\bSELECT\s+[\w*,\s]+\s+FROM\b|\bINSERT INTO\b|\bCREATE TABLE\b`,
    String.raw`Traceback \(most recent call last\)|\bat \S+ \(\S+:\d+:\d+\)`,
    String.raw`[{};]\s*$`,
  ].join('|'),
  'gim',
);
const CODE_KEYWORDS =
  /\b(code|coding|function|bug|debug|refactor|implement|compile|compiler|regex|sql|api|typescript|javascript|python|golang|rust|java|kotlin|react|stack ?trace|exception|unit tests?|repository|pull request)\b|viết code|viết hàm|lập trình|sửa lỗi|gỡ lỗi|mã nguồn|đoạn mã/gi;
/** Formal-reasoning cues: one is enough to want a reasoning model. */
const STRONG_MATH = /\b(prove|proof|theorem|lemma|derive|formally show)\b|chứng minh|định lý/gi;
const MATH_KEYWORDS =
  /\b(derivative|integral|integrate|equation|inequality|solve for|calculate|compute|probability|combinatorics|matrix|eigen\w*|optimi[sz]e|logic puzzle|riddle)\b|đạo hàm|tích phân|phương trình|bất phương trình|xác suất|ma trận|giải bài toán|tính giá trị/gi;
const LATEX = /\\(frac|int|sum|sqrt|lim|prod|begin\{(equation|align)\})|\$\$/g;
const ARITHMETIC = /\d+(\.\d+)?\s*[+\-*/^×÷]\s*\d+/;
const REASONING_CUE =
  /step[- ]by[- ]step|think (carefully|hard|deeply)|reason(ing)? (through|about)|chain of thought|từng bước|suy luận|suy nghĩ kỹ/i;
const COMPLEXITY =
  /\b(analy[sz]e|analysis|architecture|design an?|comprehensive|in-depth|detailed|trade-?offs?|compare|evaluate|strategy|strategic|research|essay|report|plan for)\b|phân tích|thiết kế|kiến trúc|chi tiết|toàn diện|so sánh|đánh giá|chiến lược|nghiên cứu/gi;
const GREETING = /^\s*(hi|hello|hey|thanks|thank you|ok|okay|xin chào|chào|cảm ơn|cám ơn)\b[\s!.,?]*$/i;

/**
 * Vietnamese detection: letters only Vietnamese uses — the Latin Extended Additional
 * block (U+1EA0–U+1EF9: ạ ả ấ ầ … ỹ) plus ă, đ, ơ, ư — measured against all letters.
 */
const VI_CHARS = /[Ạ-ỹĂăĐđƠơƯư]/g;
export function isVietnamese(text: string): boolean {
  const nfc = text.normalize('NFC');
  const vi = count(nfc, VI_CHARS);
  if (vi === 0) return false;
  const letters = count(nfc, /\p{L}/gu);
  return vi >= 3 ? vi / letters >= 0.02 : vi / letters >= 0.05;
}

export function extractSignals(req: ChatCompletionRequest, r: Requirements): Signals {
  const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
  const system = req.messages
    .filter((m) => m.role === 'system' || m.role === 'developer')
    .map(messageText)
    .join('\n');
  const task = `${system}\n${lastUser ? messageText(lastUser) : ''}`;
  const all = req.messages.map(messageText).join('\n');

  const fenced = Math.floor(count(all, /```/g) / 2);
  const codeScore =
    3 * Math.min(fenced, 2) +
    Math.min(3, count(task, CODE_PATTERNS)) +
    Math.min(2, count(task, CODE_KEYWORDS));
  const mathScore =
    3 * Math.min(1, count(task, STRONG_MATH)) +
    Math.min(4, count(task, MATH_KEYWORDS)) +
    2 * Math.min(1, count(task, LATEX)) +
    (ARITHMETIC.test(task) ? 1 : 0);
  const effort = typeof req.reasoning_effort === 'string' ? req.reasoning_effort : undefined;

  return {
    promptTokens: r.promptTokens,
    codeScore,
    hasCode: codeScore >= 2,
    mathScore,
    reasoningCue: REASONING_CUE.test(task) || effort === 'medium' || effort === 'high',
    complexityScore: Math.min(4, count(task, COMPLEXITY)),
    tools: r.tools,
    images: r.vision,
    json: r.json,
    vietnamese: isVietnamese(task),
    turns: req.messages.filter((m) => m.role === 'user' || m.role === 'assistant').length,
    greeting: Boolean(lastUser && GREETING.test(messageText(lastUser))),
  };
}

const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** Signals → tier, plus the human-readable reasons that drove it. */
export function classify(s: Signals): { tier: Tier; reasons: string[] } {
  const reasons: string[] = [];
  if (s.vietnamese) reasons.push('Vietnamese');
  if (s.mathScore >= 3 || (s.mathScore >= 2 && s.reasoningCue)) {
    reasons.unshift('math/reasoning cues');
    return { tier: 'reasoning', reasons };
  }
  if (s.reasoningCue && (s.mathScore >= 1 || s.complexityScore >= 1 || s.hasCode)) {
    reasons.unshift('explicit step-by-step reasoning');
    return { tier: 'reasoning', reasons };
  }
  if (s.promptTokens > 24_000) {
    reasons.unshift(`long prompt (~${fmtTokens(s.promptTokens)} tokens)`);
    return { tier: 'frontier', reasons };
  }
  if (
    s.complexityScore >= 2 ||
    (s.hasCode && (s.promptTokens > 4_000 || s.complexityScore >= 1)) ||
    (s.images && s.complexityScore >= 1)
  ) {
    reasons.unshift(s.hasCode ? 'substantial code task' : 'complex analysis');
    return { tier: 'frontier', reasons };
  }
  const balanced: string[] = [];
  if (s.hasCode) balanced.push('code');
  if (s.tools) balanced.push('tool use');
  if (s.json) balanced.push('JSON output');
  if (s.images) balanced.push('image input');
  if (s.mathScore >= 1) balanced.push('light math');
  if (s.complexityScore >= 1) balanced.push('analysis');
  if (s.reasoningCue) balanced.push('reasoning cue');
  if (s.promptTokens > 1_500) balanced.push(`~${fmtTokens(s.promptTokens)} prompt tokens`);
  if (s.turns > 8) balanced.push('long conversation');
  if (balanced.length) return { tier: 'balanced', reasons: [...balanced, ...reasons] };
  reasons.unshift(s.greeting ? 'greeting/small talk' : 'short simple prompt');
  return { tier: 'fast', reasons };
}

export function adjustTier(tier: Tier, variant: AutoVariant): Tier {
  if (variant === 'cheap') return tier === 'frontier' ? 'balanced' : tier === 'balanced' ? 'fast' : tier;
  if (variant === 'best') return tier === 'fast' ? 'balanced' : tier === 'balanced' ? 'frontier' : tier;
  return tier;
}

const NEIGHBOURS: Record<AutoVariant, Record<Tier, Tier[]>> = {
  default: {
    fast: ['balanced', 'frontier', 'reasoning'],
    balanced: ['frontier', 'fast', 'reasoning'],
    frontier: ['reasoning', 'balanced', 'fast'],
    reasoning: ['frontier', 'balanced', 'fast'],
  },
  best: {
    fast: ['balanced', 'frontier', 'reasoning'],
    balanced: ['frontier', 'reasoning', 'fast'],
    frontier: ['reasoning', 'balanced', 'fast'],
    reasoning: ['frontier', 'balanced', 'fast'],
  },
  cheap: {
    fast: ['balanced', 'frontier', 'reasoning'],
    balanced: ['fast', 'frontier', 'reasoning'],
    frontier: ['balanced', 'fast', 'reasoning'],
    reasoning: ['balanced', 'frontier', 'fast'],
  },
};

function wantedStrengths(s: Signals): Strength[] {
  const w: Strength[] = [];
  if (s.hasCode) w.push('code');
  if (s.mathScore >= 1) w.push('math');
  if (s.vietnamese) w.push('multilingual');
  if (s.images) w.push('vision');
  if (s.tools) w.push('tools');
  if (s.promptTokens > 100_000) w.push('long_context');
  return w;
}

/** Cheapest blended (3:1 input:output) price over a model's eligible endpoints, USD / 1M. */
function blendedPrice(m: Model, r: Requirements): number {
  const prices = m.endpoints
    .filter((e) => e.enabled && !capabilityMismatch(e, r))
    .map((e) => (3 * e.price.input + e.price.output) / 4);
  return prices.length ? Math.min(...prices) : Number.POSITIVE_INFINITY;
}

export interface AutoDecision {
  variant: AutoVariant;
  tier: Tier;
  /** Chosen model, then fallbacks (used as the `models[]` chain). */
  models: string[];
  reason: string;
  signals: Signals;
}

export const AUTO_CHAIN_LENGTH = 3;

/** Classify the request and map it onto enabled catalog models. */
export function autoRoute(
  req: ChatCompletionRequest,
  catalog: Catalog,
  variant: AutoVariant,
  r: Requirements,
): AutoDecision {
  const signals = extractSignals(req, r);
  const { tier: classified, reasons } = classify(signals);
  const tier = adjustTier(classified, variant);
  const wanted = wantedStrengths(signals);

  const usable = catalog
    .list({ type: 'chat' })
    .filter((m) => m.auto && m.endpoints.some((e) => e.enabled && !capabilityMismatch(e, r)));
  const real = usable.filter((m) => !m.id.startsWith('mock/'));
  const pool = real.length ? real : usable;

  const score = (m: Model) =>
    m.auto!.quality + 6 * (m.auto!.strengths ?? []).filter((s) => wanted.includes(s)).length;
  const rank = (models: Model[]) =>
    [...models].sort((a, b) => {
      if (variant === 'cheap')
        return blendedPrice(a, r) - blendedPrice(b, r) || score(b) - score(a) || a.id.localeCompare(b.id);
      return score(b) - score(a) || blendedPrice(a, r) - blendedPrice(b, r) || a.id.localeCompare(b.id);
    });

  const chain: string[] = [];
  let servedTier: Tier | undefined;
  for (const t of [tier, ...NEIGHBOURS[variant][tier]]) {
    for (const m of rank(pool.filter((x) => x.auto!.tiers.includes(t)))) {
      if (chain.length >= AUTO_CHAIN_LENGTH) break;
      if (!chain.includes(m.id)) {
        chain.push(m.id);
        servedTier ??= t;
      }
    }
    if (chain.length >= AUTO_CHAIN_LENGTH) break;
  }

  const variantNote =
    variant === 'default' ? '' : ` (auto:${variant}${tier !== classified ? `, ${classified}→${tier}` : ''})`;
  const tierNote = servedTier && servedTier !== tier ? `; no enabled ${tier} model, used ${servedTier}` : '';
  const reason = chain.length
    ? `${tier}${variantNote}: ${reasons.join(', ')} → ${chain[0]}${tierNote}`
    : `${tier}${variantNote}: ${reasons.join(', ')} → no enabled model satisfies the request`;
  return { variant, tier, models: chain, reason, signals };
}
