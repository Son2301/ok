import 'server-only';

const DEV_INTERNAL_TOKEN = 'dev-internal-token-change-me';

/** Strip a trailing slash and a trailing `/v1` so callers can always append `/v1/...`. */
export function serviceBase(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
}

function num(v: string | undefined, def: number): number {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : def;
}

/**
 * Runtime configuration, read on every call (cheap) so that `next build` never
 * bakes values in and a restarted server always sees its current environment.
 */
export function env() {
  const e = process.env;
  const nodeEnv = e.NODE_ENV ?? 'development';
  const gateway = serviceBase(e.GATEWAY_URL || 'http://localhost:4000');
  return {
    nodeEnv,
    databaseUrl: e.DATABASE_URL || 'memory://',
    internalToken: e.INTERNAL_TOKEN || DEV_INTERNAL_TOKEN,
    usingDevToken: !e.INTERNAL_TOKEN || e.INTERNAL_TOKEN === DEV_INTERNAL_TOKEN,
    services: {
      gateway,
      agents: serviceBase(e.AGENTS_URL || 'http://localhost:4100'),
      safe: serviceBase(e.SAFE_URL || 'http://localhost:4200'),
      review: serviceBase(e.REVIEW_URL || 'http://localhost:4300'),
    },
    /** Base URL customers use in their code (shown in curl snippets). */
    publicApiUrl: serviceBase(e.PUBLIC_API_URL || gateway),
    publicSafeUrl: serviceBase(e.PUBLIC_SAFE_URL || e.SAFE_URL || 'http://localhost:4200'),
    /** Fallback rate when the gateway's wallet summary is unavailable. Keep in sync with the gateway. */
    vndPerUsd: num(e.VND_PER_USD, 26_000),
    welcomeCreditMicros: Math.max(0, Math.floor(num(e.WELCOME_CREDIT_MICROS, 0))),
    cookieSecure: e.COOKIE_SECURE ? e.COOKIE_SECURE === 'true' : nodeEnv === 'production',
    serviceTimeoutMs: num(e.SERVICE_TIMEOUT_MS, 15_000),
    brandName: e.BRAND_NAME || 'Minh AI',
    founderName: e.FOUNDER_NAME || '',
    contactEmail: e.CONTACT_EMAIL || '',
    contactZalo: e.CONTACT_ZALO || '',
    /** Company tax code shown in the footer (trust signal). */
    companyTaxCode: e.COMPANY_TAX_CODE || '',
  };
}

export type Env = ReturnType<typeof env>;

let warned = false;
export function warnOnDevToken() {
  const cfg = env();
  if (!warned && cfg.nodeEnv === 'production' && cfg.usingDevToken) {
    warned = true;
    console.warn(
      '[web] INTERNAL_TOKEN is not set: using the development token. Set the same strong secret as the services.',
    );
  }
}
