import { parse as parseDomain } from 'tldts';
import { normalizeAccountNumber } from '../bank/banks';
import { parsePhone } from '../phone/phone';
import { levelEmoji, levelHeadline } from '../verdict/builder';
import type { Localized, Verdict } from '../verdict/types';

/** Subset of the Telegram Bot API Update object we use. https://core.telegram.org/bots/api#update */
export interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: 'private' | 'group' | 'supergroup' | 'channel' };
  from?: { id: number; is_bot?: boolean; language_code?: string };
  text?: string;
  caption?: string;
  photo?: unknown[];
  document?: unknown;
  video?: unknown;
  voice?: unknown;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

export type TelegramInput =
  | { kind: 'command'; command: 'start' | 'help' }
  | { kind: 'url'; value: string }
  | { kind: 'phone'; value: string }
  | { kind: 'bank_account'; value: string }
  | { kind: 'text'; value: string }
  | { kind: 'media_only' }
  | { kind: 'ignore' };

/** Decide what to check from a (possibly forwarded) message. In groups the bot only reacts to /check. */
export function classifyMessage(msg: TelegramMessage): TelegramInput {
  if (msg.from?.is_bot) return { kind: 'ignore' };
  let text = (msg.text ?? msg.caption ?? '').trim();
  const isGroup = msg.chat.type !== 'private';
  const cmd = text.match(/^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/);
  if (cmd) {
    const name = cmd[1]!.toLowerCase();
    if (name === 'start' || name === 'help') return { kind: 'command', command: name };
    if (name === 'check' || name === 'kiemtra') text = cmd[2]!.trim();
    else return isGroup ? { kind: 'ignore' } : { kind: 'command', command: 'help' };
  } else if (isGroup) {
    return { kind: 'ignore' };
  }
  if (!text)
    return msg.photo || msg.document || msg.video || msg.voice
      ? { kind: 'media_only' }
      : isGroup
        ? { kind: 'ignore' }
        : { kind: 'command', command: 'help' };
  if (/^\S+$/.test(text)) {
    const phone = parsePhone(text);
    if (phone && phone.type !== 'short_code') return { kind: 'phone', value: phone.e164 };
    if (
      /^(https?:\/\/|www\.)/i.test(text) ||
      (parseDomain(text.replace(/^h[x]{2}p/i, 'http')).isIcann && /\./.test(text) && !/^\d/.test(text))
    ) {
      return { kind: 'url', value: text };
    }
    if (normalizeAccountNumber(text)) return { kind: 'bank_account', value: text };
  }
  return { kind: 'text', value: text.slice(0, 10_000) };
}

export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Make any domain names non-clickable in chat (`evil.top` → `evil[.]top`). */
export function defangDomains(s: string): string {
  return s.replace(/\b(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,24})\b/gi, (m, host: string) => {
    if (!parseDomain(host).isIcann) return m;
    return m.replace(/^http/i, 'hxxp').replace(/\./g, '[.]');
  });
}

export const WELCOME_TEXT = [
  '👋 <b>Chào bạn!</b> Mình giúp kiểm tra tin nhắn, đường link, số điện thoại và số tài khoản có dấu hiệu lừa đảo hay không.',
  '',
  'Cách dùng: chuyển tiếp (forward) hoặc dán nội dung đáng ngờ vào đây, ví dụ:',
  '• một tin nhắn SMS, Zalo, Messenger',
  '• một đường link',
  '• một số điện thoại hoặc số tài khoản',
  '',
  'Với ảnh chụp màn hình, hãy gửi kèm phần chữ trong tin nhắn (mình chưa đọc được chữ trong ảnh).',
  'ℹ️ Kết quả là tự động và chỉ để tham khảo. Mình không lưu nội dung tin nhắn của bạn.',
].join('\n');

export const MEDIA_ONLY_TEXT =
  '📷 Mình chưa đọc được chữ trong ảnh hoặc tệp. Bạn hãy dán (copy) nội dung tin nhắn hoặc đường link vào đây để mình kiểm tra nhé.';

export function rateLimitedText(limit: number): string {
  return `⏳ Bạn đã dùng hết ${limit} lượt kiểm tra miễn phí hôm nay. Hãy quay lại sau 0 giờ nhé. Trong lúc chờ: đừng chuyển tiền, đừng bấm link và đừng đọc mã OTP cho bất kỳ ai.`;
}

export const ERROR_TEXT =
  '⚠️ Xin lỗi, mình chưa kiểm tra được nội dung này. Bạn thử lại sau ít phút nhé. Nếu đang bị hối thúc chuyển tiền, hãy dừng lại và gọi cho người thân trước.';

/** Short Vietnamese verdict for chat: emoji + level, top reasons, what the scammer wants, what to do. */
export function formatTelegramReply(v: Verdict): string {
  const head = levelHeadline(v.kind, v.level);
  const lines: string[] = [`${levelEmoji(v.level)} <b>${escapeHtml(head.vi)}</b> (${v.score}/100)`];
  const subject =
    v.kind === 'url'
      ? 'Link'
      : v.kind === 'phone'
        ? 'Số điện thoại'
        : v.kind === 'bank_account'
          ? 'Số tài khoản'
          : null;
  if (subject)
    lines.push(`${subject}: <code>${escapeHtml(v.kind === 'url' ? defangDomains(v.input) : v.input)}</code>`);
  const reasons = v.signals.filter((s) => s.weight > 0 && s.id !== 'llm.assessment').slice(0, 3);
  if (reasons.length) {
    lines.push('', '<b>Dấu hiệu chính:</b>');
    for (const r of reasons) lines.push(`• ${escapeHtml(defangDomains(r.label.vi))}`);
  } else {
    const trust = v.signals.find((s) => s.weight < 0);
    lines.push(
      '',
      escapeHtml(defangDomains(trust ? `${trust.label.vi}.` : 'Chưa phát hiện dấu hiệu lừa đảo rõ ràng.')),
    );
  }
  const goal = v.details?.scammerGoal as Localized | undefined;
  if (goal?.vi && (v.level === 'medium' || v.level === 'high' || v.level === 'critical')) {
    lines.push('', `<b>Kẻ gian muốn:</b> ${escapeHtml(goal.vi)}`);
  }
  const recs = v.recommendations.vi.slice(0, 2);
  if (recs.length) {
    lines.push('', '<b>Bạn nên:</b>');
    for (const r of recs) lines.push(`• ${escapeHtml(defangDomains(r))}`);
  }
  const warned = v.details?.policeWarnedScripts as Localized[] | undefined;
  if (warned?.length && v.score >= 25)
    lines.push('', `⚠️ Giống kịch bản đã được công an cảnh báo: ${escapeHtml(warned[0]!.vi)}.`);
  if (v.level === 'high' || v.level === 'critical')
    lines.push(
      '',
      '🆘 Lỡ chuyển tiền? Gọi ngay tổng đài ngân hàng để yêu cầu tạm giữ giao dịch và báo công an nơi gần nhất.',
    );
  else if (v.level === 'low' || v.level === 'safe')
    lines.push(
      '',
      'Kẻ gian hay đổi thủ đoạn, nên hãy vẫn cẩn thận khi bị yêu cầu chuyển tiền hoặc đọc mã OTP.',
    );
  lines.push('', 'ℹ️ Kết quả tự động, chỉ mang tính tham khảo.');
  return lines.join('\n').slice(0, 4000);
}

export function sendMessage(chatId: number, text: string, replyTo?: number) {
  return {
    method: 'sendMessage',
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
  };
}
