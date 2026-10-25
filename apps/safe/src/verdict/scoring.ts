import type { Level, Signal } from './types';

/**
 * Scoring formula (documented in README "Scoring"):
 *
 *   risk  = 1 − Π (1 − wᵢ/100)        over non-LLM signals with wᵢ > 0   (noisy-OR)
 *   trust = Π (1 − |wⱼ|/100)          over non-LLM signals with wⱼ < 0
 *   base  = 100 × risk × trust
 *   llm   = clamp(Σ LLM signal weights, −LLM_MAX_DOWN, +LLM_MAX_UP)
 *   score = clamp(round(base + llm), 0, 100)
 *
 * Each positive weight reads as "on its own, this signal makes a scam about w% likely"; the
 * noisy-OR means independent signals reinforce each other without ever exceeding 100. Trust
 * evidence (official domain, verified camera data…) scales the result down. The LLM is a
 * bounded nudge: it can never move the score by more than +25/−15 points, so a prompt-injected
 * "this message is safe" cannot erase hard rule evidence.
 */
export const LLM_MAX_UP = 25;
export const LLM_MAX_DOWN = 15;

export const LEVEL_THRESHOLDS = { medium: 25, high: 50, critical: 75 } as const;

export interface ScoreBreakdown {
  score: number;
  base: number;
  risk: number;
  trust: number;
  llm: number;
}

export function combineSignals(signals: readonly Signal[]): ScoreBreakdown {
  let notRisk = 1;
  let trust = 1;
  let llmSum = 0;
  for (const s of signals) {
    const w = Math.max(-100, Math.min(100, s.weight));
    if (s.source === 'llm') {
      llmSum += w;
      continue;
    }
    if (w > 0) notRisk *= 1 - w / 100;
    else if (w < 0) trust *= 1 - Math.abs(w) / 100;
  }
  const risk = 1 - notRisk;
  const base = 100 * risk * trust;
  const llm = Math.max(-LLM_MAX_DOWN, Math.min(LLM_MAX_UP, llmSum));
  const score = Math.max(0, Math.min(100, Math.round(base + llm)));
  return { score, base: round2(base), risk: round2(risk), trust: round2(trust), llm: round2(llm) };
}

export interface LevelOptions {
  /** The check could not gather enough evidence to say anything (e.g. a stripped image). */
  insufficientData?: boolean;
  /** Upper bound for the level (AI-text checks never go above `medium`). */
  maxLevel?: Exclude<Level, 'unknown' | 'safe'>;
}

const ORDER: Level[] = ['safe', 'low', 'medium', 'high', 'critical'];

export function levelFor(score: number, signals: readonly Signal[], opts: LevelOptions = {}): Level {
  const strongestRisk = Math.max(0, ...signals.filter((s) => s.source !== 'llm').map((s) => s.weight));
  const strongestTrust = Math.min(0, ...signals.filter((s) => s.source !== 'llm').map((s) => s.weight));
  let level: Level;
  if (score >= LEVEL_THRESHOLDS.critical) level = 'critical';
  else if (score >= LEVEL_THRESHOLDS.high) level = 'high';
  else if (score >= LEVEL_THRESHOLDS.medium) level = 'medium';
  // "safe" needs positive evidence; absence of red flags alone is only "low".
  else if (score < 10 && strongestTrust <= -30 && strongestRisk < 25) level = 'safe';
  else if (opts.insufficientData && strongestRisk < 10) level = 'unknown';
  else level = 'low';
  if (opts.maxLevel && level !== 'unknown' && ORDER.indexOf(level) > ORDER.indexOf(opts.maxLevel)) {
    level = opts.maxLevel;
  }
  return level;
}

/** Map a 0–1 probability from an external detector/model to a signal weight. */
export function probabilityToWeight(p: number, maxWeight: number): number {
  return Math.round(Math.max(0, Math.min(1, p)) * maxWeight);
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
