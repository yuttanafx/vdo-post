// รหัสผ่าน (scrypt), เข้ารหัสโทเคนโซเชียล (AES-256-GCM), ลงนามเซสชัน (HMAC)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DATA = path.resolve(process.env.DATA_DIR || (process.env.VERCEL ? '/tmp/klangklip' : 'data'));

function loadKey(envName, file, bytes) {
  const fromEnv = process.env[envName];
  if (fromEnv) {
    const buf = Buffer.from(fromEnv, 'hex');
    if (buf.length !== bytes) throw new Error(`${envName} ต้องเป็น hex ${bytes} ไบต์`);
    return buf;
  }
  if (process.env.VERCEL) {
    // Vercel มีหลาย instance และดิสก์ไม่ถาวร กุญแจสุ่มจะทำให้เซสชันหลุดสลับกัน → ใช้ค่าคงที่
    if (process.env.PLATFORM_MODE === 'live') throw new Error(`${envName} ต้องตั้งใน Environment Variables ของ Vercel (openssl rand -hex ${bytes})`);
    console.warn(`[demo] ${envName} ไม่ได้ตั้ง ใช้ค่าที่คำนวณจากโปรเจกต์แทน (ใช้ทดสอบเท่านั้น)`);
    return crypto.createHash('sha256').update(`${envName}:${process.env.VERCEL_PROJECT_ID || 'klangklip'}:${process.env.ADMIN_PASSWORD || ''}`).digest().subarray(0, bytes);
  }
  const f = path.join(DATA, file);
  if (fs.existsSync(f)) return Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex');
  fs.mkdirSync(DATA, { recursive: true });
  const buf = crypto.randomBytes(bytes);
  fs.writeFileSync(f, buf.toString('hex'), { mode: 0o600 });
  return buf;
}

const TOKEN_KEY = loadKey('TOKEN_KEY', 'token.key', 32);
const SESSION_KEY = loadKey('SESSION_KEY', 'session.key', 32);

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(pw, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

export function encryptToken(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', TOKEN_KEY, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

export function decryptToken(blob) {
  const [iv, tag, enc] = String(blob).split('.').map((s) => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', TOKEN_KEY, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

const b64u = (b) => Buffer.from(b).toString('base64url');

// purpose กันไม่ให้โทเคนต่างชนิด (เช่น OAuth state) ถูกนำมาใช้เป็นเซสชันล็อกอิน
export function signSession(uid, ttlMs = 14 * 24 * 3600 * 1000, purpose = 'session') {
  const body = b64u(JSON.stringify({ uid, exp: Date.now() + ttlMs, p: purpose }));
  const sig = crypto.createHmac('sha256', SESSION_KEY).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function readSession(token, purpose = 'session') {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const good = crypto.createHmac('sha256', SESSION_KEY).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== good.length || !crypto.timingSafeEqual(given, good)) return null;
  try {
    const s = JSON.parse(Buffer.from(body, 'base64url').toString());
    return s.exp > Date.now() && (s.p || 'session') === purpose ? s : null;
  } catch {
    return null;
  }
}

export const newId = (prefix) => `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
