/**
 * Run the whole platform locally with hot reload:
 *   pnpm dev                      # all five apps
 *   pnpm dev --only gateway,web   # a subset
 *   pnpm dev --raw                # raw JSON logs instead of pretty lines
 * First run on a fresh checkout does `pnpm dev:setup` automatically.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { ensureDatabase } from './db';
import {
  APPS,
  type AppName,
  CREDENTIALS_FILE,
  c,
  ENV_FILE,
  ensureEnvFile,
  loadEnv,
  log,
  PORTS,
  portInUse,
  ROOT,
} from './lib';
import { readCredentials, seedDev } from './seed';

const argv = process.argv.slice(2);
const onlyArg =
  argv.find((a) => a.startsWith('--only='))?.slice(7) ??
  (argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : undefined);
const raw = argv.includes('--raw');
const selected: AppName[] = onlyArg
  ? onlyArg
      .split(',')
      .map((s) => s.trim())
      .filter((s): s is AppName => (APPS as string[]).includes(s))
  : [...APPS];
if (!selected.length) {
  log.fail(`--only expects a comma list of: ${APPS.join(', ')}`);
  process.exit(1);
}

const COLORS: Record<AppName, (s: string) => string> = {
  gateway: c.cyan,
  agents: c.magenta,
  safe: c.green,
  review: c.yellow,
  web: c.blue,
};
const HEALTH: Record<AppName, string> = {
  gateway: `http://localhost:${PORTS.gateway}/health`,
  agents: `http://localhost:${PORTS.agents}/health`,
  safe: `http://localhost:${PORTS.safe}/health`,
  review: `http://localhost:${PORTS.review}/health`,
  web: `http://localhost:${PORTS.web}/`,
};

function appEnv(app: AppName, base: Record<string, string>): Record<string, string> {
  const gw = `http://localhost:${PORTS.gateway}`;
  const common = { ...base, PORT: String(PORTS[app]), FORCE_COLOR: '0' };
  switch (app) {
    case 'gateway':
      return common;
    case 'agents':
      return {
        ...common,
        GATEWAY_URL: `${gw}/v1`,
        PUBLIC_URL: `http://localhost:${PORTS.agents}`,
        CONTROL_PLANE_URL: `http://localhost:${PORTS.agents}`,
      };
    case 'safe':
      return { ...common, GATEWAY_URL: `${gw}/v1`, TRUST_PROXY: 'true' };
    case 'review':
      return { ...common, GATEWAY_URL: `${gw}/v1`, CONSOLE_URL: `http://localhost:${PORTS.web}` };
    case 'web':
      return {
        ...common,
        GATEWAY_URL: gw,
        AGENTS_URL: `http://localhost:${PORTS.agents}`,
        SAFE_URL: `http://localhost:${PORTS.safe}`,
        REVIEW_URL: `http://localhost:${PORTS.review}`,
        PUBLIC_API_URL: base.PUBLIC_API_URL ?? gw,
        PUBLIC_SAFE_URL: base.PUBLIC_SAFE_URL ?? `http://localhost:${PORTS.safe}`,
      };
  }
}

/** Turn the services' one-line JSON logs into `12:03:04 info  request GET /v1/models 200 3ms`. */
function prettify(line: string): string {
  if (raw || !line.startsWith('{')) return line;
  try {
    const j = JSON.parse(line) as Record<string, unknown>;
    if (typeof j.msg !== 'string') return line;
    const { t, lvl, service: _s, msg, ...rest } = j;
    const time = typeof t === 'string' ? t.slice(11, 19) : '';
    const level = String(lvl ?? 'info');
    const lv =
      level === 'error' ? c.red('error') : level === 'warn' ? c.yellow('warn ') : c.dim(level.padEnd(5));
    let detail: string;
    if (msg === 'request' && 'method' in rest) {
      const status = Number(rest.status);
      const st =
        status >= 500 ? c.red(String(status)) : status >= 400 ? c.yellow(String(status)) : String(status);
      detail = `${rest.method} ${rest.path} ${st} ${c.dim(`${rest.ms}ms`)}`;
    } else {
      const kv = Object.entries(rest)
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(' ');
      detail = `${msg}${kv ? ` ${c.dim(kv)}` : ''}`;
    }
    return `${c.dim(time)} ${lv} ${detail}`;
  } catch {
    return line;
  }
}

const children = new Map<AppName, ChildProcess>();
let shuttingDown = false;

function start(app: AppName, env: Record<string, string>) {
  const label = COLORS[app](app.padEnd(7));
  const child = spawn('pnpm', ['--filter', `@minh/${app}`, 'dev'], {
    cwd: ROOT,
    env: appEnv(app, env),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    shell: process.platform === 'win32',
  });
  children.set(app, child);
  const pipe = (stream: NodeJS.ReadableStream | null) => {
    let buf = '';
    stream?.setEncoding('utf8');
    stream?.on('data', (chunk: string) => {
      buf += chunk;
      let i = buf.indexOf('\n');
      while (i !== -1) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        const noise = /^> |^\s*$|^\S+ dev \/|ERR_PNPM_RECURSIVE/.test(line);
        const shutdownNoise = shuttingDown && /Command failed with signal|ELIFECYCLE|^\/\S+:$/.test(line);
        if (line.trim() && !noise && !shutdownNoise) process.stdout.write(`${label} ${prettify(line)}\n`);
        i = buf.indexOf('\n');
      }
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  child.on('exit', (code, signal) => {
    children.delete(app);
    if (!shuttingDown)
      log.fail(`${app} exited (${signal ?? `code ${code}`}). Fix the error above; other apps keep running.`);
  });
}

function stopAll(signal: NodeJS.Signals = 'SIGTERM') {
  for (const child of children.values()) {
    if (!child.pid) continue;
    try {
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
      else process.kill(-child.pid, signal);
    } catch {}
  }
}

async function waitHealthy(app: AppName, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!children.has(app)) return false;
    try {
      const res = await fetch(HEALTH[app], { signal: AbortSignal.timeout(2000) });
      if (res.status < 500) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function main() {
  const firstRun = !existsSync(ENV_FILE) || !existsSync(CREDENTIALS_FILE);
  if (ensureEnvFile().length) log.ok('Created .env with local defaults');
  const env = loadEnv();
  await ensureDatabase(env.DATABASE_URL);
  if (firstRun || !readCredentials()) {
    log.step('First run: seeding demo data…');
    await seedDev(env);
  }

  const busy = [];
  for (const app of selected) if (await portInUse(PORTS[app])) busy.push(`${app} (:${PORTS[app]})`);
  if (busy.length) {
    log.fail(`Port already in use: ${busy.join(', ')}. Stop the other process, or run a subset with --only.`);
    process.exit(1);
  }

  for (const app of selected) start(app, env);
  const onSignal = (sig: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${c.dim('Stopping…')}`);
    stopAll('SIGTERM');
    setTimeout(() => {
      stopAll('SIGKILL');
      process.exit(0);
    }, 5000).unref();
    const check = setInterval(() => {
      if (!children.size) {
        clearInterval(check);
        process.exit(sig === 'SIGINT' ? 0 : 0);
      }
    }, 100);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const results = await Promise.all(
    selected.map(async (app) => [app, await waitHealthy(app, app === 'web' ? 180_000 : 90_000)] as const),
  );
  if (shuttingDown) return;
  const creds = readCredentials();
  const row = (app: AppName, ok: boolean) =>
    `  ${ok ? c.green('✔ up  ') : c.red('✘ down')} ${COLORS[app](app.padEnd(8))} ${c.bold(app === 'web' ? `http://localhost:${PORTS.web}` : `http://localhost:${PORTS[app]}`)}`;
  console.log(`\n${c.bold('Minh AI is running')} ${c.dim('(Ctrl-C to stop)')}\n`);
  for (const [app, ok] of results) console.log(row(app, ok));
  if (creds) {
    console.log(`\n  Console login   ${c.bold(creds.email)} / ${c.bold(creds.password)}`);
    console.log(`  Demo API key    ${c.bold(creds.apiKey)}`);
    console.log(
      c.dim(
        `\n  curl localhost:${PORTS.gateway}/v1/chat/completions -H "authorization: Bearer ${creds.apiKey.slice(0, 14)}…" \\\n    -H 'content-type: application/json' -d '{"model":"auto","messages":[{"role":"user","content":"Xin chào"}]}'`,
      ),
    );
  }
  console.log(
    c.dim(
      `\n  Top-up test: create one in the console, then run ${c.bold('pnpm dev:pay')} to simulate the bank transfer.\n`,
    ),
  );
  if (results.some(([, ok]) => !ok)) log.warn('Some apps did not become healthy; check their logs above.');
}

main().catch((err) => {
  log.fail((err as Error).message);
  stopAll('SIGKILL');
  process.exit(1);
});
