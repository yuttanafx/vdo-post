// ตัวโพสต์ตามเวลา: ตรวจคิวทุก 10 วินาที โพสต์รายการที่ถึงเวลา
import path from 'node:path';
import * as store from './store.js';
import { publish, buildCaption } from './platforms.js';

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5 * 60 * 1000;
let running = false;

export function recoverStuck() {
  // ถ้าเซิร์ฟเวอร์ดับกลางทาง รายการที่ค้าง "กำลังโพสต์" ให้กลับไปรอใหม่
  for (const p of store.where('posts', (x) => x.status === 'posting')) {
    store.update('posts', p.id, { status: 'scheduled' });
  }
}

async function publishOne(post) {
  const clip = store.find('clips', post.clipId);
  const account = store.find('accounts', post.accountId);
  if (!clip || !account) {
    store.update('posts', post.id, { status: 'failed', error: 'คลิปหรือบัญชีถูกลบไปแล้ว' });
    return;
  }
  // store.update แก้อ็อบเจ็กต์เดิมตรง ๆ จึงต้องอ่านค่าก่อนแก้ ไม่งั้นนับซ้ำ
  const attempts = post.attempts + 1;
  store.update('posts', post.id, { status: 'posting', attempts });
  try {
    const caption = buildCaption(post.platform, { caption: post.caption, hashtags: clip.hashtags, productUrl: post.productUrl });
    const result = await publish({
      platform: post.platform,
      account,
      clip,
      filePath: path.join(store.DATA_DIR, 'uploads', clip.file),
      caption,
      productUrl: post.productUrl,
      cartProductId: post.cartProductId,
    });
    store.update('posts', post.id, { status: 'posted', postedAt: new Date().toISOString(), result, error: null });
  } catch (err) {
    if (err.needsReauth) store.update('accounts', account.id, { needsReauth: true });
    // permanent = ลองซ้ำก็ไม่หาย, noRetry = แพลตฟอร์มรับงานไปแล้ว ลองซ้ำจะโพสต์ซ้ำ
    if (!err.permanent && !err.noRetry && attempts < MAX_ATTEMPTS) {
      store.update('posts', post.id, {
        status: 'scheduled',
        scheduledAt: new Date(Date.now() + RETRY_DELAY_MS).toISOString(),
        error: `ครั้งที่ ${attempts}: ${err.message} (จะลองใหม่ใน 5 นาที)`,
      });
    } else {
      store.update('posts', post.id, { status: 'failed', error: err.message });
    }
  }
}

export async function tick() {
  if (running) return;
  running = true;
  try {
    const now = Date.now();
    const due = store.where('posts', (p) => p.status === 'scheduled' && Date.parse(p.scheduledAt) <= now);
    due.sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));
    for (const p of due) await publishOne(p);
  } finally {
    running = false;
  }
}

export function startWorker(intervalMs = 10000) {
  recoverStuck();
  const t = setInterval(() => tick().catch((e) => console.error('worker error', e)), intervalMs);
  t.unref?.();
  tick().catch(() => {});
  return t;
}
