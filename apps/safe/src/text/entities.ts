import { parse as parseDomain } from 'tldts';
import { bankMentions, findBank } from '../bank/banks';
import { stripDiacritics } from '../lib/vn-text';
import { type PhoneInfo, parsePhone } from '../phone/phone';
import { normalizeUrl, refang } from '../url/normalize';
import type { BankAccountEntity } from '../verdict/types';

export interface ExtractedEntities {
  urls: string[];
  phones: PhoneInfo[];
  bankAccounts: BankAccountEntity[];
  emails: string[];
}

const MAX_PER_TYPE = 10;
const TRAILING_PUNCT = /[.,;:!?)\]}'"…»”’]+$/;

/** Replace matched spans with spaces so later extractors don't see digits inside URLs/emails. */
function blank(text: string, start: number, end: number): string {
  return text.slice(0, start) + ' '.repeat(end - start) + text.slice(end);
}

function refangText(text: string): string {
  return text
    .replace(/\bh[xX]{2}p(s?):\/\//gi, 'http$1://')
    .replace(/\[\.\]|\(\.\)|\{\.\}/g, '.')
    .replace(/\s?\[dot\]\s?|\s?\(dot\)\s?/gi, '.');
}

export function extractEntities(input: string): ExtractedEntities {
  let text = refangText(input.normalize('NFKC'));
  const urls: string[] = [];
  const emails: string[] = [];

  // Emails first (so their domains are not mistaken for links).
  for (const m of text.matchAll(/[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}/gi)) {
    const e = m[0].toLowerCase();
    if (!emails.includes(e) && emails.length < MAX_PER_TYPE) emails.push(e);
    text = blank(text, m.index!, m.index! + m[0].length);
  }

  const pushUrl = (raw: string) => {
    const cleaned = refang(raw.replace(TRAILING_PUNCT, ''));
    try {
      const n = normalizeUrl(cleaned);
      if (!urls.includes(n.href) && urls.length < MAX_PER_TYPE) urls.push(n.href);
      return true;
    } catch {
      return false;
    }
  };
  for (const re of [/\bhttps?:\/\/[^\s<>"'“”‘’]+/gi, /\bwww\.[^\s<>"'“”‘’]+/gi]) {
    for (const m of text.matchAll(re)) {
      pushUrl(m[0]);
      text = blank(text, m.index!, m.index! + m[0].length);
    }
  }
  // Bare domains: "vietcombank-xacthuc.com/abc", "bit.ly/xyz". Validated against the public suffix list.
  for (const m of text.matchAll(
    /(?<![\w@.-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})(?::\d{2,5})?(\/[^\s<>"'“”]*)?/gi,
  )) {
    const host = m[1]!.toLowerCase();
    const info = parseDomain(host);
    if (!info.isIcann || !info.domain || !info.domainWithoutSuffix || /^\d+$/.test(info.domainWithoutSuffix))
      continue;
    if (pushUrl(m[0])) text = blank(text, m.index!, m.index! + m[0].length);
  }

  // Phones: VN mobile/landline, 1800/1900, foreign "+xx".
  const phones: PhoneInfo[] = [];
  const phoneSpans: [number, number][] = [];
  const addPhone = (raw: string, start: number) => {
    const p = parsePhone(raw);
    if (!p || p.type === 'short_code') return;
    phoneSpans.push([start, start + raw.length]);
    if (!phones.some((x) => x.e164 === p.e164) && phones.length < MAX_PER_TYPE) phones.push(p);
  };
  for (const m of text.matchAll(/(?<![\d+])(?:\+84|0084|84|0)(?:[\s.\-()]{0,2}\d){8,10}(?![\d])/g))
    addPhone(m[0], m.index!);
  for (const m of text.matchAll(/(?<!\d)(?:1800|1900)(?:[\s.-]?\d){4,6}(?!\d)/g)) addPhone(m[0], m.index!);
  for (const m of text.matchAll(/\+(?!84)\d{1,3}(?:[\s.-]?\(?\d{1,4}\)?)(?:[\s.-]?\d{2,4}){2,4}(?!\d)/g))
    addPhone(m[0], m.index!);

  const bankAccounts = extractBankAccounts(text, phoneSpans);
  return { urls, phones, bankAccounts, emails };
}

const ACCOUNT_KEYWORD =
  /(?:\bstk\b|so tai khoan|so tk|\btai khoan\b|\btk\b|\bck\b|chuyen khoan|account(?: number| no\.?)?|\bacc\b|\ba\/c\b)\s*(?:so\s*)?(?:la|vao|toi|qua|den|:|-|#)?\s*[:-]?\s*/gi;
const DIGIT_RUN = /(?<![\d.,])\d(?:[\d]|[ .-](?=\d{2,})){5,24}\d?(?![\d])/g;

function isAmount(text: string, start: number, end: number, raw: string): boolean {
  const after = text.slice(end, end + 6).toLowerCase();
  if (/^\s?(?:d|đ|vnd|vnđ|k\b|tr\b|trieu|triệu|nghin|nghìn|ngan|ngàn|usd|usdt|%|\$)/i.test(after))
    return true;
  if (/^\d{1,3}(?:[.,]\d{3})+$/.test(raw)) return true;
  const before = text.slice(Math.max(0, start - 3), start);
  return /[$₫]/.test(before);
}

function extractBankAccounts(text: string, phoneSpans: [number, number][]): BankAccountEntity[] {
  const light = stripDiacritics(text).toLowerCase();
  const out: BankAccountEntity[] = [];
  const mentions = bankMentions(light.replace(/[^a-z0-9]+/g, ' '));
  const foldedPositions = mapFoldedToLight(light);

  const candidates: { digits: string; start: number; end: number; keyword: boolean }[] = [];
  for (const m of light.matchAll(DIGIT_RUN)) {
    const raw = m[0].trim();
    const start = m.index!;
    const end = start + m[0].length;
    const digits = raw.replace(/[ .-]/g, '');
    if (digits.length < 6 || digits.length > 19) continue;
    if (isAmount(light, start, end, raw)) continue;
    const before = light.slice(Math.max(0, start - 40), start);
    ACCOUNT_KEYWORD.lastIndex = 0;
    const kw = [...before.matchAll(ACCOUNT_KEYWORD)].some((k) => k.index! + k[0].length >= before.length - 2);
    candidates.push({ digits, start, end, keyword: kw });
  }

  for (const c of candidates) {
    const overlapsPhone = phoneSpans.some(([a, b]) => c.start < b && c.end > a);
    // Closest bank mention within 50 chars on either side.
    let bank: ReturnType<typeof findBank>;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const mnt of mentions) {
      const pos = foldedPositions(mnt.index);
      const dist = pos < c.start ? c.start - (pos + mnt.length) : pos - c.end;
      if (dist >= -1 && dist <= 50 && dist < bestDist) {
        bestDist = dist;
        bank = mnt.bank;
      }
    }
    const anchored = c.keyword || (bank !== undefined && c.digits.length >= 8);
    if (!anchored) continue;
    // A phone number with only a bank nearby is most likely just a phone, unless it sits right next to the bank name
    // (MB Bank, TPBank… allow phone numbers as account numbers).
    if (overlapsPhone && !c.keyword && bestDist > 15) continue;
    if (out.some((o) => o.accountNumber === c.digits)) continue;
    const entity: BankAccountEntity = { accountNumber: c.digits };
    if (bank) {
      entity.bankCode = bank.code;
      entity.bankName = bank.name;
    }
    const name = holderName(text, c.end);
    if (name) entity.accountName = name;
    out.push(entity);
    if (out.length >= MAX_PER_TYPE) break;
  }
  return out;
}

/** Map an index in the space-collapsed folded string back to the `light` string. */
function mapFoldedToLight(light: string): (foldedIndex: number) => number {
  const map: number[] = [];
  let prevSpace = false;
  // Reproduce ` ${light.replace(/[^a-z0-9]+/g, ' ')} ` index by index.
  map.push(0);
  for (let i = 0; i < light.length; i++) {
    const isAl = /[a-z0-9]/.test(light[i]!);
    if (isAl) {
      map.push(i);
      prevSpace = false;
    } else if (!prevSpace) {
      map.push(i);
      prevSpace = true;
    }
  }
  map.push(light.length);
  return (idx) => map[Math.min(idx + 1, map.length - 1)] ?? 0;
}

const NOT_A_NAME = new Set([
  'STK',
  'TK',
  'CTK',
  'VND',
  'VNĐ',
  'OTP',
  'ATM',
  'QR',
  'SMS',
  'CCCD',
  'CMND',
  'NH',
  'CK',
  'ND',
  'SĐT',
  'SDT',
  'BANK',
]);

/** Account holder name near the number: "… - NGUYEN VAN A", "MB Bank, chủ TK: TRẦN THỊ B". */
function holderName(original: string, from: number): string | undefined {
  const window = original.slice(from, from + 80).split('\n')[0]!;
  const tokens = window.split(/[\s,;:.!?()\-–]+/).filter(Boolean);
  const isUpperWord = (w: string) =>
    /^\p{L}+$/u.test(w) &&
    w === w.toUpperCase() &&
    w !== w.toLowerCase() &&
    !NOT_A_NAME.has(w) &&
    !findBank(w);
  for (let i = 0; i < tokens.length; i++) {
    if (!isUpperWord(tokens[i]!)) continue;
    const words: string[] = [];
    for (let j = i; j < tokens.length && words.length < 6 && isUpperWord(tokens[j]!); j++)
      words.push(tokens[j]!);
    if (words.length >= 2) return words.join(' ');
    i += words.length;
  }
  return undefined;
}
