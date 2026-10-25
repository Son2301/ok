import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { type CliIo, parseArgs, runCli } from './cli';
import { PR_DIFF_A } from './test/fixtures';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'okreview-cli-'));
  dirs.push(d);
  return d;
};

function io(cwd: string, over: Partial<CliIo> = {}) {
  let stdout = '';
  let stderr = '';
  const value: CliIo = {
    cwd,
    env: {},
    stdout: (s) => {
      stdout += s;
    },
    stderr: (s) => {
      stderr += s;
    },
    readStdin: () => PR_DIFF_A,
    isTTY: false,
    ...over,
  };
  return { io: value, out: () => stdout, err: () => stderr };
}

describe('parseArgs', () => {
  it('parses flags, inline values and a leading -- from pnpm', () => {
    expect(
      parseArgs(['--', '--base', 'main', '--json', '--fail-on=high', '--mock', '--lang', 'vi']),
    ).toMatchObject({
      base: 'main',
      json: true,
      failOn: 'high',
      mock: true,
      lang: 'vi',
      head: 'HEAD',
    });
    expect(() => parseArgs(['--fail-on', 'extreme'])).toThrow(/fail-on/);
    expect(() => parseArgs(['--base'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--wat'])).toThrow(/Unknown option/);
  });
});

describe('runCli', () => {
  it('reviews a diff from stdin in mock mode, groups findings by file and honours --fail-on', async () => {
    const dir = tmp();
    const t = io(dir);
    expect(await runCli(['--diff', '-', '--mock', '--fail-on', 'high'], t.io)).toBe(1);
    const out = t.out();
    expect(out).toContain('okreview · two-pass review of stdin');
    expect(out).toMatch(
      /src\/db\/users\.ts\n\s+12\s+CRITICAL\s+security\s+SQL query built by string interpolation/,
    );
    expect(out).toContain('Failure:');
    expect(out).toContain('rejected by the Critic');
    expect(out).toContain('pnpm-lock.yaml (lockfile)');
    expect(out).not.toContain('\x1b['); // no colours when not a TTY

    const pass = io(dir);
    expect(await runCli(['--diff', '-', '--mock', '--fail-on', 'none'], pass.io)).toBe(0);
  });

  it('emits JSON', async () => {
    const t = io(tmp());
    expect(await runCli(['--diff', '-', '--mock', '--json'], t.io)).toBe(0);
    const data = JSON.parse(t.out());
    expect(
      data.findings.map((f: { path: string; line: number; severity: string }) => [
        f.path,
        f.line,
        f.severity,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ['src/db/users.ts', 12, 'critical'],
        ['src/util/log.ts', 4, 'medium'],
      ]),
    );
    expect(data.rejected).toHaveLength(1);
    expect(data.skipped).toEqual([{ path: 'pnpm-lock.yaml', reason: 'lockfile' }]);
  });

  it('reviews git diff <base>...HEAD in a real repository', async () => {
    const dir = tmp();
    const g = (...a: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], {
        cwd: dir,
        stdio: 'pipe',
      });
    g('init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'app.js'), 'export function f(a) {\n  return a;\n}\n');
    g('add', '.');
    g('commit', '-q', '-m', 'init');
    g('checkout', '-q', '-b', 'feature');
    writeFileSync(join(dir, 'app.js'), 'export function f(a) {\n  return eval(a);\n}\n');
    writeFileSync(join(dir, '.okreview.yml'), 'failOn: high\n');
    g('add', '.');
    g('commit', '-q', '-m', 'change');

    const t = io(dir, { env: { NO_COLOR: '1' } });
    const code = await runCli(['--mock', '--json'], t.io);
    const data = JSON.parse(t.out());
    expect(data.range).toBe('main...HEAD');
    expect(data.findings).toEqual([
      expect.objectContaining({
        path: 'app.js',
        line: 2,
        title: 'Dynamic code evaluation',
        severity: 'high',
      }),
    ]);
    expect(code).toBe(1); // failOn from .okreview.yml
  });

  it('explains missing credentials and bad bases', async () => {
    const t = io(tmp());
    expect(await runCli(['--diff', '-'], t.io)).toBe(2);
    expect(t.err()).toContain('OKREVIEW_API_KEY');
    const u = io(tmp());
    expect(await runCli(['--bogus'], u.io)).toBe(2);
    expect(u.err()).toContain('Usage: okreview');
  });
});
