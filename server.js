// คลังคลิป — เซิร์ฟเวอร์หลัก (Node ล้วน ไม่มี dependency)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as store from './lib/store.js';
import { hashPassword, verifyPassword, encryptToken, signSession, readSession, newId } from './lib/security.js';
import { PLATFORMS, MODE, clipProblem } from './lib/platforms.js';
import { authUrl, pagesFromCode, fbConfigured } from './lib/facebook.js';
import { captionMode, generateCaptions } from './lib/captions.js';
import os from 'node:os';
import { startWorker } from './lib/worker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const UPLOADS = path.join(store.DATA_DIR, 'uploads');
const THUMBS = path.join(store.DATA_DIR, 'thumbs');
const PORT = Number(process.env.PORT || 3000);
const MAX_UPLOAD = 500 * 1024 * 1024;
const COOKIE = 'kk_sid';

// ---------- helpers ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => new HttpError(400, m);

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
};

async function readJson(req, limit = 1_000_000) {
  const chunks = []; let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'ข้อมูลใหญ่เกินไป');
    chunks.push(c);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw bad('JSON ไม่ถูกต้อง'); }
}

const parseCookies = (h = '') => Object.fromEntries(h.split(';').map((s) => s.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, v.join('=')]));
const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role });
const str = (v, max, name) => {
  if (v == null) return '';
  if (typeof v !== 'string') throw bad(`${name} ไม่ถูกต้อง`);
  if (v.length > max) throw bad(`${name} ยาวเกิน ${max} ตัวอักษร`);
  return v.trim();
};
const urlOrEmpty = (v, name) => {
  const s = str(v, 2000, name);
  if (!s) return '';
  try { const u = new URL(s); if (!/^https?:$/.test(u.protocol)) throw 0; } catch { throw bad(`${name} ต้องเป็นลิงก์ http/https`); }
  return s;
};
const hashtagsOf = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\s,]+/)).map((h) => String(h).replace(/^#/, '').trim()).filter(Boolean).slice(0, 30);

// IP ของผู้ใช้: หลังพร็อกซี (Caddy/nginx) ต้องตั้ง TRUST_PROXY=1 ให้อ่านจาก X-Forwarded-For
// ห้ามเปิดถ้าเซิร์ฟเวอร์เปิดรับจากอินเทอร์เน็ตตรง ๆ เพราะผู้โจมตีปลอมค่านี้ได้
const clientIp = (req) => (process.env.TRUST_PROXY === '1' ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '') || req.socket.remoteAddress;

// จำกัดการลองรหัสผ่านผิด
const attempts = new Map();
function throttle(key) {
  const now = Date.now();
  const rec = (attempts.get(key) || []).filter((t) => now - t < 10 * 60 * 1000);
  if (rec.length >= 10) throw new HttpError(429, 'ลองผิดหลายครั้งเกินไป รอสักครู่แล้วลองใหม่');
  rec.push(now); attempts.set(key, rec);
}

// ---------- media ----------
const run = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { timeout: 60000 }, (err, stdout) => resolve(err ? null : stdout)));

async function probe(file) {
  const out = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', file]);
  if (!out) return {};
  try {
    const j = JSON.parse(out);
    return { width: j.streams?.[0]?.width, height: j.streams?.[0]?.height, duration: Math.round(Number(j.format?.duration) * 10) / 10 || undefined };
  } catch { return {}; }
}
const makeThumb = (file, thumb, at) => run('ffmpeg', ['-y', '-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1', '-vf', 'scale=360:-2', thumb]);

async function addClip({ file, title, product = '', caption = '', hashtags = [], uploader }) {
  const full = path.join(UPLOADS, file);
  const meta = await probe(full);
  const id = newId('clip');
  const thumb = `${id}.jpg`;
  await makeThumb(full, path.join(THUMBS, thumb), Math.min(2, (meta.duration || 2) / 2));
  return store.insert('clips', {
    id, title, product, caption, hashtags, file,
    thumb: fs.existsSync(path.join(THUMBS, thumb)) ? thumb : null,
    size: fs.statSync(full).size, ...meta, createdAt: new Date().toISOString(), uploadedBy: uploader,
  });
}

// ตัดเฟรมจากคลิป 3 จุด (ส่งให้ AI ดูเนื้อหา) — ไม่มี ffmpeg ก็คืนรายการว่าง แล้ว AI ใช้ข้อมูลข้อความอย่างเดียว
async function sampleFrames(clip) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kk-frames-'));
  try {
    const d = clip.duration || 10; const out = [];
    for (const [i, at] of [0.15, 0.5, 0.85].entries()) {
      const f = path.join(dir, `${i}.jpg`);
      await makeThumb(path.join(UPLOADS, clip.file), f, d * at);
      if (fs.existsSync(f)) out.push(fs.readFileSync(f).toString('base64'));
    }
    return out;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// จำกัดการเรียก AI ต่อผู้ใช้ (กันค่าใช้จ่ายบานปลาย)
const aiCalls = new Map();
const AI_LIMIT = Number(process.env.AI_CAPTION_LIMIT_PER_HOUR || 30);
function aiRate(uid) {
  const now = Date.now();
  const rec = (aiCalls.get(uid) || []).filter((t) => now - t < 3600_000);
  if (rec.length >= AI_LIMIT) throw new HttpError(429, `สร้างแคปชันด้วย AI ได้ ${AI_LIMIT} ครั้งต่อชั่วโมง รอสักครู่แล้วลองใหม่`);
  rec.push(now); aiCalls.set(uid, rec);
}

function sendFile(req, res, file, type, cache = 'private, max-age=3600') {
  if (!fs.existsSync(file)) throw new HttpError(404, 'ไม่พบไฟล์');
  const size = fs.statSync(file).size;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    let start = range[1] === '' ? size - Number(range[2]) : Number(range[1]);
    let end = range[1] === '' || range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
    if (start > end || start < 0 || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1, 'Cache-Control': cache });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': size, 'Cache-Control': cache });
  fs.createReadStream(file).pipe(res);
}

// ---------- auth ----------
function setupAdmin() {
  const email = (process.env.ADMIN_EMAIL || 'admin@klangklip.local').toLowerCase();
  if (store.where('users', (u) => u.role === 'admin').length) return;
  const password = process.env.ADMIN_PASSWORD || (MODE === 'mock' ? 'admin1234' : null);
  if (!password) throw new Error('โหมด live ต้องตั้ง ADMIN_PASSWORD');
  store.insert('users', { id: newId('user'), email, name: 'ผู้ดูแลระบบ', role: 'admin', passwordHash: hashPassword(password), createdAt: new Date().toISOString() });
  console.log(`สร้างแอดมินเริ่มต้น: ${email} / ${process.env.ADMIN_PASSWORD ? '(ตาม ADMIN_PASSWORD)' : password}`);
}

function sessionCookie(uid) {
  return `${COOKIE}=${signSession(uid)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${14 * 86400}${process.env.COOKIE_SECURE === '1' ? '; Secure' : ''}`;
}

// ---------- routes ----------
const routes = [];
const route = (method, pattern, opts, handler) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), opts, handler });

route('POST', '/api/auth/register', { auth: false }, async (ctx) => {
  const b = await readJson(ctx.req);
  const email = str(b.email, 200, 'อีเมล').toLowerCase();
  const name = str(b.name, 100, 'ชื่อ');
  const password = typeof b.password === 'string' ? b.password : '';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('อีเมลไม่ถูกต้อง');
  if (!name) throw bad('กรุณากรอกชื่อ');
  if (password.length < 8) throw bad('รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร');
  if (store.where('users', (u) => u.email === email).length) throw new HttpError(409, 'อีเมลนี้ถูกใช้แล้ว');
  const user = store.insert('users', { id: newId('user'), email, name, role: 'member', passwordHash: hashPassword(password), createdAt: new Date().toISOString() });
  return json(ctx.res, 201, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(user.id) });
});

route('POST', '/api/auth/login', { auth: false }, async (ctx) => {
  const b = await readJson(ctx.req);
  const email = str(b.email, 200, 'อีเมล').toLowerCase();
  throttle(`${clientIp(ctx.req)}|${email}`);
  const user = store.where('users', (u) => u.email === email)[0];
  // ตรวจรหัสผ่านเสมอ (แม้ไม่พบผู้ใช้) เพื่อไม่ให้เวลาตอบเผยว่าอีเมลมีอยู่หรือไม่
  const ok = verifyPassword(String(b.password || ''), user?.passwordHash || 'scrypt$00$00');
  if (!user || !ok) throw new HttpError(401, 'อีเมลหรือรหัสผ่านไม่ถูกต้อง');
  return json(ctx.res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(user.id) });
});

route('POST', '/api/auth/logout', { auth: false }, (ctx) => json(ctx.res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0` }));

// วิธีเชื่อมบัญชีของแต่ละแพลตฟอร์ม: mock = จำลอง, oauth = ล็อกอินผ่านแพลตฟอร์ม, none = ยังไม่เปิดให้เชื่อม
const connectModes = () => (MODE === 'mock'
  ? { tiktok: 'mock', facebook: 'mock', instagram: 'mock' }
  : { tiktok: 'none', facebook: fbConfigured() ? 'oauth' : 'none', instagram: 'none' });
route('GET', '/api/me', {}, (ctx) => json(ctx.res, 200, { user: publicUser(ctx.user), platforms: PLATFORMS, mode: MODE, connect: connectModes(), aiCaption: captionMode() }));

// สร้างแคปชันด้วย AI จากเฟรมคลิป + ข้อมูลสินค้า → ตัวเลือก 3 แบบ (ยังไม่บันทึกอะไร ผู้ใช้เลือกเองแล้วค่อยกดตั้งเวลา)
route('POST', '/api/captions/generate', {}, async (ctx) => {
  const mode = captionMode();
  if (mode === 'off') throw new HttpError(501, 'ยังไม่ได้เปิดใช้ AI — ผู้ดูแลต้องตั้ง ANTHROPIC_API_KEY ที่เซิร์ฟเวอร์');
  const b = await readJson(ctx.req);
  const clip = store.find('clips', b.clipId); if (!clip) throw new HttpError(404, 'ไม่พบคลิป');
  const tone = str(b.tone, 100, 'น้ำเสียง'); const hint = str(b.hint, 300, 'ข้อมูลเพิ่มเติม');
  aiRate(ctx.user.id);
  const frames = mode === 'ai' ? await sampleFrames(clip) : [];
  const captions = await generateCaptions({ mode, clip, frames, tone, hint });
  json(ctx.res, 200, { captions, mock: mode === 'mock', usedFrames: frames.length });
});

// คลังคลิป (ทุกคนที่ล็อกอินดูได้)
const clipView = (c) => ({ ...c, file: undefined, videoUrl: `/media/video/${c.id}`, thumbUrl: c.thumb ? `/media/thumb/${c.id}` : null });
route('GET', '/api/clips', {}, (ctx) => {
  const q = (ctx.url.searchParams.get('q') || '').toLowerCase();
  const list = store.all('clips').filter((c) => !q || [c.title, c.product, c.caption, ...(c.hashtags || [])].join(' ').toLowerCase().includes(q));
  json(ctx.res, 200, { clips: list.map(clipView).reverse() });
});
route('GET', '/media/video/:id', {}, (ctx) => {
  const c = store.find('clips', ctx.params.id); if (!c) throw new HttpError(404, 'ไม่พบคลิป');
  sendFile(ctx.req, ctx.res, path.join(UPLOADS, c.file), 'video/mp4');
});
route('GET', '/media/thumb/:id', {}, (ctx) => {
  const c = store.find('clips', ctx.params.id); if (!c?.thumb) throw new HttpError(404, 'ไม่พบภาพปก');
  sendFile(ctx.req, ctx.res, path.join(THUMBS, c.thumb), 'image/jpeg');
});

// แอดมิน: อัปโหลด/แก้ไข/ลบคลิป (ส่งไฟล์เป็น body ตรง ๆ ไม่ใช้ multipart)
route('POST', '/api/admin/clips', { admin: true }, async (ctx) => {
  const q = ctx.url.searchParams;
  const title = str(q.get('title'), 200, 'ชื่อคลิป');
  if (!title) throw bad('กรุณาตั้งชื่อคลิป');
  const type = ctx.req.headers['content-type'] || '';
  if (!type.startsWith('video/mp4') && !type.startsWith('video/quicktime')) throw bad('รองรับเฉพาะไฟล์ MP4 / MOV');
  const declared = Number(ctx.req.headers['content-length'] || 0);
  if (declared > MAX_UPLOAD) throw new HttpError(413, 'ไฟล์ใหญ่เกิน 500 MB');
  const file = `${newId('f')}.mp4`;
  const dest = path.join(UPLOADS, file);
  let size = 0;
  const out = fs.createWriteStream(dest);
  try {
    for await (const chunk of ctx.req) {
      size += chunk.length;
      if (size > MAX_UPLOAD) throw new HttpError(413, 'ไฟล์ใหญ่เกิน 500 MB');
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    }
    await new Promise((r) => out.end(r));
    if (!size) throw bad('ไม่พบไฟล์');
    const clip = await addClip({ file, title, product: str(q.get('product'), 200, 'สินค้า'), caption: str(q.get('caption'), 2000, 'แคปชัน'), hashtags: hashtagsOf(q.get('hashtags')), uploader: ctx.user.id });
    json(ctx.res, 201, { clip: clipView(clip) });
  } catch (e) {
    out.destroy(); fs.rmSync(dest, { force: true });
    throw e;
  }
});

route('PATCH', '/api/admin/clips/:id', { admin: true }, async (ctx) => {
  const c = store.find('clips', ctx.params.id); if (!c) throw new HttpError(404, 'ไม่พบคลิป');
  const b = await readJson(ctx.req);
  const patch = {};
  if ('title' in b) { patch.title = str(b.title, 200, 'ชื่อคลิป'); if (!patch.title) throw bad('ชื่อคลิปห้ามว่าง'); }
  if ('product' in b) patch.product = str(b.product, 200, 'สินค้า');
  if ('caption' in b) patch.caption = str(b.caption, 2000, 'แคปชัน');
  if ('hashtags' in b) patch.hashtags = hashtagsOf(b.hashtags);
  json(ctx.res, 200, { clip: clipView(store.update('clips', c.id, patch)) });
});

route('DELETE', '/api/admin/clips/:id', { admin: true }, (ctx) => {
  const c = store.find('clips', ctx.params.id); if (!c) throw new HttpError(404, 'ไม่พบคลิป');
  const pending = store.where('posts', (p) => p.clipId === c.id && ['scheduled', 'posting'].includes(p.status)).length;
  if (pending) throw new HttpError(409, `ลบไม่ได้ ยังมี ${pending} โพสต์ที่รอคิวอยู่ ยกเลิกคิวก่อน`);
  fs.rmSync(path.join(UPLOADS, c.file), { force: true });
  if (c.thumb) fs.rmSync(path.join(THUMBS, c.thumb), { force: true });
  store.remove('clips', c.id);
  json(ctx.res, 200, { ok: true });
});

route('GET', '/api/admin/overview', { admin: true }, (ctx) => {
  const posts = store.all('posts');
  const count = (s) => posts.filter((p) => p.status === s).length;
  json(ctx.res, 200, {
    clips: store.all('clips').length,
    members: store.where('users', (u) => u.role === 'member').map((u) => ({ ...publicUser(u), accounts: store.where('accounts', (a) => a.userId === u.id).length, posts: posts.filter((p) => p.userId === u.id).length })),
    posts: { scheduled: count('scheduled'), posted: count('posted'), failed: count('failed') },
  });
});

// บัญชีโซเชียลของสมาชิก
const accountView = (a) => ({ id: a.id, platform: a.platform, displayName: a.displayName, handle: a.handle, mock: a.mock, needsReauth: Boolean(a.needsReauth), connectedAt: a.connectedAt, supportsCart: PLATFORMS[a.platform].supportsCart });
route('GET', '/api/accounts', {}, (ctx) => json(ctx.res, 200, { accounts: store.where('accounts', (a) => a.userId === ctx.user.id).map(accountView) }));

route('POST', '/api/accounts/connect', {}, async (ctx) => {
  const b = await readJson(ctx.req);
  if (!PLATFORMS[b.platform]) throw bad('แพลตฟอร์มไม่รองรับ');
  if (MODE !== 'mock') throw new HttpError(501, 'ยังไม่ได้ตั้งค่า OAuth จริง — ดู README หัวข้อเชื่อมบัญชีจริง');
  const displayName = str(b.displayName, 100, 'ชื่อบัญชี');
  if (!displayName) throw bad('กรุณากรอกชื่อบัญชี');
  const handle = displayName.toLowerCase().replace(/[^a-z0-9._ก-๙]/g, '') || 'user';
  const acc = store.insert('accounts', {
    id: newId('acc'), userId: ctx.user.id, platform: b.platform, displayName, handle,
    tokenEnc: encryptToken(`mock-token-${newId('t')}`), mock: true, connectedAt: new Date().toISOString(),
  });
  json(ctx.res, 201, { account: accountView(acc) });
});

// ---- Facebook OAuth: ล็อกอิน → เลือกเพจ → สร้างบัญชี ----
const pendingPages = new Map(); // id → { uid, exp, pages:[{id,name,tokenEnc}] } เก็บในหน่วยความจำ 10 นาที (โทเคนเข้ารหัสอยู่แล้ว)
const fbBack = (res, hash) => { res.writeHead(302, { Location: `/#${hash}`, 'Cache-Control': 'no-store' }); res.end(); };

route('GET', '/api/oauth/facebook/start', {}, (ctx) => {
  if (!fbConfigured()) throw new HttpError(501, 'ยังไม่ได้ตั้งค่า FB_APP_ID / FB_APP_SECRET / FB_REDIRECT_URI');
  ctx.res.writeHead(302, { Location: authUrl(signSession(ctx.user.id, 10 * 60 * 1000, 'fb-oauth')), 'Cache-Control': 'no-store' });
  ctx.res.end();
});

route('GET', '/api/oauth/facebook/callback', {}, async (ctx) => {
  const q = ctx.url.searchParams;
  const st = readSession(q.get('state'), 'fb-oauth');
  if (!st || st.uid !== ctx.user.id) return fbBack(ctx.res, 'fb=error'); // state ไม่ตรง = อาจเป็น CSRF
  if (q.get('error') || !q.get('code')) return fbBack(ctx.res, 'fb=denied');
  try {
    const pages = await pagesFromCode(q.get('code'));
    if (!pages.length) return fbBack(ctx.res, 'fb=nopages');
    for (const [k, v] of pendingPages) if (v.exp < Date.now()) pendingPages.delete(k);
    const id = newId('fbp');
    pendingPages.set(id, { uid: ctx.user.id, exp: Date.now() + 10 * 60 * 1000, pages: pages.map((p) => ({ id: p.id, name: p.name, tokenEnc: encryptToken(p.token) })) });
    return fbBack(ctx.res, `fbpick=${id}`);
  } catch (e) {
    console.error('facebook oauth:', e.message);
    return fbBack(ctx.res, 'fb=error');
  }
});

const pendingFor = (ctx) => {
  const p = pendingPages.get(ctx.params.id);
  if (!p || p.exp < Date.now() || p.uid !== ctx.user.id) throw new HttpError(404, 'หมดเวลาเลือกเพจ กรุณากดเชื่อม Facebook ใหม่');
  return p;
};
route('GET', '/api/oauth/facebook/pending/:id', {}, (ctx) => {
  const p = pendingFor(ctx);
  const have = new Set(store.where('accounts', (a) => a.userId === ctx.user.id && a.platform === 'facebook').map((a) => a.meta?.pageId));
  json(ctx.res, 200, { pages: p.pages.map((x) => ({ id: x.id, name: x.name, connected: have.has(x.id) })) });
});
route('POST', '/api/oauth/facebook/pending/:id/select', {}, async (ctx) => {
  const p = pendingFor(ctx);
  const b = await readJson(ctx.req);
  const chosen = p.pages.filter((x) => (Array.isArray(b.pageIds) ? b.pageIds : []).includes(x.id));
  if (!chosen.length) throw bad('เลือกเพจอย่างน้อย 1 เพจ');
  const out = chosen.map((pg) => {
    const existing = store.where('accounts', (a) => a.userId === ctx.user.id && a.platform === 'facebook' && a.meta?.pageId === pg.id)[0];
    if (existing) return store.update('accounts', existing.id, { tokenEnc: pg.tokenEnc, displayName: pg.name, needsReauth: false }); // เชื่อมซ้ำ = ต่ออายุโทเคน
    return store.insert('accounts', { id: newId('acc'), userId: ctx.user.id, platform: 'facebook', displayName: pg.name, handle: pg.id, meta: { pageId: pg.id }, tokenEnc: pg.tokenEnc, mock: false, connectedAt: new Date().toISOString() });
  });
  pendingPages.delete(ctx.params.id);
  json(ctx.res, 201, { accounts: out.map(accountView) });
});

route('DELETE', '/api/accounts/:id', {}, (ctx) => {
  const a = store.find('accounts', ctx.params.id);
  if (!a || a.userId !== ctx.user.id) throw new HttpError(404, 'ไม่พบบัญชี');
  const pending = store.where('posts', (p) => p.accountId === a.id && ['scheduled', 'posting'].includes(p.status)).length;
  if (pending) throw new HttpError(409, `ยกเลิกการเชื่อมไม่ได้ ยังมี ${pending} โพสต์รอคิวอยู่`);
  store.remove('accounts', a.id);
  json(ctx.res, 200, { ok: true });
});

// คิวโพสต์
const postView = (p) => {
  const clip = store.find('clips', p.clipId); const acc = store.find('accounts', p.accountId);
  return { id: p.id, clipId: p.clipId, clipTitle: clip?.title || '(คลิปถูกลบ)', thumbUrl: clip?.thumb ? `/media/thumb/${clip.id}` : null, accountId: p.accountId, accountName: acc?.displayName || '(บัญชีถูกลบ)', platform: p.platform, scheduledAt: p.scheduledAt, status: p.status, caption: p.caption, productUrl: p.productUrl, cartProductId: p.cartProductId, error: p.error, result: p.result, postedAt: p.postedAt, attempts: p.attempts, userId: p.userId };
};

route('GET', '/api/posts', {}, (ctx) => {
  const status = ctx.url.searchParams.get('status');
  const mine = ctx.user.role === 'admin' && ctx.url.searchParams.get('all') === '1' ? () => true : (p) => p.userId === ctx.user.id;
  const list = store.where('posts', (p) => mine(p) && (!status || p.status === status)).sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));
  json(ctx.res, 200, { posts: list.map(postView) });
});

function parseTime(v, name = 'เวลาโพสต์') {
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw bad(`${name}ไม่ถูกต้อง`);
  if (t < Date.now() - 60_000) throw bad(`${name}ต้องไม่อยู่ในอดีต`);
  if (t > Date.now() + 365 * 86400_000) throw bad(`${name}ไกลเกิน 1 ปี`);
  return new Date(t).toISOString();
}

// สร้างหลายโพสต์ในครั้งเดียว: เลือกหลายคลิป × หลายบัญชี, หลายคลิปเว้นช่วงตาม intervalMinutes
route('POST', '/api/posts', {}, async (ctx) => {
  const b = await readJson(ctx.req);
  const clipIds = [...new Set(Array.isArray(b.clipIds) ? b.clipIds : [])];
  const accountIds = [...new Set(Array.isArray(b.accountIds) ? b.accountIds : [])];
  if (!clipIds.length || !accountIds.length) throw bad('เลือกคลิปและบัญชีอย่างน้อยอย่างละ 1');
  if (clipIds.length * accountIds.length > 100) throw bad('สร้างได้ครั้งละไม่เกิน 100 โพสต์');
  const start = Date.parse(parseTime(b.scheduledAt));
  const interval = Math.max(0, Number(b.intervalMinutes) || 0);
  if (interval > 7 * 24 * 60) throw bad('ช่วงเวลาห่างเกินไป');
  const productUrl = urlOrEmpty(b.productUrl, 'ลิงก์สินค้า');
  const cartProductId = str(b.cartProductId, 64, 'รหัสสินค้าตะกร้า');
  const captionOverride = str(b.caption, 2000, 'แคปชัน');
  const clips = clipIds.map((id) => store.find('clips', id) || (() => { throw bad('ไม่พบคลิปที่เลือก'); })());
  const accounts = accountIds.map((id) => { const a = store.find('accounts', id); if (!a || a.userId !== ctx.user.id) throw bad('บัญชีที่เลือกไม่ถูกต้อง'); return a; });
  const stale = accounts.find((a) => a.needsReauth);
  if (stale) throw bad(`บัญชี "${stale.displayName}" ต้องเชื่อมใหม่ก่อน (โทเคนหมดอายุหรือถูกเพิกถอนสิทธิ์)`);
  for (const clip of clips) for (const a of accounts) { const problem = clipProblem(a.platform, clip); if (problem) throw bad(problem); }
  if (cartProductId && !accounts.some((a) => PLATFORMS[a.platform].supportsCart)) throw bad('รหัสตะกร้าใช้ได้กับ TikTok เท่านั้น');
  const created = [];
  clips.forEach((clip, i) => {
    const at = new Date(start + i * interval * 60_000).toISOString();
    for (const a of accounts) {
      created.push(store.insert('posts', {
        id: newId('post'), userId: ctx.user.id, clipId: clip.id, accountId: a.id, platform: a.platform,
        scheduledAt: at, status: 'scheduled', attempts: 0, caption: captionOverride || clip.caption, productUrl,
        cartProductId: PLATFORMS[a.platform].supportsCart ? cartProductId : '', createdAt: new Date().toISOString(),
      }));
    }
  });
  json(ctx.res, 201, { posts: created.map(postView) });
});

function ownPost(ctx) {
  const p = store.find('posts', ctx.params.id);
  if (!p || (p.userId !== ctx.user.id && ctx.user.role !== 'admin')) throw new HttpError(404, 'ไม่พบโพสต์');
  return p;
}

route('PATCH', '/api/posts/:id', {}, async (ctx) => {
  const p = ownPost(ctx);
  if (p.status !== 'scheduled') throw new HttpError(409, 'แก้ไขได้เฉพาะโพสต์ที่ยังรอคิว');
  const b = await readJson(ctx.req);
  const patch = {};
  if ('scheduledAt' in b) patch.scheduledAt = parseTime(b.scheduledAt);
  if ('caption' in b) patch.caption = str(b.caption, 2000, 'แคปชัน');
  if ('productUrl' in b) patch.productUrl = urlOrEmpty(b.productUrl, 'ลิงก์สินค้า');
  if ('cartProductId' in b) { patch.cartProductId = str(b.cartProductId, 64, 'รหัสสินค้าตะกร้า'); if (patch.cartProductId && !PLATFORMS[p.platform].supportsCart) throw bad('รหัสตะกร้าใช้ได้กับ TikTok เท่านั้น'); }
  json(ctx.res, 200, { post: postView(store.update('posts', p.id, patch)) });
});

route('POST', '/api/posts/:id/retry', {}, (ctx) => {
  const p = ownPost(ctx);
  if (p.status !== 'failed') throw new HttpError(409, 'ลองใหม่ได้เฉพาะโพสต์ที่ล้มเหลว');
  json(ctx.res, 200, { post: postView(store.update('posts', p.id, { status: 'scheduled', attempts: 0, error: null, scheduledAt: new Date().toISOString() })) });
});

route('DELETE', '/api/posts/:id', {}, (ctx) => {
  const p = ownPost(ctx);
  if (p.status === 'posting') throw new HttpError(409, 'กำลังโพสต์อยู่ ยกเลิกไม่ได้');
  if (p.status === 'scheduled') store.update('posts', p.id, { status: 'canceled' });
  else store.remove('posts', p.id); // ลบประวัติที่จบแล้ว (posted/failed/canceled)
  json(ctx.res, 200, { ok: true });
});

// ---------- server ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const pathname = decodeURIComponent(url.pathname);
    const sec = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' };
    for (const [k, v] of Object.entries(sec)) res.setHeader(k, v);

    const r = routes.find((x) => x.method === req.method && x.re.test(pathname));
    if (r) {
      const ctx = { req, res, url, params: r.re.exec(pathname).groups || {} };
      if (r.opts.auth !== false) {
        const s = readSession(parseCookies(req.headers.cookie)[COOKIE]);
        ctx.user = s && store.find('users', s.uid);
        if (!ctx.user) throw new HttpError(401, 'กรุณาเข้าสู่ระบบ');
        if (r.opts.admin && ctx.user.role !== 'admin') throw new HttpError(403, 'เฉพาะผู้ดูแลระบบ');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        // กัน CSRF: ถ้ามี Origin ต้องตรงกับ Host
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Origin ไม่ถูกต้อง');
      }
      return await r.handler(ctx);
    }
    if (pathname.startsWith('/api/') || pathname.startsWith('/media/')) throw new HttpError(404, 'ไม่พบ');
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) throw new HttpError(404, 'ไม่พบหน้า');
    return sendFile(req, res, file, TYPES[path.extname(file)] || 'application/octet-stream', 'no-cache');
  } catch (e) {
    if (res.headersSent) return res.destroy();
    const status = e.status || 500;
    if (status === 500) console.error(e);
    json(res, status, { error: status === 500 ? 'เซิร์ฟเวอร์ผิดพลาด' : e.message });
  }
});

// ใส่คลิปตัวอย่างครั้งแรก (ถ้ามี SEED_CLIP)
async function seed() {
  const src = process.env.SEED_CLIP;
  if (!src || store.all('clips').length || !fs.existsSync(src)) return;
  const file = `${newId('f')}.mp4`;
  fs.copyFileSync(src, path.join(UPLOADS, file));
  await addClip({ file, title: 'โปรมพร้อม (ตัวอย่าง)', product: 'PROMPROM Inulin', caption: 'ไฟเบอร์จากอินนูลิน ช่วยดูแลลำไส้ 💗', hashtags: ['อินนูลิน', 'ไฟเบอร์', 'สุขภาพ'], uploader: 'seed' });
  console.log('เพิ่มคลิปตัวอย่างแล้ว');
}

setupAdmin();
await seed();
startWorker(Number(process.env.WORKER_INTERVAL_MS || 10000));
server.listen(PORT, () => console.log(`คลังคลิป รันที่ http://localhost:${PORT}  (PLATFORM_MODE=${MODE})`));

export { server };
