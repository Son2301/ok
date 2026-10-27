import { errored, type FetchLike, type SourceResult, signal, skipped, timedFetch } from '../verdict/signal';

/*
 * Third-party URL reputation adapters. Each one:
 *  - is skipped (never crashes) when its credential is missing,
 *  - turns network/API failures into status "error",
 *  - is implemented against the provider's public docs and unit-tested with fixtures.
 * verified: false — none of these have been exercised against the live services yet.
 */

// ---------------------------------------------------------------- RDAP (domain age)

export interface RdapData {
  registeredAt?: string;
  ageDays?: number;
  registrar?: string;
}

interface RdapEvent {
  eventAction?: string;
  eventDate?: string;
}
interface RdapEntity {
  roles?: string[];
  vcardArray?: [string, [string, unknown, string, string][]];
}

/**
 * Domain registration date via RDAP (rdap.org bootstrap redirector by default). Young domains
 * are a strong phishing indicator. Many ccTLDs (including .vn at the time of writing) do not
 * publish RDAP; a 404 is reported as "skipped", not as an error.
 */
export async function checkRdap(
  domain: string,
  fetchFn: FetchLike,
  opts: { baseUrl: string; now: Date; timeoutMs?: number },
): Promise<SourceResult<RdapData>> {
  const name = 'rdap';
  try {
    const res = await timedFetch(
      fetchFn,
      `${opts.baseUrl.replace(/\/+$/, '')}/domain/${encodeURIComponent(domain)}`,
      { headers: { accept: 'application/rdap+json, application/json' } },
      opts.timeoutMs ?? 3_500,
    );
    if (res.status === 404) return skipped(name, `No RDAP data for ${domain}`) as SourceResult<RdapData>;
    if (!res.ok) return errored(name, `HTTP ${res.status}`) as SourceResult<RdapData>;
    const body = (await res.json()) as { events?: RdapEvent[]; entities?: RdapEntity[] };
    const reg = body.events?.find((e) => e.eventAction === 'registration')?.eventDate;
    const registrar = body.entities
      ?.find((e) => e.roles?.includes('registrar'))
      ?.vcardArray?.[1]?.find((v) => v[0] === 'fn')?.[3];
    if (!reg)
      return {
        name,
        status: 'ok',
        detail: 'No registration date published',
        signals: [],
        data: { registrar },
      };
    const registeredAt = new Date(reg);
    if (Number.isNaN(registeredAt.getTime()))
      return {
        name,
        status: 'ok',
        detail: 'Unparseable registration date',
        signals: [],
        data: { registrar },
      };
    const ageDays = Math.max(0, Math.floor((opts.now.getTime() - registeredAt.getTime()) / 86_400_000));
    const data = { registeredAt: registeredAt.toISOString(), ageDays, registrar };
    return { name, status: 'ok', signals: domainAgeSignals(ageDays, domain), data };
  } catch (err) {
    return errored(name, err) as SourceResult<RdapData>;
  }
}

export function domainAgeSignals(ageDays: number, domain: string) {
  const ev = `${domain}: ${ageDays} ngày tuổi`;
  if (ageDays < 7) {
    return [
      signal(
        'url.domain_age',
        45,
        {
          vi: `Tên miền mới đăng ký ${ageDays} ngày trước: trang lừa đảo thường chỉ sống vài ngày`,
          en: `Domain registered only ${ageDays} days ago: scam sites usually live for days`,
        },
        'rdap',
        ev,
      ),
    ];
  }
  if (ageDays < 30) {
    return [
      signal(
        'url.domain_age',
        30,
        {
          vi: `Tên miền mới đăng ký chưa tới 1 tháng (${ageDays} ngày)`,
          en: `Domain is less than a month old (${ageDays} days)`,
        },
        'rdap',
        ev,
      ),
    ];
  }
  if (ageDays < 90) {
    return [
      signal(
        'url.domain_age',
        15,
        { vi: `Tên miền khá mới (${ageDays} ngày)`, en: `Fairly new domain (${ageDays} days)` },
        'rdap',
        ev,
      ),
    ];
  }
  if (ageDays < 180) {
    return [
      signal(
        'url.domain_age',
        5,
        { vi: `Tên miền dưới 6 tháng tuổi`, en: `Domain is under 6 months old` },
        'rdap',
        ev,
      ),
    ];
  }
  if (ageDays > 3 * 365) {
    return [
      signal(
        'url.domain_age',
        -10,
        { vi: `Tên miền đã hoạt động hơn 3 năm`, en: `Domain has existed for over 3 years` },
        'rdap',
        ev,
      ),
    ];
  }
  return [];
}

// ------------------------------------------------ Google Safe Browsing Lookup API v4

/** https://developers.google.com/safe-browsing/v4/lookup-api — verified: false */
export async function checkSafeBrowsing(
  urls: string | string[],
  apiKey: string | undefined,
  fetchFn: FetchLike,
): Promise<SourceResult> {
  const name = 'google_safe_browsing';
  if (!apiKey) return skipped(name, 'GOOGLE_SAFE_BROWSING_API_KEY not set');
  try {
    const res = await timedFetch(
      fetchFn,
      `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildSafeBrowsingRequest(urls)),
      },
      4_000,
    );
    if (!res.ok) return errored(name, `HTTP ${res.status}`);
    return parseSafeBrowsingResponse((await res.json()) as SafeBrowsingResponse);
  } catch (err) {
    return errored(name, err);
  }
}

export function buildSafeBrowsingRequest(urls: string | string[]) {
  const list = [...new Set(Array.isArray(urls) ? urls : [urls])];
  return {
    client: { clientId: 'minh-safe', clientVersion: '1.0.0' },
    threatInfo: {
      threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION'],
      platformTypes: ['ANY_PLATFORM'],
      threatEntryTypes: ['URL'],
      threatEntries: list.map((url) => ({ url })),
    },
  };
}

export interface SafeBrowsingResponse {
  matches?: { threatType?: string; platformType?: string; threat?: { url?: string } }[];
}

export function parseSafeBrowsingResponse(body: SafeBrowsingResponse): SourceResult {
  const name = 'google_safe_browsing';
  const types = [...new Set((body.matches ?? []).map((m) => m.threatType ?? 'UNKNOWN'))];
  if (!types.length) return { name, status: 'ok', signals: [], data: { threats: [] } };
  const vi: Record<string, string> = {
    SOCIAL_ENGINEERING: 'lừa đảo/giả mạo',
    MALWARE: 'mã độc',
    UNWANTED_SOFTWARE: 'phần mềm không mong muốn',
    POTENTIALLY_HARMFUL_APPLICATION: 'ứng dụng có hại',
  };
  return {
    name,
    status: 'ok',
    data: { threats: types },
    signals: [
      signal(
        'url.google_safe_browsing',
        90,
        {
          vi: `Google Safe Browsing đã đưa link này vào danh sách nguy hiểm (${types.map((t) => vi[t] ?? t).join(', ')})`,
          en: `Google Safe Browsing lists this link as dangerous (${types.join(', ')})`,
        },
        name,
        types.join(', '),
      ),
    ],
  };
}

// --------------------------------------------------------------- VirusTotal API v3

/** base64url(url) without padding = VirusTotal URL identifier. */
export function virusTotalUrlId(url: string): string {
  return Buffer.from(url).toString('base64url').replace(/=+$/, '');
}

export interface VirusTotalUrlReport {
  data?: {
    attributes?: {
      last_analysis_stats?: {
        malicious?: number;
        suspicious?: number;
        harmless?: number;
        undetected?: number;
        timeout?: number;
      };
    };
  };
}

/** https://docs.virustotal.com/reference/url-info — verified: false. We only read existing reports (no submission, for privacy). */
export async function checkVirusTotal(
  url: string,
  apiKey: string | undefined,
  fetchFn: FetchLike,
): Promise<SourceResult> {
  const name = 'virustotal';
  if (!apiKey) return skipped(name, 'VIRUSTOTAL_API_KEY not set');
  try {
    const res = await timedFetch(
      fetchFn,
      `https://www.virustotal.com/api/v3/urls/${virusTotalUrlId(url)}`,
      { headers: { 'x-apikey': apiKey, accept: 'application/json' } },
      4_000,
    );
    if (res.status === 404)
      return { name, status: 'ok', detail: 'No VirusTotal report for this URL yet', signals: [] };
    if (!res.ok) return errored(name, `HTTP ${res.status}`);
    return parseVirusTotalReport((await res.json()) as VirusTotalUrlReport);
  } catch (err) {
    return errored(name, err);
  }
}

export function parseVirusTotalReport(body: VirusTotalUrlReport): SourceResult {
  const name = 'virustotal';
  const s = body.data?.attributes?.last_analysis_stats;
  if (!s) return { name, status: 'ok', detail: 'Report has no analysis stats', signals: [] };
  const malicious = s.malicious ?? 0;
  const suspicious = s.suspicious ?? 0;
  const total = malicious + suspicious + (s.harmless ?? 0) + (s.undetected ?? 0) + (s.timeout ?? 0);
  const ev = `${malicious} độc hại, ${suspicious} đáng ngờ / ${total} công cụ`;
  const data = { malicious, suspicious, total };
  if (malicious >= 3) {
    return {
      name,
      status: 'ok',
      data,
      signals: [
        signal(
          'url.virustotal',
          80,
          {
            vi: `${malicious}/${total} công cụ bảo mật trên VirusTotal đánh dấu link này là nguy hiểm`,
            en: `${malicious}/${total} security vendors on VirusTotal flag this link as malicious`,
          },
          name,
          ev,
        ),
      ],
    };
  }
  if (malicious >= 1) {
    return {
      name,
      status: 'ok',
      data,
      signals: [
        signal(
          'url.virustotal',
          45,
          {
            vi: `${malicious} công cụ bảo mật trên VirusTotal đánh dấu link này là nguy hiểm`,
            en: `${malicious} security vendor(s) on VirusTotal flag this link as malicious`,
          },
          name,
          ev,
        ),
      ],
    };
  }
  if (suspicious >= 2) {
    return {
      name,
      status: 'ok',
      data,
      signals: [
        signal(
          'url.virustotal',
          20,
          {
            vi: `Một số công cụ bảo mật trên VirusTotal thấy link này đáng ngờ`,
            en: `Some VirusTotal vendors find this link suspicious`,
          },
          name,
          ev,
        ),
      ],
    };
  }
  return { name, status: 'ok', data, signals: [] };
}

// ------------------------------------------------------------------- URLhaus (abuse.ch)

export interface UrlhausResponse {
  query_status?: string;
  threat?: string;
  url_status?: string;
  tags?: string[] | null;
}

/** https://urlhaus-api.abuse.ch/ (POST /v1/url/, Auth-Key header) — verified: false */
export async function checkUrlhaus(
  url: string,
  authKey: string | undefined,
  fetchFn: FetchLike,
): Promise<SourceResult> {
  const name = 'urlhaus';
  if (!authKey) return skipped(name, 'URLHAUS_AUTH_KEY not set');
  try {
    const res = await timedFetch(
      fetchFn,
      'https://urlhaus-api.abuse.ch/v1/url/',
      {
        method: 'POST',
        headers: { 'Auth-Key': authKey, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ url }).toString(),
      },
      4_000,
    );
    if (!res.ok) return errored(name, `HTTP ${res.status}`);
    return parseUrlhausResponse((await res.json()) as UrlhausResponse);
  } catch (err) {
    return errored(name, err);
  }
}

export function parseUrlhausResponse(body: UrlhausResponse): SourceResult {
  const name = 'urlhaus';
  if (body.query_status === 'ok') {
    const online = body.url_status === 'online';
    return {
      name,
      status: 'ok',
      data: body,
      signals: [
        signal(
          'url.urlhaus',
          online ? 85 : 60,
          {
            vi: `URLhaus ghi nhận link này từng phát tán mã độc${online ? ' và vẫn đang hoạt động' : ''}`,
            en: `URLhaus lists this link as a malware distribution site${online ? ' (still online)' : ''}`,
          },
          name,
          [body.threat, ...(body.tags ?? [])].filter(Boolean).join(', '),
        ),
      ],
    };
  }
  if (body.query_status === 'no_results' || body.query_status === 'invalid_url')
    return { name, status: 'ok', signals: [] };
  return { name, status: 'error', detail: `Unexpected query_status: ${body.query_status}`, signals: [] };
}
