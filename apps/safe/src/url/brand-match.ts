import { domainToUnicode } from 'node:url';
import { fold } from '../lib/vn-text';
import {
  BRANDS,
  type Brand,
  type BrandCategory,
  type BrandKeyword,
  PHISHING_WORDS,
  USER_CONTENT_HOSTS,
} from './brands';
import { isOnDomain, type NormalizedUrl } from './normalize';
import { fuzzyContains, LOOKALIKE_SAFE_WORDS, skeleton, typoBudget } from './similarity';

export interface BrandOverride {
  brandId: string;
  name?: string | null;
  category?: string | null;
  officialDomains?: string[] | null;
  keywords?: BrandKeyword[] | null;
  mentions?: string[] | null;
  disabled?: boolean | null;
}

/** Curated brands merged with admin overrides from the database. */
export class BrandRegistry {
  private brands: Brand[];

  constructor(base: Brand[] = BRANDS) {
    this.brands = base.map((b) => ({ ...b }));
  }

  /** Merge overrides: existing ids are extended (domains/keywords added) or disabled; new ids are added. */
  applyOverrides(overrides: BrandOverride[], base: Brand[] = BRANDS): void {
    const byId = new Map(
      base.map((b) => [
        b.id,
        { ...b, domains: [...b.domains], keywords: [...b.keywords], mentions: [...b.mentions] },
      ]),
    );
    for (const o of overrides) {
      const existing = byId.get(o.brandId);
      if (o.disabled) {
        byId.delete(o.brandId);
        continue;
      }
      if (existing) {
        if (o.name) existing.name = o.name;
        if (o.category) existing.category = o.category as BrandCategory;
        existing.domains = unique([...existing.domains, ...(o.officialDomains ?? [])]);
        existing.keywords = uniqueBy(
          [...existing.keywords, ...(o.keywords ?? [])],
          (k) => `${k.mode}:${k.k}`,
        );
        existing.mentions = unique([...existing.mentions, ...(o.mentions ?? [])]);
      } else if (o.name && o.officialDomains?.length) {
        byId.set(o.brandId, {
          id: o.brandId,
          name: o.name,
          category: (o.category as BrandCategory) ?? 'tech',
          domains: o.officialDomains,
          keywords: o.keywords ?? [],
          mentions: o.mentions ?? [],
        });
      }
    }
    this.brands = [...byId.values()];
  }

  list(): Brand[] {
    return this.brands;
  }

  get(id: string): Brand | undefined {
    return this.brands.find((b) => b.id === id);
  }

  /** The brand whose official domain this host is on (null for user-content hosts like sites.google.com). */
  officialFor(host: string): Brand | null {
    if (isUserContentHost(host)) return null;
    for (const b of this.brands) if (b.domains.some((d) => isOnDomain(host, d))) return b;
    return null;
  }

  /** Brands mentioned in free text (already folded with `fold`). */
  mentionedIn(foldedText: string): Brand[] {
    const padded = ` ${foldedText} `;
    return this.brands.filter(
      (b) =>
        b.mentions.some((m) => padded.includes(` ${m} `)) ||
        b.keywords.some((k) => k.k.length >= 5 && k.mode !== 'token' && padded.includes(` ${k.k} `)),
    );
  }
}

export function isUserContentHost(host: string): boolean {
  return USER_CONTENT_HOSTS.some((d) => isOnDomain(host, d));
}

export interface BrandHit {
  brand: Brand;
  where: 'domain' | 'subdomain' | 'path';
  how: 'exact' | 'homoglyph' | 'lookalike' | 'official_domain_in_subdomain';
  keyword: string;
  matched: string;
  /** The label also contains phishing words like "xacthuc", "login", "otp". */
  phishingWords: string[];
  distance?: number;
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
function uniqueBy<T>(xs: T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = key(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function phishingWordsIn(s: string): string[] {
  const flat = s.toLowerCase().replace(/[^a-z0-9]/g, '');
  return PHISHING_WORDS.filter((w) => flat.includes(w));
}

/**
 * The part of the host the attacker chose: the registrable label (`vietcombank-xacthuc` in
 * `vietcombank-xacthuc.com`), or the tenant label on a hosting platform (`vcb-login` in
 * `vcb-login.web.app`). Returned in Unicode so homoglyphs are visible.
 */
function chosenLabel(n: NormalizedUrl): { ascii: string; unicode: string } | null {
  if (n.isIp || !n.domain) return null;
  const site = n.siteDomain && n.siteDomain !== n.domain ? n.siteDomain : n.domain;
  const ascii = site.split('.')[0]!;
  const unicode = domainToUnicode(`${ascii}.x`).replace(/\.x$/, '') || ascii;
  return { ascii, unicode };
}

function matchKeyword(
  kw: BrandKeyword,
  label: { ascii: string; unicode: string },
  allowFuzzy: boolean,
): { how: BrandHit['how']; matched: string; distance?: number } | null {
  const raw = label.ascii.toLowerCase();
  const tokensRaw = raw.split(/[-_]+/).filter(Boolean);
  const tokensSkel = label.unicode.split(/[-_]+/).filter(Boolean).map(skeleton);
  const joinedSkel = skeleton(label.unicode.replace(/[-_]/g, ''));
  const k = kw.k;
  const kSkel = skeleton(k);
  const literal =
    kw.mode === 'token'
      ? tokensRaw.includes(k)
      : kw.mode === 'prefix'
        ? tokensRaw.some((t) => t.startsWith(k))
        : raw.replace(/[-_]/g, '').includes(k);
  if (literal) return { how: 'exact', matched: k };
  const visual =
    kw.mode === 'token'
      ? tokensSkel.includes(kSkel)
      : kw.mode === 'prefix'
        ? tokensSkel.some((t) => t.startsWith(kSkel))
        : joinedSkel.includes(kSkel);
  if (visual) return { how: 'homoglyph', matched: label.unicode };
  if (allowFuzzy && kw.mode === 'fuzzy') {
    if (tokensRaw.some((t) => LOOKALIKE_SAFE_WORDS.has(t))) return null;
    const budget = typoBudget(k.length);
    // Long names may hide anywhere ("xacthucvietcornbank"); short ones must start a token, so
    // "mbank" inside "vietcombank" is not mistaken for a typo of "mbbank".
    const hit =
      k.length >= 9
        ? fuzzyContains(joinedSkel, kSkel, budget)
        : (tokensSkel
            .map((t) => fuzzyContains(t, kSkel, budget, { anchorStart: true }))
            .filter((h) => h !== null)
            .sort((a, b) => a.distance - b.distance)[0] ?? null);
    if (hit && hit.distance > 0 && !LOOKALIKE_SAFE_WORDS.has(hit.match)) {
      return { how: 'lookalike', matched: hit.match, distance: hit.distance };
    }
  }
  return null;
}

/** Find brand names (exact, homoglyph or typo-lookalike) in a non-official URL. */
export function detectBrandHits(n: NormalizedUrl, registry: BrandRegistry): BrandHit[] {
  if (n.isIp) return detectInPath(n, registry);
  if (registry.officialFor(n.host)) return [];
  const hits: BrandHit[] = [];
  const label = chosenLabel(n);
  const allKeywords = new Set(registry.list().flatMap((b) => b.keywords.map((k) => k.k)));

  if (label) {
    const words = phishingWordsIn(label.ascii);
    for (const brand of registry.list()) {
      let best: BrandHit | null = null;
      for (const kw of brand.keywords) {
        const m = matchKeyword(kw, label, true);
        if (!m) continue;
        // A typo-lookalike that is literally another brand's keyword is that brand, not this one.
        if (m.how === 'lookalike' && allKeywords.has(m.matched)) continue;
        const hit: BrandHit = {
          brand,
          where: 'domain',
          how: m.how,
          keyword: kw.k,
          matched: m.matched,
          phishingWords: words,
          distance: m.distance,
        };
        if (!best || rank(hit) > rank(best)) best = hit;
      }
      if (best) hits.push(best);
    }
  }

  // Subdomains: "vietcombank.com.vn.secure-login.xyz", "vcb.online-verify.top".
  const sub = n.siteDomain && n.siteDomain !== n.domain ? '' : n.subdomain;
  if (sub) {
    for (const brand of registry.list()) {
      if (hits.some((h) => h.brand.id === brand.id)) continue;
      const official = brand.domains.find(
        (d) => sub === d || sub.endsWith(`.${d}`) || sub.includes(`${d}.`) || sub.includes(d),
      );
      if (official) {
        hits.push({
          brand,
          where: 'subdomain',
          how: 'official_domain_in_subdomain',
          keyword: official,
          matched: sub,
          phishingWords: phishingWordsIn(sub),
        });
        continue;
      }
      for (const lbl of sub.split('.')) {
        const unicode = domainToUnicode(`${lbl}.x`).replace(/\.x$/, '') || lbl;
        const m = brand.keywords
          .map((kw) => ({ kw, m: matchKeyword(kw, { ascii: lbl, unicode }, false) }))
          .find((x) => x.m);
        if (m?.m) {
          hits.push({
            brand,
            where: 'subdomain',
            how: m.m.how,
            keyword: m.kw.k,
            matched: lbl,
            phishingWords: phishingWordsIn(sub),
          });
          break;
        }
      }
    }
  }

  for (const h of detectInPath(n, registry)) if (!hits.some((x) => x.brand.id === h.brand.id)) hits.push(h);
  // "viettelpost-giaohang" mentions Viettel Post, not also Viettel: drop hits whose keyword is
  // contained in a longer keyword matched at the same place. Likewise, once a label literally names
  // a brand, typo-lookalikes of other brands in it ("mbank" in "vietcombank") are noise.
  return hits.filter(
    (a) =>
      !hits.some(
        (b) =>
          b !== a &&
          b.where === a.where &&
          b.how !== 'lookalike' &&
          ((b.keyword.length > a.keyword.length && b.keyword.includes(a.keyword)) || a.how === 'lookalike'),
      ),
  );
}

function detectInPath(n: NormalizedUrl, registry: BrandRegistry): BrandHit[] {
  let path: string;
  try {
    path = decodeURIComponent(`${n.url.pathname}${n.url.search}`);
  } catch {
    path = `${n.url.pathname}${n.url.search}`;
  }
  const folded = fold(path);
  if (!folded) return [];
  const tokens = folded.split(' ');
  const joined = tokens.join('');
  const words = phishingWordsIn(folded);
  const out: BrandHit[] = [];
  for (const brand of registry.list()) {
    const kw = brand.keywords.find((k) =>
      k.mode === 'token'
        ? tokens.includes(k.k)
        : k.k.length >= 4 &&
          (k.mode === 'prefix' ? tokens.some((t) => t.startsWith(k.k)) : joined.includes(k.k)),
    );
    if (kw)
      out.push({ brand, where: 'path', how: 'exact', keyword: kw.k, matched: kw.k, phishingWords: words });
  }
  return out;
}

function rank(h: BrandHit): number {
  const how = { homoglyph: 4, exact: 3, lookalike: 2, official_domain_in_subdomain: 5 }[h.how];
  return how * 100 + h.keyword.length;
}
