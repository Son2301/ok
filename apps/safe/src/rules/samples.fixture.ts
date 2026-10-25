/**
 * Realistic Vietnamese scam and benign messages used by the rule-engine tests.
 * Phone numbers / accounts are made up. `expect` lists rule ids that must fire.
 */
export interface ScamSample {
  name: string;
  text: string;
  expect: string[];
  /** Minimum combined rule score. */
  minScore?: number;
}

export const SCAM_SAMPLES: ScamSample[] = [
  {
    name: 'fake police summons (diacritics)',
    text: 'Đây là Công an quận Hoàn Kiếm. Anh/chị có liên quan đến một vụ án rửa tiền, đề nghị lên trụ sở làm việc theo giấy triệu tập. Nếu không muốn bị bắt, hãy chuyển tiền vào tài khoản tạm giữ để xác minh. Tuyệt đối giữ bí mật.',
    expect: ['fake_authority', 'secrecy'],
    minScore: 75,
  },
  {
    name: 'fake police (no diacritics)',
    text: 'Cong an TP thong bao: ban lien quan duong day rua tien, yeu cau chuyen toan bo tien vao tai khoan an toan de dieu tra, khong duoc noi voi ai.',
    expect: ['fake_authority', 'secrecy'],
    minScore: 75,
  },
  {
    name: 'VNeID level 2',
    text: 'Bộ Công an thông báo: tài khoản định danh điện tử của bạn chưa được cập nhật định danh mức 2, sẽ bị khóa sau 24h. Truy cập vneid-capnhat.com để kích hoạt ngay.',
    expect: ['vneid_update'],
    minScore: 50,
  },
  {
    name: 'tax app',
    text: 'Cục Thuế thông báo: Ông/bà còn nợ thuế 3.250.000đ. Vui lòng cài đặt ứng dụng Thuế điện tử tại link http://etax-gdt.top/app.apk để quyết toán, quá hạn sẽ bị phạt.',
    expect: ['tax_scam'],
    minScore: 45,
  },
  {
    name: 'EVN power cut',
    text: 'EVN thông báo: Quý khách chưa thanh toán tiền điện tháng 10, hệ thống sẽ ngừng cấp điện lúc 20h tối nay. Liên hệ nhân viên 0899.123.456 để thanh toán ngay.',
    expect: ['evn_power_cut'],
    minScore: 50,
  },
  {
    name: 'easy job teencode',
    text: 'Tuyển CTV làm việc nhẹ lương cao tại nhà, chỉ cần điện thoại, thả tim tiktok nhận hh 300k-500k/ngày. ib zalo 0987654321 để nhận nv.',
    expect: ['job_easy_money', 'task_scam'],
    minScore: 60,
  },
  {
    name: 'task scam deposit',
    text: 'Chào bạn, bạn đã hoàn thành nhiệm vụ 1 nhận 50k. Nhiệm vụ 2 cần nạp 500k để nhận lại 650k, hoàn tiền ngay sau 5 phút.',
    expect: ['task_scam'],
    minScore: 55,
  },
  {
    name: 'investment guaranteed',
    text: 'Tham gia nhóm đầu tư chứng khoán cùng chuyên gia, cam kết lợi nhuận 30%/tháng, không rủi ro, bao lỗ 100%. Nạp USDT vào sàn ngay hôm nay.',
    expect: ['investment_crypto'],
    minScore: 50,
  },
  {
    name: 'crypto no diacritics',
    text: 'dau tu tien ao loi nhuan dam bao x3 tai khoan trong 7 ngay, lien he telegram @coin_vip',
    expect: ['investment_crypto'],
    minScore: 50,
  },
  {
    name: 'bank locked with link (no diacritics)',
    text: 'Vietcombank: Tai khoan cua quy khach da bi tam khoa do phat hien giao dich bat thuong. Vui long xac thuc tai https://vietcombank-xacthuc.com de mo khoa trong 24h.',
    expect: ['bank_account_locked', 'urgency'],
    minScore: 45,
  },
  {
    name: 'OTP request from fake bank staff',
    text: 'Em là nhân viên ngân hàng, hệ thống đang nâng cấp, anh đọc giúp em mã OTP vừa gửi về điện thoại để hoàn tất nhé.',
    expect: ['otp_request'],
    minScore: 60,
  },
  {
    name: 'OTP teencode',
    text: 'a ơi cho e xin lại mã 0TP vừa gửi về máy a với, e gửi nhầm số',
    expect: ['otp_request'],
    minScore: 60,
  },
  {
    name: 'loan app fee',
    text: 'Vay tiền nhanh online giải ngân trong 5 phút, không thẩm định, nợ xấu vẫn vay được, chỉ cần CCCD. Phí hồ sơ 500k chuyển trước.',
    expect: ['loan_app'],
    minScore: 40,
  },
  {
    name: 'prize with fee',
    text: 'Chúc mừng quý khách đã trúng thưởng xe SH 150i trong chương trình tri ân khách hàng của Shopee. Vui lòng nộp phí vận chuyển 2.000.000đ để nhận giải.',
    expect: ['prize_scam'],
    minScore: 45,
  },
  {
    name: 'prize no diacritics',
    text: 'chuc mung ban da trung thuong iphone 15, vui long dong thue thu nhap ca nhan 10% de nhan qua',
    expect: ['prize_scam'],
    minScore: 45,
  },
  {
    name: 'prize split letters',
    text: 'C.h.ú.c m.ừ.n.g bạn đã T.R.Ú.N.G T.H.Ư.Ở.N.G 100tr, nh4n qu4 tại link sau',
    expect: ['prize_scam'],
    minScore: 45,
  },
  {
    name: 'delivery redelivery fee',
    text: 'Đơn hàng của bạn giao không thành công do sai địa chỉ. Vui lòng thanh toán phí giao lại 25.000đ tại ghn-giaohang.top để nhận hàng.',
    expect: ['delivery_fee'],
    minScore: 40,
  },
  {
    name: 'sugar daddy',
    text: 'Anh là sugar daddy đang tìm sugar baby, bao nuôi 30tr/tháng. Em chỉ cần chuyển phí xác minh 2tr để anh gửi tiền trợ cấp.',
    expect: ['romance_sugar'],
    minScore: 40,
  },
  {
    name: 'charity to personal account',
    text: 'Kêu gọi quyên góp ủng hộ bé Na bị ung thư giai đoạn cuối, hoàn cảnh rất khó khăn. Mọi tấm lòng xin gửi về STK 0123456789 MB Bank - NGUYEN VAN A.',
    expect: ['charity'],
    minScore: 25,
  },
  {
    name: 'child in emergency room',
    text: 'Chị ơi con chị bị tai nạn đang cấp cứu ở bệnh viện, cần mổ gấp, chị chuyển ngay 50 triệu tiền viện phí vào số tài khoản của bác sĩ nhé.',
    expect: ['emergency_accident'],
    minScore: 60,
  },
  {
    name: 'relative new number',
    text: 'Mẹ ơi con đổi số rồi, đây là số mới của con. Mẹ chuyển giúp con 5 triệu vào tài khoản này, con đang cần gấp, đừng gọi lại nhé con đang họp.',
    expect: ['relative_impersonation'],
    minScore: 45,
  },
  {
    name: 'deepfake video follow-up',
    text: 'Anh vừa gọi video cho em đó, mạng yếu nên bị lag. Em chuyển gấp cho anh 20tr vào STK này nhé, mai anh trả.',
    expect: ['deepfake_followup'],
    minScore: 45,
  },
  {
    name: 'SIM 4G upgrade',
    text: 'Nhân viên nhà mạng: em hỗ trợ nâng cấp sim 4G miễn phí, anh soạn tin nhắn theo cú pháp DK gửi 999 rồi đọc mã cho em.',
    expect: ['sim_swap'],
    minScore: 50,
  },
  {
    name: 'recovery scam',
    text: 'Bạn bị lừa đảo qua mạng? Chúng tôi hỗ trợ lấy lại tiền bị lừa 100%, chỉ cần đóng phí trước 10%.',
    expect: ['recovery_scam'],
    minScore: 55,
  },
  {
    name: 'remote access app',
    text: 'Cán bộ hướng dẫn: Anh cài ứng dụng AnyDesk để em hỗ trợ cập nhật thông tin trên điện thoại nhé.',
    expect: ['remote_access'],
    minScore: 40,
  },
  {
    name: 'wedding invitation apk',
    text: 'Bạn ơi, mời bạn dự đám cưới của mình, xem thiệp mời tại file thiepcuoi.apk nhé, tải về cài đặt để xem.',
    expect: ['wedding_apk'],
    minScore: 60,
  },
  {
    name: 'English phishing',
    text: 'Your PayPal account has been limited due to unusual activity. Verify your identity at http://paypal-secure-login.xyz within 24 hours.',
    expect: ['bank_account_locked', 'urgency'],
    minScore: 45,
  },
  {
    name: 'traffic fine',
    text: 'CSGT thông báo: phương tiện của bạn có biên bản vi phạm giao thông chưa nộp phạt. Truy cập csgt-tracuu.top để nộp phạt trước 17h.',
    expect: ['traffic_fine'],
    minScore: 45,
  },
];

export const BENIGN_SAMPLES: string[] = [
  'Tối nay mấy giờ con về ăn cơm? Mẹ nấu canh chua nhé.',
  'Anh ơi mai họp lúc 9h ở phòng 302 nha, nhớ mang laptop.',
  'Vietcombank thông báo: TK 0011xxxx789 +5,000,000VND lúc 10:15 25/10. SD: 12,345,678VND. ND: LUONG THANG 10',
  'Mã OTP của bạn là 123456. Tuyệt đối không cung cấp mã này cho bất kỳ ai, kể cả nhân viên ngân hàng.',
  'Đơn hàng #SPX123 của bạn đã được giao thành công. Cảm ơn bạn đã mua sắm tại Shopee!',
  'Chị gửi em tiền học tháng 11 nhé, em kiểm tra tài khoản giúp chị.',
  'Cuối tuần này cả nhà đi Vũng Tàu không? Anh đặt phòng rồi.',
  'Công an phường thông báo: tối nay 19h họp tổ dân phố tại nhà văn hóa khu phố 3, mời bà con đến đông đủ.',
  'EVN thông báo lịch tạm ngừng cung cấp điện để bảo trì lưới điện: 8h-12h ngày 27/10 tại khu vực phường 5.',
  'Chúc mừng sinh nhật em! Chúc em tuổi mới nhiều niềm vui và sức khỏe.',
  'Bạn ơi cho mình hỏi đường đến bệnh viện Chợ Rẫy với, mình đang ở quận 5.',
  'Mai em đi phỏng vấn công việc mới, lương cũng ổn chị ạ.',
  'Hi, are we still on for lunch tomorrow at 12?',
  'Mời anh chị đến dự lễ cưới của chúng em vào 11h ngày 10/11 tại nhà hàng Hoa Sen.',
  'Ma OTP de xac nhan giao dich chuyen tien la 482910. Khong chia se ma OTP vua nhan duoc cho bat ky ai.',
  'Mai gặp nhau ở quán cà phê cũ nhé, anh đến lúc 8h.',
];
