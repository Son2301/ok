import { describe, expect, it } from 'vitest';
import { isNegated, normalizeForMatch, originalSpan, phrase, stripDiacritics } from '../lib/vn-text';
import { extractEntities } from '../text/entities';
import { combineSignals } from '../verdict/scoring';
import { runRules } from './engine';
import { SCAM_RULES } from './patterns';
import { BENIGN_SAMPLES, SCAM_SAMPLES } from './samples.fixture';

function analyze(text: string) {
  const e = extractEntities(text);
  const ctx = {
    hasUrl: e.urls.length > 0,
    hasMobile: e.phones.some((p) => p.type === 'mobile' || p.type === 'foreign'),
    hasBank: e.bankAccounts.length > 0,
  };
  const r = runRules(text, ctx);
  return { r, ids: r.hits.map((h) => h.rule.id), score: combineSignals(r.signals).score };
}

describe('Vietnamese normalization', () => {
  it('folds diacritics, đ, teencode, leetspeak and split letters', () => {
    expect(stripDiacritics('Đường dây nóng Công an')).toBe('Duong day nong Cong an');
    expect(normalizeForMatch('a ơi ck vào stk này nhé, ko đc nói j').text).toBe(
      'a oi chuyen khoan vao so tai khoan nay nhe khong duoc noi gi',
    );
    expect(normalizeForMatch('nh4n qu4 t4i link, mã 0TP').text).toBe('nhan qua tai link ma otp');
    expect(normalizeForMatch('T.R.Ú.N.G T.H.Ư.Ở.N.G').text).toBe('trung thuong');
    expect(normalizeForMatch('500k/ngày 30tr iphone15').text).toBe('500k ngay 30tr iphone15');
  });

  it('maps matches back to the original words', () => {
    const n = normalizeForMatch('Bạn đã T.R.Ú.N.G T.H.Ư.Ở.N.G rồi!');
    const m = phrase('trung thuong').exec(n.text)!;
    expect(originalSpan(n, m.index, m.index + m[0].length)).toBe('T.R.Ú.N.G T.H.Ư.Ở.N.G');
  });

  it('detects negation before a phrase', () => {
    const t = normalizeForMatch('Tuyệt đối không cung cấp mã OTP cho ai').text;
    expect(isNegated(t, t.indexOf('cung cap'))).toBe(true);
    const s = normalizeForMatch('Anh cung cấp mã OTP giúp em').text;
    expect(isNegated(s, s.indexOf('cung cap'))).toBe(false);
  });
});

describe('scam rule engine', () => {
  it('has a broad catalogue with labels, goals and advice', () => {
    const scamRules = SCAM_RULES.filter((r) => !r.tactic);
    expect(scamRules.length).toBeGreaterThanOrEqual(20);
    for (const r of SCAM_RULES) {
      expect(r.label.vi.length, r.id).toBeGreaterThan(5);
      expect(r.label.en.length, r.id).toBeGreaterThan(5);
    }
    expect(SCAM_RULES.filter((r) => r.policeWarned).length).toBeGreaterThanOrEqual(10);
  });

  it(`detects ${SCAM_SAMPLES.length} realistic scam messages (with/without diacritics, teencode)`, () => {
    expect(SCAM_SAMPLES.length).toBeGreaterThanOrEqual(20);
    for (const s of SCAM_SAMPLES) {
      const { ids, score } = analyze(s.text);
      for (const id of s.expect)
        expect(ids, `${s.name}: expected rule ${id}, got ${ids.join(',')}`).toContain(id);
      if (s.minScore) expect(score, `${s.name}: score`).toBeGreaterThanOrEqual(s.minScore);
    }
  });

  it.each(SCAM_SAMPLES.map((s) => [s.name, s]))(
    'quotes evidence from the original message: %s',
    (_name, s) => {
      const { r } = analyze(s.text);
      const hit = r.hits.find((h) => h.rule.id === s.expect[0])!;
      expect(hit.evidence.length).toBeGreaterThan(0);
      for (const e of hit.evidence) expect(s.text.replace(/\s+/g, ' ')).toContain(e.replace(/…$/, ''));
    },
  );

  it(`keeps ${BENIGN_SAMPLES.length} benign messages low`, () => {
    expect(BENIGN_SAMPLES.length).toBeGreaterThanOrEqual(10);
    for (const t of BENIGN_SAMPLES) {
      const { score, ids } = analyze(t);
      expect(score, `${t} → ${ids.join(',')}`).toBeLessThan(25);
      expect(
        ids.filter((id) => !SCAM_RULES.find((r) => r.id === id)?.tactic),
        t,
      ).toEqual([]);
    }
  });

  it('adds the "authority asks for money" combination signal', () => {
    const { r } = analyze(
      'Công an phường triệu tập anh vì liên quan vụ án, yêu cầu chuyển tiền vào tài khoản tạm giữ.',
    );
    expect(r.signals.map((s) => s.id)).toContain('text.authority_payment');
    expect(r.policeWarned.length).toBeGreaterThan(0);
    expect(r.scammerGoal?.vi).toBeTruthy();
  });

  it('does not treat a legit OTP SMS as an OTP request (negation)', () => {
    const { ids } = analyze('Mã OTP của bạn là 123456. Tuyệt đối không cung cấp mã OTP cho bất kỳ ai.');
    expect(ids).not.toContain('otp_request');
  });
});

describe('entity extraction', () => {
  it('extracts URLs (scheme, www, bare, defanged) without email domains', () => {
    const e = extractEntities(
      'Vào https://vietcombank-xacthuc.com/a, www.evil.top hoặc vneid-capnhat[.]com/x. Email: hotro@gmail.com, tp.hcm 1.5tr',
    );
    expect(e.urls).toEqual([
      'https://vietcombank-xacthuc.com/a',
      'http://www.evil.top/',
      'http://vneid-capnhat.com/x',
    ]);
    expect(e.emails).toEqual(['hotro@gmail.com']);
  });

  it('extracts VN phones in +84/84/0 forms, 1900 numbers and foreign numbers', () => {
    const e = extractEntities(
      'Gọi 0912.345.678, +84 988 123 456, 84 32 123 4567, (024) 3825 1234, 1900 545413 hoặc +855 12 345 678',
    );
    expect(e.phones.map((p) => p.e164)).toEqual([
      '+84912345678',
      '+84988123456',
      '+84321234567',
      '+842438251234',
      '1900545413',
      '+85512345678',
    ]);
    expect(e.phones.map((p) => p.carrier ?? p.type)).toEqual([
      'VinaPhone',
      'Viettel',
      'Viettel',
      'landline',
      'premium',
      'foreign',
    ]);
  });

  it('extracts bank accounts with bank names and holder names, ignoring amounts and OTPs', () => {
    const e = extractEntities(
      'Chuyển 5.000.000đ vào STK 1903 4567 8901 23 Techcombank chủ TK TRẦN THỊ BÍCH. Hoặc Vietcombank 0011004123456 - NGUYEN VAN AN. Mã OTP 123456.',
    );
    expect(e.bankAccounts).toEqual([
      {
        accountNumber: '19034567890123',
        bankCode: 'TCB',
        bankName: 'Techcombank',
        accountName: 'TRẦN THỊ BÍCH',
      },
      {
        accountNumber: '0011004123456',
        bankCode: 'VCB',
        bankName: 'Vietcombank',
        accountName: 'NGUYEN VAN AN',
      },
    ]);
  });

  it('treats a phone number right next to a bank name as an account too (MB, TPBank allow it)', () => {
    const e = extractEntities('MB 0987654321 chủ tk LE VAN C');
    expect(e.phones.map((p) => p.e164)).toEqual(['+84987654321']);
    expect(e.bankAccounts[0]).toMatchObject({
      accountNumber: '0987654321',
      bankCode: 'MB',
      accountName: 'LE VAN C',
    });
  });

  it('does not invent accounts from dates, amounts or bare numbers', () => {
    const e = extractEntities('Hẹn 25/10/2025 lúc 10:30, giá 1.250.000 VND, mã đơn 12345678.');
    expect(e.bankAccounts).toEqual([]);
  });
});
