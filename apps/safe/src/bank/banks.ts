import { fold } from '../lib/vn-text';

export interface BankInfo {
  code: string;
  name: string;
  /** Folded aliases as people write them in messages ("vcb", "ngoai thuong", "mb bank"). */
  aliases: string[];
  kind?: 'bank' | 'ewallet';
}

/** Vietnamese banks and wallets as they appear in transfer instructions. */
export const BANKS: BankInfo[] = [
  { code: 'VCB', name: 'Vietcombank', aliases: ['vietcombank', 'vcb', 'ngan hang ngoai thuong'] },
  {
    code: 'CTG',
    name: 'VietinBank',
    aliases: ['vietinbank', 'viettinbank', 'vietin', 'ngan hang cong thuong'],
  },
  { code: 'BIDV', name: 'BIDV', aliases: ['bidv'] },
  { code: 'AGRIBANK', name: 'Agribank', aliases: ['agribank', 'agri bank', 'ngan hang nong nghiep'] },
  { code: 'TCB', name: 'Techcombank', aliases: ['techcombank', 'techcom', 'tcb'] },
  { code: 'MB', name: 'MB Bank', aliases: ['mbbank', 'mb bank', 'mb', 'ngan hang quan doi'] },
  { code: 'VPB', name: 'VPBank', aliases: ['vpbank', 'vp bank', 'vpb'] },
  { code: 'ACB', name: 'ACB', aliases: ['acb', 'ngan hang a chau'] },
  { code: 'TPB', name: 'TPBank', aliases: ['tpbank', 'tp bank', 'tpb', 'ngan hang tien phong'] },
  { code: 'STB', name: 'Sacombank', aliases: ['sacombank', 'sacom', 'stb'] },
  { code: 'VIB', name: 'VIB', aliases: ['vib'] },
  { code: 'HDB', name: 'HDBank', aliases: ['hdbank', 'hd bank', 'hdb'] },
  { code: 'SHB', name: 'SHB', aliases: ['shb'] },
  { code: 'MSB', name: 'MSB', aliases: ['msb', 'maritime bank', 'ngan hang hang hai'] },
  { code: 'SEAB', name: 'SeABank', aliases: ['seabank', 'sea bank'] },
  { code: 'OCB', name: 'OCB', aliases: ['ocb', 'ngan hang phuong dong'] },
  { code: 'EIB', name: 'Eximbank', aliases: ['eximbank', 'exim'] },
  { code: 'LPB', name: 'LPBank', aliases: ['lpbank', 'lienvietpostbank', 'lienviet', 'lpb'] },
  { code: 'NAB', name: 'Nam A Bank', aliases: ['namabank', 'nam a bank'] },
  { code: 'PVCB', name: 'PVcomBank', aliases: ['pvcombank', 'pvcom'] },
  { code: 'BAB', name: 'Bac A Bank', aliases: ['bacabank', 'bac a bank'] },
  { code: 'VAB', name: 'VietABank', aliases: ['vietabank', 'viet a bank'] },
  { code: 'KLB', name: 'KienlongBank', aliases: ['kienlongbank', 'kien long bank'] },
  { code: 'ABB', name: 'ABBank', aliases: ['abbank', 'an binh bank'] },
  { code: 'BVB', name: 'BVBank (Bản Việt)', aliases: ['bvbank', 'vietcapitalbank', 'ban viet'] },
  { code: 'NCB', name: 'NCB', aliases: ['ncb', 'ngan hang quoc dan'] },
  { code: 'SGB', name: 'Saigonbank', aliases: ['saigonbank'] },
  { code: 'PGB', name: 'PGBank', aliases: ['pgbank'] },
  { code: 'SCB', name: 'SCB', aliases: ['scb'] },
  { code: 'CAKE', name: 'Cake by VPBank', aliases: ['cake by vpbank', 'ngan hang so cake'] },
  { code: 'TIMO', name: 'Timo', aliases: ['timo'] },
  { code: 'MOMO', name: 'Ví MoMo', aliases: ['momo', 'vi momo'], kind: 'ewallet' },
  { code: 'ZALOPAY', name: 'ZaloPay', aliases: ['zalopay', 'zalo pay'], kind: 'ewallet' },
  {
    code: 'VTMONEY',
    name: 'Viettel Money',
    aliases: ['viettel money', 'viettelpay', 'viettel pay'],
    kind: 'ewallet',
  },
];

const ALIAS_INDEX: { alias: string; bank: BankInfo }[] = BANKS.flatMap((b) =>
  b.aliases.map((alias) => ({ alias, bank: b })),
).sort((a, b) => b.alias.length - a.alias.length);

/** Find a bank by free-text name or code ("Vietcombank", "vcb", "MB Bank"). */
export function findBank(nameOrCode: string | undefined | null): BankInfo | undefined {
  if (!nameOrCode) return undefined;
  const f = fold(nameOrCode);
  const byCode = BANKS.find((b) => b.code.toLowerCase() === f.replace(/\s/g, ''));
  if (byCode) return byCode;
  return ALIAS_INDEX.find((x) => f === x.alias || ` ${f} `.includes(` ${x.alias} `))?.bank;
}

/** All bank mentions in folded text, with their positions. */
export function bankMentions(folded: string): { bank: BankInfo; index: number; length: number }[] {
  const out: { bank: BankInfo; index: number; length: number }[] = [];
  const padded = ` ${folded} `;
  for (const { alias, bank } of ALIAS_INDEX) {
    let from = 0;
    for (;;) {
      const i = padded.indexOf(` ${alias} `, from);
      if (i < 0) break;
      if (!out.some((o) => i >= o.index && i < o.index + o.length))
        out.push({ bank, index: i, length: alias.length + 1 });
      from = i + alias.length + 1;
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

/** Normalize an account number to digits; null if it cannot be one (6–19 digits). */
export function normalizeAccountNumber(raw: string): string | null {
  const digits = raw.replace(/[\s.-]/g, '');
  if (!/^\d{6,19}$/.test(digits)) return null;
  return digits;
}

/** Mask for public display: 1903******123. */
export function maskAccount(acc: string): string {
  if (acc.length <= 6) return acc;
  return `${acc.slice(0, 4)}${'*'.repeat(Math.max(2, acc.length - 7))}${acc.slice(-3)}`;
}
