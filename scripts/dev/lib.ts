/** Shared helpers for the local-development scripts (setup, dev runner, pay, reset). */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const ENV_FILE = join(ROOT, '.env');
export const DEV_DIR = join(ROOT, '.dev');
export const CREDENTIALS_FILE = join(DEV_DIR, 'credentials.json');
export const DEV_COMPOSE = join(ROOT, 'docker-compose.dev.yml');

export const PORTS = { web: 3000, gateway: 4000, agents: 4100, safe: 4200, review: 4300 } as const;
export type AppName = keyof typeof PORTS;
export const APPS: AppName[] = ['gateway', 'agents', 'safe', 'review', 'web'];

export const DEMO = { email: 'demo@minh.local', password: 'minh-demo-2026', orgName: 'Shop Demo' } as const;

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = {
  dim: paint(2),
  bold: paint(1),
  red: paint(31),
  green: paint(32),
  yellow: paint(33),
  blue: paint(34),
  magenta: paint(35),
  cyan: paint(36),
  gray: paint(90),
};

export const log = {
  step: (msg: string) => console.log(`${c.cyan('›')} ${msg}`),
  ok: (msg: string) => console.log(`${c.green('✔')} ${msg}`),
  warn: (msg: string) => console.log(`${c.yellow('!')} ${msg}`),
  fail: (msg: string) => console.error(`${c.red('✘')} ${msg}`),
};

/** Minimal .env parser (KEY=VALUE, # comments, optional quotes). */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1).replace(/\\n/g, '\n');
    }
    out[key] = value;
  }
  return out;
}

export function readEnvFile(): Record<string, string> {
  return existsSync(ENV_FILE) ? parseEnv(readFileSync(ENV_FILE, 'utf8')) : {};
}

/** process.env wins over .env so one-off overrides work: `DATABASE_URL=… pnpm dev`. */
export function loadEnv(): Record<string, string> {
  const merged: Record<string, string> = { ...readEnvFile() };
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) merged[k] = v;
  return merged;
}

export const secret = (bytes = 24) => randomBytes(bytes).toString('hex');

/** The defaults a fresh local checkout needs. Secrets are generated per machine. */
export function devEnvDefaults(): [string, string, string?][] {
  return [
    ['NODE_ENV', 'development', 'Local development defaults written by `pnpm dev:setup`. Safe to edit.'],
    ['LOG_LEVEL', 'info'],
    [
      'DATABASE_URL',
      'postgres://minh:minh@localhost:5433/minh',
      'Postgres from docker-compose.dev.yml (or point this at any Postgres 16).',
    ],
    ['INTERNAL_TOKEN', secret(24), 'Shared by the web console and every service.'],
    [
      'PLATFORM_ORG_ID',
      'org_platform',
      'Org that funds free tiers (Safe checks, Review quota, Agents included tokens).',
    ],
    ['PLATFORM_ORG_INITIAL_CREDIT_USD', '20'],
    ['AGENTS_PLATFORM_ORG_ID', 'org_platform'],
    ['SAFE_PLATFORM_ORG_ID', 'org_platform'],
    ['REVIEW_PLATFORM_ORG_ID', 'org_platform'],
    [
      'AGENTS_ENCRYPTION_KEY',
      randomBytes(32).toString('base64'),
      'Encrypts agent integration credentials at rest.',
    ],
    ['REVIEW_STATE_SECRET', secret(24)],
    ['SAFE_FINGERPRINT_SALT', secret(16)],
    ['WELCOME_CREDIT_MICROS', '2000000', 'New sign-ups get $2 (~52.000đ) so you can try everything locally.'],
    ['VND_PER_USD', '26000'],
    [
      'TOPUP_BANK_ID',
      '970436',
      'Fake receiving account so VietQR top-ups work locally; pay with `pnpm dev:pay`.',
    ],
    ['TOPUP_BANK_ACCOUNT_NO', '0071000123456'],
    ['TOPUP_BANK_ACCOUNT_NAME', 'MINH AI DEV'],
    ['SEPAY_API_KEY', `dev-sepay-${secret(8)}`],
    [
      'OPENAI_API_KEY',
      '',
      'Add any provider key to use real models; with none, the gateway serves an offline mock model.',
    ],
    ['ANTHROPIC_API_KEY', ''],
    ['GEMINI_API_KEY', ''],
    ['DEEPSEEK_API_KEY', ''],
    ['DASHSCOPE_API_KEY', ''],
    ['OPENROUTER_API_KEY', ''],
  ];
}

/** Append any missing keys to .env without touching existing values. Returns the keys added. */
export function ensureEnvFile(): string[] {
  const existing = readEnvFile();
  const added: string[] = [];
  let text = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : '';
  if (text && !text.endsWith('\n')) text += '\n';
  for (const [key, value, comment] of devEnvDefaults()) {
    if (key in existing) continue;
    if (comment) text += `${text ? '\n' : ''}# ${comment}\n`;
    text += `${key}=${value}\n`;
    added.push(key);
  }
  if (added.length) writeFileSync(ENV_FILE, text, { mode: 0o600 });
  return added;
}

export function hasCommand(cmd: string, args = ['--version']): boolean {
  const r = spawnSync(cmd, args, { stdio: 'ignore', shell: process.platform === 'win32' });
  return r.status === 0;
}

export function dockerAvailable(): boolean {
  return hasCommand('docker', ['info']);
}

export function portInUse(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const sock = createConnection({ port, host });
    sock.once('connect', () => {
      sock.destroy();
      resolvePromise(true);
    });
    sock.once('error', () => resolvePromise(false));
    sock.setTimeout(500, () => {
      sock.destroy();
      resolvePromise(false);
    });
  });
}

export function isLocalDatabase(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return ['localhost', '127.0.0.1', '::1', 'postgres', 'host.docker.internal'].includes(host);
  } catch {
    return url.startsWith('memory://') || url.startsWith('pglite://');
  }
}

export function dbUrlForDisplay(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return url;
  }
}
