import { createDb, type DbHandle, migrate } from '@minh/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { safeMigrations } from '../db/migrations';
import { strictFetch } from '../test/helpers';
import { normalizeUrl } from '../url/normalize';
import { FeedStore, parseOpenPhish, parsePhishTank } from './feeds';
import {
  buildSafeBrowsingRequest,
  checkRdap,
  checkSafeBrowsing,
  checkUrlhaus,
  checkVirusTotal,
  parseSafeBrowsingResponse,
  parseUrlhausResponse,
  parseVirusTotalReport,
  virusTotalUrlId,
} from './url-reputation';

describe('credential-gated sources are skipped without keys', () => {
  it('never touches the network when unconfigured', async () => {
    const f = strictFetch();
    expect((await checkSafeBrowsing('https://a.test/', undefined, f)).status).toBe('skipped');
    expect((await checkVirusTotal('https://a.test/', undefined, f)).status).toBe('skipped');
    expect((await checkUrlhaus('https://a.test/', undefined, f)).status).toBe('skipped');
    expect(f.calls).toHaveLength(0);
  });
});

describe('Google Safe Browsing v4 (fixtures)', () => {
  it('builds the documented request and parses matches', async () => {
    const req = buildSafeBrowsingRequest(['https://a.test/', 'https://a.test/']);
    expect(req.threatInfo.threatEntries).toEqual([{ url: 'https://a.test/' }]);
    expect(req.threatInfo.threatTypes).toContain('SOCIAL_ENGINEERING');
    const hit = parseSafeBrowsingResponse({
      matches: [
        {
          threatType: 'SOCIAL_ENGINEERING',
          platformType: 'ANY_PLATFORM',
          threat: { url: 'https://a.test/' },
        },
      ],
    });
    expect(hit.signals[0]).toMatchObject({ id: 'url.google_safe_browsing', weight: 90 });
    expect(hit.signals[0]!.label.vi).toContain('lừa đảo');
    expect(parseSafeBrowsingResponse({}).signals).toHaveLength(0);
    const f = strictFetch({
      'https://safebrowsing.googleapis.com/': async (r) => {
        expect(new URL(r.url).searchParams.get('key')).toBe('gsb-key');
        return Response.json({});
      },
    });
    expect((await checkSafeBrowsing('https://a.test/', 'gsb-key', f)).status).toBe('ok');
  });
});

describe('VirusTotal v3 (fixtures)', () => {
  it('uses unpadded base64url ids and maps vendor counts', async () => {
    expect(virusTotalUrlId('http://example.com/')).toBe('aHR0cDovL2V4YW1wbGUuY29tLw');
    expect(
      parseVirusTotalReport({
        data: {
          attributes: { last_analysis_stats: { malicious: 7, suspicious: 1, harmless: 60, undetected: 20 } },
        },
      }).signals[0]?.weight,
    ).toBe(80);
    expect(
      parseVirusTotalReport({ data: { attributes: { last_analysis_stats: { malicious: 1, harmless: 70 } } } })
        .signals[0]?.weight,
    ).toBe(45);
    expect(
      parseVirusTotalReport({ data: { attributes: { last_analysis_stats: { malicious: 0, harmless: 70 } } } })
        .signals,
    ).toHaveLength(0);
    const f = strictFetch({
      'https://www.virustotal.com/api/v3/urls/': (r) => {
        expect(r.headers.get('x-apikey')).toBe('vt');
        return new Response('{}', { status: 404 });
      },
    });
    expect(await checkVirusTotal('https://a.test/', 'vt', f)).toMatchObject({ status: 'ok', signals: [] });
  });
});

describe('URLhaus (fixtures)', () => {
  it('parses hits and misses and sends Auth-Key', async () => {
    expect(
      parseUrlhausResponse({
        query_status: 'ok',
        threat: 'malware_download',
        url_status: 'online',
        tags: ['apk'],
      }).signals[0]?.weight,
    ).toBe(85);
    expect(parseUrlhausResponse({ query_status: 'no_results' }).signals).toHaveLength(0);
    const f = strictFetch({
      'https://urlhaus-api.abuse.ch/v1/url/': async (r) => {
        expect(r.headers.get('auth-key')).toBe('uh');
        expect(await r.text()).toBe('url=https%3A%2F%2Fa.test%2F');
        return Response.json({ query_status: 'no_results' });
      },
    });
    expect((await checkUrlhaus('https://a.test/', 'uh', f)).status).toBe('ok');
  });
  it('turns HTTP failures into errors, not crashes', async () => {
    const f = strictFetch({ 'https://urlhaus-api.abuse.ch/': () => new Response('x', { status: 500 }) });
    expect((await checkUrlhaus('https://a.test/', 'uh', f)).status).toBe('error');
  });
});

describe('RDAP domain age (fixtures)', () => {
  const now = new Date('2026-10-25T00:00:00Z');
  const rdap = (date: string) =>
    strictFetch({
      'https://rdap.test/domain/': () =>
        Response.json({
          events: [{ eventAction: 'registration', eventDate: date }],
          entities: [
            { roles: ['registrar'], vcardArray: ['vcard', [['fn', {}, 'text', 'Example Registrar']]] },
          ],
        }),
    });

  it('scores young domains higher and old domains as weak trust', async () => {
    const young = await checkRdap('evil.top', rdap('2026-10-22T00:00:00Z'), {
      baseUrl: 'https://rdap.test',
      now,
    });
    expect(young.data).toMatchObject({ ageDays: 3, registrar: 'Example Registrar' });
    expect(young.signals[0]!.weight).toBe(45);
    expect(
      (await checkRdap('a.top', rdap('2026-10-01T00:00:00Z'), { baseUrl: 'https://rdap.test', now }))
        .signals[0]!.weight,
    ).toBe(30);
    expect(
      (await checkRdap('old.com', rdap('2015-01-01T00:00:00Z'), { baseUrl: 'https://rdap.test', now }))
        .signals[0]!.weight,
    ).toBe(-10);
  });

  it('reports a 404 (no RDAP for this TLD) as skipped', async () => {
    const f = strictFetch({ 'https://rdap.test/': () => new Response('', { status: 404 }) });
    expect((await checkRdap('example.vn', f, { baseUrl: 'https://rdap.test', now })).status).toBe('skipped');
  });
});

describe('phishing feeds', () => {
  let handle: DbHandle;
  let feeds: FeedStore;
  beforeAll(async () => {
    handle = await createDb('memory://');
    await migrate(handle, 'safe', safeMigrations);
    feeds = new FeedStore(handle.db);
  });
  afterAll(() => handle.close());

  it('parses OpenPhish text and PhishTank JSON', () => {
    expect(parseOpenPhish('https://a.test/x\n\n# comment\nhttp://b.test/\nnot a url')).toEqual([
      'https://a.test/x',
      'http://b.test/',
    ]);
    expect(parsePhishTank([{ url: 'https://c.test/' }, { nope: 1 }])).toEqual(['https://c.test/']);
    expect(() => parsePhishTank({})).toThrow();
  });

  it('is skipped until a feed is imported, then matches URLs and hosts', async () => {
    expect((await feeds.lookup(normalizeUrl('https://vcb-login.test/a'))).status).toBe('skipped');
    const f = strictFetch({
      'https://openphish.test/feed.txt': () =>
        new Response('https://vcb-login.test/a\nhttps://www.other-phish.test/x\n'),
    });
    const res = await feeds.importAll({ openPhishUrl: 'https://openphish.test/feed.txt' }, f);
    expect(res).toEqual([
      { source: 'openphish', status: 'ok', count: 2 },
      { source: 'phishtank', status: 'skipped', count: 0, detail: 'PHISHTANK_APP_KEY not set' },
    ]);
    expect((await feeds.lookup(normalizeUrl('https://vcb-login.test/a'))).signals[0]).toMatchObject({
      id: 'url.phishing_feed',
      weight: 90,
    });
    expect((await feeds.lookup(normalizeUrl('https://other-phish.test/zzz'))).signals[0]).toMatchObject({
      id: 'url.phishing_feed_host',
      weight: 70,
    });
    expect((await feeds.lookup(normalizeUrl('https://clean.test/'))).signals).toHaveLength(0);
  });

  it('keeps the last good import usable when a later import fails', async () => {
    const f = strictFetch({ 'https://openphish.test/feed.txt': () => new Response('down', { status: 503 }) });
    const [r] = await feeds.importAll({ openPhishUrl: 'https://openphish.test/feed.txt' }, f);
    expect(r!.status).toBe('error');
    expect((await feeds.lookup(normalizeUrl('https://vcb-login.test/a'))).status).toBe('ok');
  });
});
