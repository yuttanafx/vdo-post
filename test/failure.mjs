// ทดสอบเส้นทางล้มเหลว: MOCK_FAIL_RATE=1 → ลองใหม่ 3 ครั้ง → failed → กด retry
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import assert from 'node:assert/strict';
const PORT = 3800 + Math.floor(Math.random() * 100), BASE = `http://localhost:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkf-'));
const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT, DATA_DIR: dataDir, WORKER_INTERVAL_MS: '300', MOCK_FAIL_RATE: '1', ADMIN_PASSWORD: 'adminpass1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => srv.stdout.on('data', (d) => String(d).includes('รันที่') && r()));
let cookie = '';
const req = async (p, o = {}) => { const r = await fetch(BASE + p, { method: o.method || 'GET', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(o.headers || {}) }, body: o.raw ?? (o.body ? JSON.stringify(o.body) : undefined) }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; return { status: r.status, body: await r.json() }; };
try {
  await req('/api/auth/login', { method: 'POST', body: { email: 'admin@klangklip.local', password: 'adminpass1' } });
  const clip = (await req('/api/admin/clips?title=t', { method: 'POST', raw: Buffer.from('x'), headers: { 'Content-Type': 'video/mp4' } })).body.clip;
  const acc = (await req('/api/accounts/connect', { method: 'POST', body: { platform: 'tiktok', displayName: 'a' } })).body.account;
  const p = (await req('/api/posts', { method: 'POST', body: { clipIds: [clip.id], accountIds: [acc.id], scheduledAt: new Date(Date.now() + 200).toISOString() } })).body.posts[0];
  await new Promise((r) => setTimeout(r, 1500));
  let cur = (await req('/api/posts')).body.posts[0];
  assert.equal(cur.status, 'scheduled'); assert.equal(cur.attempts, 1); assert.match(cur.error, /จะลองใหม่ใน 5 นาที/);
  assert.ok(Date.parse(cur.scheduledAt) > Date.now() + 4 * 60_000, 'ต้องเลื่อนไป ~5 นาที');
  // ข้ามการรอ: ใช้ PATCH ให้ถึงเวลาทันที 2 รอบ
  for (let i = 0; i < 2; i++) { await req(`/api/posts/${p.id}`, { method: 'PATCH', body: { scheduledAt: new Date().toISOString() } }); await new Promise((r) => setTimeout(r, 1200)); }
  cur = (await req('/api/posts')).body.posts[0];
  assert.equal(cur.status, 'failed'); assert.equal(cur.attempts, 3);
  const r = await req(`/api/posts/${p.id}/retry`, { method: 'POST' });
  assert.equal(r.status, 200); assert.equal(r.body.post.status, 'scheduled'); assert.equal(r.body.post.attempts, 0);
  console.log('ok   ล้มเหลว → ลองใหม่ → failed ครบ 3 ครั้ง → retry');
} catch (e) { console.error('FAIL', e.message); process.exitCode = 1; } finally { srv.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); }
