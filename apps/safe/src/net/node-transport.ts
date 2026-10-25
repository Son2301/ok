import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { isIP } from 'node:net';
import type { TLSSocket } from 'node:tls';
import zlib from 'node:zlib';
import type { HopRequest, HopResponse, TlsInfo, Transport } from './safe-fetch';

/**
 * Real network transport. The socket connects to `req.address` (already validated by the
 * SafeFetcher) through a custom `lookup`, so Node never performs its own DNS query for the hop:
 * there is no window for DNS rebinding. TLS still verifies the certificate against the hostname
 * (SNI = hostname). No agent/keep-alive is reused and no cookies are sent.
 */
export const nodeTransport: Transport = (req: HopRequest) =>
  new Promise<HopResponse>((resolve, reject) => {
    const isHttps = req.url.protocol === 'https:';
    const hostname = req.url.hostname.replace(/^\[|\]$/g, '');
    const pinnedLookup: LookupFunction = (_host, options, callback) => {
      if (options?.all) {
        (callback as (err: null, addrs: { address: string; family: number }[]) => void)(null, [
          { address: req.address, family: req.family },
        ]);
      } else {
        (callback as (err: null, addr: string, family: number) => void)(null, req.address, req.family);
      }
    };
    const options: https.RequestOptions = {
      protocol: req.url.protocol,
      hostname,
      port: req.url.port || (isHttps ? 443 : 80),
      path: `${req.url.pathname}${req.url.search}`,
      method: 'GET',
      headers: req.headers,
      agent: false,
      lookup: pinnedLookup,
      signal: req.signal,
      ...(isHttps ? { servername: isIP(hostname) ? undefined : hostname, rejectUnauthorized: true } : {}),
    };
    const client = (isHttps ? https : http).request(options, (res) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) {
        if (v === undefined || k === 'set-cookie') continue;
        headers[k] = Array.isArray(v) ? v.join(', ') : v;
      }
      let tls: TlsInfo | undefined;
      if (isHttps) {
        try {
          const cert = (res.socket as TLSSocket).getPeerCertificate?.();
          if (cert && Object.keys(cert).length) {
            tls = {
              issuer: firstOf(cert.issuer?.O) ?? firstOf(cert.issuer?.CN),
              subject: firstOf(cert.subject?.CN),
              validFrom: cert.valid_from,
              validTo: cert.valid_to,
            };
          }
        } catch {
          // certificate details are best-effort
        }
      }
      const status = res.statusCode ?? 0;
      // Redirect bodies are irrelevant.
      if (status >= 300 && status < 400) {
        res.resume();
        resolve({ status, headers, body: new Uint8Array(), truncated: false, tls });
        return;
      }
      const encoding = (headers['content-encoding'] ?? '').toLowerCase();
      let stream: NodeJS.ReadableStream = res;
      if (encoding.includes('gzip')) stream = res.pipe(zlib.createGunzip());
      else if (encoding.includes('deflate')) stream = res.pipe(zlib.createInflate());
      else if (encoding.includes('br')) stream = res.pipe(zlib.createBrotliDecompress());
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve({ status, headers, body: new Uint8Array(Buffer.concat(chunks)), truncated, tls });
      };
      stream.on('data', (chunk: Buffer) => {
        if (done) return;
        const room = req.maxBytes - size;
        if (chunk.length >= room) {
          chunks.push(chunk.subarray(0, Math.max(0, room)));
          size += Math.max(0, room);
          truncated = chunk.length > room || truncated;
          finish();
          res.destroy();
          return;
        }
        chunks.push(chunk);
        size += chunk.length;
      });
      stream.on('end', finish);
      stream.on('error', (err) => {
        if (done) return;
        // Decompression errors after some data: keep what we have.
        if (size > 0) finish();
        else reject(err);
      });
    });
    client.on('error', reject);
    client.end();
  });

function firstOf(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
