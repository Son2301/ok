import type { Db } from '@minh/db';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { feedEntries, feedImports } from '../db/schema';
import { hostKey, type NormalizedUrl, normalizeUrl } from '../url/normalize';
import { type FetchLike, type SourceResult, signal, timedFetch } from '../verdict/signal';

export interface FeedImportResult {
  source: string;
  status: 'ok' | 'skipped' | 'error';
  count: number;
  detail?: string;
}

const MAX_ENTRIES = 200_000;

/**
 * Phishing URL feeds imported into our own table so URL checks stay fast and private
 * (we never send user URLs to the feed providers).
 *   - OpenPhish community feed: plain text, one URL per line (no key; set OPENPHISH_FEED_URL).
 *   - PhishTank: JSON dump, needs PHISHTANK_APP_KEY.
 * verified: false — parsers are fixture-tested; the live endpoints have not been exercised.
 */
export class FeedStore {
  constructor(private readonly db: Db) {}

  async lookup(n: NormalizedUrl): Promise<SourceResult> {
    const name = 'phishing_feeds';
    try {
      const imported = await this.db
        .select({ source: feedImports.source })
        .from(feedImports)
        .where(eq(feedImports.lastStatus, 'ok'));
      if (!imported.length) {
        return {
          name,
          status: 'skipped',
          detail: 'No phishing feed imported yet (configure OPENPHISH_FEED_URL or PHISHTANK_APP_KEY)',
          signals: [],
        };
      }
      const host = hostKey(n.host);
      const rows = await this.db
        .select({ source: feedEntries.source, url: feedEntries.url })
        .from(feedEntries)
        .where(sql`${feedEntries.url} = ${n.href} OR ${feedEntries.host} = ${host}`)
        .limit(20);
      const exact = rows.filter((r) => r.url === n.href);
      const sources = [...new Set(rows.map((r) => r.source))];
      if (exact.length) {
        return {
          name,
          status: 'ok',
          signals: [
            signal(
              'url.phishing_feed',
              90,
              {
                vi: `Link này có trong danh sách trang lừa đảo (${sources.join(', ')})`,
                en: `This link is on a phishing blocklist (${sources.join(', ')})`,
              },
              name,
              sources.join(', '),
            ),
          ],
        };
      }
      if (rows.length) {
        return {
          name,
          status: 'ok',
          signals: [
            signal(
              'url.phishing_feed_host',
              70,
              {
                vi: `Tên miền này từng chứa trang lừa đảo (${sources.join(', ')})`,
                en: `This host has served phishing pages before (${sources.join(', ')})`,
              },
              name,
              `${rows.length} link lừa đảo trên ${host}`,
            ),
          ],
        };
      }
      return { name, status: 'ok', signals: [] };
    } catch (err) {
      return { name, status: 'error', detail: (err as Error).message, signals: [] };
    }
  }

  async importAll(
    cfg: { openPhishUrl?: string; phishTankAppKey?: string },
    fetchFn: FetchLike,
  ): Promise<FeedImportResult[]> {
    const results: FeedImportResult[] = [];
    if (cfg.openPhishUrl) {
      results.push(
        await this.runImport('openphish', async () =>
          parseOpenPhish(await (await this.get(fetchFn, cfg.openPhishUrl!)).text()),
        ),
      );
    } else {
      results.push({
        source: 'openphish',
        status: 'skipped',
        count: 0,
        detail: 'OPENPHISH_FEED_URL not set',
      });
    }
    if (cfg.phishTankAppKey) {
      const url = `https://data.phishtank.com/data/${encodeURIComponent(cfg.phishTankAppKey)}/online-valid.json`;
      results.push(
        await this.runImport('phishtank', async () =>
          parsePhishTank(await (await this.get(fetchFn, url)).json()),
        ),
      );
    } else {
      results.push({ source: 'phishtank', status: 'skipped', count: 0, detail: 'PHISHTANK_APP_KEY not set' });
    }
    return results;
  }

  private async get(fetchFn: FetchLike, url: string): Promise<Response> {
    const res = await timedFetch(
      fetchFn,
      url,
      { headers: { 'user-agent': 'minh-safe-feed-importer/1.0' } },
      60_000,
    );
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    return res;
  }

  /** Store parsed URLs for a source. Exposed for tests and manual imports. */
  async runImport(source: string, load: () => Promise<string[]>): Promise<FeedImportResult> {
    const now = new Date();
    try {
      const urls = (await load()).slice(0, MAX_ENTRIES);
      const rows: { source: string; url: string; host: string; firstSeen: Date; lastSeen: Date }[] = [];
      const seen = new Set<string>();
      for (const raw of urls) {
        try {
          const n = normalizeUrl(raw);
          if (seen.has(n.href)) continue;
          seen.add(n.href);
          rows.push({ source, url: n.href, host: hostKey(n.host), firstSeen: now, lastSeen: now });
        } catch {
          // skip malformed feed lines
        }
      }
      for (let i = 0; i < rows.length; i += 500) {
        await this.db
          .insert(feedEntries)
          .values(rows.slice(i, i + 500))
          .onConflictDoUpdate({ target: [feedEntries.source, feedEntries.url], set: { lastSeen: now } });
      }
      await this.recordImport(source, 'ok', rows.length, null, now);
      return { source, status: 'ok', count: rows.length };
    } catch (err) {
      await this.recordImport(source, 'error', 0, (err as Error).message, now);
      return { source, status: 'error', count: 0, detail: (err as Error).message };
    }
  }

  private async recordImport(source: string, status: string, count: number, error: string | null, now: Date) {
    // Keep a previous successful import usable if a later run fails.
    const prev = await this.db.select().from(feedImports).where(eq(feedImports.source, source));
    const keepOk = status === 'error' && prev[0]?.lastStatus === 'ok';
    await this.db
      .insert(feedImports)
      .values({
        source,
        lastRunAt: now,
        lastStatus: keepOk ? 'ok' : status,
        lastCount: keepOk ? prev[0]!.lastCount : count,
        lastError: error,
      })
      .onConflictDoUpdate({
        target: feedImports.source,
        set: {
          lastRunAt: now,
          lastStatus: keepOk ? 'ok' : status,
          lastCount: keepOk ? prev[0]!.lastCount : count,
          lastError: error,
        },
      });
  }

  /** Drop entries not seen in recent imports (phishing pages are short-lived). */
  async prune(olderThanDays = 30): Promise<void> {
    await this.db
      .delete(feedEntries)
      .where(lt(feedEntries.lastSeen, new Date(Date.now() - olderThanDays * 86_400_000)));
  }

  async countBySource(sources: string[]): Promise<Record<string, number>> {
    if (!sources.length) return {};
    const rows = await this.db
      .select({ source: feedEntries.source, n: sql<number>`count(*)::int` })
      .from(feedEntries)
      .where(and(inArray(feedEntries.source, sources)))
      .groupBy(feedEntries.source);
    return Object.fromEntries(rows.map((r) => [r.source, Number(r.n)]));
  }
}

export function parseOpenPhish(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^https?:\/\//i.test(l));
}

export function parsePhishTank(json: unknown): string[] {
  if (!Array.isArray(json)) throw new Error('PhishTank feed is not an array');
  return json.map((e) => (e as { url?: unknown }).url).filter((u): u is string => typeof u === 'string');
}
