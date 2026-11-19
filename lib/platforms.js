// ตัวโพสต์ต่อแพลตฟอร์ม
// PLATFORM_MODE=mock (ค่าเริ่มต้น) → จำลองการโพสต์ ไม่ส่งออกอินเทอร์เน็ต
// PLATFORM_MODE=live → ต้องเขียน/ตั้งค่าตัวเชื่อม API จริง (ดู README)
import { decryptToken } from './security.js';
import * as facebook from './facebook.js';

export const PLATFORMS = {
  tiktok: { label: 'TikTok', maxCaption: 2200, supportsCart: true },
  facebook: { label: 'Facebook (เพจ)', maxCaption: 5000, supportsCart: false },
  instagram: { label: 'Instagram', maxCaption: 2200, supportsCart: false },
};

export const MODE = process.env.PLATFORM_MODE || 'mock';

export function buildCaption(platform, { caption, hashtags, productUrl }) {
  const parts = [caption?.trim()];
  // TikTok/Instagram ลิงก์ในแคปชันกดไม่ได้ จึงใส่เป็นข้อความอ้างอิงเท่านั้น
  if (productUrl) parts.push(`🛒 สั่งซื้อ: ${productUrl}`);
  if (hashtags?.length) parts.push(hashtags.map((h) => `#${h.replace(/^#/, '')}`).join(' '));
  const text = parts.filter(Boolean).join('\n\n');
  const max = PLATFORMS[platform].maxCaption;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const mock = {
  async publish({ platform, account, caption, clip, cartProductId }) {
    decryptToken(account.tokenEnc); // ตรวจว่าโทเคนถอดรหัสได้จริง
    await new Promise((r) => setTimeout(r, 400));
    if (Math.random() < Number(process.env.MOCK_FAIL_RATE || 0)) {
      throw new Error('[mock] แพลตฟอร์มตอบกลับผิดพลาดชั่วคราว');
    }
    const postId = `mock${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const base = { tiktok: 'https://www.tiktok.com/@', facebook: 'https://facebook.com/', instagram: 'https://instagram.com/reel/' }[platform];
    return {
      postId,
      url: `${base}${platform === 'instagram' ? '' : account.handle + '/video/'}${postId}`,
      note: `mock: ${clip.title} (${caption.length} ตัวอักษร)${cartProductId ? ` + ตะกร้า ${cartProductId}` : ''}`,
    };
  },
};

const notImplemented = {
  async publish({ platform }) {
    throw Object.assign(new Error(`ยังไม่รองรับการโพสต์จริงของ ${PLATFORMS[platform].label} (ดู README)`), { permanent: true });
  },
};

// เลือกตัวโพสต์ตามบัญชี: บัญชีจำลอง → mock, บัญชีที่เชื่อมจริง → ตัวเชื่อมของแพลตฟอร์มนั้น
const LIVE = { facebook: facebook, tiktok: notImplemented, instagram: notImplemented };
export const publish = (ctx) => (ctx.account.mock ? mock : LIVE[ctx.platform]).publish(ctx);

// ข้อกำหนดคลิปของแต่ละแพลตฟอร์ม (ตรวจตอนตั้งเวลา เพื่อไม่ให้รู้ว่าพลาดตอนโพสต์)
export function clipProblem(platform, clip) {
  if (platform === 'facebook') {
    if (clip.duration != null && (clip.duration < 3 || clip.duration > 90)) return `Facebook Reels รองรับคลิปยาว 3–90 วินาที (คลิป "${clip.title}" ยาว ${clip.duration} วินาที)`;
    if (clip.width && clip.height && (clip.width < 540 || clip.height < 960 || Math.abs(clip.width / clip.height - 9 / 16) > 0.02)) return `Facebook Reels ต้องเป็นแนวตั้ง 9:16 ขั้นต่ำ 540×960 (คลิป "${clip.title}" คือ ${clip.width}×${clip.height})`;
  }
  return null;
}
