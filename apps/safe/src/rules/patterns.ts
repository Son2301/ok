import type { Localized } from '../verdict/types';

/**
 * Vietnamese scam patterns.
 *
 * Patterns run on text normalized by `normalizeForMatch` (lowercase ASCII, no diacritics,
 * teencode expanded: ck→"chuyen khoan", stk→"so tai khoan", ko/k→"khong", hh→"hoa hong"…).
 * Spaces inside a phrase are optional, so "tai khoan" also matches "taikhoan".
 *
 * A rule fires when EVERY group matches (AND); a group is a list of alternatives (OR). A group
 * alternative may also be an entity found in the message (a link, a mobile number, a bank account).
 * Anchors in negatable rules are ignored when preceded by a negation ("tuyệt đối không cung cấp mã OTP").
 */

export type EntityRequirement = { entity: 'url' | 'mobile' | 'bank' };
export type GroupItem = string | EntityRequirement;

export type ScamCategory =
  | 'impersonation_authority'
  | 'impersonation_bank'
  | 'impersonation_utility'
  | 'impersonation_relative'
  | 'job_task'
  | 'investment'
  | 'loan'
  | 'prize'
  | 'delivery'
  | 'ecommerce'
  | 'romance'
  | 'charity'
  | 'emergency'
  | 'credential_theft'
  | 'malware'
  | 'recovery'
  | 'account_trade'
  | 'tactic';

export interface ScamRule {
  id: string;
  category: ScamCategory;
  weight: number;
  label: Localized;
  groups: GroupItem[][];
  /** If any of these match, the rule does not fire (legit notices). */
  none?: string[];
  negatable?: boolean;
  scammerGoal?: Localized;
  advice?: Localized[];
  /** Name of the script the police have publicly warned about. */
  policeWarned?: Localized;
  /** Generic manipulation tactic (urgency, secrecy…), not a scam type by itself. */
  tactic?: string;
}

const URL: EntityRequirement = { entity: 'url' };
const MOBILE: EntityRequirement = { entity: 'mobile' };
const BANK: EntityRequirement = { entity: 'bank' };

const MONEY =
  'chuyen (tien|khoan|gap|ngay|truoc|giup|ho|lai|vao|cho)|chuyen \\d+|nap (tien|them|truoc|\\d+)|dong (phi|tien|thue|truoc)|nop (phi|tien|thue|phat)|thanh toan|gui tien|gui (truoc|phi)|phi (ho so|xac minh|giai ngan|bao hiem|van chuyen|nhan qua|nhan thuong|kich hoat|mo khoa|dich vu|thu tuc)|so tai khoan|tai khoan (tam giu|an toan|chuyen dung)|ung truoc|dat coc|coc truoc|transfer|send money';
const LINK_ACTION =
  'link|duong dan|truy cap|bam vao|nhan vao|click|dang nhap|tai (ung dung|app)|cai (dat )?(ung dung|app)|apk';

export const SCAM_RULES: ScamRule[] = [
  {
    id: 'fake_authority',
    category: 'impersonation_authority',
    weight: 55,
    label: {
      vi: 'Mạo danh công an, viện kiểm sát hoặc tòa án',
      en: 'Impersonates police, procuracy or court',
    },
    groups: [
      [
        'cong an|bo cong an|canh sat|vien kiem sat|toa an|co quan dieu tra|cuc canh sat|an ninh dieu tra|thanh tra|police|procuracy|court',
      ],
      [
        'trieu tap|giay (trieu tap|moi)|lenh (bat|tam giam|phong toa|khan cap)|bi bat|dieu tra|vu an|rua tien|duong day|ma tuy|buon lau|truy na|khoi to|truy cuu|phong toa|niem phong|ho so (vu an|dieu tra)|xac minh (tai san|nguon tien|tien|tai khoan)|warrant|arrest|money laundering',
      ],
      [
        `${MONEY}|kho bac|giu bi mat|khong (duoc )?(noi|tiet lo|chia se|bao) (voi|cho) (ai|bat ky ai|nguoi than|nguoi nha)|cai (dat )?(ung dung|app)|link|lam viec qua (dien thoai|zalo|video)|goi video|ket ban zalo`,
        BANK,
        URL,
      ],
    ],
    scammerGoal: {
      vi: 'Làm bạn hoảng sợ để chuyển tiền vào "tài khoản tạm giữ" hoặc cài ứng dụng giúp chúng chiếm tài khoản.',
      en: 'Scare you into moving money to a "holding account" or installing an app that lets them take over your accounts.',
    },
    advice: [
      {
        vi: 'Công an, viện kiểm sát, tòa án không làm việc qua điện thoại hay Zalo và không bao giờ yêu cầu chuyển tiền. Hãy cúp máy và đến trực tiếp trụ sở công an gần nhất nếu cần xác minh.',
        en: 'Police, prosecutors and courts never handle cases by phone or chat and never ask for money. Hang up and go to your local police station in person if you need to check.',
      },
    ],
    policeWarned: {
      vi: 'giả danh công an, viện kiểm sát, tòa án gọi điện báo liên quan vụ án rồi yêu cầu chuyển tiền để "xác minh"',
      en: 'callers posing as police/prosecutors claiming you are linked to a case, then demanding money "for verification"',
    },
  },
  {
    id: 'vneid_update',
    category: 'impersonation_authority',
    weight: 55,
    label: {
      vi: 'Mạo danh cán bộ hỗ trợ cập nhật VNeID, định danh điện tử',
      en: 'Fake VNeID / e-ID update support',
    },
    groups: [
      [
        'vneid|dinh danh (dien tu|muc 2|muc hai)|dinh danh muc|can cuoc (cong dan|dien tu)|cccd|tich hop (du lieu|thong tin|cccd|bao hiem)|dong bo (du lieu|thong tin|cccd)|chuan hoa (du lieu|thong tin)',
      ],
      ['cap nhat|kich hoat|xac thuc|nang cap|tich hop|dong bo|chuan hoa|bi khoa|het han|vo hieu'],
      [
        'link|truy cap|bam vao|cai (dat )?(ung dung|app)|tai (ung dung|app)|apk|cung cap|gui (anh|hinh)|chup (anh|hinh)|bi khoa|se bi|truoc \\d+|trong (vong )?\\d+ ?(h|gio|ngay)|het han|vo hieu|ho tro (online|tai nha|tu xa|qua dien thoai)|zalo',
        URL,
      ],
    ],
    scammerGoal: {
      vi: 'Dụ bạn cài ứng dụng giả hoặc cung cấp ảnh CCCD, khuôn mặt để chiếm tài khoản ngân hàng.',
      en: 'Trick you into installing a fake app or sending ID and face photos to take over your bank account.',
    },
    advice: [
      {
        vi: 'Chỉ cập nhật VNeID trên ứng dụng tải từ CH Play/App Store hoặc trực tiếp tại công an xã, phường. Cán bộ không gọi điện hướng dẫn cài ứng dụng.',
        en: 'Only update VNeID in the app from Google Play/App Store or in person at your local police office. Officers do not call to walk you through installing apps.',
      },
    ],
    policeWarned: {
      vi: 'mạo danh công an hỗ trợ "cập nhật định danh mức 2", "tích hợp VNeID" để cài ứng dụng giả chiếm tài khoản',
      en: 'fake police "helping" with level-2 e-ID / VNeID updates to install a fake app',
    },
  },
  {
    id: 'tax_scam',
    category: 'impersonation_authority',
    weight: 45,
    label: { vi: 'Mạo danh cơ quan thuế', en: 'Impersonates the tax office' },
    groups: [
      [
        'cuc thue|chi cuc thue|tong cuc thue|co quan thue|can bo thue|thue dien tu|etax|hoan thue|quyet toan thue|no thue|nop thue|tax refund|tax office',
      ],
      [
        'cai (dat )?(ung dung|app)|tai (ung dung|app)|apk|link|truy cap|bam vao|qua han|bi phat|cuong che|chuyen (tien|khoan)|nop (tien|phi)|cung cap|xac thuc|hoan tien|ket ban zalo',
        URL,
      ],
    ],
    scammerGoal: {
      vi: 'Dụ bạn cài ứng dụng "thuế điện tử" giả hoặc chuyển tiền nộp thuế vào tài khoản của chúng.',
      en: 'Get you to install a fake "e-tax" app or pay "tax" into their account.',
    },
    advice: [
      {
        vi: 'Cơ quan thuế không gọi điện yêu cầu cài ứng dụng hay chuyển khoản. Hãy tra cứu trên thuedientu.gdt.gov.vn hoặc đến chi cục thuế.',
        en: 'The tax office does not call asking you to install apps or transfer money. Check on thuedientu.gdt.gov.vn or visit the tax office.',
      },
    ],
    policeWarned: {
      vi: 'mạo danh cơ quan thuế hướng dẫn cài ứng dụng thuế giả để quyết toán, hoàn thuế',
      en: 'fake tax officers guiding victims to install a fake tax app for refunds/settlement',
    },
  },
  {
    id: 'evn_power_cut',
    category: 'impersonation_utility',
    weight: 50,
    label: {
      vi: 'Mạo danh điện lực, dọa cắt điện để đòi tiền',
      en: 'Fake power company threatening a power cut',
    },
    groups: [
      ['evn|dien luc|cong ty dien|tien dien|hoa don dien'],
      ['cat dien|ngung (cap|cung cap) dien|tam ngung (cap|cung cap) dien|ngat dien'],
      [
        'no tien|con no|qua han|chua thanh toan|thanh toan (ngay|gap|tien dien|truoc)|nop tien|chuyen (tien|khoan)|hoan tien|link|truy cap|bam vao|cai (dat )?(ung dung|app)|lien he (nhan vien|zalo|ngay|gap)|so tai khoan',
        URL,
        MOBILE,
      ],
    ],
    none: ['bao tri|sua chua (luoi|duong day)|thi cong|lich (tam )?ngung'],
    scammerGoal: {
      vi: 'Làm bạn lo bị cắt điện để chuyển tiền "nợ tiền điện" hoặc cài ứng dụng giả.',
      en: 'Make you fear a power cut so you pay a fake bill or install a fake app.',
    },
    advice: [
      {
        vi: 'Kiểm tra hóa đơn trên ứng dụng EVN chính thức hoặc gọi tổng đài chăm sóc khách hàng in trên hóa đơn. Điện lực không yêu cầu chuyển khoản vào tài khoản cá nhân.',
        en: 'Check your bill in the official EVN app or call the hotline printed on your bill. The power company never asks for transfers to personal accounts.',
      },
    ],
    policeWarned: {
      vi: 'mạo danh nhân viên điện lực báo nợ tiền điện, dọa cắt điện để ép chuyển tiền hoặc bấm link',
      en: 'fake power company staff claiming unpaid bills and threatening disconnection',
    },
  },
  {
    id: 'job_easy_money',
    category: 'job_task',
    weight: 40,
    label: {
      vi: 'Mời "việc nhẹ lương cao", kiếm tiền online dễ dàng',
      en: '"Easy job, high pay" online work offer',
    },
    groups: [
      [
        'viec nhe luong cao|kiem tien online|lam (viec )?tai nha (cung )?(kiem|thu nhap|nhan)|chi can (co )?(dien thoai|smartphone)|khong can kinh nghiem|thu nhap (khung|hap dan|cao|on dinh) (moi ngay|hang ngay)',
      ],
      [
        '\\d+ ?(k|nghin|ngan|trieu|tr)? ?(moi |1 |mot )?(ngay|gio|tuan)|thu nhap|hoa hong|nhan tin|zalo|telegram|lien he|cong tac vien',
        MOBILE,
      ],
    ],
    scammerGoal: {
      vi: 'Dụ bạn vào nhóm "làm việc online" rồi yêu cầu nạp tiền để nhận việc hoặc rút thưởng.',
      en: 'Lure you into an "online job" group, then make you deposit money to get tasks or withdraw earnings.',
    },
    advice: [
      {
        vi: 'Công việc thật không bắt bạn nạp tiền, mua hàng trước hay đóng phí để được nhận lương.',
        en: 'Real jobs never require you to deposit money, buy goods or pay fees before getting paid.',
      },
    ],
  },
  {
    id: 'task_scam',
    category: 'job_task',
    weight: 60,
    label: { vi: 'Lừa "làm nhiệm vụ" nhận hoa hồng', en: 'Task scam ("do missions for commission")' },
    groups: [
      [
        'lam nhiem vu|nhiem vu|nhan nv|tha tim|like (video|bai|page)|danh gia san pham|chot don|xem video (nhan|kiem)|nap tien (lam|de lam|nhan)|order (hang|san pham)',
      ],
      [
        'hoa hong|nap (tien|truoc|them|\\d+)|hoan (tien|lai|von)|nhan (lai|ve) \\d+|\\d+ ?(k|nghin|ngan|trieu|tr|%)|thuong|thu nhap',
      ],
    ],
    scammerGoal: {
      vi: 'Trả thưởng nhỏ lúc đầu để tạo lòng tin, sau đó bắt nạp số tiền ngày càng lớn rồi chiếm đoạt.',
      en: 'Pay small rewards first to build trust, then demand ever-larger deposits and disappear with them.',
    },
    advice: [
      {
        vi: 'Dừng ngay, không nạp thêm tiền dù được hứa "hoàn lại cả gốc lẫn lãi". Đây là kịch bản lừa đảo phổ biến nhất hiện nay.',
        en: 'Stop now and do not deposit more, even if promised your money back with interest. This is one of the most common scams today.',
      },
    ],
    policeWarned: {
      vi: 'lừa "làm nhiệm vụ" online: ban đầu trả thưởng nhỏ, sau đó yêu cầu nạp tiền ngày càng lớn rồi chiếm đoạt',
      en: 'online "task" scams that pay small rewards then demand growing deposits',
    },
  },
  {
    id: 'investment_crypto',
    category: 'investment',
    weight: 50,
    label: {
      vi: 'Mời đầu tư với lợi nhuận cam kết, "không rủi ro"',
      en: 'Investment offer with guaranteed, "risk-free" returns',
    },
    groups: [
      [
        'dau tu|chung khoan|co phieu|tien ao|tien dien tu|crypto|bitcoin|btc|usdt|forex|ngoai hoi|san (giao dich|dau tu)|coin|nhom (kin|vip|dau tu)|chuyen gia|tin hieu|invest|trading|signal',
      ],
      [
        'loi nhuan (dam bao|cam ket|on dinh|khung|\\d+)|cam ket (loi nhuan|lai|hoan von)|bao lo|khong (rui ro|lo)|lai (suat )?\\d+ ?% ?(moi |1 |mot )?(ngay|tuan|thang)|x ?\\d (tai khoan|von|so tien)|nhan (doi|gap doi|gap ba) (tai khoan|so tien|von)|chac chan (thang|lai|loi)|guaranteed|risk free|double your',
      ],
    ],
    scammerGoal: {
      vi: 'Dụ bạn nạp tiền vào "sàn" giả, cho thấy lãi ảo rồi không cho rút.',
      en: 'Get you to deposit into a fake trading platform that shows fake profits and blocks withdrawals.',
    },
    advice: [
      {
        vi: 'Không có khoản đầu tư hợp pháp nào cam kết lãi cao và không rủi ro. Không nạp tiền theo hướng dẫn của "chuyên gia" trong nhóm kín.',
        en: 'No legitimate investment guarantees high, risk-free returns. Do not deposit on the advice of "experts" in private groups.',
      },
    ],
    policeWarned: {
      vi: 'lừa đầu tư tiền ảo, chứng khoán, ngoại hối qua "chuyên gia" và "sàn" với lợi nhuận cam kết',
      en: 'crypto/forex/stock investment scams run through "experts" and fake platforms',
    },
  },
  {
    id: 'bank_account_locked',
    category: 'impersonation_bank',
    weight: 45,
    label: {
      vi: 'Báo tài khoản hoặc thẻ ngân hàng bị khóa để dụ xác thực',
      en: 'Claims your bank account/card is locked to make you "verify"',
    },
    groups: [
      [
        'tai khoan (cua )?(quy khach|ban|anh|chi|ong|ba)? ?(da |se )?(bi )?(khoa|tam khoa|dong bang|dinh chi|vo hieu|han che)|the (cua quy khach )?(da |se )?(bi )?(khoa|tam khoa)|giao dich (bat thuong|dang ngo)|xac thuc sinh trac hoc|sinh trac hoc|account (has been )?(locked|suspended|limited)|unusual activity',
      ],
      [
        'link|truy cap|bam vao|nhan vao|xac thuc|cap nhat|xac minh|dang nhap|cung cap|mo khoa|kich hoat|goi (lai|ngay)|verify|click|log ?in',
        URL,
      ],
    ],
    none: ['tren (ung dung|app) chinh thuc', 'khong bao gio (gui|yeu cau)'],
    scammerGoal: {
      vi: 'Dẫn bạn vào trang đăng nhập giả để lấy mật khẩu và mã OTP, rồi rút sạch tiền.',
      en: 'Send you to a fake login page to steal your password and OTP, then empty your account.',
    },
    advice: [
      {
        vi: 'Ngân hàng không gửi đường link qua tin nhắn. Hãy tự mở ứng dụng ngân hàng hoặc gọi số tổng đài in sau thẻ để kiểm tra.',
        en: 'Banks do not send links by SMS. Open your banking app yourself or call the hotline on the back of your card.',
      },
    ],
  },
  {
    id: 'otp_request',
    category: 'credential_theft',
    weight: 60,
    negatable: true,
    label: { vi: 'Đòi mã OTP hoặc mã xác thực', en: 'Asks for your OTP / verification code' },
    groups: [
      [
        '(cung cap|doc|gui|nhan lai|bao|xin|chup|chuyen tiep|forward|share|nhap|dien|cho) (lai |giup |ho )?(cho (em|anh|chi|minh|toi) |giup (em|anh|chi|minh) )?(lai )?(ma )?(otp|xac thuc|xac nhan)|ma (otp|xac thuc|xac nhan) (vua|da|moi) (gui|nhan|toi|ve)|send (me )?(the )?(otp|code|verification code)|(otp|ma) vua gui ve',
      ],
    ],
    scammerGoal: {
      vi: 'Lấy mã OTP để tự xác nhận giao dịch chuyển tiền từ tài khoản của bạn.',
      en: 'Get your OTP so they can approve transfers out of your account.',
    },
    advice: [
      {
        vi: 'Không bao giờ đọc hay gửi mã OTP cho bất kỳ ai, kể cả người xưng là nhân viên ngân hàng, công an hay người thân.',
        en: 'Never read out or send an OTP to anyone, including people claiming to be bank staff, police or family.',
      },
    ],
  },
  {
    id: 'credential_request',
    category: 'credential_theft',
    weight: 50,
    negatable: true,
    label: { vi: 'Đòi mật khẩu, mã PIN hoặc số thẻ', en: 'Asks for your password, PIN or card number' },
    groups: [
      [
        '(cung cap|gui|doc|cho|nhap|xin|bao) (lai |giup |ho )?(mat khau|password|ma pin|so the|ma cvv|cvv|ma bao mat)',
      ],
    ],
    advice: [
      {
        vi: 'Không ai có quyền hỏi mật khẩu, mã PIN hay mã CVV của bạn, kể cả ngân hàng.',
        en: 'No one, not even your bank, should ever ask for your password, PIN or CVV.',
      },
    ],
  },
  {
    id: 'loan_app',
    category: 'loan',
    weight: 40,
    label: { vi: 'Mời vay tiền dễ dãi, thu phí trước', en: 'Too-easy loan offer with upfront fees' },
    groups: [
      ['vay (tien|nhanh|online|tin chap|tieu dung)|ho tro vay|giai ngan|khoan vay|app vay|cho vay'],
      [
        'giai ngan (nhanh|ngay|trong)|khong (can )?(tham dinh|the chap|chung minh thu nhap|gap mat)|chi can (cccd|cmnd|can cuoc)|no xau (van|cung) (vay|duoc)|phi (ho so|bao hiem|giai ngan|xac minh|dich vu)|dong phi|nop phi|chuyen (truoc|phi)|duyet (nhanh|100)',
      ],
    ],
    scammerGoal: {
      vi: 'Thu "phí hồ sơ", "phí bảo hiểm khoản vay" rồi không giải ngân, hoặc lấy danh bạ để đòi nợ khủng bố.',
      en: 'Collect "processing" or "insurance" fees without ever lending, or harvest your contacts for harassment.',
    },
    advice: [
      {
        vi: 'Tổ chức cho vay hợp pháp không thu phí trước khi giải ngân. Chỉ vay qua ngân hàng hoặc công ty tài chính được cấp phép.',
        en: 'Licensed lenders do not charge fees before paying out. Borrow only from banks or licensed finance companies.',
      },
    ],
  },
  {
    id: 'prize_scam',
    category: 'prize',
    weight: 45,
    label: {
      vi: 'Báo trúng thưởng, nhận quà rồi đòi đóng phí',
      en: 'Fake prize or gift that requires a fee',
    },
    groups: [
      [
        'trung thuong|trung giai|nhan thuong|qua tri an|tri an khach hang|may man (duoc chon|trung)|giai thuong|phan thuong|you (have )?won|winner|prize',
      ],
      [
        'phi|thue|dong|nop|chuyen|thanh toan|link|truy cap|bam vao|nhan tin|lien he|xac nhan|cung cap|ket ban|zalo|claim|click',
        URL,
      ],
    ],
    scammerGoal: {
      vi: 'Bắt bạn đóng "phí nhận quà", "thuế thu nhập" hoặc nhập thông tin thẻ để nhận giải không có thật.',
      en: 'Make you pay a "delivery fee" or "income tax", or enter card details, for a prize that does not exist.',
    },
    advice: [
      {
        vi: 'Giải thưởng thật không bắt người trúng chuyển tiền trước. Hãy tự kiểm tra trên trang chính thức của nhãn hàng.',
        en: 'Real prizes never require winners to pay first. Check on the brand’s official site yourself.',
      },
    ],
    policeWarned: {
      vi: 'báo trúng thưởng, nhận quà tri ân rồi bắt đóng phí, thuế để nhận giải',
      en: 'fake prize notices demanding fees or taxes to claim',
    },
  },
  {
    id: 'delivery_fee',
    category: 'delivery',
    weight: 40,
    label: { vi: 'Giả đơn vị giao hàng đòi phí giao lại', en: 'Fake courier asking for a redelivery fee' },
    groups: [
      [
        'don hang|buu kien|buu pham|kien hang|giao hang|van chuyen|shipper|cod|hai quan|ma van don|parcel|package|delivery',
      ],
      [
        'khong thanh cong|that bai|bi giu|bi tam giu|sai dia chi|thieu (phi|thong tin)|phi (giao lai|giao hang|van chuyen|luu kho|hai quan|thong quan)|giao lai|tam giu|thong quan|failed|on hold|redelivery',
      ],
      ['phi|thanh toan|chuyen|nop|dong|link|truy cap|bam vao|cap nhat|xac nhan', URL],
    ],
    scammerGoal: {
      vi: 'Dụ bạn bấm link trả "phí giao lại" vài chục nghìn để lấy số thẻ, mã OTP.',
      en: 'Get you to click a link to pay a tiny "redelivery fee" so they can steal your card details and OTP.',
    },
    advice: [
      {
        vi: 'Kiểm tra đơn trực tiếp trong ứng dụng mua sắm hoặc ứng dụng của hãng vận chuyển, không bấm link trong tin nhắn.',
        en: 'Check the order in the shopping or courier app directly; do not click links in messages.',
      },
    ],
  },
  {
    id: 'refund_scam',
    category: 'ecommerce',
    weight: 40,
    label: {
      vi: 'Giả bên bán hàng "hoàn tiền" để lấy thông tin',
      en: 'Fake seller "refund" to steal details',
    },
    groups: [
      ['hoan tien|hoan lai tien|boi thuong|refund'],
      ['don hang|san pham|shop|mua hang|loi san pham|giao nham'],
      ['link|bam vao|truy cap|cung cap|so tai khoan|otp|zalo|ket ban|quet ma', URL],
    ],
    scammerGoal: {
      vi: 'Dẫn bạn vào trang "hoàn tiền" giả hoặc bắt quét mã để chuyển tiền ngược lại cho chúng.',
      en: 'Send you to a fake "refund" page or make you scan a code that actually sends them money.',
    },
    advice: [
      {
        vi: 'Hoàn tiền thật được xử lý ngay trong ứng dụng mua sắm, không cần bạn bấm link, cung cấp OTP hay kết bạn Zalo.',
        en: 'Real refunds happen inside the shopping app; they never need links, OTPs or chat-app contacts.',
      },
    ],
  },
  {
    id: 'romance_sugar',
    category: 'romance',
    weight: 40,
    label: {
      vi: 'Hẹn hò, "bao nuôi", gửi quà từ nước ngoài để đòi phí',
      en: 'Romance / "sugar" offer or overseas gift with fees',
    },
    groups: [
      [
        'sugar (baby|daddy|mommy|mom)|bao nuoi|nguoi yeu (nuoc ngoai|qua mang)|tro cap (hang )?thang|ket ban (bon phuong|nuoc ngoai)|qua tu nuoc ngoai|gui qua (tu nuoc ngoai|ve viet nam)|hen ho',
      ],
      ['chuyen|phi|nop|dong|hai quan|xac minh|coc|nap|thanh toan|tien'],
    ],
    scammerGoal: {
      vi: 'Tạo tình cảm hoặc hứa trợ cấp để bắt bạn đóng "phí xác minh", "phí hải quan".',
      en: 'Build a relationship or promise allowances, then demand "verification" or "customs" fees.',
    },
    advice: [
      {
        vi: 'Người thật lòng không bắt bạn trả phí để nhận tiền hay quà. Đừng chuyển tiền cho người chỉ quen qua mạng.',
        en: 'Someone who cares will not make you pay to receive money or gifts. Never send money to people you only know online.',
      },
    ],
  },
  {
    id: 'charity',
    category: 'charity',
    weight: 25,
    label: { vi: 'Kêu gọi quyên góp qua tài khoản cá nhân', en: 'Donation appeal to a personal account' },
    groups: [
      [
        'quyen gop|tu thien|ung ho|keu goi|chung tay|hoan canh (kho khan|dang thuong|ngheo)|benh hiem ngheo|ung thu|donate|charity',
      ],
      ['so tai khoan|chuyen khoan|gui ve|ung ho qua|chuyen tien|momo', BANK],
    ],
    advice: [
      {
        vi: 'Trước khi ủng hộ, hãy kiểm tra tổ chức hoặc người kêu gọi qua nguồn tin chính thống; ưu tiên tài khoản của tổ chức từ thiện được cấp phép.',
        en: 'Before donating, verify the person or organisation through trusted sources; prefer licensed charities’ accounts.',
      },
    ],
  },
  {
    id: 'emergency_accident',
    category: 'emergency',
    weight: 60,
    label: {
      vi: 'Báo người thân bị tai nạn, cấp cứu hoặc bị bắt để ép chuyển tiền gấp',
      en: 'Claims a relative is hurt or detained to demand urgent money',
    },
    groups: [
      [
        'cap cuu|tai nan|benh vien|phong mo|mo gap|bat coc|bi giu|tam giu|bi bat|nguy kich|hon me|chan thuong|accident|hospital|kidnap',
      ],
      [
        '(con|chau|chong|vo|bo|me|em|be) (cua )?(anh|chi|ban|ong|ba|co|chu|bac|em|a|c)? ?(dang|bi|da)|nguoi nha|than nhan|be nha|con (anh|chi|ban|a|c)|your (son|daughter|child)',
      ],
      [
        'chuyen (gap|ngay|tien|khoan|truoc)|tien (vien phi|mo|thuoc|phau thuat|chuoc|bao lanh)|dong (vien phi|tien)|vien phi|tam ung|so tai khoan|gui tien|send money',
        BANK,
      ],
    ],
    scammerGoal: {
      vi: 'Làm bạn hoảng loạn để chuyển tiền "viện phí" hoặc "tiền bảo lãnh" ngay, không kịp kiểm tra.',
      en: 'Panic you into paying "hospital fees" or "bail" at once, before you can check.',
    },
    advice: [
      {
        vi: 'Bình tĩnh, gọi ngay cho người thân đó hoặc thầy cô, bạn bè của họ qua số quen thuộc. Bệnh viện không yêu cầu chuyển tiền qua tài khoản cá nhân.',
        en: 'Stay calm and call the relative, or their teachers or friends, on numbers you know. Hospitals do not ask for transfers to personal accounts.',
      },
    ],
    policeWarned: {
      vi: 'báo tin con, người thân bị tai nạn đang cấp cứu hoặc bị bắt giữ để ép chuyển tiền gấp',
      en: 'calls claiming a child or relative is in hospital or detained, demanding urgent payment',
    },
  },
  {
    id: 'relative_impersonation',
    category: 'impersonation_relative',
    weight: 45,
    label: {
      vi: 'Giả người thân đổi số mới, mượn tiền gấp',
      en: 'Pretends to be a relative with a "new number" asking for money',
    },
    groups: [
      [
        'doi so|so moi|mat dien thoai|dien thoai (hong|hu|bi mat)|zalo moi|nick moi|tai khoan moi|dang (ban|hop)|dung goi (lai|dien)|khong nghe may duoc|nhan tin thoi',
      ],
      [
        'chuyen (giup|ho|gap|ngay|tien|khoan)|muon (tam|tien|gap)|gui (giup|ho|tien)|can gap|ung giup|cho (con|em|minh|anh|chi) muon|nap (giup|ho)|chuyen vao (tai khoan|so tai khoan)',
      ],
    ],
    scammerGoal: {
      vi: 'Giả làm người thân để bạn chuyển tiền mà không gọi lại kiểm tra.',
      en: 'Pose as family so you send money without calling back to check.',
    },
    advice: [
      {
        vi: 'Gọi lại cho người thân bằng số cũ quen thuộc hoặc hỏi một chuyện riêng chỉ hai người biết trước khi chuyển tiền.',
        en: 'Call your relative on their old, known number or ask something only they would know before sending money.',
      },
    ],
    policeWarned: {
      vi: 'giả làm người thân, bạn bè "đổi số mới", "mất điện thoại" rồi hỏi mượn tiền gấp',
      en: 'scammers posing as relatives with a "new number" asking to borrow money urgently',
    },
  },
  {
    id: 'deepfake_followup',
    category: 'impersonation_relative',
    weight: 45,
    label: {
      vi: 'Gọi video chập chờn rồi nhắn vay tiền (dấu hiệu deepfake)',
      en: 'Glitchy video call followed by a money request (deepfake sign)',
    },
    groups: [
      ['goi video|video call|facetime|vua goi (cho|video)|cuoc goi video'],
      [
        'mang (yeu|lag|cham|chap chon)|lag|chap chon|bi (dung|do|giat)|khong ro|tat (cam|camera)|song yeu|mat song',
      ],
      ['chuyen|muon|gui tien|nap|so tai khoan|can gap', BANK],
    ],
    scammerGoal: {
      vi: 'Dùng video giả mặt, giả giọng vài giây để bạn tin là người quen, rồi vay tiền.',
      en: 'Use a few seconds of fake face/voice video to convince you it is someone you know, then borrow money.',
    },
    advice: [
      {
        vi: 'Gọi lại bằng số điện thoại quen (cuộc gọi thường, không qua ứng dụng) và hỏi chuyện riêng. Cuộc gọi video ngắn, mờ, mất tiếng là dấu hiệu đáng ngờ.',
        en: 'Call back on the known number (regular call, not via an app) and ask a personal question. Short, blurry, silent video calls are a warning sign.',
      },
    ],
    policeWarned: {
      vi: 'dùng deepfake gọi video vài giây giả làm người quen rồi nhắn tin vay tiền',
      en: 'deepfake video calls of a few seconds impersonating acquaintances, followed by loan requests',
    },
  },
  {
    id: 'sim_swap',
    category: 'credential_theft',
    weight: 50,
    label: { vi: 'Giả nhà mạng nâng cấp hoặc khóa SIM', en: 'Fake carrier SIM upgrade / lock notice' },
    groups: [
      [
        'nang cap (sim|len 4g|len 5g|4g|5g)|sim (cua quy khach )?(da |se )?(bi )?(khoa|thu hoi)|doi sim|chuan hoa (thong tin )?(thue bao|sim)|thue bao (bi|se bi) (khoa|thu hoi|cat)|khoa 2 chieu|khoa hai chieu',
      ],
      [
        'soan (tin|tin nhan)|gui (den|toi|ve) \\d+|cu phap|doc (ma|otp)|cung cap|link|truy cap|bam|goi (lai|toi)|chup (anh|hinh)|cccd|can cuoc',
        URL,
      ],
    ],
    scammerGoal: {
      vi: 'Chiếm SIM của bạn để nhận mã OTP ngân hàng thay bạn.',
      en: 'Take over your SIM so they receive your bank OTPs.',
    },
    advice: [
      {
        vi: 'Nâng cấp SIM chỉ làm tại cửa hàng nhà mạng hoặc trong ứng dụng chính thức. Không soạn tin theo cú pháp lạ do người gọi hướng dẫn.',
        en: 'Upgrade your SIM only in a carrier store or the official app. Never send SMS commands a caller dictates.',
      },
    ],
    policeWarned: {
      vi: 'giả nhân viên nhà mạng "nâng cấp SIM 4G/5G" để chiếm SIM và nhận mã OTP ngân hàng',
      en: 'fake carrier staff offering "4G/5G SIM upgrades" to hijack SIMs and bank OTPs',
    },
  },
  {
    id: 'recovery_scam',
    category: 'recovery',
    weight: 55,
    label: { vi: 'Hứa lấy lại tiền đã bị lừa', en: 'Promises to recover money you lost to scammers' },
    groups: [
      [
        'lay lai (tien|so tien)|thu hoi (tien|so tien|tai san)|ho tro (lay lai|thu hoi)|hoan tra (tien|so tien) (bi lua|da mat)|recover (your )?(money|funds)',
      ],
      ['phi|nop|dong|chuyen|truoc|cam ket|100|hacker|luat su|lien he|zalo|telegram'],
    ],
    scammerGoal: {
      vi: 'Lừa lần hai những người vừa bị lừa bằng cách thu "phí dịch vụ" lấy lại tiền.',
      en: 'Scam victims a second time by charging "fees" to recover their money.',
    },
    advice: [
      {
        vi: 'Chỉ cơ quan công an mới có thẩm quyền điều tra và thu hồi tiền. Không ai "lấy lại tiền" được nếu bạn phải trả phí trước.',
        en: 'Only the police can investigate and recover funds. Anyone charging upfront to "recover" money is a scammer.',
      },
    ],
    policeWarned: {
      vi: 'hứa "lấy lại tiền bị lừa" nhưng bắt đóng phí trước (lừa đảo lần hai)',
      en: '"fund recovery" offers that charge upfront fees (second-wave scams)',
    },
  },
  {
    id: 'remote_access',
    category: 'malware',
    weight: 40,
    label: {
      vi: 'Dụ cài ứng dụng điều khiển từ xa hoặc file .apk',
      en: 'Asks you to install remote-control software or an .apk file',
    },
    groups: [
      [
        'teamviewer|anydesk|ultraviewer|rustdesk|airdroid|quicksupport|chia se man hinh|share man hinh|dieu khien tu xa|file apk|tai (file|tep) apk|cai apk|remote access|screen share',
      ],
    ],
    scammerGoal: {
      vi: 'Điều khiển điện thoại của bạn từ xa để tự chuyển tiền và đọc mã OTP.',
      en: 'Control your phone remotely to make transfers and read your OTPs themselves.',
    },
    advice: [
      {
        vi: 'Không cài ứng dụng theo hướng dẫn của người lạ. Nếu đã cài, hãy tắt mạng, gỡ ứng dụng và báo ngay cho ngân hàng.',
        en: 'Never install apps a stranger tells you to. If you did, switch off data, uninstall it and call your bank immediately.',
      },
    ],
  },
  {
    id: 'wedding_apk',
    category: 'malware',
    weight: 65,
    label: {
      vi: 'Thiệp cưới online kèm file cài đặt (.apk)',
      en: 'Online wedding invitation that is an installer (.apk)',
    },
    groups: [
      [
        'thiep (moi|cuoi|moi cuoi|moi dam cuoi)|moi (cuoi|dam cuoi|du dam cuoi|tiec cuoi)|dam cuoi|le cuoi|thu moi|wedding',
      ],
      ['apk|tai (ve|file|thiep|app|ung dung)|cai (dat )?(ung dung|app|file)|mo file'],
    ],
    scammerGoal: {
      vi: 'Cài mã độc vào điện thoại qua "thiệp mời" để đọc tin nhắn OTP và chiếm tài khoản ngân hàng.',
      en: 'Install malware through a fake invitation to read OTP messages and take over bank accounts.',
    },
    advice: [
      {
        vi: 'Thiệp mời thật không cần cài ứng dụng. Không mở file .apk; hỏi lại người gửi bằng cuộc gọi.',
        en: 'Real invitations never need an app. Do not open .apk files; check with the sender by phone.',
      },
    ],
    policeWarned: {
      vi: 'gửi "thiệp mời đám cưới online" là file .apk chứa mã độc chiếm tài khoản',
      en: '"online wedding invitations" that are malicious .apk files',
    },
  },
  {
    id: 'wedding_link',
    category: 'malware',
    weight: 20,
    label: { vi: 'Thiệp mời qua đường link lạ', en: 'Invitation delivered via an unknown link' },
    groups: [
      ['thiep (moi|cuoi|moi cuoi|moi dam cuoi)|moi (cuoi|dam cuoi|du dam cuoi|tiec cuoi)|thu moi|wedding'],
      ['xem (thiep|chi tiet)|link|bam vao', URL],
    ],
    advice: [
      {
        vi: 'Nếu link mở ra yêu cầu tải ứng dụng hay đăng nhập, hãy dừng lại và hỏi lại người gửi.',
        en: 'If the link asks you to download an app or log in, stop and check with the sender.',
      },
    ],
  },
  {
    id: 'bank_staff',
    category: 'impersonation_bank',
    weight: 40,
    label: {
      vi: 'Giả nhân viên ngân hàng mời nâng hạn mức, mở thẻ',
      en: 'Fake bank staff offering limit increases or new cards',
    },
    groups: [
      [
        '(nhan vien|can bo|tong dai vien) (ngan hang|ho tro|cham soc khach hang)|tong dai (ngan hang|ho tro)|ngan hang (thong bao|ho tro)',
      ],
      [
        'nang (cap|han muc)|mo the|the tin dung|tang han muc|rut tien the|hoan phi|giam lai suat|he thong (dang )?nang cap|cap nhat|xac thuc|ho tro',
      ],
      ['otp|ma xac thuc|link|bam|truy cap|cung cap|ung dung|app|zalo', URL],
    ],
    scammerGoal: {
      vi: 'Lấy mã OTP hoặc thông tin thẻ với cớ "nâng hạn mức", "mở thẻ".',
      en: 'Get your OTP or card details under the pretext of "raising your limit" or "opening a card".',
    },
    advice: [
      {
        vi: 'Mọi thay đổi về thẻ, hạn mức hãy làm trong ứng dụng ngân hàng hoặc tại quầy giao dịch.',
        en: 'Make any card or limit changes in your banking app or at a branch.',
      },
    ],
    policeWarned: {
      vi: 'giả nhân viên ngân hàng mời nâng hạn mức, mở thẻ tín dụng để lấy mã OTP',
      en: 'fake bank staff offering credit limit increases to obtain OTPs',
    },
  },
  {
    id: 'traffic_fine',
    category: 'impersonation_authority',
    weight: 45,
    label: {
      vi: 'Báo "phạt nguội" giả, đòi nộp phạt qua link',
      en: 'Fake traffic fine demanding payment via link',
    },
    groups: [
      ['phat nguoi|vi pham giao thong|nop phat|bien ban vi pham|csgt|canh sat giao thong|dang kiem'],
      ['link|truy cap|bam vao|nop (phat|tien)|chuyen|thanh toan|cai (ung dung|app)|zalo', URL],
    ],
    scammerGoal: {
      vi: 'Dụ bạn nộp "tiền phạt" vào tài khoản của chúng hoặc nhập thông tin thẻ.',
      en: 'Get you to pay a "fine" into their account or enter card details.',
    },
    advice: [
      {
        vi: 'Tra cứu phạt nguội trên trang csgt.vn hoặc ứng dụng VNeID; tiền phạt chỉ nộp qua Cổng dịch vụ công hoặc kho bạc.',
        en: 'Check fines on csgt.vn or the VNeID app; fines are paid only through the National Public Service Portal or the treasury.',
      },
    ],
    policeWarned: {
      vi: 'báo "phạt nguội" giả, yêu cầu nộp phạt qua link hoặc ứng dụng lạ',
      en: 'fake traffic-fine notices requesting payment via links or unknown apps',
    },
  },
  {
    id: 'account_trade',
    category: 'account_trade',
    weight: 40,
    label: {
      vi: 'Mua bán, cho thuê tài khoản ngân hàng hoặc CCCD',
      en: 'Buying/renting bank accounts or ID cards',
    },
    groups: [
      [
        '(cho )?thue (tai khoan|so tai khoan|tai khoan ngan hang)|mua (tai khoan|so tai khoan|cccd|can cuoc)|ban (tai khoan|so tai khoan|cccd)|mo tai khoan ho',
      ],
    ],
    advice: [
      {
        vi: 'Cho thuê hoặc bán tài khoản ngân hàng là vi phạm pháp luật; tài khoản đó sẽ bị dùng để nhận tiền lừa đảo và bạn có thể bị liên đới.',
        en: 'Renting or selling bank accounts is illegal; they are used to receive scam money and you may be held liable.',
      },
    ],
  },

  // ----------------------------------------------------------- generic tactics
  {
    id: 'urgency',
    category: 'tactic',
    tactic: 'urgency',
    weight: 10,
    label: { vi: 'Hối thúc phải làm ngay', en: 'Pressures you to act immediately' },
    groups: [
      [
        'chuyen gap|rat gap|gap lam|gap gap|can gap tien|xu ly gap|ngay lap tuc|khan cap|ngay hom nay|trong (vong )?\\d+ ?(h|gio|phut|ngay)|truoc \\d+ ?(h|gio)|het han|lan cuoi|ngay bay gio|urgent|immediately|within \\d+ hours|asap',
      ],
    ],
  },
  {
    id: 'secrecy',
    category: 'tactic',
    tactic: 'secrecy',
    weight: 20,
    label: {
      vi: 'Yêu cầu giữ bí mật, không cho người thân biết',
      en: 'Asks you to keep it secret from family',
    },
    groups: [
      [
        'giu bi mat|tuyet doi bi mat|khong (duoc )?(noi|ke|tiet lo|chia se|bao) (voi|cho) (ai|bat ky ai|nguoi nha|nguoi than|gia dinh)|dung (noi|ke|bao) (voi|cho) (ai|nguoi nha|nguoi than)|dont tell',
      ],
    ],
  },
  {
    id: 'threat',
    category: 'tactic',
    tactic: 'threat',
    weight: 15,
    label: { vi: 'Đe dọa phạt, bắt giữ, khóa tài khoản', en: 'Threatens fines, arrest or account closure' },
    groups: [
      [
        'truy cuu trach nhiem|xu ly theo (quy dinh )?phap luat|bi phat|khoi to|bi bat|phong toa|khoa vinh vien|cuong che|thu hoi (sim|tai khoan)|legal action',
      ],
    ],
  },
  {
    id: 'payment_request',
    category: 'tactic',
    tactic: 'payment_request',
    weight: 10,
    label: { vi: 'Yêu cầu chuyển tiền hoặc đóng phí', en: 'Asks you to transfer money or pay a fee' },
    groups: [[MONEY]],
  },
  {
    id: 'link_action',
    category: 'tactic',
    tactic: 'link_click',
    weight: 10,
    label: { vi: 'Giục bấm vào đường link', en: 'Urges you to click a link' },
    groups: [
      [
        'bam vao (link|duong link|duong dan|day)|truy cap (link|duong link|duong dan|vao|ngay)|nhan vao (link|day|duong dan)|click (vao|link|here)|vao link',
      ],
      [URL, 'link'],
    ],
  },
  {
    id: 'personal_data',
    category: 'tactic',
    tactic: 'personal_data_request',
    weight: 25,
    negatable: true,
    label: {
      vi: 'Đòi ảnh CCCD, ảnh khuôn mặt hoặc thông tin cá nhân',
      en: 'Asks for ID photos, face photos or personal data',
    },
    groups: [
      [
        '(cung cap|gui|chup) (lai )?(anh |hinh )?(cccd|can cuoc|cmnd|giay to|mat truoc|mat sau|so the|thong tin ca nhan|anh chan dung|khuon mat)|quay video (khuon mat|chan dung)|xac thuc khuon mat',
      ],
    ],
  },
];

/** Rules whose presence + a payment request means "an authority wants money in a personal account". */
export const AUTHORITY_RULES = new Set([
  'fake_authority',
  'vneid_update',
  'tax_scam',
  'evn_power_cut',
  'traffic_fine',
]);

export const LINK_ACTION_SRC = LINK_ACTION;
