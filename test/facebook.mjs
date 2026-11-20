// ทดสอบตัวเชื่อม Facebook ทั้งสาย (OAuth → เลือกเพจ → โพสต์ Reels) กับ Graph API จำลองในเครื่อง
// ไม่ได้พิสูจน์ว่า Facebook จริงตอบแบบเดียวกัน — พิสูจน์ว่าโค้ดเรียกตามขั้นตอนที่เอกสารระบุและจัดการ error ถูก
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import assert from 'node:assert/strict';

const sample = process.env.SAMPLE_VIDEO;
const video = sample ? fs.readFileSync(sample) : Buffer.alloc(200_000, 7);
const VER = 'v23.0';

// ---- Graph API จำลอง ----
const log = []; let mode = 'ok'; let statusPolls = 0;
const fake = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks); const url = new URL(req.url, 'http://x');
  const form = req.headers['content-type']?.includes('urlencoded') ? Object.fromEntries(new URLSearchParams(raw.toString())) : {};
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const p = url.pathname; log.push({ method: req.method, path: p, q: Object.fromEntries(url.searchParams), form, headers: req.headers, bytes: raw.length, raw: p.startsWith('/rupload') ? raw : undefined });
  if (p === `/${VER}/oauth/access_token`) {
    if (url.searchParams.get('code')) return send(200, { access_token: 'SHORT_USER' });
    return send(200, { access_token: url.searchParams.get('fb_exchange_token') === 'SHORT_USER' ? 'LONG_USER' : 'WRONG' });
  }
  if (p === `/${VER}/me/accounts`) return url.searchParams.get('access_token') === 'LONG_USER' ? send(200, { data: [{ id: 'P1', name: 'เพจร้านสมชาย', access_token: 'PAGE_TOKEN_1' }, { id: 'P2', name: 'เพจสำรอง', access_token: 'PAGE_TOKEN_2' }, { id: 'P3', name: 'ไม่มีโทเคน' }] }) : send(400, { error: { message: 'bad', code: 190 } });
  if (p === `/${VER}/P1/video_reels` && req.method === 'POST') {
    if (form.upload_phase === 'start') {
      if (mode === 'authErr') return send(400, { error: { message: 'Error validating access token: Session has expired', code: 190 } });
      if (mode === 'rate') return send(400, { error: { message: 'Application request limit reached', code: 4 } });
      return send(200, { video_id: 'VID1', upload_url: `http://localhost:${fake.address().port}/rupload/VID1` });
    }
    if (form.upload_phase === 'finish') return send(200, { success: true });
  }
  if (p === '/rupload/VID1') return send(200, { success: true });
  if (p === `/${VER}/VID1`) {
    if (url.searchParams.get('fields') === 'status') { statusPolls++; return send(200, { status: mode === 'procErr' ? { video_status: 'error' } : statusPolls % 2 ? { video_status: 'processing' } : { video_status: 'ready' } }); }
    if (url.searchParams.get('fields') === 'permalink_url') return send(200, { permalink_url: '/reel/VID1/' });
  }
  send(404, { error: { message: `unhandled ${req.method} ${p}`, code: 2500 } });
});
await new Promise((r) => fake.listen(0, r));
const FAKE = `http://localhost:${fake.address().port}`;

// ---- แอปจริงของเรา ----
const PORT = 4000 + Math.floor(Math.random() * 500), BASE = `http://localhost:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkfb-'));
const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT, DATA_DIR: dataDir, WORKER_INTERVAL_MS: '300', PLATFORM_MODE: 'live', ADMIN_PASSWORD: 'adminpass1', FB_APP_ID: 'APP1', FB_APP_SECRET: 'SECRET1', FB_REDIRECT_URI: `${BASE}/api/oauth/facebook/callback`, FB_GRAPH_BASE: FAKE, FB_POLL_MS: '100' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => srv.stdout.on('data', (d) => String(d).includes('รันที่') && r()));

let cookie = '', pass = 0;
const req = async (p, o = {}) => { const r = await fetch(BASE + p, { method: o.method || 'GET', redirect: 'manual', headers: { ...(o.body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(o.headers || {}) }, body: o.raw ?? (o.body ? JSON.stringify(o.body) : undefined) }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const ct = r.headers.get('content-type') || ''; return { status: r.status, loc: r.headers.get('location'), body: ct.includes('json') ? await r.json() : null }; };
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok  ', name); } catch (e) { console.error('  FAIL', name, '\n      ', e.message); process.exitCode = 1; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitPost = async (id, pred, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { const p = (await req('/api/posts')).body.posts.find((x) => x.id === id); if (pred(p)) return p; await sleep(150); } return (await req('/api/posts')).body.posts.find((x) => x.id === id); };
const schedule = async (clipId, accountId, extra = {}) => (await req('/api/posts', { method: 'POST', body: { clipIds: [clipId], accountIds: [accountId], scheduledAt: new Date(Date.now() + 300).toISOString(), caption: 'แคปชันทดสอบ', productUrl: 'https://shop.example/x', ...extra } }));

try {
  await req('/api/auth/login', { method: 'POST', body: { email: 'admin@klangklip.local', password: 'adminpass1' } });
  const clip = (await req('/api/admin/clips?' + new URLSearchParams({ title: 'คลิปรีล', hashtags: 'สุขภาพ ไฟเบอร์' }), { method: 'POST', raw: video, headers: { 'Content-Type': 'video/mp4' } })).body.clip;
  let state, accId;

  await t('โหมด live: เชื่อมผ่าน OAuth เท่านั้น, ปิดบัญชีจำลอง', async () => {
    const me = (await req('/api/me')).body;
    assert.equal(me.connect.facebook, 'oauth'); assert.equal(me.connect.tiktok, 'none');
    assert.equal((await req('/api/accounts/connect', { method: 'POST', body: { platform: 'facebook', displayName: 'x' } })).status, 501);
  });
  await t('start → redirect ไป Facebook พร้อม scope/redirect_uri/state', async () => {
    const r = await req('/api/oauth/facebook/start');
    assert.equal(r.status, 302);
    const u = new URL(r.loc);
    assert.equal(u.searchParams.get('client_id'), 'APP1'); assert.equal(u.searchParams.get('redirect_uri'), `${BASE}/api/oauth/facebook/callback`);
    for (const s of ['pages_show_list', 'pages_manage_posts', 'publish_video']) assert.ok(u.searchParams.get('scope').split(',').includes(s), s);
    state = u.searchParams.get('state'); assert.ok(state.length > 20);
  });
  await t('state ปลอม/ผิดวัตถุประสงค์ถูกปฏิเสธ (กัน CSRF) และใช้ state เป็นเซสชันไม่ได้', async () => {
    assert.equal((await req('/api/oauth/facebook/callback?code=abc&state=forged')).loc, '/#fb=error');
    const sessionAsState = cookie.split('=')[1];
    assert.equal((await req(`/api/oauth/facebook/callback?code=abc&state=${sessionAsState}`)).loc, '/#fb=error');
    const stateAsSession = await fetch(BASE + '/api/me', { headers: { Cookie: `kk_sid=${state}` } });
    assert.equal((await stateAsSession.json()).user, null); // /api/me เปิดให้ผู้เยี่ยมชม → ต้องไม่ถูกมองว่าเป็นผู้ใช้
    assert.equal((await fetch(BASE + '/api/accounts', { headers: { Cookie: `kk_sid=${state}` } })).status, 401);
    assert.equal(log.filter((l) => l.path.endsWith('/oauth/access_token')).length, 0, 'ต้องไม่เรียก Facebook เมื่อ state ผิด');
  });
  let pick;
  await t('ผู้ใช้กดปฏิเสธ → #fb=denied / อนุญาต → แลกโทเคนและไปหน้าเลือกเพจ', async () => {
    assert.equal((await req(`/api/oauth/facebook/callback?error=access_denied&state=${state}`)).loc, '/#fb=denied');
    const r = await req(`/api/oauth/facebook/callback?code=CODE1&state=${state}`);
    assert.match(r.loc, /^\/#fbpick=fbp_/); pick = r.loc.split('=')[1];
    const ex = log.filter((l) => l.path.endsWith('/oauth/access_token'));
    assert.equal(ex.length, 2); assert.equal(ex[0].q.code, 'CODE1'); assert.equal(ex[0].q.client_secret, 'SECRET1'); assert.equal(ex[1].q.grant_type, 'fb_exchange_token');
  });
  await t('เลือกเพจ: แสดงเฉพาะเพจที่มีโทเคน, สร้างบัญชี, โทเคนถูกเข้ารหัส, ไม่รั่วไปหน้าเว็บ', async () => {
    const p = (await req(`/api/oauth/facebook/pending/${pick}`)).body.pages;
    assert.deepEqual(p.map((x) => x.id), ['P1', 'P2']);
    assert.equal((await req(`/api/oauth/facebook/pending/${pick}/select`, { method: 'POST', body: { pageIds: ['NOPE'] } })).status, 400);
    const r = await req(`/api/oauth/facebook/pending/${pick}/select`, { method: 'POST', body: { pageIds: ['P1'] } });
    assert.equal(r.status, 201); accId = r.body.accounts[0].id;
    assert.equal(r.body.accounts[0].displayName, 'เพจร้านสมชาย'); assert.equal(r.body.accounts[0].mock, false);
    assert.ok(!JSON.stringify(r.body).includes('PAGE_TOKEN'));
    const db = fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8');
    assert.ok(!db.includes('PAGE_TOKEN_1') && !db.includes('LONG_USER'), 'โทเคนต้องไม่อยู่ในไฟล์แบบข้อความ');
    assert.equal((await req(`/api/oauth/facebook/pending/${pick}`)).status, 404, 'pending ใช้ได้ครั้งเดียว');
  });
  await t('โพสต์ Reels: ลำดับ start → upload → finish → poll, ส่งโทเคน/ไฟล์/แคปชันถูกต้อง', async () => {
    const r = await schedule(clip.id, accId); assert.equal(r.status, 201, JSON.stringify(r.body));
    const p = await waitPost(r.body.posts[0].id, (x) => x.status === 'posted');
    assert.equal(p.status, 'posted', p.error); assert.equal(p.result.url, 'https://www.facebook.com/reel/VID1/'); assert.equal(p.result.postId, 'VID1');
    const calls = log.filter((l) => l.path.includes('video_reels') || l.path.startsWith('/rupload'));
    assert.deepEqual(calls.map((c) => c.form.upload_phase || 'upload'), ['start', 'upload', 'finish']);
    assert.equal(calls[0].form.access_token, 'PAGE_TOKEN_1');
    assert.equal(calls[1].headers.authorization, 'OAuth PAGE_TOKEN_1'); assert.equal(calls[1].headers.offset, '0'); assert.equal(calls[1].headers.file_size, String(video.length));
    assert.ok(Buffer.compare(calls[1].raw, video) === 0, 'ไบต์ที่อัปโหลดต้องตรงกับไฟล์ต้นฉบับ');
    assert.equal(calls[2].form.video_state, 'PUBLISHED'); assert.equal(calls[2].form.video_id, 'VID1');
    const d = calls[2].form.description;
    assert.ok(d.includes('แคปชันทดสอบ') && d.includes('🛒 สั่งซื้อ: https://shop.example/x') && d.includes('#สุขภาพ #ไฟเบอร์'), d);
  });
  await t('Facebook ประมวลผลวิดีโอไม่ผ่านหลัง finish → ล้มเหลวทันที ไม่ลองซ้ำ (กันโพสต์ซ้ำ)', async () => {
    mode = 'procErr'; const before = log.filter((l) => l.form.upload_phase === 'finish').length;
    const r = await schedule(clip.id, accId);
    const p = await waitPost(r.body.posts[0].id, (x) => x.status === 'failed');
    assert.equal(p.status, 'failed'); assert.equal(p.attempts, 1); assert.match(p.error, /ประมวลผลวิดีโอไม่ผ่าน/);
    await sleep(1200);
    assert.equal(log.filter((l) => l.form.upload_phase === 'finish').length, before + 1, 'ต้อง finish แค่ครั้งเดียว');
  });
  await t('rate limit (code 4) → ลองใหม่ภายหลัง ไม่ล้มเหลวถาวร', async () => {
    mode = 'rate';
    const r = await schedule(clip.id, accId);
    const p = await waitPost(r.body.posts[0].id, (x) => x.attempts >= 1 && x.status !== 'posting');
    assert.equal(p.status, 'scheduled'); assert.match(p.error, /code 4.*จะลองใหม่ใน 5 นาที/);
    await req(`/api/posts/${p.id}`, { method: 'DELETE' });
  });
  await t('โทเคนหมดอายุ (code 190) → ล้มเหลวทันที + ติดธง "ต้องเชื่อมใหม่" + ห้ามตั้งเวลาเพิ่ม', async () => {
    mode = 'authErr';
    const r = await schedule(clip.id, accId);
    const p = await waitPost(r.body.posts[0].id, (x) => x.status === 'failed');
    assert.equal(p.status, 'failed'); assert.equal(p.attempts, 1); assert.match(p.error, /code 190/);
    assert.equal((await req('/api/accounts')).body.accounts[0].needsReauth, true);
    const again = await schedule(clip.id, accId);
    assert.equal(again.status, 400); assert.match(again.body.error, /ต้องเชื่อมใหม่/);
  });
  await t('เชื่อมเพจเดิมซ้ำ = ต่ออายุโทเคน ล้างธง ไม่สร้างบัญชีซ้ำ', async () => {
    mode = 'ok';
    const s = new URL((await req('/api/oauth/facebook/start')).loc).searchParams.get('state');
    const pk = (await req(`/api/oauth/facebook/callback?code=CODE2&state=${s}`)).loc.split('=')[1];
    assert.equal((await req(`/api/oauth/facebook/pending/${pk}`)).body.pages.find((x) => x.id === 'P1').connected, true);
    await req(`/api/oauth/facebook/pending/${pk}/select`, { method: 'POST', body: { pageIds: ['P1'] } });
    const accs = (await req('/api/accounts')).body.accounts;
    assert.equal(accs.length, 1); assert.equal(accs[0].needsReauth, false);
    const r = await schedule(clip.id, accId); assert.equal(r.status, 201);
    assert.equal((await waitPost(r.body.posts[0].id, (x) => x.status === 'posted')).status, 'posted');
  });
  await t('ตรวจข้อกำหนด Reels ตอนตั้งเวลา (ยาวเกิน 90 วินาที / ไม่ใช่ 9:16)', async () => {
    const { clipProblem } = await import(`../lib/platforms.js?${Date.now()}`).catch(() => ({}));
    if (!clipProblem) throw new Error('import ไม่ได้');
    assert.ok(clipProblem('facebook', { title: 'x', duration: 120, width: 540, height: 960 }));
    assert.ok(clipProblem('facebook', { title: 'x', duration: 30, width: 1920, height: 1080 }));
    assert.ok(clipProblem('facebook', { title: 'x', duration: 30, width: 480, height: 854 }));
    assert.equal(clipProblem('facebook', { title: 'x', duration: 30, width: 540, height: 960 }), null);
    assert.equal(clipProblem('facebook', { title: 'x' }), null);
    assert.equal(clipProblem('tiktok', { title: 'x', duration: 300 }), null);
  });
  await t('TikTok/Instagram ที่เชื่อมจริงยังไม่รองรับ → ล้มเหลวทันทีพร้อมข้อความชัดเจน', async () => {
    const { publish } = await import(`../lib/platforms.js?${Date.now()}`);
    await assert.rejects(() => publish({ platform: 'tiktok', account: { mock: false } }), (e) => e.permanent === true && /ยังไม่รองรับ/.test(e.message));
  });
} finally {
  srv.kill(); fake.close(); fs.rmSync(dataDir, { recursive: true, force: true });
  console.log(`\nผ่าน ${pass} ชุด${process.exitCode ? ' (มีที่ล้มเหลว)' : ''}`);
}
