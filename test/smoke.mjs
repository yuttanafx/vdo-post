// ทดสอบ end-to-end: เปิดเซิร์ฟเวอร์ชั่วคราว (DATA_DIR แยก) แล้วเรียก API จริง
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const PORT = 3300 + Math.floor(Math.random() * 500);
const BASE = `http://localhost:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kk-'));
const sample = process.env.SAMPLE_VIDEO;
const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT, DATA_DIR: dataDir, WORKER_INTERVAL_MS: '500', ADMIN_PASSWORD: 'adminpass1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => srv.stdout.on('data', (d) => String(d).includes('รันที่') && res()));

let pass = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok  ', name); } catch (e) { console.error('  FAIL', name, '\n      ', e.message); process.exitCode = 1; } };

class Client {
  cookie = '';
  async req(p, { method = 'GET', body, raw, headers = {} } = {}) {
    const r = await fetch(BASE + p, { method, redirect: 'manual', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}), ...headers }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
    const sc = r.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, body: ct.includes('json') ? await r.json() : await r.arrayBuffer(), headers: r.headers };
  }
}
const admin = new Client(), a = new Client(), b = new Client(), anon = new Client();
const future = (ms) => new Date(Date.now() + ms).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await t('ไม่ล็อกอิน: ดูคลังคลิปได้ แต่เรียก API ที่เป็นของสมาชิกไม่ได้', async () => {
    assert.equal((await anon.req('/api/clips')).status, 200);
    const me = await anon.req('/api/me'); assert.equal(me.status, 200); assert.equal(me.body.user, null);
    for (const path of ['/api/posts', '/api/accounts', '/api/admin/overview']) assert.equal((await anon.req(path)).status, 401, path);
    assert.equal((await anon.req('/api/posts', { method: 'POST', body: {} })).status, 401);
  });
  await t('แอดมินล็อกอิน / รหัสผิดถูกปฏิเสธ', async () => {
    assert.equal((await anon.req('/api/auth/login', { method: 'POST', body: { email: 'admin@klangklip.local', password: 'wrong' } })).status, 401);
    assert.equal((await admin.req('/api/auth/login', { method: 'POST', body: { email: 'admin@klangklip.local', password: 'adminpass1' } })).status, 200);
  });
  await t('สมัครสมาชิก 2 คน + validate', async () => {
    assert.equal((await anon.req('/api/auth/register', { method: 'POST', body: { email: 'x', name: 'x', password: '12345678' } })).status, 400);
    assert.equal((await anon.req('/api/auth/register', { method: 'POST', body: { email: 'x@y.co', name: 'x', password: 'short' } })).status, 400);
    assert.equal((await a.req('/api/auth/register', { method: 'POST', body: { email: 'a@test.co', name: 'สมาชิก A', password: 'password-a' } })).status, 201);
    assert.equal((await b.req('/api/auth/register', { method: 'POST', body: { email: 'b@test.co', name: 'สมาชิก B', password: 'password-b' } })).status, 201);
    assert.equal((await anon.req('/api/auth/register', { method: 'POST', body: { email: 'A@test.co', name: 'dup', password: 'password-a' } })).status, 409);
  });
  let clipId;
  await t('สมาชิกอัปโหลดคลิปไม่ได้ / แอดมินอัปโหลดได้', async () => {
    const buf = sample ? fs.readFileSync(sample) : Buffer.from('not-a-real-video');
    assert.equal((await a.req('/api/admin/clips?title=x', { method: 'POST', raw: buf, headers: { 'Content-Type': 'video/mp4' } })).status, 403);
    assert.equal((await admin.req('/api/admin/clips?title=x', { method: 'POST', raw: buf, headers: { 'Content-Type': 'text/plain' } })).status, 400);
    const r = await admin.req('/api/admin/clips?' + new URLSearchParams({ title: 'คลิปทดสอบ', product: 'สินค้า', hashtags: '#a #b' }), { method: 'POST', raw: buf, headers: { 'Content-Type': 'video/mp4' } });
    assert.equal(r.status, 201); clipId = r.body.clip.id;
    assert.deepEqual(r.body.clip.hashtags, ['a', 'b']);
    if (sample) { assert.equal(r.body.clip.width, 540); assert.ok(r.body.clip.duration > 29); assert.ok(r.body.clip.thumbUrl); }
  });
  await t('สมาชิกเห็นคลิป + สตรีมวิดีโอแบบ Range', async () => {
    assert.equal((await a.req('/api/clips')).body.clips.length, 1);
    const r = await a.req(`/media/video/${clipId}`, { headers: { Range: 'bytes=0-9' } });
    assert.equal(r.status, 206); assert.equal(r.body.byteLength, 10);
    assert.equal((await anon.req(`/media/video/${clipId}`)).status, 200); // ผู้เยี่ยมชมดูตัวอย่างคลิปได้
    assert.equal((await a.req(`/media/video/${clipId}`, { headers: { Range: 'bytes=999999999-' } })).status, 416);
  });
  let accA1, accA2, accB;
  await t('เชื่อมบัญชี และแยกตามสมาชิก', async () => {
    accA1 = (await a.req('/api/accounts/connect', { method: 'POST', body: { platform: 'tiktok', displayName: 'shopA' } })).body.account;
    accA2 = (await a.req('/api/accounts/connect', { method: 'POST', body: { platform: 'facebook', displayName: 'เพจ A' } })).body.account;
    accB = (await b.req('/api/accounts/connect', { method: 'POST', body: { platform: 'instagram', displayName: 'shopB' } })).body.account;
    assert.equal((await a.req('/api/accounts')).body.accounts.length, 2);
    assert.equal((await b.req('/api/accounts')).body.accounts.length, 1);
    assert.equal((await a.req('/api/accounts/connect', { method: 'POST', body: { platform: 'line', displayName: 'x' } })).status, 400);
    const db = fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8');
    assert.ok(!db.includes('mock-token'), 'โทเคนต้องถูกเข้ารหัสในไฟล์');
    assert.equal(JSON.stringify(accA1).includes('token'), false);
  });
  await t('สมาชิก B ใช้บัญชีของ A ไม่ได้', async () => {
    const r = await b.req('/api/posts', { method: 'POST', body: { clipIds: [clipId], accountIds: [accA1.id], scheduledAt: future(60000) } });
    assert.equal(r.status, 400);
  });
  await t('validate การตั้งเวลา (อดีต, ลิงก์, ตะกร้า)', async () => {
    const base = { clipIds: [clipId], accountIds: [accA1.id] };
    assert.equal((await a.req('/api/posts', { method: 'POST', body: { ...base, scheduledAt: future(-3600000) } })).status, 400);
    assert.equal((await a.req('/api/posts', { method: 'POST', body: { ...base, scheduledAt: 'abc' } })).status, 400);
    assert.equal((await a.req('/api/posts', { method: 'POST', body: { ...base, scheduledAt: future(60000), productUrl: 'javascript:alert(1)' } })).status, 400);
    assert.equal((await a.req('/api/posts', { method: 'POST', body: { clipIds: [clipId], accountIds: [accA2.id], scheduledAt: future(60000), cartProductId: '123' } })).status, 400);
  });
  let postIds;
  await t('ตั้งเวลา 2 บัญชี → ถึงเวลาแล้วโพสต์เอง', async () => {
    const r = await a.req('/api/posts', { method: 'POST', body: { clipIds: [clipId], accountIds: [accA1.id, accA2.id], scheduledAt: future(1500), caption: 'แคปชัน', productUrl: 'https://shop.example/a', cartProductId: 'SKU1' } });
    assert.equal(r.status, 201); assert.equal(r.body.posts.length, 2);
    postIds = r.body.posts.map((p) => p.id);
    assert.equal(r.body.posts.find((p) => p.platform === 'facebook').cartProductId, '', 'ตะกร้าใช้เฉพาะ TikTok');
    assert.equal(r.body.posts.find((p) => p.platform === 'tiktok').cartProductId, 'SKU1');
    assert.ok((await a.req('/api/posts?status=scheduled')).body.posts.length >= 2);
    await sleep(3000);
    const posted = (await a.req('/api/posts?status=posted')).body.posts;
    assert.equal(posted.length, 2, JSON.stringify((await a.req('/api/posts')).body.posts.map((p) => [p.status, p.error])));
    assert.ok(posted.every((p) => p.result.url.startsWith('https://')));
  });
  await t('A เห็นเฉพาะโพสต์ตัวเอง / B แก้ของ A ไม่ได้', async () => {
    assert.equal((await b.req('/api/posts')).body.posts.length, 0);
    assert.equal((await b.req(`/api/posts/${postIds[0]}`, { method: 'DELETE' })).status, 404);
    assert.equal((await b.req(`/api/posts/${postIds[0]}`, { method: 'PATCH', body: { caption: 'hack' } })).status, 404);
  });
  let multi;
  await t('หลายคลิป × เว้นช่วงเวลา, แก้ไข, ยกเลิก', async () => {
    const buf = sample ? fs.readFileSync(sample) : Buffer.from('v2');
    const c2 = (await admin.req('/api/admin/clips?title=คลิป2', { method: 'POST', raw: buf, headers: { 'Content-Type': 'video/mp4' } })).body.clip.id;
    const t0 = Date.now() + 3600_000;
    const r = await a.req('/api/posts', { method: 'POST', body: { clipIds: [clipId, c2], accountIds: [accA1.id], scheduledAt: new Date(t0).toISOString(), intervalMinutes: 90 } });
    assert.equal(r.status, 201); multi = r.body.posts;
    assert.equal(Date.parse(multi[1].scheduledAt) - Date.parse(multi[0].scheduledAt), 90 * 60_000);
    const e = await a.req(`/api/posts/${multi[0].id}`, { method: 'PATCH', body: { caption: 'ใหม่', scheduledAt: future(7200000) } });
    assert.equal(e.status, 200); assert.equal(e.body.post.caption, 'ใหม่');
    assert.equal((await a.req(`/api/posts/${multi[1].id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await a.req('/api/posts?status=canceled')).body.posts.length, 1);
    assert.equal((await admin.req(`/api/admin/clips/${clipId}`, { method: 'DELETE' })).status, 409, 'ลบคลิปที่ยังมีคิวไม่ได้');
    assert.equal((await a.req(`/api/accounts/${accA1.id}`, { method: 'DELETE' })).status, 409, 'ยกเลิกบัญชีที่ยังมีคิวไม่ได้');
    assert.equal((await a.req(`/api/posts/${postIds[0]}`, { method: 'PATCH', body: { caption: 'x' } })).status, 409, 'แก้โพสต์ที่โพสต์แล้วไม่ได้');
  });
  await t('สิทธิ์แอดมิน + retry ใช้ได้เฉพาะโพสต์ที่ล้มเหลว', async () => {
    const o = await admin.req('/api/admin/overview');
    assert.equal(o.status, 200); assert.equal(o.body.members.length, 2);
    assert.equal((await a.req('/api/admin/overview')).status, 403);
    assert.equal((await a.req(`/api/posts/${postIds[0]}/retry`, { method: 'POST' })).status, 409);
  });
  await t('Origin ข้ามไซต์ถูกปฏิเสธ + path traversal ไม่ได้', async () => {
    assert.equal((await a.req('/api/accounts/connect', { method: 'POST', body: { platform: 'tiktok', displayName: 'x' }, headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await anon.req('/..%2f..%2fserver.js')).status, 404);
    assert.equal((await anon.req('/')).status, 200);
  });
} finally {
  srv.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log(`\nผ่าน ${pass} ชุด${process.exitCode ? ' (มีที่ล้มเหลว)' : ''}`);
}
