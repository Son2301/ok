import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { maskRecord, maskSecret, parseKey, SecretBox } from './crypto';
import {
  chunkText,
  csvToText,
  detectKind,
  estimateTokens,
  extractText,
  htmlToText,
  normalizeVi,
  parseCsv,
} from './text';
import { daysInMonth, describeLocalTime, localDay, localMonth, ManualClock } from './time';

describe('SecretBox (AES-256-GCM)', () => {
  const key = randomBytes(32);
  const box = new SecretBox([key]);

  it('round-trips and binds ciphertexts to their AAD', () => {
    const payload = box.encryptJson(
      { botToken: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef' },
      'org_1:agt_1:telegram',
    );
    expect(payload.startsWith('v1.')).toBe(true);
    expect(payload).not.toContain('ABCDEFGHIJ');
    expect(box.decryptJson(payload, 'org_1:agt_1:telegram')).toEqual({
      botToken: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef',
    });
    // Same plaintext encrypts differently each time (random IV).
    expect(box.encrypt('x', 'a')).not.toBe(box.encrypt('x', 'a'));
    // Copying a row onto another agent fails.
    expect(() => box.decrypt(payload, 'org_1:agt_2:telegram')).toThrow();
  });

  it('detects tampering', () => {
    const payload = box.encrypt('secret value', 'aad');
    const parts = payload.split('.');
    const ct = Buffer.from(parts[4]!, 'base64url');
    ct[0] = ct[0]! ^ 0xff;
    parts[4] = ct.toString('base64url');
    expect(() => box.decrypt(parts.join('.'), 'aad')).toThrow();
  });

  it('supports key rotation (previous key still decrypts)', () => {
    const oldBox = new SecretBox([key]);
    const stored = oldBox.encrypt('rotating', 'aad');
    const rotated = new SecretBox([randomBytes(32), key]);
    expect(rotated.decrypt(stored, 'aad')).toBe('rotating');
    expect(rotated.encrypt('new', 'aad').split('.')[1]).toBe(rotated.keyId);
    expect(() => new SecretBox([randomBytes(32)]).decrypt(stored, 'aad')).toThrow(/unknown key/);
  });

  it('parses base64/hex keys and requires a key in production', () => {
    const k = randomBytes(32);
    expect(parseKey(k.toString('base64')).equals(k)).toBe(true);
    expect(parseKey(k.toString('hex')).equals(k)).toBe(true);
    expect(parseKey(k.toString('base64url')).equals(k)).toBe(true);
    expect(() => parseKey('too-short')).toThrow(/32 bytes/);
    expect(() => SecretBox.fromEnv({ production: true })).toThrow(/required in production/);
    expect(SecretBox.fromEnv({ production: false }).ephemeral).toBe(true);
  });

  it('masks secrets for display', () => {
    expect(maskSecret('shpat_1234567890abcdef')).toBe('••••cdef');
    expect(maskSecret('short')).toBe('••••');
    expect(maskRecord({ accessToken: 'abcdefghijklmnop', empty: '', refreshToken: 'xyz' })).toEqual({
      accessToken: '••••mnop',
      refreshToken: '••••',
    });
  });
});

describe('Vietnamese text handling', () => {
  it('strips diacritics including đ/Đ', () => {
    expect(normalizeVi('Chính sách Đổi trả hàng – Miễn phí')).toBe('chinh sach doi tra hang – mien phi');
    expect(normalizeVi('ĐƯỜNG Nguyễn Huệ')).toBe('duong nguyen hue');
  });

  it('estimates more tokens for diacritic-heavy text', () => {
    expect(estimateTokens('abcd'.repeat(100))).toBe(100);
    expect(estimateTokens('đổi trả')).toBeGreaterThan(estimateTokens('doi tra'));
  });
});

describe('chunkText', () => {
  it('returns one chunk for short text and nothing for empty text', () => {
    expect(chunkText('Xin chào')).toEqual([{ ordinal: 0, content: 'Xin chào', tokens: 3 }]);
    expect(chunkText('   \n\n  ')).toEqual([]);
  });

  it('splits long documents into ~maxTokens chunks with overlap and carries headings', () => {
    const para = (i: number) =>
      `Đoạn ${i}: ${'Sản phẩm áo thun cotton được bán với giá tốt, giao hàng toàn quốc. '.repeat(6)}`;
    const text = `# Chính sách bán hàng\n\n${Array.from({ length: 30 }, (_, i) => para(i)).join('\n\n')}`;
    const chunks = chunkText(text, { maxTokens: 800, overlapTokens: 100 });
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.tokens).toBeLessThanOrEqual(800 + 20);
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));
    // Every chunk keeps the section heading for context.
    for (const c of chunks) expect(c.content.startsWith('# Chính sách bán hàng')).toBe(true);
    // Overlap: the end of chunk N reappears at the start of chunk N+1.
    const tail = chunks[0]!.content.slice(-60);
    expect(chunks[1]!.content).toContain(tail.slice(tail.indexOf(' ') + 1));
  });

  it('hard-splits a single huge paragraph', () => {
    const chunks = chunkText('từ '.repeat(5000), { maxTokens: 200, overlapTokens: 20 });
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) expect(c.tokens).toBeLessThanOrEqual(220);
  });
});

describe('plain-text extraction', () => {
  it('extracts text from HTML without scripts/styles and decodes entities', () => {
    const html = `<html><head><title>x</title><style>p{color:red}</style></head><body><h1>Giờ mở cửa</h1><p>Thứ 2&nbsp;&ndash; Thứ 7: 8h&#8211;21h &amp; CN nghỉ</p><script>alert(1)</script><ul><li>Chi nhánh Q1</li><li>Chi nhánh Q3</li></ul></body></html>`;
    const text = htmlToText(html);
    expect(text).toContain('Giờ mở cửa');
    expect(text).toContain('8h–21h & CN nghỉ');
    expect(text).toContain('- Chi nhánh Q1');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('color:red');
  });

  it('parses CSV with quotes and turns rows into searchable lines', () => {
    const csv = 'Mã,Tên sản phẩm,Giá\nAO-M,"Áo thun, size M",150000\nQUAN,"Quần ""jean""",350000\n';
    expect(parseCsv(csv)).toEqual([
      ['Mã', 'Tên sản phẩm', 'Giá'],
      ['AO-M', 'Áo thun, size M', '150000'],
      ['QUAN', 'Quần "jean"', '350000'],
    ]);
    expect(csvToText(csv)).toBe(
      'Mã: AO-M; Tên sản phẩm: Áo thun, size M; Giá: 150000\nMã: QUAN; Tên sản phẩm: Quần "jean"; Giá: 350000',
    );
    expect(parseCsv('a;b\n1;2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('detects supported kinds', () => {
    expect(detectKind('faq.md')).toBe('markdown');
    expect(detectKind('gia.csv')).toBe('csv');
    expect(detectKind('page.HTML')).toBe('html');
    expect(detectKind('notes.txt')).toBe('text');
    expect(detectKind(null, 'text/plain; charset=utf-8')).toBe('text');
    expect(detectKind('report.pdf')).toBeNull();
    expect(extractText('﻿hello', 'text')).toBe('hello');
  });
});

describe('time helpers (Asia/Ho_Chi_Minh)', () => {
  it('computes local day/month across the UTC date line', () => {
    const d = new Date('2026-10-31T18:30:00Z'); // 01:30 on Nov 1 in Vietnam
    expect(localDay(d, 'Asia/Ho_Chi_Minh')).toBe('2026-11-01');
    expect(localMonth(d, 'Asia/Ho_Chi_Minh')).toBe('2026-11');
    expect(describeLocalTime(d, 'Asia/Ho_Chi_Minh')).toBe(
      'Sunday, 2026-11-01 01:30 (Asia/Ho_Chi_Minh, UTC+07:00)',
    );
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29);
    const clock = new ManualClock('2026-01-01T00:00:00Z');
    clock.advance(86_400_000);
    expect(clock.now().toISOString()).toBe('2026-01-02T00:00:00.000Z');
  });
});
