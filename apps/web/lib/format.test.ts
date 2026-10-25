import { describe, expect, it } from 'vitest';
import {
  formatCompactVnd,
  formatDate,
  formatDateTime,
  formatDayKey,
  formatDuration,
  formatMicrosVnd,
  formatPricePerMillion,
  formatRelative,
  formatTokens,
  formatUsd,
  formatVnd,
  maskMiddle,
  microsToVnd,
  parseVndInput,
  vndToMicros,
} from './format';

describe('VND formatting', () => {
  it('formats whole đồng Vietnamese-style', () => {
    expect(formatVnd(200_000)).toBe('200.000đ');
    expect(formatVnd(1_234_567, 'vi')).toBe('1.234.567đ');
    expect(formatVnd(0)).toBe('0đ');
  });

  it('formats English with the ₫ prefix', () => {
    expect(formatVnd(200_000, 'en')).toBe('₫200,000');
  });

  it('keeps fractions for tiny per-request costs only when asked', () => {
    expect(formatVnd(0.156, 'vi', { precise: true })).toBe('0,16đ');
    expect(formatVnd(18.62, 'vi', { precise: true })).toBe('18,6đ');
    expect(formatVnd(1234.4, 'vi', { precise: true })).toBe('1.234đ');
    expect(formatVnd(0.156)).toBe('0đ');
    expect(formatVnd(0.0012, 'vi', { precise: true })).toBe('0,0012đ');
  });

  it('signs debits and (optionally) credits', () => {
    expect(formatVnd(-5000)).toBe('−5.000đ');
    expect(formatVnd(5000, 'vi', { signed: true })).toBe('+5.000đ');
    expect(formatVnd(-0.2)).toBe('0đ'); // rounds to zero: no "−0đ"
  });

  it('converts micro-USD at the wallet rate', () => {
    expect(microsToVnd(1_000_000, 26_000)).toBe(26_000);
    expect(formatMicrosVnd(7_692_307, 26_000)).toBe('200.000đ');
    expect(formatMicrosVnd(6, 26_000, 'vi', { precise: true })).toBe('0,16đ');
    expect(vndToMicros(200_000, 26_000)).toBe(7_692_307); // floor, same as core Billing
  });

  it('compacts preset amounts', () => {
    expect(formatCompactVnd(100_000)).toBe('100k');
    expect(formatCompactVnd(1_000_000)).toBe('1tr');
    expect(formatCompactVnd(2_500_000)).toBe('2,5tr');
    expect(formatCompactVnd(5_000_000, 'en')).toBe('5M');
    expect(formatCompactVnd(500_000, 'en')).toBe('500K');
  });
});

describe('parseVndInput', () => {
  it.each([
    ['200000', 200_000],
    ['200.000', 200_000],
    ['200,000', 200_000],
    ['200.000đ', 200_000],
    ['200k', 200_000],
    ['200K', 200_000],
    ['1tr', 1_000_000],
    ['1,5tr', 1_500_000],
    ['1.5 triệu', 1_500_000],
    ['2 triệu', 2_000_000],
    ['  300 nghìn ', 300_000],
    ['5M', 5_000_000],
    ['1.000.000 VND', 1_000_000],
  ])('%s → %d', (input, expected) => {
    expect(parseVndInput(input)).toBe(expected);
  });

  it.each(['', 'abc', '200,5', '1tr2', '-5000', '2 củ'])('rejects %j', (input) => {
    expect(parseVndInput(input)).toBeNull();
  });
});

describe('other formats', () => {
  it('formats USD with useful precision', () => {
    expect(formatUsd(2_500_000)).toBe('$2.50');
    expect(formatUsd(150)).toBe('$0.00015');
    expect(formatUsd(500_000)).toBe('$0.50');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(-1_000_000)).toBe('−$1.00');
  });

  it('formats model prices per 1M tokens in both currencies', () => {
    expect(formatPricePerMillion(0.1575, 26_000, 'vi')).toEqual({ usd: '$0.158', vnd: '4.095đ' });
    expect(formatPricePerMillion(2.5, 26_000, 'en')).toEqual({ usd: '$2.50', vnd: '₫65,000' });
  });

  it('formats tokens and durations', () => {
    expect(formatTokens(812)).toBe('812');
    expect(formatTokens(12_345)).toBe('12,3k');
    expect(formatTokens(3_000_000, 'en')).toBe('3M');
    expect(formatDuration(850)).toBe('850 ms');
    expect(formatDuration(2140)).toBe('2,1 s');
    expect(formatDuration(65_000)).toBe('1 phút 5 giây');
    expect(formatDuration(65_000, 'en')).toBe('1m 5s');
    expect(formatDuration(null)).toBe('—');
  });

  it('shows dates in Vietnam time regardless of the server time zone', () => {
    const d = new Date('2026-10-25T17:30:00Z'); // 00:30 on the 26th in Hà Nội
    expect(formatDate(d, 'vi')).toBe('26/10/2026');
    expect(formatDateTime(d, 'vi')).toBe('00:30 26/10/2026');
    expect(formatDayKey('2026-10-05', 'vi')).toBe('05/10');
    expect(formatDayKey('2026-10-05', 'en')).toBe('Oct 5');
  });

  it('formats relative times', () => {
    const now = Date.parse('2026-10-25T10:00:00Z');
    expect(formatRelative(now - 10_000, 'vi', now)).toBe('vừa xong');
    expect(formatRelative(now - 3 * 60_000, 'vi', now)).toBe('3 phút trước');
    expect(formatRelative(now - 2 * 3600_000, 'en', now)).toBe('2 hours ago');
  });

  it('masks identifiers', () => {
    expect(maskMiddle('0011004123456')).toBe('0011••••••56');
    expect(maskMiddle('abc')).toBe('abc');
  });
});
