import { describe, expect, it } from 'vitest';
import { detectInput, findBank, normalizePhone, normalizeUrl } from './detect';

describe('detectInput', () => {
  it('treats empty input as empty', () => {
    expect(detectInput('   ').kind).toBe('empty');
  });

  it.each([
    ['https://vcb-digibank.top/login', 'https://vcb-digibank.top/login'],
    ['vcb-digibank.top/login', 'https://vcb-digibank.top/login'],
    ['www.shopee-sale.xyz', 'https://www.shopee-sale.xyz/'],
    ['bit.ly/3abcDEF', 'https://bit.ly/3abcDEF'],
  ])('detects the link %s', (input, value) => {
    const d = detectInput(input);
    expect(d.kind).toBe('url');
    expect(d.value).toBe(value);
  });

  it.each([
    ['0912345678', '0912345678'],
    ['0912 345 678', '0912345678'],
    ['+84 912 345 678', '0912345678'],
    ['84912345678', '0912345678'],
    ['SĐT: 0899.123.456', '0899123456'],
    ['1900 1234', '19001234'],
    ['024 3825 1234', '02438251234'],
  ])('detects the phone number %s', (input, value) => {
    const d = detectInput(input);
    expect(d.kind).toBe('phone');
    expect(d.value).toBe(value);
  });

  it('offers "bank account" as an alternative for phone-shaped numbers (MoMo / alias accounts)', () => {
    expect(detectInput('0912345678').alternatives).toContain('bank_account');
  });

  it.each([
    ['0011004123456', '0011004123456', undefined],
    ['STK 0011004123456 Vietcombank', '0011004123456', 'VCB'],
    ['1903 4567 8901 23 - Techcombank', '19034567890123', 'TCB'],
    ['0912345678 MB', '0912345678', 'MB'],
    ['STK: 0011004123456 - NGUYEN VAN A - VCB', '0011004123456', 'VCB'],
  ])('detects the bank account %s', (input, value, bank) => {
    const d = detectInput(input);
    expect(d.kind).toBe('bank_account');
    expect(d.value).toBe(value);
    expect(d.bank?.code).toBe(bank);
  });

  it('detects emails', () => {
    const d = detectInput('Vietcombank.HoTro@gmail.com');
    expect(d.kind).toBe('email');
    expect(d.value).toBe('vietcombank.hotro@gmail.com');
  });

  it('treats real messages as text, even when they contain links and accounts', () => {
    const msg =
      'Đây là Công an quận 1, anh liên quan vụ án rửa tiền, chuyển tiền vào tài khoản tạm giữ STK 0011004123456 Vietcombank';
    const d = detectInput(msg);
    expect(d.kind).toBe('text');
    expect(d.value).toBe(msg);
    expect(d.bank?.name).toBe('Vietcombank');
    expect(detectInput('Bạn đã trúng thưởng, nhận quà tại https://qua-tang.top ngay').kind).toBe('text');
  });

  it('does not mistake version numbers or decimals for links', () => {
    expect(detectInput('1.2.3').kind).not.toBe('url');
    expect(normalizeUrl('3.14')).toBeNull();
  });
});

describe('helpers', () => {
  it('normalises Vietnamese phone numbers only', () => {
    expect(normalizePhone('+84 98 765 4321')).toBe('0987654321');
    expect(normalizePhone('0123456789')).toBeNull(); // old 11-digit prefixes are gone; 01x is not mobile
    expect(normalizePhone('12345')).toBeNull();
    expect(normalizePhone('+1 415 555 0100')).toBeNull();
  });

  it('finds banks by short code or name as whole words', () => {
    expect(findBank('chuyển vào vietcombank nhé')?.code).toBe('VCB');
    expect(findBank('TK MB Bank')?.code).toBe('MB');
    expect(findBank('tôi dùng 100mb data')).toBeUndefined();
  });

  it('normalises links', () => {
    expect(normalizeUrl('HTTP://Example.COM/a')).toBe('http://example.com/a');
    expect(normalizeUrl('not a link')).toBeNull();
    expect(normalizeUrl('localhost')).toBeNull();
  });
});
