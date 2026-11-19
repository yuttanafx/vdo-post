// Facebook: OAuth เชื่อมเพจ + โพสต์ Reels ลงเพจผ่าน Graph API
// อ้างอิงขั้นตอน Reels Publishing API ของ Meta: start → อัปโหลดไบนารีไป rupload → finish → ตรวจสถานะ
// หมายเหตุ: ยังไม่เคยทดสอบกับ Facebook จริง (ทดสอบกับ Graph API จำลองใน test/facebook.mjs)
// ตรวจเอกสารล่าสุดก่อนใช้งาน: https://developers.facebook.com/docs/video-api/guides/reels-publishing
import fs from 'node:fs';
import { decryptToken } from './security.js';

export const FB_SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'publish_video'];

const cfg = () => ({
  appId: process.env.FB_APP_ID,
  secret: process.env.FB_APP_SECRET,
  redirect: process.env.FB_REDIRECT_URI,
  base: (process.env.FB_GRAPH_BASE || 'https://graph.facebook.com').replace(/\/$/, ''),
  dialog: (process.env.FB_DIALOG_BASE || 'https://www.facebook.com').replace(/\/$/, ''),
  ver: process.env.FB_GRAPH_VERSION || 'v23.0',
  pollMs: Number(process.env.FB_POLL_MS || 5000),
  pollMax: Number(process.env.FB_POLL_MAX || 36), // 36 × 5 วินาที = 3 นาที
});

export const fbConfigured = () => { const c = cfg(); return Boolean(c.appId && c.secret && c.redirect); };

// รหัส error ของ Graph ที่ลองซ้ำก็ไม่หาย (โทเคนหมดอายุ/สิทธิ์ไม่พอ/พารามิเตอร์ผิด)
const PERMANENT_CODES = new Set([10, 100, 190, 200, 283, 368, 1366046]);

function graphError(e, status) {
  const code = e?.code;
  const err = new Error(`Facebook: ${e?.message || `HTTP ${status}`}${code ? ` (code ${code})` : ''}`);
  err.permanent = PERMANENT_CODES.has(code) || (status >= 400 && status < 500 && status !== 429 && code == null);
  err.needsReauth = code === 190;
  return err;
}

async function graph(method, pathname, params, token) {
  const c = cfg();
  const url = new URL(`${c.base}/${c.ver}${pathname}`);
  const all = { ...params, ...(token ? { access_token: token } : {}) };
  let body;
  if (method === 'GET') for (const [k, v] of Object.entries(all)) url.searchParams.set(k, v);
  else body = new URLSearchParams(all);
  const res = await fetch(url, { method, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw graphError(data.error, res.status);
  return data;
}

// ---------- OAuth ----------
export function authUrl(state) {
  const c = cfg();
  const u = new URL(`${c.dialog}/${c.ver}/dialog/oauth`);
  u.search = new URLSearchParams({ client_id: c.appId, redirect_uri: c.redirect, state, scope: FB_SCOPES.join(','), response_type: 'code' }).toString();
  return u.toString();
}

// แลก code → โทเคนผู้ใช้อายุยาว → รายการเพจพร้อมโทเคนเพจ (โทเคนเพจจากโทเคนอายุยาวไม่หมดอายุตามเวลา)
export async function pagesFromCode(code) {
  const c = cfg();
  const short = await graph('GET', '/oauth/access_token', { client_id: c.appId, client_secret: c.secret, redirect_uri: c.redirect, code });
  const long = await graph('GET', '/oauth/access_token', { grant_type: 'fb_exchange_token', client_id: c.appId, client_secret: c.secret, fb_exchange_token: short.access_token });
  const pages = await graph('GET', '/me/accounts', { fields: 'id,name,access_token', limit: 100 }, long.access_token);
  return (pages.data || []).filter((p) => p.id && p.access_token).map((p) => ({ id: p.id, name: p.name, token: p.access_token }));
}

// ---------- Reels ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function videoState(status = {}) {
  const phases = [status.uploading_phase, status.processing_phase, status.publishing_phase];
  if (status.video_status === 'error' || phases.some((p) => p?.status === 'error')) return 'error';
  if (status.video_status === 'ready' || status.publishing_phase?.status === 'complete') return 'ready';
  return 'processing';
}

export async function publish({ account, filePath, caption }) {
  const c = cfg();
  const token = decryptToken(account.tokenEnc);
  const pageId = account.meta?.pageId;
  if (!pageId) throw Object.assign(new Error('บัญชีนี้ไม่มีรหัสเพจ ให้เชื่อมใหม่'), { permanent: true });

  // 1) เริ่มเซสชันอัปโหลด
  const start = await graph('POST', `/${pageId}/video_reels`, { upload_phase: 'start' }, token);
  if (!start.video_id || !start.upload_url) throw new Error('Facebook ไม่ส่ง video_id/upload_url กลับมา');

  // 2) อัปโหลดไฟล์ (ไฟล์เดียว ไม่แบ่งชิ้น)
  const buf = await fs.promises.readFile(filePath);
  const up = await fetch(start.upload_url, { method: 'POST', headers: { Authorization: `OAuth ${token}`, offset: '0', file_size: String(buf.length) }, body: buf });
  const upData = await up.json().catch(() => ({}));
  if (!up.ok || upData.success === false || upData.error) throw graphError(upData.error || { message: `อัปโหลดไฟล์ไม่สำเร็จ (HTTP ${up.status})` }, up.status);

  // 3) สั่งเผยแพร่ — เวลาตามคิวของเราเอง จึงโพสต์ทันที (PUBLISHED)
  await graph('POST', `/${pageId}/video_reels`, { upload_phase: 'finish', video_id: start.video_id, video_state: 'PUBLISHED', description: caption }, token);

  // ผ่านขั้นนี้แล้ว Facebook รับงานไปแล้ว ห้ามลองใหม่เด็ดขาด ไม่งั้นโพสต์ซ้ำ
  try {
    let state = 'processing';
    for (let i = 0; i < c.pollMax && state === 'processing'; i++) {
      const s = await graph('GET', `/${start.video_id}`, { fields: 'status' }, token);
      state = videoState(s.status);
      if (state === 'processing') await sleep(c.pollMs);
    }
    if (state === 'error') throw new Error('Facebook ประมวลผลวิดีโอไม่ผ่าน (อาจไม่ตรงข้อกำหนด Reels: 9:16, 3–90 วินาที, อย่างน้อย 540×960)');
    let url = `https://www.facebook.com/reel/${start.video_id}`;
    try {
      const p = await graph('GET', `/${start.video_id}`, { fields: 'permalink_url' }, token);
      if (p.permalink_url) url = p.permalink_url.startsWith('/') ? `https://www.facebook.com${p.permalink_url}` : p.permalink_url;
    } catch { /* ใช้ลิงก์สำรอง */ }
    return { postId: start.video_id, url, note: state === 'ready' ? 'เผยแพร่แล้ว' : 'ส่งให้ Facebook แล้ว กำลังประมวลผล (ตรวจสถานะในเพจ)' };
  } catch (e) {
    e.noRetry = true;
    throw e;
  }
}
