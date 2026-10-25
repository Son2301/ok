import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeResolver, fakeTransport } from '../test/helpers';
import { classifyIp, isBlockedIp, parseIPv6 } from './ip';
import { nodeTransport } from './node-transport';
import { metaRefreshTarget, SafeFetcher } from './safe-fetch';

describe('IP classification', () => {
  it.each([
    '127.0.0.1',
    '127.1.2.3',
    '10.0.0.1',
    '172.16.5.4',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '100.100.100.200',
    '0.0.0.0',
    '192.0.0.192',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '203.0.113.5',
  ])('blocks private/reserved IPv4 %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each([
    '::',
    '::1',
    '[::1]',
    'fe80::1',
    'fe80::1%eth0',
    'fc00::1',
    'fd00:ec2::254',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:169.254.169.254',
    '64:ff9b::a9fe:a9fe',
    '64:ff9b::10.0.0.1',
    '2002:7f00:1::1',
    '2002:c0a8:101::1',
    '2001:db8::1',
    '2001::1',
    '::127.0.0.1',
    'fec0::1',
    '100::1',
    '3fff::1',
  ])('blocks internal/transition IPv6 %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34',
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808',
  ])('allows public %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });

  it('parses IPv6 forms and rejects garbage', () => {
    expect(parseIPv6('::ffff:192.168.0.1')).toEqual([0, 0, 0, 0, 0, 0xffff, 0xc0a8, 0x0001]);
    expect(parseIPv6('1:2:3:4:5:6:7:8')).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(parseIPv6('1::2::3')).toBeNull();
    expect(classifyIp('not-an-ip')).toMatchObject({ blocked: true, reason: 'unparseable' });
    expect(classifyIp('::ffff:127.0.0.1').reason).toContain('loopback');
  });
});

describe('SafeFetcher (fake network)', () => {
  const page = '<html><head><title>Hello</title></head><body>ok</body></html>';

  it('fetches a public page and pins the validated address', async () => {
    const t = fakeTransport({ 'https://example.com/': { body: page } });
    const f = new SafeFetcher(t, fakeResolver({ 'example.com': ['93.184.216.34'] }));
    const res = await f.fetch('https://example.com/');
    expect(res.ok).toBe(true);
    expect(t.hops[0]!.address).toBe('93.184.216.34');
    expect(t.hops[0]!.headers.cookie).toBeUndefined();
  });

  it.each([
    'http://127.0.0.1/',
    'http://[::1]/',
    'http://2130706433/',
    'http://0x7f000001/',
    'http://0177.0.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::ffff:169.254.169.254]/',
    'http://[fd00:ec2::254]/',
  ])('blocks literal internal address %s before any connection', async (url) => {
    const t = fakeTransport({});
    const f = new SafeFetcher(t, fakeResolver({}));
    const res = await f.fetch(url);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('blocked_ip');
    expect(t.hops).toHaveLength(0);
  });

  it('blocks hostnames that resolve to private addresses (v4 and v6) and mixed answers', async () => {
    const t = fakeTransport({});
    const resolver = fakeResolver({
      'evil.test': ['10.0.0.5'],
      'evil6.test': ['fe80::1'],
      'mixed.test': ['93.184.216.34', '127.0.0.1'],
    });
    const f = new SafeFetcher(t, resolver);
    for (const host of ['evil.test', 'evil6.test', 'mixed.test']) {
      const res = await f.fetch(`http://${host}/`);
      expect(res.error?.code, host).toBe('blocked_ip');
    }
    expect(t.hops).toHaveLength(0);
  });

  it('blocks internal-looking hostnames, bad schemes and ports', async () => {
    const f = new SafeFetcher(fakeTransport({}), fakeResolver({}));
    expect((await f.fetch('http://localhost/')).error?.code).toBe('blocked_host');
    expect((await f.fetch('http://metadata.google.internal/')).error?.code).toBe('blocked_host');
    expect((await f.fetch('http://intranet/')).error?.code).toBe('blocked_host');
    expect((await f.fetch('ftp://example.com/')).error?.code).toBe('blocked_scheme');
    expect((await f.fetch('http://example.com:22/')).error?.code).toBe('blocked_port');
  });

  it('re-validates every redirect hop: redirect to a private IP is blocked', async () => {
    const t = fakeTransport({
      'https://short.test/abc': { status: 302, headers: { location: 'http://127.0.0.1:8080/admin' } },
    });
    const f = new SafeFetcher(t, fakeResolver({ 'short.test': ['93.184.216.34'] }));
    const res = await f.fetch('https://short.test/abc');
    expect(res.error?.code).toBe('blocked_ip');
    expect(t.hops).toHaveLength(1);
    expect(res.chain.map((h) => h.url)).toEqual(['https://short.test/abc', 'http://127.0.0.1:8080/admin']);
  });

  it('blocks a redirect to a hostname that resolves internally, and to file://', async () => {
    const t = fakeTransport({
      'https://a.test/': { status: 301, headers: { location: 'https://internal.test/secret' } },
      'https://b.test/': { status: 302, headers: { location: 'file:///etc/passwd' } },
    });
    const f = new SafeFetcher(
      t,
      fakeResolver({
        'a.test': ['93.184.216.34'],
        'b.test': ['93.184.216.34'],
        'internal.test': ['192.168.0.10'],
      }),
    );
    expect((await f.fetch('https://a.test/')).error?.code).toBe('blocked_ip');
    expect((await f.fetch('https://b.test/')).error?.code).toBe('blocked_scheme');
  });

  it('defeats DNS rebinding between hops: each hop is resolved again and pinned', async () => {
    let calls = 0;
    const resolver = fakeResolver({
      'rebind.test': () => (++calls === 1 ? ['93.184.216.34'] : ['127.0.0.1']),
    });
    const t = fakeTransport({
      'http://rebind.test/': { status: 302, headers: { location: 'http://rebind.test/next' } },
    });
    const f = new SafeFetcher(t, resolver);
    const res = await f.fetch('http://rebind.test/');
    expect(res.error?.code).toBe('blocked_ip');
    expect(resolver.lookups).toEqual(['rebind.test', 'rebind.test']);
    // The only connection made went to the address that was validated, never to the rebound one.
    expect(t.hops.map((h) => h.address)).toEqual(['93.184.216.34']);
  });

  it('stops after max redirects', async () => {
    const routes: Record<string, { status: number; headers: Record<string, string> }> = {};
    for (let i = 0; i < 8; i++)
      routes[`https://loop.test/${i}`] = { status: 302, headers: { location: `/${i + 1}` } };
    const f = new SafeFetcher(fakeTransport(routes), fakeResolver({ 'loop.test': ['93.184.216.34'] }));
    const res = await f.fetch('https://loop.test/0', { maxRedirects: 5 });
    expect(res.error?.code).toBe('too_many_redirects');
    expect(res.chain).toHaveLength(6);
  });

  it('follows meta refresh as a hop and caps the body', async () => {
    const big = 'x'.repeat(600 * 1024);
    const t = fakeTransport({
      'https://s.test/': { body: '<meta http-equiv="refresh" content="0; url=https://land.test/page">' },
      'https://land.test/page': { body: big },
    });
    const f = new SafeFetcher(
      t,
      fakeResolver({ 's.test': ['93.184.216.34'], 'land.test': ['93.184.216.35'] }),
    );
    const res = await f.fetch('https://s.test/', { maxBytes: 512 * 1024 });
    expect(res.finalUrl).toBe('https://land.test/page');
    expect(res.chain[0]!.next).toBe('meta-refresh');
    expect(res.body!.byteLength).toBe(512 * 1024);
    expect(res.truncated).toBe(true);
  });

  it('times out a hanging server', async () => {
    const f = new SafeFetcher(
      fakeTransport({ 'https://slow.test/': { hang: true } }),
      fakeResolver({ 'slow.test': ['93.184.216.34'] }),
    );
    const started = Date.now();
    const res = await f.fetch('https://slow.test/', { timeoutMs: 150 });
    expect(res.error?.code).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('strips credentials and fragments', async () => {
    const t = fakeTransport({ 'https://example.com/x': { body: 'ok' } });
    const f = new SafeFetcher(t, fakeResolver({ 'example.com': ['93.184.216.34'] }));
    const res = await f.fetch('https://user:pass@example.com/x#frag');
    expect(res.ok).toBe(true);
    expect(t.hops[0]!.url.href).toBe('https://example.com/x');
  });

  it('extracts meta refresh targets', () => {
    expect(
      metaRefreshTarget(new TextEncoder().encode('<META HTTP-EQUIV=Refresh CONTENT="2;URL=\'/next\'">')),
    ).toBe('/next');
    expect(
      metaRefreshTarget(new TextEncoder().encode('<meta http-equiv="refresh" content="60">')),
    ).toBeNull();
  });
});

describe('nodeTransport against a local server (loopback explicitly allowed for this test only)', () => {
  let server: http.Server;
  let port = 0;
  const seen: { host?: string; cookie?: string; path?: string }[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push({ host: req.headers.host, cookie: req.headers.cookie, path: req.url });
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/landing', 'set-cookie': 'session=abc' });
        res.end();
        return;
      }
      if (req.url === '/big') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('y'.repeat(100_000));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<title>Landing</title>');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('connects to the pinned address with the original Host header, never sends cookies, caps bodies', async () => {
    const resolver = fakeResolver({ 'public.test': ['127.0.0.1'] });
    const f = new SafeFetcher(nodeTransport, resolver, {
      allowedPorts: [port],
      isAllowedAddress: (ip) => ip === '127.0.0.1',
    });
    const res = await f.fetch(`http://public.test:${port}/redirect`);
    expect(res.ok).toBe(true);
    expect(new TextDecoder().decode(res.body)).toContain('Landing');
    expect(seen.map((s) => s.host)).toEqual([`public.test:${port}`, `public.test:${port}`]);
    expect(seen.every((s) => s.cookie === undefined)).toBe(true);
    expect(res.headers?.['set-cookie']).toBeUndefined();

    const big = await f.fetch(`http://public.test:${port}/big`, { maxBytes: 1000 });
    expect(big.body!.byteLength).toBe(1000);
    expect(big.truncated).toBe(true);
  });

  it('the default policy refuses the same loopback server', async () => {
    const f = new SafeFetcher(nodeTransport, fakeResolver({ 'public.test': ['127.0.0.1'] }), {
      allowedPorts: [port],
    });
    const res = await f.fetch(`http://public.test:${port}/`);
    expect(res.error?.code).toBe('blocked_ip');
  });
});
