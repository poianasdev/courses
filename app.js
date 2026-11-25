'use strict';
/* =====================================================================
 *  GRG Cursos — front-end estático (GitHub Pages)
 *  - Vários cursos: cada pasta do Drive adicionada = 1 curso; subpastas = módulos
 *  - Home: cards dos cursos | Curso: módulos em carrossel | Aula: player
 *  - Player: <video> nativo + Service Worker (sw.js) que repassa o token ao Drive
 *  - Progresso: localStorage | Fornecedores, capas e títulos editados: IndexedDB
 * ===================================================================== */

/* ---------- storage simples ---------- */
const LS = { settings: 'cd.settings', cache: 'cd.cache', progress: 'cd.progress', user: 'cd.user', collapsed: 'cd.collapsed' };
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));

const DEFAULT_API = 'https://www.googleapis.com/drive/v3';
const API = window.__API_BASE || DEFAULT_API;

let settings = load(LS.settings, {});
settings.clientId ||= '';
if (!Array.isArray(settings.roots)) settings.roots = settings.rootId ? [{ id: settings.rootId, name: '' }] : []; // migra versão antiga
delete settings.rootId;
let cache = load(LS.cache, { v: 3, courses: [], syncedAt: null });
if (cache.v !== 3) cache = { v: 3, courses: [], syncedAt: null }; // estrutura antiga: precisa sincronizar de novo
let progress = load(LS.progress, { done: {}, last: {}, lastAt: {}, pos: {}, lastOpened: null });
progress.done ||= {}; progress.last ||= {}; progress.lastAt ||= {}; progress.pos ||= {};
let user = load(LS.user, null);
let token = null, tokenExpires = 0;
let hideDone = false, panelOpen = true;
const openMods = new Set();
const overrides = new Map(); // key -> { key, title, cover(Blob) }
let ctx = null; // contexto da tela do player

/* ---------- helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const app = $('#app');
const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) { if (typeof v === 'function') e.addEventListener(k.slice(2), v); }
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
}
const fmtDur = ms => {
  if (!ms) return '';
  const s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
  return h ? `${h}h${String(m).padStart(2, '0')}` : `${Math.max(m, 1)}min`;
};
const cleanName = n => n.replace(/\.(mp4|mkv|mov|avi|webm|m4v)$/i, '').replace(/_+/g, ' ');
let statusTimer;
function setStatus(msg, err = false, autoHide = 0) {
  const s = $('#status'); clearTimeout(statusTimer);
  s.hidden = !msg; s.textContent = msg || ''; s.classList.toggle('err', err);
  if (msg && autoHide) statusTimer = setTimeout(() => setStatus(''), autoHide);
}
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const hue = s => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const gradient = s => `linear-gradient(135deg,hsl(${hue(s)} 45% 22%),hsl(${(hue(s) + 50) % 360} 50% 12%))`;

/* ---------- Google Auth + Drive ---------- */
function parseFolderId(v) {
  v = (v || '').trim();
  const m = v.match(/folders\/([\w-]+)/) || v.match(/[?&]id=([\w-]+)/);
  return m ? m[1] : v;
}
function ensureGis() {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    (function wait() {
      if (window.google?.accounts?.oauth2) return res();
      if (Date.now() - t0 > 8000) return rej(new Error('Não foi possível carregar o login do Google (verifique sua conexão/bloqueadores).'));
      setTimeout(wait, 150);
    })();
  });
}
let tokenPending = null;
function getToken() {
  if (token && Date.now() < tokenExpires - 30000) return Promise.resolve(token);
  if (tokenPending) return tokenPending;
  if (!settings.clientId) return Promise.reject(new Error('Configure o Client ID primeiro.'));
  return tokenPending = (async () => {
    await ensureGis();
    return new Promise((resolve, reject) => {
      const tc = google.accounts.oauth2.initTokenClient({
        client_id: settings.clientId,
        scope: 'https://www.googleapis.com/auth/drive.readonly',
        callback: r => {
          if (r.error) return reject(new Error('Login falhou: ' + r.error));
          token = r.access_token; tokenExpires = Date.now() + r.expires_in * 1000; resolve(token);
        },
        error_callback: e => reject(new Error('Login cancelado ou bloqueado (' + (e.type || 'popup') + ').')),
      });
      tc.requestAccessToken({ prompt: user ? '' : 'consent' });
    });
  })().finally(() => { tokenPending = null; });
}
async function gfetch(url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + await getToken() } });
    if (r.status === 401 && attempt === 0) { token = null; continue; }
    if (!r.ok) throw new Error(`Drive API ${r.status}: ${(await r.text()).slice(0, 180)}`);
    return r.json();
  }
}
async function driveList(parentId) {
  const out = []; let pageToken = '';
  do {
    const p = new URLSearchParams({
      q: `'${parentId}' in parents and trashed=false`,
      fields: 'nextPageToken,files(id,name,mimeType,thumbnailLink,videoMediaMetadata(durationMillis),shortcutDetails(targetId,targetMimeType))',
      pageSize: '1000', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
    });
    if (pageToken) p.set('pageToken', pageToken);
    const j = await gfetch(`${API}/files?` + p);
    out.push(...j.files); pageToken = j.nextPageToken || '';
  } while (pageToken);
  return out;
}
const isFolder = f => f.mimeType === 'application/vnd.google-apps.folder';
const isVideo = f => f.mimeType?.startsWith('video/') ||
  (f.mimeType === 'application/vnd.google-apps.shortcut' && f.shortcutDetails?.targetMimeType?.startsWith('video/'));
const isCover = f => f.mimeType?.startsWith('image/') && /^(capa|cover)/i.test(f.name);
const toLesson = (f, sub) => ({
  id: f.shortcutDetails?.targetId || f.id, name: cleanName(f.name), sub,
  dur: Number(f.videoMediaMetadata?.durationMillis) || 0, thumb: f.thumbnailLink || '',
});
const byLesson = (a, b) => collator.compare(a.sub, b.sub) || collator.compare(a.name, b.name);
const coverOf = f => f && { id: f.id, link: f.thumbnailLink || '' };
const thumbOf = lessons => { const t = lessons.find(l => l.thumb) || lessons[0]; return t ? { id: t.id, link: t.thumb } : null; };

async function scanModule(folderId, path, acc) {
  const files = await driveList(folderId);
  if (!path.length) { const cv = files.find(isCover); if (cv) acc.cover = coverOf(cv); }
  files.filter(isVideo).forEach(f => acc.lessons.push(toLesson(f, path.join(' / '))));
  for (const d of files.filter(isFolder)) await scanModule(d.id, [...path, d.name], acc);
}
async function syncRoot(rootId, label) {
  const meta = await gfetch(`${API}/files/${rootId}?fields=id,name&supportsAllDrives=true`);
  let name = meta.name, folderId = rootId, top = await driveList(rootId);
  // Pasta "embrulho": sem vídeos e com uma única subpasta que já contém módulos → desce uma camada
  for (let depth = 0; depth < 2; depth++) {
    const subs = top.filter(isFolder);
    if (top.some(isVideo) || subs.length !== 1) break;
    const inner = await driveList(subs[0].id);
    if (!inner.some(isFolder)) break;
    name = subs[0].name; folderId = subs[0].id; top = inner;
  }
  const course = { id: rootId, name, cover: coverOf(top.find(isCover)), modules: [] };
  const loose = top.filter(isVideo).map(f => toLesson(f, '')).sort(byLesson);
  if (loose.length) course.modules.push({ id: '_root', name: 'Aulas gerais', lessons: loose, cover: thumbOf(loose) });
  const folders = top.filter(isFolder).sort((a, b) => collator.compare(a.name, b.name));
  for (let i = 0; i < folders.length; i++) {
    setStatus(`${label} — módulo ${i + 1}/${folders.length}: ${folders[i].name}`);
    const acc = { lessons: [], cover: null }; await scanModule(folders[i].id, [], acc);
    acc.lessons.sort(byLesson);
    if (acc.lessons.length) course.modules.push({ id: folders[i].id, name: folders[i].name, lessons: acc.lessons, cover: acc.cover || thumbOf(acc.lessons) });
  }
  if (!course.cover) course.cover = course.modules[0]?.cover || null;
  return course;
}
async function fetchUser() {
  try {
    const j = await gfetch(`${API}/about?fields=user(displayName,photoLink)`);
    user = { name: j.user?.displayName || 'Conectado', photo: j.user?.photoLink || '' }; save(LS.user, user); paintUser();
  } catch { /* opcional */ }
}
async function sync() {
  if (!settings.clientId || !settings.roots.length) return openSettings();
  const btn = $('#btnSync'); btn.disabled = true;
  const errors = [], courses = [];
  try {
    for (let i = 0; i < settings.roots.length; i++) {
      const r = settings.roots[i], label = `Curso ${i + 1}/${settings.roots.length}`;
      try {
        setStatus(`${label}: conectando ao Google Drive…`);
        const c = await syncRoot(r.id, label); courses.push(c); r.name = c.name;
      } catch (e) {
        errors.push(`${r.name || r.id}: ${e.message}`);
        const old = cache.courses.find(x => x.id === r.id); if (old) courses.push(old);
      }
    }
    cache = { v: 3, courses, syncedAt: Date.now() }; save(LS.cache, cache); save(LS.settings, settings);
    await fetchUser();
    if (errors.length) setStatus('Alguns cursos falharam — ' + errors.join(' | '), true);
    else setStatus(`Sincronizado: ${courses.length} curso(s), ${courses.reduce((n, c) => n + lessonsOf(c).length, 0)} aula(s).`, false, 3500);
  } catch (e) { setStatus(e.message, true); }
  finally { btn.disabled = false; render(); }
}

/* ---------- modelo: cursos / módulos / aulas ---------- */
function modMeta(m, i) {
  const n = m.name.match(/^\s*(?:m[oó]dulo\s*)?(\d+)/i);
  const title = m.name.replace(/^\s*(m[oó]dulo\s*)?\d+\s*[-–._:)]*\s*/i, '').trim();
  return { num: String(n ? n[1] : i + 1).padStart(2, '0'), title: title || m.name };
}
const ovTitle = key => overrides.get(key)?.title || '';
const courseTitle = c => ovTitle('c:' + c.id) || c.name;
const modTitle = (c, m, i) => ovTitle(`m:${c.id}:${m.id}`) || modMeta(m, i).title;
function lessonsOf(c) {
  return c.modules.flatMap((m, i) => { const t = modTitle(c, m, i); return m.lessons.map(l => ({ ...l, mid: m.id, mtitle: t })); });
}
const isDone = id => !!progress.done[id];
function setDone(id, v) { if (v) progress.done[id] = Date.now(); else delete progress.done[id]; save(LS.progress, progress); }
function stats(lessons) {
  const total = lessons.length, done = lessons.filter(l => isDone(l.id)).length;
  return { total, done, pct: total ? Math.round(done / total * 100) : 0, remainMs: lessons.filter(l => !isDone(l.id)).reduce((s, l) => s + l.dur, 0) };
}
const lessonHref = (c, l) => `#/curso/${c.id}/aula/${l.id}`;

/* ---------- imagens ---------- */
function driveImg(cls, id, link, w) {
  const img = el('img', { class: cls, loading: 'lazy', alt: '', referrerpolicy: 'no-referrer', draggable: 'false' });
  const fallback = `https://drive.google.com/thumbnail?id=${id}&sz=w${w}`;
  let tried = !link;
  img.addEventListener('error', () => { if (!tried) { tried = true; img.src = fallback; } else img.remove(); });
  img.src = link ? link.replace(/=s\d+$/, '=s' + w) : fallback;
  return img;
}
const coverUrls = new Map();
function coverUrl(key) {
  const o = overrides.get(key); if (!o?.cover) return null;
  if (!coverUrls.has(key)) coverUrls.set(key, URL.createObjectURL(o.cover));
  return coverUrls.get(key);
}
function dropCoverUrl(key) { const u = coverUrls.get(key); if (u) { URL.revokeObjectURL(u); coverUrls.delete(key); } }
async function shrinkImage(file, max = 900) {
  if (!file.type.startsWith('image/')) throw new Error('Escolha um arquivo de imagem.');
  if (file.size > 15 * 1024 * 1024) throw new Error('Imagem muito grande (máx. 15 MB).');
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { throw new Error('Não foi possível ler essa imagem.'); }
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const cv = document.createElement('canvas'); cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
  const g = cv.getContext('2d'); g.fillStyle = '#111'; g.fillRect(0, 0, cv.width, cv.height); g.drawImage(bmp, 0, 0, cv.width, cv.height);
  return new Promise((res, rej) => cv.toBlob(b => b ? res(b) : rej(new Error('Falha ao processar a imagem.')), 'image/jpeg', 0.86));
}

/* ---------- componentes ---------- */
const pbar = pct => el('div', { class: 'pbar', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 }, el('i', { style: `width:${pct}%` }));

// card vertical (curso ou módulo) com botão de editar
function poster(o) {
  const url = coverUrl(o.key);
  const a = el('a', { class: 'mod', href: o.href, draggable: 'false', style: `background:${gradient(o.key)}`, title: o.title },
    url ? el('img', { class: 'bg', src: url, alt: '', draggable: 'false' }) : (o.def ? driveImg('bg', o.def.id, o.def.link, 600) : null),
    el('div', { class: 'frame' }, el('span', { class: 'badge' }, o.badge), el('h3', {}, o.title), el('small', {}, o.sub)),
    pbar(o.pct));
  const edit = el('button', { class: 'editbtn', type: 'button', title: 'Editar capa e título', 'aria-label': 'Editar ' + o.title, onclick: e => { e.preventDefault(); e.stopPropagation(); openEdit(o.edit); } }, '✎');
  return el('div', { class: 'poster' }, a, edit);
}
function lessonCard(c, l) {
  return el('a', { class: 'lcard', href: lessonHref(c, l) },
    el('div', { class: 'thumb', style: `background:${gradient(l.id)}` }, driveImg('', l.id, l.thumb, 480), isDone(l.id) ? el('span', { class: 'tick', title: 'Concluída' }, '✓') : null),
    el('div', { class: 'meta' }, el('b', {}, l.name), el('small', {}, courseTitle(c) + ' · ' + l.mtitle)));
}
function carousel(items) {
  const track = el('div', { class: 'track', role: 'list' }, items);
  const prev = el('button', { class: 'car-btn prev', type: 'button', 'aria-label': 'Anteriores', hidden: true }, '‹');
  const next = el('button', { class: 'car-btn next', type: 'button', 'aria-label': 'Próximos', hidden: true }, '›');
  const step = () => Math.max(track.clientWidth * 0.85, 240);
  const upd = () => {
    prev.hidden = track.scrollLeft < 4;
    next.hidden = track.scrollLeft + track.clientWidth >= track.scrollWidth - 4;
  };
  prev.addEventListener('click', () => track.scrollBy({ left: -step(), behavior: 'smooth' }));
  next.addEventListener('click', () => track.scrollBy({ left: step(), behavior: 'smooth' }));
  track.addEventListener('scroll', upd, { passive: true });
  track.addEventListener('keydown', e => {
    if (e.key === 'ArrowRight') track.scrollBy({ left: step(), behavior: 'smooth' });
    if (e.key === 'ArrowLeft') track.scrollBy({ left: -step(), behavior: 'smooth' });
  });
  // arrastar com o mouse
  track.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'mouse' || e.button !== 0 || e.target.closest('button')) return;
    const sx = e.clientX, sl = track.scrollLeft; let moved = false;
    const move = ev => {
      const dx = ev.clientX - sx;
      if (!moved && Math.abs(dx) > 5) { moved = true; track.classList.add('dragging'); }
      if (moved) track.scrollLeft = sl - dx;
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      track.classList.remove('dragging');
      if (moved) {
        const stop = ev => { ev.preventDefault(); ev.stopPropagation(); };
        track.addEventListener('click', stop, { capture: true, once: true });
        setTimeout(() => track.removeEventListener('click', stop, true), 60);
      }
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  });
  const wrap = el('div', { class: 'carousel' }, prev, track, next);
  if (window.ResizeObserver) new ResizeObserver(upd).observe(track);
  requestAnimationFrame(upd);
  return wrap;
}

/* ---------- views ---------- */
function emptyState() {
  const hasRoots = settings.roots.length > 0;
  return el('div', { class: 'empty' }, el('h1', {}, hasRoots ? 'Cursos ainda não carregados' : 'Nenhum curso ainda'),
    el('p', {}, hasRoots ? 'Clique em sincronizar para ler suas pastas do Google Drive.' : 'Configure o Client ID e adicione a pasta do Drive de cada curso.'),
    el('button', { class: 'primary', type: 'button', onclick: hasRoots ? sync : () => openSettings() }, hasRoots ? '↻ Sincronizar Drive' : 'Adicionar curso'));
}
function searchHits(courses, q) {
  return courses.flatMap(c => lessonsOf(c).filter(l => (l.name + ' ' + l.mtitle + ' ' + courseTitle(c)).toLowerCase().includes(q)).map(l => ({ c, l }))).slice(0, 80);
}
function hitsView(hits) {
  return [el('h1', {}, `Resultados (${hits.length})`),
    hits.length ? el('div', { class: 'grid' }, hits.map(({ c, l }) => lessonCard(c, l))) : el('p', { class: 'empty' }, 'Nada encontrado.')];
}
function viewHome() {
  app.replaceChildren();
  if (!cache.courses.length) return app.append(emptyState());
  const q = $('#search').value.trim().toLowerCase();
  if (q) return app.append(...hitsView(searchHits(cache.courses, q)));
  app.append(el('div', { class: 'page-head' }, el('h1', {}, 'Meus cursos'),
    el('button', { class: 'primary', type: 'button', onclick: () => openSettings(true) }, '+ Adicionar curso')));
  app.append(el('div', { class: 'poster-grid' }, cache.courses.map(c => {
    const s = stats(lessonsOf(c));
    return poster({
      href: `#/curso/${c.id}`, key: 'c:' + c.id, title: courseTitle(c), def: c.cover, pct: s.pct,
      badge: `${c.modules.length} módulo${c.modules.length === 1 ? '' : 's'}`, sub: `${s.done}/${s.total} aulas · ${s.pct}%`,
      edit: { key: 'c:' + c.id, kind: 'course', defaultTitle: c.name, def: c.cover },
    });
  })));
}
function viewCourseHome(cid) {
  const c = cache.courses.find(x => x.id === cid);
  if (!c) { location.hash = '#/'; return; }
  const all = lessonsOf(c), st = stats(all), q = $('#search').value.trim().toLowerCase();
  const last = all.find(l => l.id === progress.last[c.id]), target = last || all.find(l => !isDone(l.id)) || all[0];
  app.replaceChildren(
    el('div', { class: 'backbar' }, el('a', { href: '#/', 'aria-label': 'Voltar', title: 'Voltar' }, '←'), el('span', {}, 'Cursos')),
    el('div', { class: 'chead' },
      el('div', {}, el('h1', {}, courseTitle(c)),
        el('div', { class: 'hint' }, `${c.modules.length} módulo${c.modules.length === 1 ? '' : 's'} · ${st.done}/${st.total} aulas · ${st.pct}% concluído` + (st.remainMs ? ` · faltam ${fmtDur(st.remainMs)}` : ''))),
      target ? el('a', { class: 'primary btn', href: lessonHref(c, target) }, last ? '▶ Continuar' : '▶ Começar') : null));
  if (q) return app.append(...hitsView(searchHits([c], q)));
  app.append(el('section', { class: 'section' },
    el('div', { class: 'section-head' }, el('h2', {}, 'Módulos'), el('small', {}, 'arraste ou use as setas')),
    carousel(c.modules.map((m, i) => {
      const meta = modMeta(m, i), s = stats(m.lessons), title = modTitle(c, m, i);
      const next = m.lessons.find(l => !isDone(l.id)) || m.lessons[0], key = `m:${c.id}:${m.id}`;
      return poster({
        href: lessonHref(c, next), key, title, def: m.cover, pct: s.pct,
        badge: m.id === '_root' ? 'Geral' : `Módulo ${meta.num}`, sub: `${s.done}/${s.total} aulas`,
        edit: { key, kind: 'module', defaultTitle: meta.title, def: m.cover },
      });
    }))));
}
function viewContinue() {
  app.replaceChildren(el('h1', {}, 'Continuar assistindo'));
  const items = cache.courses.map(c => {
    const l = lessonsOf(c).find(x => x.id === progress.last[c.id]);
    return l && { c, l, at: progress.lastAt[c.id] || 0 };
  }).filter(Boolean).sort((a, b) => b.at - a.at);
  app.append(items.length ? el('div', { class: 'grid' }, items.map(({ c, l }) => lessonCard(c, l))) : el('p', { class: 'empty' }, 'Você ainda não assistiu nenhuma aula.'));
}

/* ---------- player de vídeo ---------- */
// O iframe do Drive pede login quando o navegador bloqueia cookies de terceiros (Brave, Safari…).
// Aqui o vídeo toca num <video> nativo; o Service Worker (sw.js) adiciona o token OAuth às requisições ao Drive.
let swScope = null;
async function ensureSW() {
  if (swScope) return swScope;
  if (!('serviceWorker' in navigator)) throw new Error('sw');
  const reg = await navigator.serviceWorker.register('sw.js?v=4');
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('sw')), 4000);
      navigator.serviceWorker.addEventListener('controllerchange', () => { clearTimeout(t); res(); }, { once: true });
    });
  }
  return swScope = reg.scope;
}
const driveLink = id => `https://drive.google.com/file/d/${id}/view`;
function stopVideos() { $$('video').forEach(v => { try { v.pause(); v.removeAttribute('src'); v.load(); } catch { /* ok */ } }); }
function frameMsg(frame, text, btn) { frame.replaceChildren(el('div', { class: 'pmsg' }, el('p', {}, text), btn || null)); }
function iframeFallback(frame, cur, note, why) {
  frame.replaceChildren(el('iframe', { src: `https://drive.google.com/file/d/${cur.id}/preview`, allow: 'autoplay; fullscreen', allowfullscreen: true, title: cur.name }));
  note.replaceChildren(why + ' Se pedir login, use ', el('a', { class: 'dlink', href: driveLink(cur.id), target: '_blank', rel: 'noopener' }, 'Abrir no Drive ↗'), '.');
  note.hidden = false;
}
async function mountPlayer(frame, cur, note) {
  const alive = () => ctx && ctx.cur === cur && frame.isConnected;
  note.hidden = true; frameMsg(frame, 'Carregando vídeo…');
  let scope, tok, meta;
  try { scope = await ensureSW(); }
  catch { return iframeFallback(frame, cur, note, 'A reprodução direta não está disponível agora (tente recarregar a página com F5).'); }
  try { tok = await getToken(); }
  catch (e) {
    if (!alive()) return;
    return frameMsg(frame, 'Entre com sua conta Google para assistir a aula aqui. ' + (e.message || ''),
      el('button', { class: 'primary', type: 'button', onclick: () => mountPlayer(frame, cur, note) }, 'Entrar com Google'));
  }
  if (!alive()) return;
  try { meta = await gfetch(`${API}/files/${cur.id}?fields=size,mimeType&supportsAllDrives=true`); }
  catch (e) { if (alive()) iframeFallback(frame, cur, note, 'Não foi possível acessar o arquivo pela API (' + e.message.slice(0, 80) + ').'); return; }
  if (!alive()) return;
  const size = Number(meta.size);
  if (!size) return iframeFallback(frame, cur, note, 'Este arquivo não pode ser reproduzido diretamente.');

  const u = new URL('stream/' + cur.id, scope);
  u.searchParams.set('t', tok); u.searchParams.set('s', size); u.searchParams.set('m', meta.mimeType || 'video/mp4');
  if (API !== DEFAULT_API) u.searchParams.set('b', API);
  const v = el('video', { controls: true, playsinline: true, preload: 'metadata', src: u.href });
  const pos = progress.pos[cur.id];
  v.addEventListener('loadedmetadata', () => { if (pos > 5 && v.duration && pos < v.duration - 10) v.currentTime = pos; }, { once: true });
  let lastSave = 0;
  const savePos = force => {
    const now = Date.now(); if (!force && now - lastSave < 5000) return; lastSave = now;
    if (v.currentTime > 5 && !v.ended) { progress.pos[cur.id] = Math.floor(v.currentTime); save(LS.progress, progress); }
  };
  v.addEventListener('timeupdate', () => savePos(false));
  v.addEventListener('pause', () => savePos(true));
  v.addEventListener('ended', () => {
    delete progress.pos[cur.id]; setDone(cur.id, true);
    if (alive()) refreshPlayer();
  });
  v.addEventListener('error', () => {
    if (!alive()) return;
    savePos(true);
    if (Date.now() >= tokenExpires - 5000) {
      return frameMsg(frame, 'Sua sessão com o Google expirou. Reconecte para continuar de onde parou.',
        el('button', { class: 'primary', type: 'button', onclick: () => mountPlayer(frame, cur, note) }, 'Reconectar'));
    }
    iframeFallback(frame, cur, note, 'Este vídeo não pôde ser reproduzido diretamente (formato não suportado pelo navegador ou acesso recusado).');
  });
  frame.replaceChildren(v);
}

function buildSide(c, cur) {
  const q = $('#search').value.trim().toLowerCase(), s = stats(lessonsOf(c));
  const side = el('aside', { class: 'side' });
  side.append(el('div', { class: 'side-head' },
    el('div', { class: 't' }, el('b', {}, 'Aulas'), el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Fechar lista', onclick: () => togglePanel(false) }, '✕')),
    el('div', { class: 'mini' }, el('i', { style: `width:${s.pct}%` })),
    el('small', { class: 'hint' }, `${s.done}/${s.total} concluídas · ${s.pct}%` + (s.remainMs ? ` · faltam ${fmtDur(s.remainMs)}` : '')),
    el('label', { class: 'check', style: 'font-weight:400;font-size:.88rem' },
      el('input', { type: 'checkbox', checked: hideDone, onchange: e => { hideDone = e.target.checked; refreshPlayer(); } }), 'Ocultar concluídas')));
  c.modules.forEach((m, i) => {
    const title = modTitle(c, m, i);
    const items = m.lessons.filter(l => (!hideDone || !isDone(l.id) || l.id === cur.id) && (!q || (l.name + ' ' + title).toLowerCase().includes(q)));
    if (!items.length) return;
    const id = c.id + '|' + m.id, md = m.lessons.filter(l => isDone(l.id)).length;
    const det = el('details', { open: !!q || openMods.has(id) }, el('summary', {}, el('span', {}, title), el('small', {}, `${md}/${m.lessons.length}`)));
    det.addEventListener('toggle', () => { if (det.open) openMods.add(id); else openMods.delete(id); });
    items.forEach(l => {
      const cb = el('input', { type: 'checkbox', checked: isDone(l.id), 'aria-label': 'Concluída: ' + l.name });
      cb.addEventListener('change', () => { setDone(l.id, cb.checked); refreshPlayer(); });
      det.append(el('div', { class: 'lesson' + (l.id === cur.id ? ' current' : '') + (isDone(l.id) ? ' done' : '') }, cb,
        el('a', { class: 'th', href: lessonHref(c, l), style: `background:${gradient(l.id)}`, tabindex: '-1', 'aria-hidden': 'true' }, driveImg('', l.id, l.thumb, 220), isDone(l.id) ? pbar(100) : null),
        el('a', { href: lessonHref(c, l) }, l.name, l.sub ? el('small', { class: 'sub' }, l.sub) : null)));
    });
    side.append(det);
  });
  return side;
}
function togglePanel(open) {
  panelOpen = open; const w = $('.watch'); if (!w) return;
  w.classList.toggle('nopanel', !open); const s = $('.side'); if (s) s.hidden = !open;
  const b = $('#btnPanel'); if (b) b.hidden = open;
}
function viewPlayer(cid, lid) {
  const c = cache.courses.find(x => x.id === cid);
  if (!c) { location.hash = '#/'; return; }
  const all = lessonsOf(c), idx = Math.max(0, all.findIndex(l => l.id === lid)), cur = all[idx];
  if (!cur) { location.hash = '#/curso/' + cid; return; }
  progress.last[c.id] = cur.id; progress.lastAt[c.id] = Date.now(); progress.lastOpened = { courseId: c.id, lessonId: cur.id }; save(LS.progress, progress);
  openMods.add(c.id + '|' + cur.mid);
  ctx = { c, cur };

  const prev = all[idx - 1], next = all[idx + 1], go = l => () => { location.hash = lessonHref(c, l); };
  const inMod = all.filter(l => l.mid === cur.mid), pos = inMod.findIndex(l => l.id === cur.id) + 1;
  const chk = el('input', { type: 'checkbox', id: 'curDone', checked: isDone(cur.id) });
  chk.addEventListener('change', () => { setDone(cur.id, chk.checked); refreshPlayer(); });
  const frame = el('div', { class: 'frame' }), note = el('p', { class: 'pnote', hidden: true, role: 'status' });

  const player = el('section', { class: 'player' },
    el('div', { class: 'backbar' }, el('a', { href: '#/curso/' + c.id, 'aria-label': 'Voltar ao curso', title: 'Voltar ao curso' }, '←'), el('span', {}, courseTitle(c))),
    frame,
    el('div', { class: 'info' },
      el('div', { class: 'kicker' }, el('span', {}, `${cur.mtitle} · aula ${pos} de ${inMod.length}` + (cur.dur ? ` · ${fmtDur(cur.dur)}` : '')),
        el('a', { class: 'dlink', href: driveLink(cur.id), target: '_blank', rel: 'noopener' }, '↗ Abrir no Drive')),
      el('h2', {}, cur.name), note,
      el('div', { class: 'controls' },
        el('label', { class: 'check', for: 'curDone' }, chk, 'Aula concluída'),
        el('span', { class: 'grow' }),
        el('button', { type: 'button', id: 'btnPanel', hidden: panelOpen, onclick: () => togglePanel(true) }, '☰ Aulas'),
        el('button', { type: 'button', disabled: !prev, onclick: prev && go(prev) }, '‹ Anterior'),
        el('button', { type: 'button', disabled: !next, onclick: next && go(next) }, 'Próxima ›'),
        el('button', { type: 'button', class: 'primary', onclick: () => { setDone(cur.id, true); next ? go(next)() : refreshPlayer(); } }, next ? 'Concluir e próxima' : 'Concluir'))));
  app.replaceChildren(el('div', { class: 'watch' + (panelOpen ? '' : ' nopanel') }, player, buildSide(c, cur)));
  const s = $('.side'); if (s) s.hidden = !panelOpen;
  $('.side .current')?.scrollIntoView({ block: 'center' });
  mountPlayer(frame, cur, note);
}
// atualiza só a lista lateral e o checkbox, sem recarregar o vídeo
function refreshPlayer() {
  if (!ctx || !$('.side')) return render();
  const old = $('.side'), top = old.scrollTop, ns = buildSide(ctx.c, ctx.cur);
  ns.hidden = !panelOpen; old.replaceWith(ns); ns.scrollTop = top;
  const cb = $('#curDone'); if (cb) cb.checked = isDone(ctx.cur.id);
}

/* ---------- editar capa / título ---------- */
const dlgEdit = $('#dlgEdit'); let edTarget = null, edState = null;
function openEdit(t) {
  edTarget = t; edState = { file: null, prevUrl: null, reset: false };
  $('#editTitle').textContent = t.kind === 'course' ? 'Editar curso' : 'Editar módulo';
  $('#edTitle').value = ovTitle(t.key) || t.defaultTitle;
  $('#edFile').value = ''; $('#edErr').hidden = true;
  paintPreview(); dlgEdit.showModal();
}
function paintPreview() {
  const box = $('#edPreview'); box.replaceChildren(); box.style.background = gradient(edTarget.key);
  let src = null;
  if (edState.file) src = edState.prevUrl; else if (!edState.reset) src = coverUrl(edTarget.key);
  if (src) box.append(el('img', { src, alt: '' }));
  else if (edTarget.def) box.append(driveImg('', edTarget.def.id, edTarget.def.link, 400));
}
function closeEdit() { if (edState?.prevUrl) URL.revokeObjectURL(edState.prevUrl); edState = null; dlgEdit.close(); }
$('#edFile').addEventListener('change', e => {
  const f = e.target.files[0]; if (!f) return;
  if (edState.prevUrl) URL.revokeObjectURL(edState.prevUrl);
  edState.file = f; edState.prevUrl = URL.createObjectURL(f); edState.reset = false; paintPreview();
});
$('#edReset').onclick = () => {
  if (edState.prevUrl) URL.revokeObjectURL(edState.prevUrl);
  edState = { file: null, prevUrl: null, reset: true }; $('#edFile').value = ''; $('#edTitle').value = edTarget.defaultTitle; paintPreview();
};
$('#btnCancelEdit').onclick = closeEdit;
dlgEdit.addEventListener('cancel', () => { if (edState?.prevUrl) URL.revokeObjectURL(edState.prevUrl); });
$('#formEdit').addEventListener('submit', async e => {
  e.preventDefault();
  const err = m => { const p = $('#edErr'); p.textContent = m; p.hidden = false; };
  const key = edTarget.key; let cover = edState.reset ? null : (overrides.get(key)?.cover || null);
  try { if (edState.file) cover = await shrinkImage(edState.file); } catch (ex) { return err(ex.message); }
  const t = $('#edTitle').value.trim(), title = t === edTarget.defaultTitle ? '' : t;
  try {
    if (!title && !cover) { await ovDel(key); overrides.delete(key); }
    else { const rec = { key, title, cover }; await ovPut(rec); overrides.set(key, rec); }
  } catch (ex) { return err('Erro ao salvar: ' + (ex.message || ex)); }
  dropCoverUrl(key); closeEdit(); render();
});

/* ---------- IndexedDB (fornecedores + capas/títulos) ---------- */
let dbp = null;
function db() {
  return dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open('cursos-db', 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('suppliers')) d.createObjectStore('suppliers', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('overrides')) d.createObjectStore('overrides', { keyPath: 'key' });
    };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function dbDo(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode), req = fn(t.objectStore(store));
    t.oncomplete = () => res(req?.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  });
}
const supAll = () => dbDo('suppliers', 'readonly', s => s.getAll());
const supPut = r => dbDo('suppliers', 'readwrite', s => s.put(r));
const supDel = id => dbDo('suppliers', 'readwrite', s => s.delete(id));
const ovAll = () => dbDo('overrides', 'readonly', s => s.getAll());
const ovPut = r => dbDo('overrides', 'readwrite', s => s.put(r));
const ovDel = k => dbDo('overrides', 'readwrite', s => s.delete(k));
async function loadOverrides() { try { (await ovAll() || []).forEach(o => overrides.set(o.key, o)); } catch (e) { setStatus('Não foi possível abrir o armazenamento local: ' + e.message, true); } }

/* ---------- fornecedores ---------- */
let suppliers = [], supState = { q: '', niche: '' };
async function loadSuppliers() {
  try { suppliers = (await supAll()) || []; navigator.storage?.persist?.(); }
  catch (e) { setStatus('Não foi possível abrir o armazenamento local de fornecedores: ' + e.message, true); }
}
function normUrl(u) {
  u = (u || '').trim(); if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return '';
  return 'https://' + u;
}
function contactNode(t) {
  if (!t) return null;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t.trim())) return el('a', { href: 'mailto:' + t.trim() }, t.trim());
  const d = t.replace(/\D/g, '');
  if (d.length >= 10 && d.length <= 13 && /^[\d\s()+.-]+$/.test(t)) {
    const wa = d.length <= 11 ? '55' + d : d;
    return el('span', {}, t + ' · ', el('a', { href: `https://wa.me/${wa}`, target: '_blank', rel: 'noopener' }, 'WhatsApp'));
  }
  return document.createTextNode(t);
}
function openBlob(blob, name, download) {
  const url = URL.createObjectURL(blob);
  if (download) { const a = el('a', { href: url, download: name || 'catalogo.pdf' }); document.body.append(a); a.click(); a.remove(); }
  else window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
function supCard(s) {
  const site = normUrl(s.site);
  let host = s.site; try { host = new URL(site).hostname.replace(/^www\./, ''); } catch { /* mantém */ }
  return el('article', { class: 'sup' },
    el('h3', {}, s.name), el('span', { class: 'chip' }, s.niche),
    s.contact ? el('div', { class: 'line' }, el('span', { class: 'ic' }, '👤'), el('span', {}, contactNode(s.contact))) : null,
    site ? el('div', { class: 'line' }, el('span', { class: 'ic' }, '🌐'), el('a', { href: site, target: '_blank', rel: 'noopener noreferrer' }, host)) : null,
    !s.pdf ? el('div', { class: 'line muted' }, el('span', { class: 'ic' }, '📄'), 'Sem catálogo') : null,
    el('div', { class: 'acts' },
      s.pdf ? el('button', { type: 'button', onclick: () => openBlob(s.pdf, s.pdfName) }, '📄 Catálogo') : null,
      s.pdf ? el('button', { type: 'button', title: 'Baixar PDF', onclick: () => openBlob(s.pdf, s.pdfName, true) }, '⬇') : null,
      el('span', { class: 'sp' }),
      el('button', { type: 'button', onclick: () => openSupForm(s) }, 'Editar'),
      el('button', { type: 'button', class: 'del', onclick: async () => {
        if (!confirm(`Excluir o fornecedor "${s.name}"?`)) return;
        await supDel(s.id); suppliers = suppliers.filter(x => x.id !== s.id);
        if (supState.niche && !suppliers.some(x => x.niche === supState.niche)) supState.niche = '';
        viewSuppliers();
      } }, 'Excluir')));
}
function viewSuppliers() {
  const niches = [...new Set(suppliers.map(s => s.niche))].sort(collator.compare);
  const q = el('input', { type: 'search', placeholder: 'Buscar fornecedor por nome…', 'aria-label': 'Buscar fornecedor por nome', value: supState.q });
  const sel = el('select', { 'aria-label': 'Filtrar por nicho' }, el('option', { value: '' }, 'Todos os nichos'), niches.map(n => el('option', { value: n }, n)));
  sel.value = supState.niche;
  const gridBox = el('div'), count = el('div', { class: 'count' });
  const paint = () => {
    const t = supState.q.trim().toLowerCase();
    const list = suppliers.filter(s => (!supState.niche || s.niche === supState.niche) && (!t || s.name.toLowerCase().includes(t))).sort((a, b) => collator.compare(a.name, b.name));
    count.textContent = `${list.length} de ${suppliers.length} fornecedor(es)`;
    gridBox.replaceChildren(list.length ? el('div', { class: 'grid sup-grid' }, list.map(supCard))
      : el('div', { class: 'empty' }, suppliers.length ? 'Nenhum fornecedor encontrado com esses filtros.' : 'Nenhum fornecedor cadastrado ainda.'));
  };
  q.addEventListener('input', () => { supState.q = q.value; paint(); });
  sel.addEventListener('change', () => { supState.niche = sel.value; paint(); });
  app.replaceChildren(el('h1', {}, 'Fornecedores'),
    el('div', { class: 'toolbar' }, q, sel, el('button', { class: 'primary', type: 'button', onclick: () => openSupForm() }, '+ Novo fornecedor')), count, gridBox);
  paint();
}
const dlgSup = $('#dlgSup'); let editing = null;
function openSupForm(s = null) {
  editing = s; $('#supTitle').textContent = s ? 'Editar fornecedor' : 'Novo fornecedor';
  $('#supName').value = s?.name || ''; $('#supNiche').value = s?.niche || ''; $('#supContact').value = s?.contact || ''; $('#supSite').value = s?.site || '';
  $('#supPdf').value = ''; $('#supPdfRemove').checked = false; $('#supErr').hidden = true;
  $('#supPdfCurrent').hidden = !s?.pdf; $('#supPdfName').textContent = s?.pdf ? '📄 ' + (s.pdfName || 'catalogo.pdf') + ' (enviar outro substitui)' : '';
  $('#nicheList').replaceChildren(...[...new Set(suppliers.map(x => x.niche))].map(n => el('option', { value: n })));
  dlgSup.showModal();
}
$('#btnCancelSup').onclick = () => dlgSup.close();
$('#formSup').addEventListener('submit', async e => {
  e.preventDefault();
  const err = m => { const p = $('#supErr'); p.textContent = m; p.hidden = false; };
  const file = $('#supPdf').files[0];
  if (file && file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) return err('O catálogo precisa ser um arquivo PDF.');
  if (file && file.size > 30 * 1024 * 1024) return err('PDF muito grande (máx. 30 MB).');
  const site = $('#supSite').value.trim();
  if (site && !normUrl(site)) return err('Site inválido. Use http(s):// ou apenas o domínio.');
  const rec = {
    id: editing?.id || uid(), createdAt: editing?.createdAt || Date.now(),
    name: $('#supName').value.trim(), niche: $('#supNiche').value.trim(), contact: $('#supContact').value.trim(), site,
    pdf: editing?.pdf || null, pdfName: editing?.pdfName || '',
  };
  if (!rec.name || !rec.niche) return err('Informe nome e nicho.');
  if ($('#supPdfRemove').checked) { rec.pdf = null; rec.pdfName = ''; }
  if (file) { rec.pdf = file; rec.pdfName = file.name; }
  try {
    await supPut(rec);
    suppliers = [...suppliers.filter(x => x.id !== rec.id), rec];
    dlgSup.close(); viewSuppliers();
  } catch (ex) { err('Erro ao salvar: ' + (ex.message || ex)); }
});

/* ---------- roteador ---------- */
function render() {
  const [route, cid, , lid] = location.hash.replace(/^#\/?/, '').split('/');
  const name = route === 'curso' ? 'home' : route || 'home';
  $$('#nav [data-route]').forEach(a => a.classList.toggle('active', a.dataset.route === name));
  $('#search').hidden = route === 'fornecedores';
  closeNav(); ctx = null; stopVideos();
  if (route === 'curso' && cid) { if (lid) viewPlayer(cid, lid); else viewCourseHome(cid); }
  else if (route === 'continuar') viewContinue();
  else if (route === 'fornecedores') viewSuppliers();
  else viewHome();
  if (!(route === 'curso' && lid)) window.scrollTo(0, 0);
}
window.addEventListener('hashchange', render);
$('#search').addEventListener('input', () => (ctx ? refreshPlayer() : render()));

/* ---------- menu lateral ---------- */
const openNav = () => { document.body.classList.add('nav-open'); $('#scrim').hidden = false; };
function closeNav() { document.body.classList.remove('nav-open'); $('#scrim').hidden = true; }
$('#btnMenu').onclick = openNav; $('#scrim').onclick = closeNav;
if (load(LS.collapsed, false)) document.body.classList.add('collapsed');
$('#btnCollapse').onclick = () => { const c = document.body.classList.toggle('collapsed'); save(LS.collapsed, c); };
const initials = () => (user?.name || '?').split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
function paintUser() {
  $('#userName').textContent = user?.name || 'Não conectado';
  const av = $('#avatar'); av.replaceChildren();
  if (user?.photo) { const i = el('img', { alt: '', referrerpolicy: 'no-referrer', src: user.photo }); i.onerror = () => { i.remove(); av.textContent = initials(); }; av.append(i); }
  else av.textContent = initials();
}

/* ---------- configurações (Client ID + lista de cursos) ---------- */
const dlgS = $('#dlgSettings'); let draftRoots = [];
function setErr(m) { const p = $('#setErr'); p.textContent = m || ''; p.hidden = !m; }
function paintRoots() {
  const ul = $('#rootList');
  ul.replaceChildren(...draftRoots.map((r, i) => el('li', {},
    el('div', { class: 'rinfo' }, el('b', {}, r.name || 'Pasta do Drive'), el('small', {}, r.id)),
    el('button', { type: 'button', class: 'del', 'aria-label': 'Remover ' + (r.name || r.id), title: 'Remover curso', onclick: () => { draftRoots.splice(i, 1); paintRoots(); } }, '✕'))));
  if (!draftRoots.length) ul.append(el('li', { class: 'hint' }, 'Nenhum curso adicionado ainda.'));
}
function addRoot() {
  const raw = $('#inRoot').value.trim(); if (!raw) return true;
  const id = parseFolderId(raw);
  if (!/^[\w-]{10,}$/.test(id)) { setErr('Link ou ID de pasta inválido.'); return false; }
  if (!draftRoots.some(r => r.id === id)) draftRoots.push({ id, name: '' });
  $('#inRoot').value = ''; setErr(''); paintRoots(); return true;
}
function openSettings(focusAdd = false) {
  $('#inClient').value = settings.clientId; $('#inRoot').value = ''; setErr('');
  draftRoots = settings.roots.map(r => ({ id: r.id, name: cache.courses.find(c => c.id === r.id)?.name || r.name || '' }));
  paintRoots(); dlgS.showModal(); if (focusAdd === true) $('#inRoot').focus();
}
$('#btnSettings').onclick = () => openSettings();
$('#btnCancelSettings').onclick = () => dlgS.close();
$('#btnAddRoot').onclick = addRoot;
$('#inRoot').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addRoot(); } });
$('#formSettings').addEventListener('submit', e => {
  e.preventDefault();
  if (!addRoot()) return;
  const clientId = $('#inClient').value.trim();
  if (!clientId) return setErr('Informe o OAuth Client ID.');
  if (!draftRoots.length) return setErr('Adicione ao menos uma pasta de curso.');
  settings = { clientId, roots: draftRoots.map(r => ({ id: r.id, name: r.name })) };
  save(LS.settings, settings); token = null; dlgS.close(); sync();
});
$('#btnSync').onclick = sync;

/* ---------- backup ---------- */
const dlgB = $('#dlgBackup');
$('#btnBackup').onclick = () => dlgB.showModal();
$('#btnCloseBackup').onclick = () => dlgB.close();
const blobToB64 = b => new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result.split(',')[1]); f.readAsDataURL(b); });
const b64ToBlob = (b64, type) => { const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Blob([u], { type }); };
$('#btnExport').onclick = async () => {
  const sup = await Promise.all(suppliers.map(async s => ({ ...s, pdf: undefined, pdfBase64: s.pdf ? await blobToB64(s.pdf) : null })));
  const ovs = await Promise.all([...overrides.values()].map(async o => ({ key: o.key, title: o.title, coverBase64: o.cover ? await blobToB64(o.cover) : null })));
  const blob = new Blob([JSON.stringify({ version: 3, progress, suppliers: sup, overrides: ovs, roots: settings.roots })], { type: 'application/json' });
  openBlob(blob, `backup-grg-cursos-${new Date().toISOString().slice(0, 10)}.json`, true);
};
$('#fileImport').addEventListener('change', async e => {
  try {
    const j = JSON.parse(await e.target.files[0].text());
    const p = j.progress || (j.done ? j : null);
    if (!p && !j.suppliers && !j.overrides && !j.roots) throw new Error('formato');
    if (p) { progress = { done: p.done || {}, last: p.last || {}, lastAt: p.lastAt || {}, pos: p.pos || {}, lastOpened: p.lastOpened || null }; save(LS.progress, progress); }
    for (const s of j.suppliers || []) {
      const { pdfBase64, ...rec } = s;
      rec.pdf = pdfBase64 ? b64ToBlob(pdfBase64, 'application/pdf') : null;
      await supPut(rec);
    }
    for (const o of j.overrides || []) {
      const rec = { key: o.key, title: o.title || '', cover: o.coverBase64 ? b64ToBlob(o.coverBase64, 'image/jpeg') : null };
      await ovPut(rec); overrides.set(rec.key, rec); dropCoverUrl(rec.key);
    }
    if (Array.isArray(j.roots)) {
      j.roots.forEach(r => { if (r?.id && !settings.roots.some(x => x.id === r.id)) settings.roots.push({ id: r.id, name: r.name || '' }); });
      save(LS.settings, settings);
    }
    await loadSuppliers(); dlgB.close(); render();
    setStatus('Backup importado.' + (j.roots?.length && !cache.courses.length ? ' Clique em Sincronizar Drive para carregar os cursos.' : ''), false, 4000);
  } catch { setStatus('Arquivo de backup inválido.', true); }
  e.target.value = '';
});

/* ---------- início ---------- */
(async () => {
  await Promise.allSettled([loadSuppliers(), loadOverrides()]);
  paintUser(); render();
  if (settings.roots.length && !cache.courses.length) setStatus('Clique em “Sincronizar Drive” para carregar seus cursos.');
})();
