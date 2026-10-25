import { describe, expect, it } from 'vitest';
import { maskPhone, parsePhone } from './phone';

describe('Vietnamese phone parsing', () => {
  it.each([
    ['0912345678', '+84912345678', 'VinaPhone'],
    ['+84 912 345 678', '+84912345678', 'VinaPhone'],
    ['84912345678', '+84912345678', 'VinaPhone'],
    ['0084912345678', '+84912345678', 'VinaPhone'],
    ['(+84) 98-765-4321', '+84987654321', 'Viettel'],
    ['0987.654.321', '+84987654321', 'Viettel'],
    ['0321234567', '+84321234567', 'Viettel'],
    ['0901234567', '+84901234567', 'MobiFone'],
    ['0771234567', '+84771234567', 'MobiFone'],
    ['0881234567', '+84881234567', 'VinaPhone'],
    ['0921234567', '+84921234567', 'Vietnamobile'],
    ['0581234567', '+84581234567', 'Vietnamobile'],
    ['0991234567', '+84991234567', 'Gmobile'],
    ['0871234567', '+84871234567', 'Itel'],
    ['0551234567', '+84551234567', 'Reddi (Wintel)'],
  ])('%s → %s (%s)', (raw, e164, carrier) => {
    const p = parsePhone(raw)!;
    expect(p.e164).toBe(e164);
    expect(p.type).toBe('mobile');
    expect(p.carrier).toBe(carrier);
    expect(p.national).toBe(`0${e164.slice(3)}`);
  });

  it('detects landlines with area codes', () => {
    expect(parsePhone('024 3825 1234')).toMatchObject({
      type: 'landline',
      area: 'Hà Nội',
      e164: '+842438251234',
    });
    expect(parsePhone('028.3829.1234')).toMatchObject({ type: 'landline', area: 'TP. Hồ Chí Minh' });
    expect(parsePhone('0236 3821 234')).toMatchObject({ type: 'landline', area: 'Đà Nẵng' });
    expect(parsePhone('+84 292 3821 234')).toMatchObject({ type: 'landline', area: 'Cần Thơ' });
  });

  it('handles service numbers, short codes and foreign numbers', () => {
    expect(parsePhone('1900 545 413')).toMatchObject({ type: 'premium', e164: '1900545413' });
    expect(parsePhone('1800 588 822')).toMatchObject({ type: 'toll_free' });
    expect(parsePhone('113')).toMatchObject({ type: 'short_code', area: 'Công an (khẩn cấp)' });
    expect(parsePhone('+855 12 345 678')).toMatchObject({
      type: 'foreign',
      country: '855',
      countryName: 'Campuchia',
    });
    expect(parsePhone('+1 202 555 0143')).toMatchObject({ type: 'foreign', country: '1' });
  });

  it('rejects invalid numbers', () => {
    for (const bad of ['0112345678', '091234567', '09123456789', 'abc', '', '0201234567', '+84 12'])
      expect(parsePhone(bad), bad).toBeNull();
  });

  it('masks for display', () => {
    expect(maskPhone('0912345678')).toBe('0912***678');
  });
});
