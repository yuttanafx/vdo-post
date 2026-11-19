// ที่เก็บข้อมูลแบบไฟล์ JSON (เขียนแบบ atomic) — โหมด dev ไม่ต้องใช้ Firebase
// ทุกการเข้าถึงข้อมูลผ่านไฟล์นี้ที่เดียว เพื่อให้สลับไปใช้ Firestore ได้ภายหลัง
import fs from 'node:fs';
import path from 'node:path';

// บน Vercel ดิสก์เขียนได้เฉพาะ /tmp (ข้อมูลชั่วคราว หายเมื่อ function รีสตาร์ต)
const DATA = path.resolve(process.env.DATA_DIR || (process.env.VERCEL ? '/tmp/klangklip' : 'data'));
const FILE = path.join(DATA, 'db.json');
const COLLECTIONS = ['users', 'clips', 'accounts', 'posts'];

fs.mkdirSync(path.join(DATA, 'uploads'), { recursive: true });
fs.mkdirSync(path.join(DATA, 'thumbs'), { recursive: true });

const db = Object.fromEntries(COLLECTIONS.map((c) => [c, []]));
if (fs.existsSync(FILE)) Object.assign(db, JSON.parse(fs.readFileSync(FILE, 'utf8')));

export function save() {
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, FILE);
}

export const DATA_DIR = DATA;
export const all = (coll) => db[coll];
export const find = (coll, id) => db[coll].find((x) => x.id === id) || null;
export const where = (coll, fn) => db[coll].filter(fn);

export function insert(coll, doc) {
  db[coll].push(doc);
  save();
  return doc;
}

export function update(coll, id, patch) {
  const doc = find(coll, id);
  if (!doc) return null;
  Object.assign(doc, patch);
  save();
  return doc;
}

export function remove(coll, id) {
  const i = db[coll].findIndex((x) => x.id === id);
  if (i < 0) return false;
  db[coll].splice(i, 1);
  save();
  return true;
}
