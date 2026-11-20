// คลังคลิป — หน้าเว็บ (vanilla JS ไม่มี build step)
const $app = document.getElementById('app');
const S = { me: null, platforms: {}, mode: 'mock', tab: 'library', clips: [], accounts: [], posts: [], filter: 'scheduled', q: '', selected: new Set(), overview: null, authMode: 'login' };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (iso) => new Date(iso).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' });
const fmtDur = (s) => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : '');
const pad = (n) => String(n).padStart(2, '0');
const toLocalInput = (d) => { d = new Date(d); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const STATUS = { scheduled: 'รอโพสต์', posting: 'กำลังโพสต์', posted: 'โพสต์แล้ว', failed: 'ล้มเหลว', canceled: 'ยกเลิกแล้ว' };
const platLabel = (p) => S.platforms[p]?.label || p;

function toast(msg, isErr) {
  const el = Object.assign(document.createElement('div'), { className: `toast${isErr ? ' err' : ''}`, textContent: msg });
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), 4500);
}

async function api(path, { method = 'GET', body, raw, headers } = {}) {
  const res = await fetch(path, { method, headers: { ...(body && !raw ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && S.me) { S.me = null; render(); }
  if (!res.ok) throw new Error(data.error || `ผิดพลาด (${res.status})`);
  return data;
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

// ---------- modal ----------
function modal(html, { wide } = {}) {
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `<div class="card modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true">${html}</div>`;
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => e.key === 'Escape' && close();
  ov.addEventListener('mousedown', (e) => e.target === ov && close());
  document.addEventListener('keydown', onKey);
  document.body.append(ov);
  ov.querySelector('[data-close]')?.addEventListener('click', close);
  ov.querySelector('input:not([type=checkbox]), textarea, select')?.focus();
  return { el: ov, close };
}

// ---------- data ----------
async function loadClips() { S.clips = (await api(`/api/clips?q=${encodeURIComponent(S.q)}`)).clips; }
async function loadAccounts() { S.accounts = (await api('/api/accounts')).accounts; }
async function loadPosts() { S.posts = (await api('/api/posts')).posts; }
async function loadOverview() { S.overview = S.me.role === 'admin' ? await api('/api/admin/overview') : null; }

async function boot() {
  try {
    const me = await api('/api/me');
    Object.assign(S, { me: me.user, platforms: me.platforms, mode: me.mode, connect: me.connect, aiCaption: me.aiCaption, aiKey: me.aiKey || { set: false } });
    await Promise.all([loadClips(), ...(S.me ? [loadAccounts(), loadPosts()] : [])]);
  } catch { S.me = null; }
  render();
  if (S.me) {
    handleOAuthReturn();
    // ล็อกอินสำเร็จจากป๊อปอัพ → ทำสิ่งที่ค้างไว้ต่อ (เช่น เปิดหน้าตั้งเวลาโพสต์ของคลิปที่กด)
    const next = S.afterLogin; S.afterLogin = null;
    if (next) next();
  }
}

// กลับจาก Facebook OAuth: #fbpick=<id> → เลือกเพจ, #fb=denied|error|nopages → แจ้งผล
function handleOAuthReturn() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (!h.size) return;
  history.replaceState(null, '', location.pathname);
  S.tab = 'accounts'; render();
  const msg = { denied: 'ยกเลิกการเชื่อม Facebook', error: 'เชื่อม Facebook ไม่สำเร็จ ลองใหม่อีกครั้ง', nopages: 'ไม่พบเพจที่คุณมีสิทธิ์จัดการ (ต้องเป็นแอดมินเพจและอนุญาตให้แอปเข้าถึงเพจ)' }[h.get('fb')];
  if (msg) toast(msg, true);
  if (h.get('fbpick')) openPagePicker(h.get('fbpick'));
}

async function openPagePicker(id) {
  let pages;
  try { pages = (await api(`/api/oauth/facebook/pending/${id}`)).pages; } catch (e) { return toast(e.message, true); }
  const m = modal(`<h2>เลือกเพจ Facebook ที่จะใช้โพสต์</h2><form id="pp">
    ${pages.map((p) => `<label class="check"><input type="checkbox" name="pg" value="${esc(p.id)}" ${p.connected ? '' : 'checked'}><span>${esc(p.name)}${p.connected ? ' <span class="hint">(เชื่อมอยู่แล้ว — เลือกเพื่อต่ออายุสิทธิ์)</span>' : ''}</span></label>`).join('')}
    <p class="err-msg" id="ppErr" role="alert"></p>
    <div class="modal-foot"><button type="button" class="btn" data-close>ยกเลิก</button><button class="btn primary">เชื่อมเพจที่เลือก</button></div></form>`);
  m.el.querySelector('#pp').onsubmit = async (e) => {
    e.preventDefault();
    try { await api(`/api/oauth/facebook/pending/${id}/select`, { method: 'POST', body: { pageIds: new FormData(e.target).getAll('pg') } }); await loadAccounts(); m.close(); viewAccounts(); toast('เชื่อมเพจแล้ว'); }
    catch (err) { m.el.querySelector('#ppErr').textContent = err.message; }
  };
}

// ---------- render ----------
function render() {
  if (!S.me) return renderGuest();
  const tabs = [['library', 'คลังคลิป'], ['queue', 'คิวโพสต์'], ['accounts', 'บัญชีของฉัน'], ...(S.me.role === 'admin' ? [['admin', 'ผู้ดูแล']] : [])];
  const pending = S.posts.filter((p) => p.status === 'scheduled').length;
  $app.innerHTML = `
    <header class="topbar"><div class="topbar-in">
      <div class="logo"><i></i>คลังคลิป</div>
      <nav class="nav" aria-label="เมนูหลัก">${tabs.map(([k, l]) => `<button data-tab="${k}" ${S.tab === k ? 'aria-current="page"' : ''}>${l}${k === 'queue' && pending ? ` (${pending})` : ''}</button>`).join('')}</nav>
      <div class="who"><span>${esc(S.me.name)}</span><button class="btn sm" id="logout">ออกจากระบบ</button></div>
    </div></header>
    <main id="view"></main>`;
  $app.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', guard(async () => { S.tab = b.dataset.tab; if (S.tab === 'queue') await loadPosts(); if (S.tab === 'admin') await loadOverview(); render(); })));
  $app.querySelector('#logout').addEventListener('click', guard(async () => { await api('/api/auth/logout', { method: 'POST' }); S.me = null; S.selected.clear(); render(); }));
  ({ library: viewLibrary, queue: viewQueue, accounts: viewAccounts, admin: viewAdmin })[S.tab]();
}

// ผู้เยี่ยมชมที่ยังไม่ล็อกอิน: เห็นคลังคลิปได้เลย ล็อกอินเมื่อจะตั้งเวลาโพสต์เท่านั้น
function renderGuest() {
  S.tab = 'library';
  $app.innerHTML = `
    <header class="topbar"><div class="topbar-in">
      <div class="logo"><i></i>คลังคลิป</div>
      <div class="nav"></div>
      <div class="who"><button class="btn sm" id="gLogin">เข้าสู่ระบบ</button><button class="btn sm primary" id="gReg">สมัครสมาชิก</button></div>
    </div></header>
    <main id="view"></main>`;
  $app.querySelector('#gLogin').onclick = () => openAuthModal('login');
  $app.querySelector('#gReg').onclick = () => openAuthModal('register');
  viewLibrary();
}

// ถ้ายังไม่ล็อกอิน เด้งป๊อปอัพให้ล็อกอินก่อน แล้วค่อยทำ next() ต่อหลังล็อกอินสำเร็จ
function requireLogin(next) {
  if (S.me) return next();
  openAuthModal('login', next);
}

function openAuthModal(mode = 'login', next = null) {
  S.authMode = mode; S.afterLogin = next;
  const m = modal('', { wide: true });
  const box = m.el.querySelector('.modal');
  const draw = () => {
    const reg = S.authMode === 'register';
    box.innerHTML = `<div class="logo"><i></i>คลังคลิป</div>
    <p class="sub">${reg ? 'สมัครสมาชิกเพื่อตั้งเวลาโพสต์คลิป' : next ? 'เข้าสู่ระบบเพื่อตั้งเวลาโพสต์คลิป' : 'เข้าสู่ระบบเพื่อจัดคิวโพสต์คลิป'}</p>
    <form id="authForm">
    ${reg ? '<label class="f"><span>ชื่อ</span><input type="text" name="name" required maxlength="100" autocomplete="name"></label>' : ''}
    <label class="f"><span>อีเมล</span><input type="email" name="email" required autocomplete="email"></label>
    <label class="f"><span>รหัสผ่าน</span><input type="password" name="password" required minlength="${reg ? 8 : 1}" autocomplete="${reg ? 'new-password' : 'current-password'}">${reg ? '<div class="hint">อย่างน้อย 8 ตัวอักษร</div>' : ''}</label>
    <p class="err-msg" id="authErr" role="alert"></p>
    <button class="btn primary" style="width:100%">${reg ? 'สมัครสมาชิก' : 'เข้าสู่ระบบ'}</button>
    </form>
    <div class="switch">${reg ? 'มีบัญชีแล้ว?' : 'ยังไม่มีบัญชี?'} <button type="button" class="link" id="swap">${reg ? 'เข้าสู่ระบบ' : 'สมัครสมาชิก'}</button> · <button type="button" class="link" id="authCancel">ไว้ก่อน</button></div>`;
    box.querySelector('#swap').onclick = () => { S.authMode = reg ? 'login' : 'register'; draw(); };
    box.querySelector('#authCancel').onclick = () => { S.afterLogin = null; m.close(); };
    box.querySelector('#authForm').onsubmit = async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target));
      const btn = e.target.querySelector('button.primary'); btn.disabled = true;
      try {
        await api(`/api/auth/${reg ? 'register' : 'login'}`, { method: 'POST', body });
        m.close();
        await boot();
      } catch (err) { box.querySelector('#authErr').textContent = err.message; btn.disabled = false; }
    };
    box.querySelector('input')?.focus();
  };
  draw();
}

// ---------- library ----------
function viewLibrary() {
  const admin = S.me?.role === 'admin';
  const v = document.getElementById('view');
  v.innerHTML = `
    <div class="page-head">
      <div><h1>คลังคลิป</h1><p>${S.me ? 'เลือกคลิปที่ต้องการ แล้วกดตั้งเวลาโพสต์ลง TikTok / Facebook / Instagram' : 'ดูคลิปได้เลย — เข้าสู่ระบบเมื่อต้องการตั้งเวลาโพสต์ลง TikTok / Facebook / Instagram'}</p></div>
      <div class="row"><input type="search" id="q" placeholder="ค้นหาชื่อ สินค้า แฮชแท็ก" value="${esc(S.q)}" style="width:240px" aria-label="ค้นหาคลิป">${admin ? '<button class="btn primary" id="addClip">+ เพิ่มคลิป</button>' : ''}</div>
    </div>
    ${S.clips.length ? `<div class="grid">${S.clips.map(clipCard).join('')}</div>` : `<div class="card empty"><h3>${S.q ? 'ไม่พบคลิปที่ค้นหา' : 'ยังไม่มีคลิปในคลัง'}</h3>${admin && !S.q ? 'กด "+ เพิ่มคลิป" เพื่ออัปโหลดคลิปแรก' : S.q ? '' : 'รอผู้ดูแลเพิ่มคลิป'}</div>`}
    ${S.selected.size ? `<div class="selbar"><span>เลือก ${S.selected.size} คลิป</span><button class="btn primary" id="schedSel">ตั้งเวลาโพสต์</button><button class="btn" id="clearSel">ล้าง</button></div>` : ''}`;

  let t; v.querySelector('#q').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(guard(async () => { S.q = e.target.value; await loadClips(); const pos = e.target.selectionStart; viewLibrary(); const q = document.getElementById('q'); q.focus(); q.setSelectionRange(pos, pos); }), 250); });
  v.querySelector('#addClip')?.addEventListener('click', openUpload);
  v.querySelector('#schedSel')?.addEventListener('click', () => openSchedule([...S.selected]));
  v.querySelector('#clearSel')?.addEventListener('click', () => { S.selected.clear(); viewLibrary(); });
  v.querySelectorAll('[data-pick]').forEach((i) => i.addEventListener('change', () => { i.checked ? S.selected.add(i.dataset.pick) : S.selected.delete(i.dataset.pick); viewLibrary(); }));
  v.querySelectorAll('[data-play]').forEach((b) => b.addEventListener('click', () => {
    const c = S.clips.find((x) => x.id === b.dataset.play);
    const m = modal(`<h2>${esc(c.title)}</h2><video src="${c.videoUrl}" controls autoplay playsinline></video><div class="modal-foot"><button class="btn" data-close>ปิด</button><button class="btn primary" id="go">ตั้งเวลาโพสต์คลิปนี้</button></div>`);
    m.el.querySelector('#go').onclick = () => { m.close(); openSchedule([c.id]); };
  }));
  v.querySelectorAll('[data-sched]').forEach((b) => b.addEventListener('click', () => openSchedule([b.dataset.sched])));
  v.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openEditClip(b.dataset.edit)));
  v.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', guard(async () => { const c = S.clips.find((x) => x.id === b.dataset.del); if (!confirm(`ลบคลิป "${c.title}" ออกจากคลัง?`)) return; await api(`/api/admin/clips/${c.id}`, { method: 'DELETE' }); S.selected.delete(c.id); await loadClips(); viewLibrary(); toast('ลบคลิปแล้ว'); })));
}

function clipCard(c) {
  const admin = S.me?.role === 'admin';
  const tags = (c.hashtags || []).slice(0, 3).map((h) => `#${esc(h)}`).join(' ');
  return `<article class="card clip ${S.selected.has(c.id) ? 'sel' : ''}">
    <button class="thumb" data-play="${c.id}" style="${c.thumbUrl ? `background-image:url('${c.thumbUrl}')` : ''}" aria-label="ดูตัวอย่าง ${esc(c.title)}"><span class="play"></span>${c.duration ? `<span class="dur">${fmtDur(c.duration)}</span>` : ''}</button>
    <label class="pick" title="เลือกคลิปนี้"><input type="checkbox" data-pick="${c.id}" ${S.selected.has(c.id) ? 'checked' : ''} aria-label="เลือก ${esc(c.title)}"></label>
    <div class="clip-body"><h3>${esc(c.title)}</h3>${c.product ? `<div class="prod">${esc(c.product)}</div>` : ''}${tags ? `<div class="prod">${tags}</div>` : ''}
      <div class="clip-actions"><button class="btn sm primary" data-sched="${c.id}">ตั้งเวลา</button>${admin ? `<button class="btn sm" data-edit="${c.id}">แก้ไข</button><button class="btn sm danger" data-del="${c.id}">ลบ</button>` : ''}</div></div>
  </article>`;
}

function openUpload() {
  const m = modal(`<h2>เพิ่มคลิปเข้าคลัง</h2><form id="up">
    <label class="f"><span>ไฟล์วิดีโอ (MP4 / MOV ไม่เกิน 500 MB)</span><input type="file" name="file" accept="video/mp4,video/quicktime" required></label>
    <label class="f"><span>ชื่อคลิป</span><input type="text" name="title" required maxlength="200"></label>
    <label class="f"><span>สินค้า</span><input type="text" name="product" maxlength="200"></label>
    <label class="f"><span>แคปชันเริ่มต้น</span><textarea name="caption" maxlength="2000"></textarea></label>
    <label class="f"><span>แฮชแท็ก (คั่นด้วยเว้นวรรค)</span><input type="text" name="hashtags" placeholder="อินนูลิน ไฟเบอร์ สุขภาพ"></label>
    <p class="err-msg" id="upErr" role="alert"></p>
    <div class="modal-foot"><button type="button" class="btn" data-close>ยกเลิก</button><button class="btn primary" id="upBtn">อัปโหลด</button></div></form>`);
  m.el.querySelector('input[name=file]').addEventListener('change', (e) => { const t = m.el.querySelector('input[name=title]'); if (!t.value && e.target.files[0]) t.value = e.target.files[0].name.replace(/\.[^.]+$/, ''); });
  m.el.querySelector('#up').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target); const file = f.get('file');
    const qs = new URLSearchParams({ title: f.get('title'), product: f.get('product'), caption: f.get('caption'), hashtags: f.get('hashtags') });
    const btn = m.el.querySelector('#upBtn'); btn.disabled = true; btn.textContent = 'กำลังอัปโหลด…';
    try { await api(`/api/admin/clips?${qs}`, { method: 'POST', raw: file, headers: { 'Content-Type': file.type || 'video/mp4' } }); await loadClips(); m.close(); viewLibrary(); toast('เพิ่มคลิปแล้ว'); }
    catch (err) { m.el.querySelector('#upErr').textContent = err.message; btn.disabled = false; btn.textContent = 'อัปโหลด'; }
  };
}

function openEditClip(id) {
  const c = S.clips.find((x) => x.id === id);
  const m = modal(`<h2>แก้ไขคลิป</h2><form id="ed">
    <label class="f"><span>ชื่อคลิป</span><input type="text" name="title" required maxlength="200" value="${esc(c.title)}"></label>
    <label class="f"><span>สินค้า</span><input type="text" name="product" maxlength="200" value="${esc(c.product)}"></label>
    <label class="f"><span>แคปชันเริ่มต้น</span><textarea name="caption" maxlength="2000">${esc(c.caption)}</textarea></label>
    ${aiBoxHtml()}
    <label class="f" style="margin-top:14px"><span>แฮชแท็ก</span><input type="text" name="hashtags" value="${esc((c.hashtags || []).join(' '))}"></label>
    <div class="modal-foot"><button type="button" class="btn" data-close>ยกเลิก</button><button class="btn primary">บันทึก</button></div></form>`);
  wireAi(m.el, id, m.el.querySelector('[name=caption]'));
  m.el.querySelector('#ed').onsubmit = guard(async (e) => { e.preventDefault(); await api(`/api/admin/clips/${id}`, { method: 'PATCH', body: Object.fromEntries(new FormData(e.target)) }); await loadClips(); m.close(); viewLibrary(); toast('บันทึกแล้ว'); });
}

// ---------- AI caption ----------
const TONES = ['ขายตรง กระตุ้นให้ซื้อ', 'สนุก เป็นกันเอง', 'รีวิวจริงใจ น่าเชื่อถือ', 'พรีเมียม สุภาพ'];
function aiBoxHtml() {
  if (S.aiCaption === 'off') return '<div class="ai"><button type="button" class="btn sm" disabled>✨ AI คิดคอนเทนต์ให้</button><div class="hint">ยังไม่ได้ใส่ API key ของคุณ — <button type="button" class="link" data-ai-setup>ไปใส่ที่ "บัญชีของฉัน"</button></div></div>';
  return `<div class="ai">
    <div class="row"><select data-ai-tone aria-label="น้ำเสียงแคปชัน" style="width:auto;flex:1">${TONES.map((t) => `<option>${esc(t)}</option>`).join('')}</select><button type="button" class="btn sm primary" data-ai-go>✨ AI คิดคอนเทนต์ให้</button></div>
    <input type="text" data-ai-hint maxlength="300" placeholder="บอก AI เพิ่มเติม (ไม่บังคับ) เช่น กลุ่มลูกค้าคือคนทำงานออฟฟิศ" style="margin-top:8px" aria-label="ข้อมูลเพิ่มเติมสำหรับ AI">
    <div class="hint" style="margin-top:6px">AI จะดูภาพจากในคลิปและข้อมูลสินค้า แล้วเสนอคอนเทนต์ 3 แบบให้เลือกแนบกับคลิป${S.aiKey?.set ? '' : ' · (ยังไม่ได้ใส่ API key ของคุณ)'}</div>
    <div data-ai-out aria-live="polite"></div></div>`;
}
function wireAi(root, clipId, textarea) {
  root.querySelector('[data-ai-setup]')?.addEventListener('click', () => { root.querySelector('[data-close]')?.click(); S.tab = 'accounts'; render(); });
  const go = root.querySelector('[data-ai-go]'); if (!go) return;
  const out = root.querySelector('[data-ai-out]');
  go.addEventListener('click', async () => {
    go.disabled = true; go.textContent = '✨ กำลังดูคลิปและคิดคอนเทนต์…'; out.innerHTML = '';
    try {
      const r = await api('/api/captions/generate', { method: 'POST', body: { clipId, tone: root.querySelector('[data-ai-tone]').value, hint: root.querySelector('[data-ai-hint]').value } });
      out.innerHTML = `<div class="hint" style="margin:8px 0 4px">${r.mock ? 'ตัวอย่างจำลอง (ยังไม่ได้ใส่ API key) — ' : ''}กดเลือกแบบที่ชอบเพื่อแนบเป็นแคปชันของคลิปนี้ แล้วแก้ไขต่อได้</div>${r.captions.map((c, i) => `<button type="button" class="ai-opt" data-i="${i}">${esc(c)}</button>`).join('')}`;
      out.querySelectorAll('.ai-opt').forEach((b) => b.addEventListener('click', () => { textarea.value = r.captions[b.dataset.i]; out.querySelectorAll('.ai-opt').forEach((x) => x.classList.toggle('on', x === b)); textarea.focus(); }));
    } catch (e) { out.innerHTML = `<div class="err-msg" style="margin-top:8px" role="alert">${esc(e.message)}</div>`; }
    go.disabled = false; go.textContent = '✨ คิดใหม่อีกครั้ง';
  });
}

// ---------- schedule ----------
function openSchedule(clipIds) {
  if (!S.me) return requireLogin(() => openSchedule(clipIds));
  const clips = clipIds.map((id) => S.clips.find((c) => c.id === id)).filter(Boolean);
  if (!clips.length) return;
  if (!S.accounts.length) {
    const m = modal(`<h2>ยังไม่ได้เชื่อมบัญชี</h2><p>ต้องเชื่อมบัญชี TikTok / Facebook / Instagram อย่างน้อย 1 บัญชีก่อนตั้งเวลาโพสต์</p><div class="modal-foot"><button class="btn" data-close>ปิด</button><button class="btn primary" id="go">ไปเชื่อมบัญชี</button></div>`, { wide: true });
    m.el.querySelector('#go').onclick = () => { m.close(); S.tab = 'accounts'; render(); };
    return;
  }
  const soon = new Date(Date.now() + 3600_000); soon.setMinutes(0, 0, 0);
  const single = clips.length === 1;
  const m = modal(`<h2>ตั้งเวลาโพสต์</h2><form id="sc">
    <div class="chips">${clips.map((c) => `<span class="chip">${esc(c.title)}</span>`).join('')}</div>
    <fieldset style="border:0;padding:0;margin:0 0 14px"><legend style="font-weight:600;font-size:14px;margin-bottom:5px">โพสต์ไปที่ (เลือกได้หลายบัญชี)</legend>
      ${S.accounts.map((a) => `<label class="check"><input type="checkbox" name="acc" value="${a.id}" data-cart="${a.supportsCart ? 1 : 0}"><span class="badge ${a.platform}">${esc(platLabel(a.platform))}</span> ${esc(a.displayName)}</label>`).join('')}</fieldset>
    <label class="f"><span>${single ? 'วันและเวลาที่โพสต์' : 'เวลาโพสต์คลิปแรก'}</span><input type="datetime-local" name="at" required value="${toLocalInput(soon)}"></label>
    ${single ? '' : `<label class="f"><span>เว้นช่วงระหว่างคลิป (นาที)</span><input type="number" name="interval" min="0" max="10080" value="60"><div class="hint">เช่น 60 = คลิปถัดไปโพสต์ห่างกันทีละ 1 ชั่วโมง</div></label>`}
    <label class="f"><span>แคปชัน</span><textarea name="caption" maxlength="2000" placeholder="${single ? '' : 'เว้นว่าง = ใช้แคปชันเริ่มต้นของแต่ละคลิป'}">${single ? esc(clips[0].caption) : ''}</textarea></label>
    ${single ? aiBoxHtml() : ''}
    <label class="f"><span>ลิงก์สินค้า / ร้านค้าของคุณ</span><input type="url" name="productUrl" placeholder="https://shopee.co.th/ร้านของคุณ"><div class="hint">จะแนบไปกับแคปชัน (บน TikTok/Instagram ลิงก์ในแคปชันกดไม่ได้)</div></label>
    <label class="f" id="cartBox" hidden><span>รหัสสินค้าสำหรับปักตะกร้า TikTok (ถ้ามี)</span><input type="text" name="cartProductId" maxlength="64" placeholder="รหัสสินค้าใน TikTok Shop"></label>
    <p class="err-msg" id="scErr" role="alert"></p>
    <div class="modal-foot"><button type="button" class="btn" data-close>ยกเลิก</button><button class="btn primary">ตั้งเวลา</button></div></form>`);
  const syncCart = () => { m.el.querySelector('#cartBox').hidden = ![...m.el.querySelectorAll('[name=acc]:checked')].some((i) => i.dataset.cart === '1'); };
  m.el.querySelectorAll('[name=acc]').forEach((i) => i.addEventListener('change', syncCart));
  if (single) wireAi(m.el, clips[0].id, m.el.querySelector('[name=caption]'));
  m.el.querySelector('#sc').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target); const accountIds = f.getAll('acc');
    const err = m.el.querySelector('#scErr');
    if (!accountIds.length) { err.textContent = 'เลือกบัญชีอย่างน้อย 1 บัญชี'; return; }
    try {
      const r = await api('/api/posts', { method: 'POST', body: { clipIds, accountIds, scheduledAt: new Date(f.get('at')).toISOString(), intervalMinutes: f.get('interval') || 0, caption: f.get('caption'), productUrl: f.get('productUrl'), cartProductId: f.get('cartProductId') || '' } });
      await loadPosts(); S.selected.clear(); m.close(); S.tab = 'queue'; S.filter = 'scheduled'; render(); toast(`ตั้งเวลาแล้ว ${r.posts.length} โพสต์`);
    } catch (e2) { err.textContent = e2.message; }
  };
}

// ---------- queue ----------
let pollTimer;
function viewQueue() {
  const v = document.getElementById('view');
  const counts = (s) => S.posts.filter((p) => s === 'all' || p.status === s).length;
  const list = S.posts.filter((p) => S.filter === 'all' || p.status === S.filter);
  if (S.filter === 'posted' || S.filter === 'failed') list.reverse();
  v.innerHTML = `<div class="page-head"><div><h1>คิวโพสต์</h1><p>โพสต์ทั้งหมดที่ตั้งเวลาไว้ ระบบจะโพสต์ให้อัตโนมัติเมื่อถึงเวลา</p></div></div>
    <div class="tabs" role="group" aria-label="กรองสถานะ">${['scheduled', 'posted', 'failed', 'canceled', 'all'].map((s) => `<button data-f="${s}" aria-pressed="${S.filter === s}">${s === 'all' ? 'ทั้งหมด' : STATUS[s]} (${counts(s)})</button>`).join('')}</div>
    ${list.length ? list.map(postRow).join('') : `<div class="card empty"><h3>ไม่มีรายการ</h3>${S.filter === 'scheduled' ? 'ไปที่ "คลังคลิป" เลือกคลิปแล้วกด "ตั้งเวลา"' : ''}</div>`}`;
  v.querySelectorAll('[data-f]').forEach((b) => b.addEventListener('click', () => { S.filter = b.dataset.f; viewQueue(); }));
  v.querySelectorAll('[data-pedit]').forEach((b) => b.addEventListener('click', () => openEditPost(b.dataset.pedit)));
  v.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', guard(async () => { if (!confirm('ยกเลิกโพสต์นี้?')) return; await api(`/api/posts/${b.dataset.cancel}`, { method: 'DELETE' }); await loadPosts(); render(); toast('ยกเลิกแล้ว'); })));
  v.querySelectorAll('[data-retry]').forEach((b) => b.addEventListener('click', guard(async () => { await api(`/api/posts/${b.dataset.retry}/retry`, { method: 'POST' }); await loadPosts(); render(); toast('ส่งเข้าคิวใหม่แล้ว'); })));
  v.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', guard(async () => { await api(`/api/posts/${b.dataset.rm}`, { method: 'DELETE' }); await loadPosts(); render(); })));
  clearInterval(pollTimer);
  pollTimer = setInterval(() => { if (S.me && S.tab === 'queue' && !document.querySelector('.overlay')) loadPosts().then(() => S.tab === 'queue' && viewQueue()).catch(() => {}); }, 10000);
}

function postRow(p) {
  const acts = [];
  if (p.status === 'scheduled') acts.push(`<button class="btn sm" data-pedit="${p.id}">แก้ไข</button><button class="btn sm danger" data-cancel="${p.id}">ยกเลิก</button>`);
  if (p.status === 'failed') acts.push(`<button class="btn sm primary" data-retry="${p.id}">ลองใหม่</button>`);
  if (p.status === 'posted' && p.result?.url) acts.push(`<a class="btn sm" href="${esc(p.result.url)}" target="_blank" rel="noopener noreferrer">ดูโพสต์${S.mode === 'mock' ? ' (จำลอง)' : ''}</a>`);
  if (['posted', 'failed', 'canceled'].includes(p.status)) acts.push(`<button class="btn sm" data-rm="${p.id}" aria-label="ลบประวัติ">ลบประวัติ</button>`);
  return `<div class="card post"><div class="pt" style="${p.thumbUrl ? `background-image:url('${p.thumbUrl}')` : ''}"></div>
    <div><h3>${esc(p.clipTitle)}</h3><div class="meta"><span class="badge ${p.platform}">${esc(platLabel(p.platform))}</span><span>${esc(p.accountName)}</span><span>${p.status === 'posted' ? `โพสต์เมื่อ ${fmtTime(p.postedAt)}` : fmtTime(p.scheduledAt)}</span><span class="badge ${p.status}">${STATUS[p.status]}</span>${p.cartProductId ? '<span>🛒 ปักตะกร้า</span>' : ''}</div>${p.error ? `<div class="err">${esc(p.error)}</div>` : ''}</div>
    <div class="acts">${acts.join('')}</div></div>`;
}

function openEditPost(id) {
  const p = S.posts.find((x) => x.id === id);
  const cart = S.platforms[p.platform]?.supportsCart;
  const m = modal(`<h2>แก้ไขโพสต์</h2><p class="hint" style="margin-top:-8px">${esc(p.clipTitle)} → ${esc(platLabel(p.platform))} (${esc(p.accountName)})</p><form id="pe">
    <label class="f"><span>วันและเวลา</span><input type="datetime-local" name="at" required value="${toLocalInput(p.scheduledAt)}"></label>
    <label class="f"><span>แคปชัน</span><textarea name="caption" maxlength="2000">${esc(p.caption)}</textarea></label>
    <label class="f"><span>ลิงก์สินค้า</span><input type="url" name="productUrl" value="${esc(p.productUrl)}"></label>
    ${cart ? `<label class="f"><span>รหัสสินค้าตะกร้า TikTok</span><input type="text" name="cartProductId" maxlength="64" value="${esc(p.cartProductId)}"></label>` : ''}
    <p class="err-msg" id="peErr" role="alert"></p>
    <div class="modal-foot"><button type="button" class="btn" data-close>ปิด</button><button class="btn primary">บันทึก</button></div></form>`);
  m.el.querySelector('#pe').onsubmit = async (e) => {
    e.preventDefault(); const f = Object.fromEntries(new FormData(e.target));
    try { await api(`/api/posts/${id}`, { method: 'PATCH', body: { scheduledAt: new Date(f.at).toISOString(), caption: f.caption, productUrl: f.productUrl, ...(cart ? { cartProductId: f.cartProductId } : {}) } }); await loadPosts(); m.close(); viewQueue(); toast('บันทึกแล้ว'); }
    catch (err) { m.el.querySelector('#peErr').textContent = err.message; }
  };
}

// ---------- accounts ----------
function connectBox(k, p, mine) {
  const how = S.connect?.[k];
  const top = `margin-top:${mine.length ? 10 : 0}px`;
  if (how === 'mock') return `<form data-connect="${k}" class="row" style="${top};flex-wrap:nowrap"><input type="text" name="displayName" placeholder="${k === 'facebook' ? 'ชื่อเพจ' : 'ชื่อบัญชี'}" required maxlength="100" aria-label="ชื่อบัญชี ${esc(p.label)}"><button class="btn sm primary" style="white-space:nowrap">+ เชื่อม</button></form>`;
  if (how === 'oauth') return `<div style="${top}"><a class="btn sm primary" href="/api/oauth/facebook/start">${mine.length ? 'เชื่อมเพจเพิ่ม / ต่ออายุสิทธิ์' : 'เชื่อมด้วย Facebook'}</a></div>`;
  return `<div class="hint" style="${top}">ยังไม่เปิดให้เชื่อมแพลตฟอร์มนี้</div>`;
}
function viewAccounts() {
  const v = document.getElementById('view');
  v.innerHTML = `<div class="page-head"><div><h1>บัญชีของฉัน</h1><p>เชื่อมบัญชีโซเชียลของคุณเพื่อให้ระบบโพสต์แทน</p></div></div>
    ${S.mode === 'mock' ? '<div class="notice"><b>โหมดทดลอง:</b> การเชื่อมบัญชีและการโพสต์เป็นการจำลอง ยังไม่ได้ส่งขึ้น TikTok/Facebook/Instagram จริง</div>' : ''}
    ${aiKeyCard()}
    <div class="cols">${Object.entries(S.platforms).map(([k, p]) => {
      const mine = S.accounts.filter((a) => a.platform === k);
      return `<section class="card plat"><h3><span class="badge ${k}">${esc(p.label)}</span></h3>
        ${mine.map((a) => `<div class="acc"><div><b>${esc(a.displayName)}</b>${a.needsReauth ? ' <span class="badge failed">ต้องเชื่อมใหม่</span>' : ''}<div class="hint" style="margin:0">${a.mock ? 'บัญชีจำลอง · ' : ''}เชื่อมเมื่อ ${fmtTime(a.connectedAt)}</div></div><button class="btn sm danger" data-unlink="${a.id}">ยกเลิกการเชื่อม</button></div>`).join('')}
        ${connectBox(k, p, mine)}
        ${k === 'facebook' ? '<div class="hint">โพสต์ลงเพจ (Page) เท่านั้น ไม่รองรับโปรไฟล์ส่วนตัว</div>' : k === 'instagram' ? '<div class="hint">ต้องเป็นบัญชีธุรกิจ/Creator ที่ผูกกับเพจ Facebook</div>' : '<div class="hint">รองรับรหัสสินค้าสำหรับปักตะกร้าตอนตั้งเวลา</div>'}</section>`;
    }).join('')}</div>`;
  wireAiKey(v);
  v.querySelectorAll('[data-connect]').forEach((f) => f.addEventListener('submit', guard(async (e) => { e.preventDefault(); await api('/api/accounts/connect', { method: 'POST', body: { platform: f.dataset.connect, displayName: new FormData(f).get('displayName') } }); await loadAccounts(); viewAccounts(); toast('เชื่อมบัญชีแล้ว'); })));
  v.querySelectorAll('[data-unlink]').forEach((b) => b.addEventListener('click', guard(async () => { if (!confirm('ยกเลิกการเชื่อมบัญชีนี้?')) return; await api(`/api/accounts/${b.dataset.unlink}`, { method: 'DELETE' }); await loadAccounts(); viewAccounts(); toast('ยกเลิกการเชื่อมแล้ว'); })));
}

// ---------- AI API key (ของใครของมัน) ----------
function aiKeyCard() {
  const k = S.aiKey || {};
  return `<section class="card plat" style="margin-bottom:16px"><h3>✨ AI คิดคอนเทนต์ — API key ของคุณ</h3>
    <p class="hint" style="margin-top:0">ใส่ Anthropic API key ของคุณเอง ระบบจะใช้คีย์นี้ให้ AI ดูภาพในคลิปแล้วคิดคอนเทนต์/แคปชันให้เลือกแนบกับคลิป ค่าใช้จ่ายคิดกับบัญชี Anthropic ของคุณ (สร้างคีย์ที่ console.anthropic.com) คีย์เก็บแบบเข้ารหัสบนเซิร์ฟเวอร์และไม่ถูกส่งกลับมาแสดงอีก</p>
    ${k.set ? `<div class="acc"><div><b>ใส่คีย์แล้ว</b> <span class="hint" style="margin:0">ลงท้ายด้วย …${esc(k.hint)}</span></div><button class="btn sm danger" id="aiKeyDel">ลบคีย์</button></div>` : ''}
    <form id="aiKeyForm" class="row" style="margin-top:10px"><input type="password" name="key" placeholder="${k.set ? 'ใส่คีย์ใหม่เพื่อเปลี่ยน' : 'sk-ant-...'}" autocomplete="off" spellcheck="false" required aria-label="Anthropic API key" style="flex:1"><button class="btn primary">${k.set ? 'เปลี่ยนคีย์' : 'บันทึกคีย์'}</button></form>
    <p class="err-msg" id="aiKeyErr" role="alert"></p>
    ${S.mode === 'mock' && !k.set ? '<div class="hint">โหมดทดลอง: ถ้ายังไม่ใส่คีย์ ปุ่ม AI จะให้ตัวอย่างจำลอง</div>' : ''}</section>`;
}
async function refreshAi() { const me = await api('/api/me'); S.aiCaption = me.aiCaption; S.aiKey = me.aiKey || { set: false }; }
function wireAiKey(v) {
  v.querySelector('#aiKeyForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('/api/me/ai-key', { method: 'PUT', body: { key: new FormData(e.target).get('key') } }); await refreshAi(); viewAccounts(); toast('บันทึก API key แล้ว'); }
    catch (err) { v.querySelector('#aiKeyErr').textContent = err.message; }
  });
  v.querySelector('#aiKeyDel')?.addEventListener('click', guard(async () => { if (!confirm('ลบ API key ของคุณ?')) return; await api('/api/me/ai-key', { method: 'DELETE' }); await refreshAi(); viewAccounts(); toast('ลบ API key แล้ว'); }));
}

// ---------- admin ----------
function viewAdmin() {
  const o = S.overview; const v = document.getElementById('view');
  if (!o) return (v.innerHTML = '<div class="card empty">กำลังโหลด…</div>');
  v.innerHTML = `<div class="page-head"><div><h1>ผู้ดูแล</h1><p>ภาพรวมระบบและสมาชิก</p></div></div>
    <div class="stats">${[['คลิปในคลัง', o.clips], ['รอโพสต์', o.posts.scheduled], ['โพสต์แล้ว', o.posts.posted], ['ล้มเหลว', o.posts.failed], ['สมาชิก', o.members.length]].map(([l, n]) => `<div class="card stat"><b>${n}</b><span>${l}</span></div>`).join('')}</div>
    <div class="card" style="overflow-x:auto"><table><thead><tr><th>ชื่อ</th><th>อีเมล</th><th>บัญชีที่เชื่อม</th><th>โพสต์ทั้งหมด</th></tr></thead><tbody>
    ${o.members.length ? o.members.map((m) => `<tr><td>${esc(m.name)}</td><td>${esc(m.email)}</td><td>${m.accounts}</td><td>${m.posts}</td></tr>`).join('') : '<tr><td colspan="4" class="hint">ยังไม่มีสมาชิก</td></tr>'}</tbody></table></div>`;
}

boot();
