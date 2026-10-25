import { isNegated, type NormalizedText, normalizeForMatch, originalSpan, phrase } from '../lib/vn-text';
import { signal } from '../verdict/signal';
import type { Localized, Signal } from '../verdict/types';
import { AUTHORITY_RULES, type GroupItem, SCAM_RULES, type ScamRule } from './patterns';

export interface RuleContext {
  hasUrl: boolean;
  hasMobile: boolean;
  hasBank: boolean;
}

export interface RuleHit {
  rule: ScamRule;
  /** Quotes from the original message that triggered each group. */
  evidence: string[];
}

export interface RuleAnalysis {
  normalized: NormalizedText;
  hits: RuleHit[];
  signals: Signal[];
  /** The main scam type (strongest non-tactic rule), if any. */
  primary?: ScamRule;
  tactics: string[];
  scammerGoal?: Localized;
  advice: Localized[];
  policeWarned: Localized[];
}

const regexCache = new Map<string, RegExp>();
function compile(src: string): RegExp {
  let re = regexCache.get(src);
  if (!re) {
    re = phrase(src);
    regexCache.set(src, re);
  }
  re.lastIndex = 0;
  return re;
}

function matchItem(item: GroupItem, n: NormalizedText, ctx: RuleContext, negatable: boolean): string | null {
  if (typeof item !== 'string') {
    const ok = item.entity === 'url' ? ctx.hasUrl : item.entity === 'mobile' ? ctx.hasMobile : ctx.hasBank;
    return ok ? `[${item.entity}]` : null;
  }
  const re = compile(item);
  for (const m of n.text.matchAll(re)) {
    if (negatable && isNegated(n.text, m.index!)) continue;
    return originalSpan(n, m.index!, m.index! + m[0].length, 80);
  }
  return null;
}

/** Evaluate every rule against a message. Pure and deterministic. */
export function runRules(text: string, ctx: RuleContext, rules: ScamRule[] = SCAM_RULES): RuleAnalysis {
  const n = normalizeForMatch(text);
  const hits: RuleHit[] = [];
  for (const rule of rules) {
    if (rule.none?.some((src) => compile(src).test(n.text))) continue;
    const evidence: string[] = [];
    let ok = true;
    for (const group of rule.groups) {
      let found: string | null = null;
      for (const item of group) {
        found = matchItem(item, n, ctx, rule.negatable === true);
        if (found) break;
      }
      if (!found) {
        ok = false;
        break;
      }
      if (!found.startsWith('[') && !evidence.includes(found)) evidence.push(found);
    }
    if (ok) hits.push({ rule, evidence });
  }

  const signals: Signal[] = hits.map((h) =>
    signal(
      `text.rule.${h.rule.id}`,
      h.rule.weight,
      h.rule.label,
      'rules',
      h.evidence.length ? h.evidence.map((e) => `“${e}”`).join(' … ') : undefined,
    ),
  );

  const scamHits = hits.filter((h) => !h.rule.tactic).sort((a, b) => b.rule.weight - a.rule.weight);
  const authority = scamHits.find((h) => AUTHORITY_RULES.has(h.rule.id));
  const paymentAsked = hits.some((h) => h.rule.id === 'payment_request') || ctx.hasBank;
  if (authority && paymentAsked) {
    signals.push(
      signal(
        'text.authority_payment',
        35,
        {
          vi: 'Cơ quan nhà nước không bao giờ yêu cầu chuyển tiền vào tài khoản cá nhân hay "tài khoản tạm giữ"',
          en: 'Government agencies never ask you to transfer money to personal or "holding" accounts',
        },
        'rules',
        authority.rule.label.vi,
      ),
    );
  }

  const advice: Localized[] = [];
  for (const h of scamHits)
    for (const a of h.rule.advice ?? []) if (!advice.some((x) => x.vi === a.vi)) advice.push(a);
  return {
    normalized: n,
    hits,
    signals,
    primary: scamHits[0]?.rule,
    tactics: [...new Set(hits.filter((h) => h.rule.tactic).map((h) => h.rule.tactic!))],
    scammerGoal: scamHits.find((h) => h.rule.scammerGoal)?.rule.scammerGoal,
    advice,
    policeWarned: scamHits.filter((h) => h.rule.policeWarned).map((h) => h.rule.policeWarned!),
  };
}
