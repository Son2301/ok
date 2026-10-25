import { newId } from '@ok/shared';
import { combineSignals, type LevelOptions, levelFor } from './scoring';
import type { CheckKind, Entities, Level, Localized, Signal, SourceStatus, Verdict } from './types';

/*
 * Wording rules (product + trust & safety):
 *  - Never tell users something is "an toàn"/"safe". Low scores say "Chưa phát hiện dấu hiệu lừa đảo"
 *    plus a reminder that scammers change tactics. The `level` enum keeps `safe` for machines only.
 *  - When few sources could run, say "Chưa đủ dữ liệu" instead of implying a clean result.
 *  - Media/AI-text results talk about "warning signs found / not found", never "real/fake".
 *  - Name the red flags in plain words.
 */

const NOUN: Record<CheckKind, Localized> = {
  url: { vi: 'đường link này', en: 'this link' },
  text: { vi: 'tin nhắn này', en: 'this message' },
  phone: { vi: 'số điện thoại này', en: 'this phone number' },
  bank_account: { vi: 'số tài khoản này', en: 'this bank account' },
  email: { vi: 'địa chỉ email này', en: 'this email address' },
  image: { vi: 'ảnh này', en: 'this image' },
  video: { vi: 'video này', en: 'this video' },
  audio: { vi: 'đoạn âm thanh này', en: 'this audio clip' },
  ai_text: { vi: 'đoạn văn này', en: 'this text' },
};

const ACTION: Partial<Record<CheckKind, Localized>> = {
  url: {
    vi: 'Đừng mở link và tuyệt đối không nhập thông tin cá nhân.',
    en: 'Do not open it and never enter personal details.',
  },
  text: {
    vi: 'Đừng làm theo yêu cầu trong tin nhắn và đừng chuyển tiền.',
    en: 'Do not follow its instructions and do not send money.',
  },
  phone: {
    vi: 'Đừng làm theo yêu cầu chuyển tiền hay đọc mã OTP từ số này.',
    en: 'Do not send money or read out OTP codes to this number.',
  },
  bank_account: { vi: 'Đừng chuyển tiền vào tài khoản này.', en: 'Do not transfer money to this account.' },
  email: {
    vi: 'Đừng trả lời, đừng mở tệp đính kèm hay bấm link trong email.',
    en: 'Do not reply, open attachments or click links in it.',
  },
};

const TACTICS_CHANGE: Localized = {
  vi: 'Kẻ gian liên tục đổi thủ đoạn, nên hãy luôn cẩn thận khi bị yêu cầu chuyển tiền hoặc cung cấp mã OTP.',
  en: 'Scammers change tactics all the time, so stay careful whenever you are asked to send money or share an OTP.',
};

const MEDIA_NOTE: Localized = {
  vi: 'Lưu ý: không công cụ nào kết luận chắc chắn được một nội dung là thật hay do AI tạo ra; các bộ phát hiện vẫn có thể báo nhầm.',
  en: 'Note: no tool can prove whether content is real or AI-generated; detectors also raise false alarms.',
};

const isMediaKind = (k: CheckKind) => k === 'image' || k === 'video' || k === 'audio';
const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const lcFirst = (s: string) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

function joinReasons(signals: Signal[], lang: 'vi' | 'en', n = 2): string {
  return signals
    .slice(0, n)
    .map((s) => lcFirst(s.label[lang]))
    .join('; ');
}

export interface SummaryContext {
  /** Fewer than half of the configured sources produced data. */
  limitedData?: boolean;
}

/** Default plain-language summary for a level. Checks may append notes or override. */
export function defaultSummary(
  kind: CheckKind,
  level: Level,
  signals: Signal[],
  ctx: SummaryContext = {},
): Localized {
  const noun = NOUN[kind];
  const risks = signals.filter((s) => s.weight > 0).sort((a, b) => b.weight - a.weight);
  const trusts = signals.filter((s) => s.weight < 0).sort((a, b) => a.weight - b.weight);
  const rVi = joinReasons(risks, 'vi');
  const rEn = joinReasons(risks, 'en');

  if (isMediaKind(kind) || kind === 'ai_text') {
    const note =
      kind === 'ai_text'
        ? {
            vi: 'Đây chỉ là ước lượng với độ tin cậy thấp, không đủ để kết luận ai là người viết.',
            en: 'This is a low-confidence estimate and cannot tell who wrote it.',
          }
        : MEDIA_NOTE;
    switch (level) {
      case 'critical':
      case 'high':
        return {
          vi: `Phát hiện nhiều dấu hiệu cảnh báo: ${noun.vi} có thể đã được tạo hoặc chỉnh sửa bằng AI (${rVi}). ${note.vi}`,
          en: `Several warning signs found: ${noun.en} may have been AI-generated or edited (${rEn}). ${note.en}`,
        };
      case 'medium':
        return {
          vi: `Phát hiện một vài dấu hiệu cảnh báo ở ${noun.vi}: ${rVi}. ${note.vi}`,
          en: `A few warning signs found in ${noun.en}: ${rEn}. ${note.en}`,
        };
      case 'unknown':
        return kind === 'ai_text'
          ? {
              vi: `Chưa đủ dữ liệu: ${noun.vi} quá ngắn để ước lượng. ${note.vi}`,
              en: `Not enough data: ${noun.en} is too short to estimate. ${note.en}`,
            }
          : {
              vi: `Chưa đủ dữ liệu: ${noun.vi} không còn thông tin gốc để đánh giá (thường do đã gửi qua Zalo, Facebook hoặc chụp lại màn hình). ${note.vi}`,
              en: `Not enough data: ${noun.en} has no original metadata left to assess (common after chat apps or screenshots). ${note.en}`,
            };
      default:
        return {
          vi: `Chưa thấy dấu hiệu cảnh báo ở ${noun.vi}. Điều này không chứng minh nội dung là thật. ${note.vi}`,
          en: `No warning signs found in ${noun.en}. This does not prove it is authentic. ${note.en}`,
        };
    }
  }

  const act = ACTION[kind] ?? { vi: '', en: '' };
  switch (level) {
    case 'critical':
      return {
        vi: `Rất nguy hiểm: ${noun.vi} rất có thể là lừa đảo. Dấu hiệu chính: ${rVi}. ${act.vi}`.trim(),
        en: `Very dangerous: ${noun.en} is very likely a scam. Main red flags: ${rEn}. ${act.en}`.trim(),
      };
    case 'high':
      return {
        vi: `Nguy hiểm: ${noun.vi} có nhiều dấu hiệu lừa đảo. Dấu hiệu chính: ${rVi}. ${act.vi}`.trim(),
        en: `Dangerous: ${noun.en} shows several scam red flags. Main red flags: ${rEn}. ${act.en}`.trim(),
      };
    case 'medium':
      return {
        vi: `Đáng ngờ: ${noun.vi} có dấu hiệu bất thường (${rVi}). Hãy xác minh kỹ trước khi làm theo.`,
        en: `Suspicious: ${noun.en} shows unusual signs (${rEn}). Verify carefully before acting on it.`,
      };
    case 'unknown':
      return {
        vi: `Chưa đủ dữ liệu để đánh giá ${noun.vi}. ${TACTICS_CHANGE.vi}`,
        en: `Not enough data to assess ${noun.en}. ${TACTICS_CHANGE.en}`,
      };
    case 'safe': {
      const why = trusts[0] ? ` ${cap(trusts[0].label.vi)}.` : '';
      const whyEn = trusts[0] ? ` ${cap(trusts[0].label.en)}.` : '';
      return {
        vi: `Chưa phát hiện dấu hiệu lừa đảo ở ${noun.vi}.${why} ${TACTICS_CHANGE.vi}`,
        en: `No scam signs found in ${noun.en}.${whyEn} ${TACTICS_CHANGE.en}`,
      };
    }
    default:
      if (ctx.limitedData) {
        return {
          vi: `Chưa phát hiện dấu hiệu lừa đảo ở ${noun.vi}, nhưng chưa đủ dữ liệu để đánh giá đầy đủ vì một số nguồn kiểm tra chưa chạy được. ${TACTICS_CHANGE.vi}`,
          en: `No scam signs found in ${noun.en}, but there is not enough data for a full assessment because some sources could not run. ${TACTICS_CHANGE.en}`,
        };
      }
      return {
        vi: `Chưa phát hiện dấu hiệu lừa đảo ở ${noun.vi}. ${TACTICS_CHANGE.vi}`,
        en: `No scam signs found in ${noun.en}. ${TACTICS_CHANGE.en}`,
      };
  }
}

const EMOJI: Record<Level, string> = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '🟢',
  safe: '🟢',
  unknown: '⚪',
};

/** Headline used by share cards and the Telegram bot. Never claims "safe". */
export function levelHeadline(kind: CheckKind, level: Level): Localized {
  if (isMediaKind(kind) || kind === 'ai_text') {
    switch (level) {
      case 'critical':
      case 'high':
        return { vi: 'NHIỀU DẤU HIỆU CẢNH BÁO', en: 'SEVERAL WARNING SIGNS' };
      case 'medium':
        return { vi: 'MỘT VÀI DẤU HIỆU CẢNH BÁO', en: 'A FEW WARNING SIGNS' };
      case 'unknown':
        return { vi: 'CHƯA ĐỦ DỮ LIỆU', en: 'NOT ENOUGH DATA' };
      default:
        return { vi: 'CHƯA THẤY DẤU HIỆU CẢNH BÁO', en: 'NO WARNING SIGNS FOUND' };
    }
  }
  switch (level) {
    case 'critical':
      return { vi: 'RẤT NGUY HIỂM', en: 'VERY DANGEROUS' };
    case 'high':
      return { vi: 'NGUY HIỂM', en: 'DANGEROUS' };
    case 'medium':
      return { vi: 'ĐÁNG NGỜ', en: 'SUSPICIOUS' };
    case 'unknown':
      return { vi: 'CHƯA ĐỦ DỮ LIỆU', en: 'NOT ENOUGH DATA' };
    default:
      return { vi: 'CHƯA PHÁT HIỆN DẤU HIỆU LỪA ĐẢO', en: 'NO SCAM SIGNS FOUND' };
  }
}

export const levelEmoji = (level: Level) => EMOJI[level];

/** Make links non-clickable when echoed back in chat apps: `evil.com` → `evil[.]com`, `http` → `hxxp`. */
export function defang(s: string): string {
  return s.replace(/^http/i, 'hxxp').replace(/\./g, '[.]');
}

const SHARE_SUBJECT: Record<CheckKind, Localized> = {
  url: { vi: 'Link', en: 'Link' },
  text: { vi: 'Tin nhắn', en: 'Message' },
  phone: { vi: 'Số điện thoại', en: 'Phone number' },
  bank_account: { vi: 'Số tài khoản', en: 'Bank account' },
  email: { vi: 'Email', en: 'Email' },
  image: { vi: 'Ảnh', en: 'Image' },
  video: { vi: 'Video', en: 'Video' },
  audio: { vi: 'Âm thanh', en: 'Audio' },
  ai_text: { vi: 'Đoạn văn', en: 'Text' },
};

function shareSubjectValue(kind: CheckKind, input: string): string | null {
  switch (kind) {
    case 'url':
    case 'email':
      return defang(input);
    case 'phone':
    case 'bank_account':
      return input;
    case 'text':
    case 'ai_text': {
      const flat = input.replace(/\s+/g, ' ').trim();
      return `“${flat.length > 70 ? `${flat.slice(0, 70)}…` : flat}”`.replace(/https?:\/\/\S+/gi, (u) =>
        defang(u),
      );
    }
    default:
      return null;
  }
}

/** Short, forwardable card for Zalo/Messenger ("Ask your kids" use case). */
export function buildShareText(
  kind: CheckKind,
  input: string,
  level: Level,
  score: number,
  signals: Signal[],
): Localized {
  const head = levelHeadline(kind, level);
  const emoji = EMOJI[level];
  const subject = SHARE_SUBJECT[kind];
  const value = shareSubjectValue(kind, input);
  const risks = signals.filter((s) => s.weight > 0).sort((a, b) => b.weight - a.weight);
  const lines = { vi: [`${emoji} ${head.vi} (${score}/100)`], en: [`${emoji} ${head.en} (${score}/100)`] };
  if (value) {
    lines.vi.push(`${subject.vi}: ${value}`);
    lines.en.push(`${subject.en}: ${value}`);
  }
  if (risks.length) {
    lines.vi.push(`Dấu hiệu: ${joinReasons(risks, 'vi', 3)}.`);
    lines.en.push(`Red flags: ${joinReasons(risks, 'en', 3)}.`);
  }
  const risky = level === 'high' || level === 'critical';
  if (isMediaKind(kind) || kind === 'ai_text') {
    lines.vi.push('Kết quả chỉ để tham khảo, không phải kết luận thật/giả.');
    lines.en.push('This is a hint, not a real/fake verdict.');
  } else if (risky || level === 'medium') {
    lines.vi.push('Đừng chuyển tiền, đừng bấm link, đừng đọc mã OTP. Hỏi người thân trước khi làm theo.');
    lines.en.push('Do not send money, click links or share OTPs. Ask family before acting.');
  } else {
    lines.vi.push('Chưa phát hiện dấu hiệu lừa đảo, nhưng hãy vẫn cẩn thận vì kẻ gian hay đổi thủ đoạn.');
    lines.en.push('No scam signs found, but stay careful: scammers change tactics.');
  }
  return { vi: lines.vi.join('\n'), en: lines.en.join('\n') };
}

/** First-hour guide for people who already paid or shared details. Attached to high/critical verdicts. */
export function ifAlreadyPaidGuide(): { vi: string[]; en: string[] } {
  return {
    vi: [
      'Gọi ngay tổng đài ngân hàng của bạn (số in sau thẻ hoặc trong ứng dụng chính thức), đề nghị khóa tài khoản/thẻ và tra soát, tạm giữ giao dịch càng sớm càng tốt.',
      'Đổi mật khẩu ngân hàng, email, Zalo/Facebook nếu đã nhập hoặc đọc cho người khác; gỡ ứng dụng lạ vừa cài và tắt mạng điện thoại nếu nghi bị điều khiển từ xa.',
      'Trình báo ngay cơ quan công an nơi gần nhất và báo cáo trên cổng canhbao.khonggianmang.gov.vn.',
      'Giữ lại bằng chứng: ảnh chụp tin nhắn, số điện thoại, số tài khoản nhận tiền, biên lai chuyển khoản. Đừng xóa cuộc trò chuyện.',
      'Cảnh giác với người hứa "lấy lại tiền đã mất" nhưng đòi phí trước: đó là lừa đảo lần hai.',
    ],
    en: [
      "Call your bank's hotline now (on the back of your card or in the official app) and ask them to lock the account/card and trace and hold the transfer as early as possible.",
      'Change your banking, email and Zalo/Facebook passwords if you entered or shared them; uninstall any app you were told to install and switch off mobile data if you suspect remote control.',
      'Report it to the nearest police station and on the national portal canhbao.khonggianmang.gov.vn.',
      'Keep evidence: screenshots of messages, phone numbers, the receiving account number and transfer receipts. Do not delete the conversation.',
      'Beware of anyone promising to "recover your money" for an upfront fee: that is a second scam.',
    ],
  };
}

export interface BuildOptions extends LevelOptions {
  id?: string;
  checkedAt?: Date;
  summary?: Localized;
  /** Sentences appended to the generated summary (e.g. "matches a police-warned script"). */
  summaryNotes?: Localized[];
  /** Override automatic detection of "few sources could run". */
  limitedData?: boolean;
  /** Upper bound for the score (AI-text estimates are capped). */
  maxScore?: number;
  maxRecommendations?: number;
}

/** Accumulates signals, source statuses and advice for one check, then renders a Verdict. */
export class VerdictBuilder {
  readonly signals: Signal[] = [];
  readonly sources: SourceStatus[] = [];
  readonly details: Record<string, unknown> = {};
  entities?: Entities;
  private readonly recs = { vi: [] as string[], en: [] as string[] };

  constructor(
    readonly kind: CheckKind,
    public input: string,
  ) {}

  add(...signals: (Signal | null | undefined | false)[]): this {
    for (const s of signals) {
      if (!s) continue;
      // Same id + evidence twice: keep the stronger one.
      const idx = this.signals.findIndex((x) => x.id === s.id && x.evidence === s.evidence);
      if (idx >= 0) {
        if (Math.abs(s.weight) > Math.abs(this.signals[idx]!.weight)) this.signals[idx] = s;
      } else {
        this.signals.push(s);
      }
    }
    return this;
  }

  has(id: string): boolean {
    return this.signals.some((s) => s.id === id);
  }

  source(name: string, status: SourceStatus['status'], detail?: string): this {
    const existing = this.sources.findIndex((s) => s.name === name);
    const entry: SourceStatus = detail ? { name, status, detail } : { name, status };
    if (existing >= 0) this.sources[existing] = entry;
    else this.sources.push(entry);
    return this;
  }

  recommend(vi: string, en: string): this {
    if (!this.recs.vi.includes(vi)) {
      this.recs.vi.push(vi);
      this.recs.en.push(en);
    }
    return this;
  }

  score() {
    return combineSignals(this.signals);
  }

  build(opts: BuildOptions = {}): Verdict {
    const combined = combineSignals(this.signals).score;
    const score = opts.maxScore !== undefined ? Math.min(combined, opts.maxScore) : combined;
    const level = levelFor(score, this.signals, opts);
    const signals = [...this.signals].sort((a, b) => sortKey(b) - sortKey(a));
    for (const [vi, en] of defaultRecommendations(this.kind, level)) this.recommend(vi, en);
    const max = opts.maxRecommendations ?? 6;
    const okCount = this.sources.filter((s) => s.status === 'ok').length;
    const limitedData = opts.limitedData ?? (this.sources.length > 0 && okCount / this.sources.length < 0.5);
    let summary = opts.summary ?? defaultSummary(this.kind, level, signals, { limitedData });
    for (const note of opts.summaryNotes ?? [])
      summary = { vi: `${summary.vi} ${note.vi}`, en: `${summary.en} ${note.en}` };
    const risky = level === 'high' || level === 'critical';
    return {
      id: opts.id ?? newId('chk'),
      kind: this.kind,
      input: this.input,
      score,
      level,
      summary,
      signals,
      ...(this.entities ? { entities: this.entities } : {}),
      recommendations: { vi: this.recs.vi.slice(0, max), en: this.recs.en.slice(0, max) },
      ...(risky ? { ifAlreadyPaid: ifAlreadyPaidGuide() } : {}),
      shareText: buildShareText(this.kind, this.input, level, score, signals),
      sources: this.sources,
      ...(Object.keys(this.details).length ? { details: this.details } : {}),
      checkedAt: (opts.checkedAt ?? new Date()).toISOString(),
      cached: false,
    };
  }
}

/** Risk signals first (strongest first), then trust evidence, then informational ones. */
function sortKey(s: Signal) {
  if (s.weight > 0) return 1000 + s.weight;
  if (s.weight < 0) return 500 - s.weight;
  return 0;
}

function defaultRecommendations(kind: CheckKind, level: Level): [string, string][] {
  const risky = level === 'high' || level === 'critical';
  const out: [string, string][] = [];
  switch (kind) {
    case 'url':
      if (risky) {
        out.push([
          'Không mở đường link này và không nhập tài khoản, mật khẩu, mã OTP hay số thẻ.',
          'Do not open this link or enter any username, password, OTP or card number.',
        ]);
        out.push([
          'Bạn có thể báo cáo trang lừa đảo tại canhbao.khonggianmang.gov.vn.',
          'You can report phishing sites to the Vietnamese authorities at canhbao.khonggianmang.gov.vn.',
        ]);
      } else if (level === 'medium') {
        out.push([
          'Hãy tự gõ địa chỉ trang chính thức vào trình duyệt thay vì bấm vào link.',
          'Type the official address into your browser yourself instead of clicking the link.',
        ]);
      } else {
        out.push([
          'Trước khi đăng nhập, luôn kiểm tra kỹ tên miền trên thanh địa chỉ.',
          'Always double-check the domain in the address bar before logging in.',
        ]);
      }
      break;
    case 'text':
      if (risky || level === 'medium') {
        out.push([
          'Không chuyển tiền, không bấm link, không cung cấp mã OTP hay mật khẩu.',
          'Do not send money, click links, or share OTP codes or passwords.',
        ]);
        out.push([
          'Gọi lại cho người hoặc cơ quan đó qua số điện thoại chính thức mà bạn tự tìm, không dùng số có trong tin nhắn.',
          'Call the person or organisation back on an official number you look up yourself, not one from the message.',
        ]);
      }
      if (risky) {
        out.push([
          'Báo cáo số điện thoại hoặc tài khoản này để cảnh báo người khác. Tin nhắn rác có thể gửi về 5656.',
          'Report this number or account to warn others. In Vietnam, spam SMS can be forwarded to 5656.',
        ]);
      }
      if (!risky && level !== 'medium') {
        out.push([
          'Nếu sau đó có ai yêu cầu chuyển tiền gấp hay đọc mã OTP, hãy dừng lại và xác minh trước.',
          'If anyone later asks for an urgent transfer or an OTP, stop and verify first.',
        ]);
      }
      break;
    case 'phone':
      if (risky || level === 'medium') {
        out.push([
          'Cúp máy nếu người gọi đòi chuyển tiền, đọc mã OTP hay cài ứng dụng lạ.',
          'Hang up if the caller asks you to send money, read an OTP or install an app.',
        ]);
        out.push([
          'Có thể phản ánh cuộc gọi lừa đảo, cuộc gọi rác qua tổng đài 156.',
          'In Vietnam you can report scam or spam calls by calling 156.',
        ]);
      } else {
        out.push([
          'Chưa có báo cáo không có nghĩa là số này đáng tin. Đừng bao giờ đọc mã OTP qua điện thoại.',
          'No reports does not mean the number can be trusted. Never read out an OTP over the phone.',
        ]);
      }
      break;
    case 'bank_account':
      if (risky || level === 'medium') {
        out.push(['Không chuyển tiền vào tài khoản này.', 'Do not transfer money to this account.']);
      } else {
        out.push([
          'Trước khi chuyển tiền, hãy gọi điện xác minh với người nhận qua số bạn đã biết từ trước.',
          'Before transferring, verify with the recipient by calling a number you already know.',
        ]);
      }
      break;
    case 'email':
      if (risky || level === 'medium') {
        out.push([
          'Không trả lời, không mở tệp đính kèm và không bấm link trong email từ địa chỉ này.',
          'Do not reply, open attachments or click links in emails from this address.',
        ]);
      }
      out.push([
        'Ngân hàng và cơ quan nhà nước không bao giờ yêu cầu mật khẩu hay mã OTP qua email.',
        'Banks and government agencies never ask for passwords or OTPs by email.',
      ]);
      break;
    case 'image':
    case 'video':
    case 'audio':
      out.push([
        'Nếu nội dung này được dùng để xin tiền hoặc gây áp lực, hãy gọi lại cho người đó bằng số bạn đã biết từ trước.',
        'If this content is used to ask for money or pressure you, call the person back on a number you already know.',
      ]);
      if (kind !== 'image') {
        out.push([
          'Khi gọi video, hãy yêu cầu người kia quay nghiêng mặt hoặc đưa tay qua mặt: video giả thường bị méo, nhòe ở những lúc đó.',
          'On a video call, ask the person to turn their head or wave a hand over their face: deepfakes often glitch then.',
        ]);
      }
      out.push([
        'Kết quả chỉ mang tính tham khảo, không dùng làm bằng chứng duy nhất.',
        'Treat this result as a hint only, never as sole proof.',
      ]);
      break;
    case 'ai_text':
      out.push([
        'Đây chỉ là ước lượng, độ tin cậy thấp. Đừng dùng kết quả này để kết luận hay buộc tội ai.',
        'This is a low-confidence estimate. Do not use it to accuse anyone.',
      ]);
      break;
  }
  return out;
}
