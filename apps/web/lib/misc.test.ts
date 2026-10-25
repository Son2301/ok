import { describe, expect, it } from 'vitest';
import { getDictionary } from './i18n';
import { describeEntry, entrySourceHref, type LedgerEntry } from './ledger';
import { safeNext } from './safe-next';
import { createSseParser, type SseEvent } from './sse';
import { riskTone } from './status';
import { parseVietQrUrl } from './vietqr';

describe('safeNext', () => {
  it('allows same-site paths only', () => {
    expect(safeNext('/console/billing?x=1')).toBe('/console/billing?x=1');
    expect(safeNext('https://evil.example')).toBe('/console');
    expect(safeNext('//evil.example/x')).toBe('/console');
    expect(safeNext('/\\evil.example')).toBe('/console');
    expect(safeNext('/login?next=/x')).toBe('/console');
    expect(safeNext(undefined, '/x')).toBe('/x');
    expect(safeNext('/ok\r\nSet-Cookie: a=b')).toBe('/console');
  });
});

describe('createSseParser', () => {
  const collect = (chunks: string[]) => {
    const events: SseEvent[] = [];
    const p = createSseParser((e) => events.push(e));
    for (const c of chunks) p.push(c);
    p.end();
    return events;
  };

  it('parses data-only OpenAI-style streams split across chunks', () => {
    const events = collect(['data: {"a":', '1}\n\nda', 'ta: [DONE]\n\n']);
    expect(events).toEqual([
      { event: 'message', data: '{"a":1}' },
      { event: 'message', data: '[DONE]' },
    ]);
  });

  it('parses named events, comments, CRLF and multi-line data', () => {
    const events = collect([
      ': keep-alive\r\n\r\nevent: delta\r\ndata: {"text":"Xin"}\r\n\r\n',
      'event: done\ndata: line1\ndata: line2\n\n',
    ]);
    expect(events).toEqual([
      { event: 'delta', data: '{"text":"Xin"}' },
      { event: 'done', data: 'line1\nline2' },
    ]);
  });

  it('flushes a trailing event without a blank line', () => {
    expect(collect(['data: tail'])).toEqual([{ event: 'message', data: 'tail' }]);
  });
});

describe('parseVietQrUrl', () => {
  it('reads bank, account and holder back from the quick-link image URL', () => {
    const url =
      'https://img.vietqr.io/image/970436-1234567890-compact2.png?amount=200000&addInfo=OKA7F3K2QX&accountName=CONG+TY+OK+AI';
    expect(parseVietQrUrl(url)).toEqual({
      bankId: '970436',
      bankName: 'Vietcombank',
      accountNo: '1234567890',
      accountName: 'CONG TY OK AI',
      amount: 200000,
      addInfo: 'OKA7F3K2QX',
    });
  });

  it('handles short bank names and junk', () => {
    expect(
      parseVietQrUrl('https://img.vietqr.io/image/vietcombank-0011004123456-compact2.png')?.bankName,
    ).toBe('Vietcombank');
    expect(parseVietQrUrl(null)).toBeNull();
    expect(parseVietQrUrl('not a url')).toBeNull();
  });
});

describe('ledger', () => {
  const t = getDictionary('vi');
  const base: LedgerEntry = {
    id: 'wle_1',
    amountMicros: -717,
    balanceAfterMicros: 1000,
    kind: 'usage',
    product: 'gateway',
    apiKeyId: null,
    ref: 'gen_abc',
    description: 'openai/gpt-5-mini via azure',
    meta: { model: 'openai/gpt-5-mini', provider: 'azure' },
    createdAt: '2026-10-25T10:00:00Z',
  };

  it('describes entries in the viewer’s language', () => {
    expect(describeEntry(base, t)).toBe('openai/gpt-5-mini · azure');
    expect(
      describeEntry({ ...base, kind: 'grant', description: 'Welcome credit', meta: null, product: null }, t),
    ).toBe('Tiền tặng khi tạo tài khoản');
    expect(describeEntry({ ...base, kind: 'topup', meta: { amount_vnd: 200000 }, product: null }, t)).toBe(
      'Nạp tiền · VietQR',
    );
    expect(describeEntry({ ...base, meta: null, description: null, product: 'safe' }, t)).toBe(
      'Sử dụng Safe',
    );
  });

  it('links each entry to the receipt of what caused it', () => {
    expect(entrySourceHref(base)).toBe('/console/gateway/requests/gen_abc');
    expect(entrySourceHref({ ...base, ref: 'chk_1' })).toBe('/console/safe/checks/chk_1');
    expect(entrySourceHref({ ...base, ref: 'agent:agt_9:2026-10-25' })).toBe('/console/agents/agt_9');
    expect(entrySourceHref({ ...base, ref: 'top_1' })).toBeNull();
  });
});

describe('riskTone', () => {
  it('never paints a low score green', () => {
    expect(riskTone('low')).toBe('info');
    expect(riskTone('safe')).toBe('info');
    expect(riskTone('critical')).toBe('danger');
    expect(riskTone('unknown')).toBe('neutral');
  });
});
