/**
 * Vietnamese phone number parsing: +84 / 84 / 0084 / 0 forms, mobile carrier by prefix,
 * fixed-line area codes, 1800/1900 service numbers, short codes and foreign numbers.
 *
 * Carrier = the network that was originally assigned the prefix. Since 2018 subscribers can port
 * their number to another network, so the current carrier may differ.
 */

export type PhoneType = 'mobile' | 'landline' | 'toll_free' | 'premium' | 'short_code' | 'foreign';

export interface PhoneInfo {
  /** E.164, e.g. `+84912345678`. Short codes and 1800/1900 numbers keep their national form. */
  e164: string;
  /** National format for Vietnamese numbers, e.g. `0912345678`. */
  national?: string;
  country: string;
  countryName?: string;
  type: PhoneType;
  carrier?: string;
  area?: string;
}

const MOBILE_PREFIXES: Record<string, string> = {};
const add = (carrier: string, prefixes: string[]) => {
  for (const p of prefixes) MOBILE_PREFIXES[p] = carrier;
};
add('Viettel', ['032', '033', '034', '035', '036', '037', '038', '039', '086', '096', '097', '098']);
add('VinaPhone', ['081', '082', '083', '084', '085', '088', '091', '094']);
add('MobiFone', ['070', '076', '077', '078', '079', '089', '090', '093']);
add('Vietnamobile', ['052', '056', '058', '092']);
add('Gmobile', ['059', '099']);
add('Itel', ['087']);
add('Reddi (Wintel)', ['055']);

/** Fixed-line area codes (province names as before the July 2025 administrative merger). */
const AREA_CODES: Record<string, string> = {
  '024': 'Hà Nội',
  '028': 'TP. Hồ Chí Minh',
  '0203': 'Quảng Ninh',
  '0204': 'Bắc Giang',
  '0205': 'Lạng Sơn',
  '0206': 'Cao Bằng',
  '0207': 'Tuyên Quang',
  '0208': 'Thái Nguyên',
  '0209': 'Bắc Kạn',
  '0210': 'Phú Thọ',
  '0211': 'Vĩnh Phúc',
  '0212': 'Sơn La',
  '0213': 'Lai Châu',
  '0214': 'Lào Cai',
  '0215': 'Điện Biên',
  '0216': 'Yên Bái',
  '0218': 'Hòa Bình',
  '0219': 'Hà Giang',
  '0220': 'Hải Dương',
  '0221': 'Hưng Yên',
  '0222': 'Bắc Ninh',
  '0225': 'Hải Phòng',
  '0226': 'Hà Nam',
  '0227': 'Thái Bình',
  '0228': 'Nam Định',
  '0229': 'Ninh Bình',
  '0232': 'Quảng Bình',
  '0233': 'Quảng Trị',
  '0234': 'Thừa Thiên Huế',
  '0235': 'Quảng Nam',
  '0236': 'Đà Nẵng',
  '0237': 'Thanh Hóa',
  '0238': 'Nghệ An',
  '0239': 'Hà Tĩnh',
  '0251': 'Đồng Nai',
  '0252': 'Bình Thuận',
  '0254': 'Bà Rịa – Vũng Tàu',
  '0255': 'Quảng Ngãi',
  '0256': 'Bình Định',
  '0257': 'Phú Yên',
  '0258': 'Khánh Hòa',
  '0259': 'Ninh Thuận',
  '0260': 'Kon Tum',
  '0261': 'Đắk Nông',
  '0262': 'Đắk Lắk',
  '0263': 'Lâm Đồng',
  '0269': 'Gia Lai',
  '0270': 'Vĩnh Long',
  '0271': 'Bình Phước',
  '0272': 'Long An',
  '0273': 'Tiền Giang',
  '0274': 'Bình Dương',
  '0275': 'Bến Tre',
  '0276': 'Tây Ninh',
  '0277': 'Đồng Tháp',
  '0290': 'Cà Mau',
  '0291': 'Bạc Liêu',
  '0292': 'Cần Thơ',
  '0293': 'Hậu Giang',
  '0294': 'Trà Vinh',
  '0296': 'An Giang',
  '0297': 'Kiên Giang',
  '0299': 'Sóc Trăng',
};

/** Calling codes we name explicitly (longest match wins). */
const COUNTRY_CODES: Record<string, string> = {
  '1': 'Mỹ/Canada',
  '7': 'Nga',
  '33': 'Pháp',
  '44': 'Anh',
  '49': 'Đức',
  '60': 'Malaysia',
  '61': 'Úc',
  '62': 'Indonesia',
  '63': 'Philippines',
  '65': 'Singapore',
  '66': 'Thái Lan',
  '81': 'Nhật Bản',
  '82': 'Hàn Quốc',
  '86': 'Trung Quốc',
  '91': 'Ấn Độ',
  '95': 'Myanmar',
  '852': 'Hồng Kông',
  '853': 'Ma Cao',
  '855': 'Campuchia',
  '856': 'Lào',
  '886': 'Đài Loan',
  '971': 'UAE',
  '234': 'Nigeria',
  '232': 'Sierra Leone',
  '216': 'Tunisia',
  '243': 'CHDC Congo',
};

/** Countries where large scam compounds targeting Vietnamese victims have been reported. */
export const HIGH_RISK_CALLING_CODES = new Set(['855', '856', '95']);

export const KNOWN_SHORT_CODES: Record<string, string> = {
  '111': 'Tổng đài bảo vệ trẻ em',
  '112': 'Cứu nạn khẩn cấp',
  '113': 'Công an (khẩn cấp)',
  '114': 'Cứu hỏa, cứu nạn',
  '115': 'Cấp cứu y tế',
  '156': 'Tiếp nhận phản ánh cuộc gọi rác',
  '5656': 'Tiếp nhận phản ánh tin nhắn rác',
};

export function parsePhone(raw: string): PhoneInfo | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let s = trimmed.replace(/[\s.\-()/ ]/g, '');
  if (!/^\+?\d+$/.test(s)) return null;
  if (s.startsWith('00')) s = `+${s.slice(2)}`;

  // Short codes and service numbers.
  if (!s.startsWith('+')) {
    if (/^\d{3,5}$/.test(s))
      return { e164: s, national: s, country: 'VN', type: 'short_code', area: KNOWN_SHORT_CODES[s] };
    if (/^1800\d{4}(\d{2})?$/.test(s)) return { e164: s, national: s, country: 'VN', type: 'toll_free' };
    if (/^1900\d{4}(\d{2})?$/.test(s)) return { e164: s, national: s, country: 'VN', type: 'premium' };
  }

  let national: string | null = null;
  if (s.startsWith('+84')) national = `0${s.slice(3)}`;
  else if (s.startsWith('+')) {
    const digits = s.slice(1);
    if (digits.length < 7 || digits.length > 15) return null;
    const cc = ['', '', ''].map((_, i) => digits.slice(0, 3 - i)).find((c) => COUNTRY_CODES[c]);
    return {
      e164: `+${digits}`,
      country: cc ?? digits.slice(0, 3),
      countryName: cc ? COUNTRY_CODES[cc] : undefined,
      type: 'foreign',
    };
  } else if (s.startsWith('84') && (s.length === 11 || s.length === 12) && /^84[235789]/.test(s))
    national = `0${s.slice(2)}`;
  else if (s.startsWith('0')) national = s;
  else if (s.length === 9 && /^[35789]/.test(s)) national = `0${s}`;
  if (!national) return null;

  if (national.length === 10) {
    const carrier = MOBILE_PREFIXES[national.slice(0, 3)];
    if (carrier) return { e164: `+84${national.slice(1)}`, national, country: 'VN', type: 'mobile', carrier };
    return null;
  }
  if (national.length === 11 && national.startsWith('02')) {
    const area = AREA_CODES[national.slice(0, 3)] ?? AREA_CODES[national.slice(0, 4)];
    if (area) return { e164: `+84${national.slice(1)}`, national, country: 'VN', type: 'landline', area };
  }
  return null;
}

/** Mask the middle digits for public display: 0912***678. */
export function maskPhone(p: string): string {
  const d = p.replace(/\D/g, '');
  if (d.length <= 6) return p;
  return `${p.slice(0, p.length - d.length + 4)}***${d.slice(-3)}`;
}
