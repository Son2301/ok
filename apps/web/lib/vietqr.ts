/**
 * The top-up API returns a VietQR "quick link" image URL
 * (`https://img.vietqr.io/image/<bank>-<account>-<template>.png?amount=…&addInfo=…&accountName=…`).
 * People who can't scan (paying from the same phone) need the account typed
 * out, so we read the bank, account number and holder back from that URL.
 */

/** NAPAS BINs of common Vietnamese banks → display name. */
export const BANK_BINS: Record<string, string> = {
  '970436': 'Vietcombank',
  '970407': 'Techcombank',
  '970422': 'MB Bank',
  '970416': 'ACB',
  '970418': 'BIDV',
  '970415': 'VietinBank',
  '970432': 'VPBank',
  '970423': 'TPBank',
  '970403': 'Sacombank',
  '970405': 'Agribank',
  '970441': 'VIB',
  '970443': 'SHB',
  '970437': 'HDBank',
  '970448': 'OCB',
  '970426': 'MSB',
  '970431': 'Eximbank',
  '970440': 'SeABank',
  '970449': 'LPBank',
  '970425': 'ABBank',
  '970428': 'Nam A Bank',
  '970409': 'Bac A Bank',
  '970412': 'PVcomBank',
  '970427': 'VietABank',
  '970419': 'NCB',
  '970452': 'KienlongBank',
  '970429': 'SCB',
  '970438': 'BaoViet Bank',
  '970400': 'Saigonbank',
};

export interface VietQrInfo {
  bankId: string;
  bankName: string;
  accountNo: string;
  accountName: string | null;
  amount: number | null;
  addInfo: string | null;
}

export function parseVietQrUrl(url: string | null | undefined): VietQrInfo | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const file = decodeURIComponent(u.pathname.split('/').pop() ?? '');
  // <bankId>-<accountNo>-<template>.png ; the template is optional.
  const m = file.match(/^([^-]+)-([^-]+?)(?:-([a-z0-9_]+))?\.(png|jpg)$/i);
  if (!m) return null;
  const [, bankId = '', accountNo = ''] = m;
  const amount = Number(u.searchParams.get('amount'));
  const name = BANK_BINS[bankId] ?? bankId.replace(/^\w/, (c) => c.toUpperCase());
  return {
    bankId,
    bankName: name,
    accountNo,
    accountName: u.searchParams.get('accountName'),
    amount: Number.isFinite(amount) && amount > 0 ? amount : null,
    addInfo: u.searchParams.get('addInfo'),
  };
}

/** Bank details for a top-up: the API's `bank` field when present, else parsed from the QR URL. */
export function topupBankInfo(topup: {
  qrImageUrl: string | null;
  bank?: { bankId: string; accountNo: string; accountName: string } | null;
}): VietQrInfo | null {
  const parsed = parseVietQrUrl(topup.qrImageUrl);
  if (!topup.bank) return parsed;
  const { bankId, accountNo, accountName } = topup.bank;
  return {
    bankId,
    bankName: BANK_BINS[bankId] ?? bankId.replace(/^\w/, (c) => c.toUpperCase()),
    accountNo,
    accountName,
    amount: parsed?.amount ?? null,
    addInfo: parsed?.addInfo ?? null,
  };
}
