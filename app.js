'use strict';
/* =====================================================================
 *  Meus Cursos — front-end estático (GitHub Pages)
 *  - Cursos/aulas vindos do Google Drive (OAuth, somente leitura)
 *  - Progresso: localStorage
 *  - Fornecedores (CRUD + PDF): IndexedDB
 * ===================================================================== */

/* ---------- storage simples ---------- */
const LS = { settings: 'cd.settings', cache: 'cd.cache', progress: 'cd.progress', user: 'cd.user', collapsed: 'cd.collapsed' };
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));

let settings = load(LS.settings, { clientId: '', rootId: '' });
let cache = load(LS.cache, { courses: [], syncedAt: null });
let progress = load(LS.progress, { done: {}, last: {}, lastAt: {}, lastOpened: null });
progress.done ||= {}; progress.last ||= {}; progress.lastAt ||= {};
let user = load(LS.user, null);
let token = null, tokenExpires = 0;
let hideDone = false, panelOpen = true;
const openMods = new Set();
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

/* ---------- Google Auth + Drive ---------- */
function parseFolderId(v) {
  v = v.trim();
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
async function getToken() {
  if (token && Date.now() < tokenExpires - 30000) return token;
  if (!settings.clientId) throw new Error('Configure o Client ID primeiro.');
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
    const j = await gfetch('https://www.googleapis.com/drive/v3/files?' + p);
    out.push(...j.files); pageToken = j.nextPageToken || '';
  } while (pageToken);
  return out;
}
const isFolder = f => f.mimeType === 'application/vnd.google-apps.folder';
const isVideo = f => f.mimeType?.startsWith('video/') ||
  (f.mimeType === 'application/vnd.google-apps.shortcut' && f.shortcutDetails?.targetMimeType?.startsWith('video/'));
const toLesson = (f, module) => ({
  id: f.shortcutDetails?.targetId || f.id, name: cleanName(f.name), module,
  dur: Number(f.videoMediaMetadata?.durationMillis) || 0, thumb: f.thumbnailLink || '',
});
async function scan(folderId, path, acc) {
  const files = await driveList(folderId);
  const key = path.join(' / ') || 'Geral';
  const cover = files.find(f => f.mimeType?.startsWith('image/') && /^(capa|cover)/i.test(f.name));
  if (cover) acc.covers[key] = { id: cover.id, link: cover.thumbnailLink || '' };
  files.filter(isVideo).forEach(f => acc.lessons.push(toLesson(f, key)));
  for (const d of files.filter(isFolder)) await scan(d.id, [...path, d.name], acc);
}
async function fetchUser() {
  try {
    const j = await gfetch('https://www.googleapis.com/drive/v3/about?fields=user(displayName,photoLink)');
    user = { name: j.user?.displayName || 'Conectado', photo: j.user?.photoLink || '' }; save(LS.user, user); paintUser();
  } catch { /* opcional */ }
}
async function sync() {
  if (!settings.clientId || !settings.rootId) return openSettings();
  const btn = $('#btnSync'); btn.disabled = true;
  try {
    setStatus('Conectando ao Google Drive…');
    const top = await driveList(settings.rootId);
    const folders = top.filter(isFolder).sort((a, b) => collator.compare(a.name, b.name));
    const courses = [];
    for (let i = 0; i < folders.length; i++) {
      setStatus(`Lendo curso ${i + 1}/${folders.length}: ${folders[i].name}`);
      const acc = { lessons: [], covers: {} }; await scan(folders[i].id, [], acc);
      acc.lessons.sort((a, b) => collator.compare(a.module, b.module) || collator.compare(a.name, b.name));
      if (acc.lessons.length) courses.push({ id: folders[i].id, name: folders[i].name, lessons: acc.lessons, covers: acc.covers });
    }
    const loose = top.filter(isVideo).map(f => toLesson(f, 'Geral')).sort((a, b) => collator.compare(a.name, b.name));
    if (loose.length) courses.push({ id: '_loose', name: 'Aulas avulsas', lessons: loose, covers: {} });
    cache = { courses, syncedAt: Date.now() }; save(LS.cache, cache);
    await fetchUser();
    setStatus(`Sincronizado: ${courses.length} curso(s), ${courses.reduce((n, c) => n + c.lessons.length, 0)} aula(s).`, false, 3500);
  } catch (e) { setStatus(e.message, true); }
  finally { btn.disabled = false; render(); }
}

/* ---------- progresso ---------- */
const isDone = id => !!progress.done[id];
function setDone(id, v) { if (v) progress.done[id] = Date.now(); else delete progress.done[id]; save(LS.progress, progress); }
function stats(lessons) {
  const total = lessons.length, done = lessons.filter(l => isDone(l.id)).length;
  return { total, done, pct: total ? Math.round(done / total * 100) : 0, remainMs: lessons.filter(l => !isDone(l.id)).reduce((s, l) => s + l.dur, 0) };
}
function modulesOf(c) {
  const map = new Map();
  c.lessons.forEach(l => { if (!map.has(l.module)) map.set(l.module, []); map.get(l.module).push(l); });
  return [...map.keys()].sort(collator.compare).map((key, i) => {
    const lessons = map.get(key), n = key.match(/(\d+)/);
    let title = key.split(' / ').pop().replace(/^\s*(m[oó]dulo\s*)?\d+\s*[-–._:)]*\s*/i, '').trim();
    if (key === 'Geral') title = 'Aulas';
    const cv = c.covers?.[key], t = lessons.find(l => l.thumb);
    return {
      key, lessons, num: String(n ? n[1] : i + 1).padStart(2, '0'), title: title || key,
      cover: cv || (t ? { id: t.id, link: t.thumb } : { id: lessons[0].id, link: '' }),
      next: lessons.find(l => !isDone(l.id)) || lessons[0],
    };
  });
}
const lessonHref = (c, l) => `#/curso/${c.id}/aula/${l.id}`;
const findLesson = (cid, lid) => { const c = cache.courses.find(x => x.id === cid); return c && { c, l: c.lessons.find(x => x.id === lid) }; };

/* ---------- imagens (thumbs do Drive) ---------- */
function driveImg(cls, id, link, w) {
  const img = el('img', { class: cls, loading: 'lazy', alt: '', referrerpolicy: 'no-referrer' });
  const fallback = `https://drive.google.com/thumbnail?id=${id}&sz=w${w}`;
  let tried = !link;
  img.addEventListener('error', () => { if (!tried) { tried = true; img.src = fallback; } else img.remove(); });
  img.src = link ? link.replace(/=s\d+$/, '=s' + w) : fallback;
  return img;
}
const gradient = s => `linear-gradient(135deg,hsl(${hue(s)} 45% 22%),hsl(${(hue(s) + 50) % 360} 50% 12%))`;

/* ---------- componentes ---------- */
const pbar = pct => el('div', { class: 'pbar', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 }, el('i', { style: `width:${pct}%` }));

function moduleCard(c, m) {
  const s = stats(m.lessons);
  const card = el('a', { class: 'mod', href: lessonHref(c, m.next), style: `background:${gradient(c.id + m.key)}`, title: m.title },
    driveImg('bg', m.cover.id, m.cover.link, 600),
    el('div', { class: 'frame' }, el('span', { class: 'badge' }, `Módulo ${m.num}`), el('h3', {}, m.title),
      el('small', {}, `${s.done}/${s.total} aulas`)),
    pbar(s.pct));
  return card;
}
function lessonCard(c, l, sub) {
  const mod = l.module === 'Geral' ? '' : ' · ' + l.module;
  return el('a', { class: 'lcard', href: lessonHref(c, l) },
    el('div', { class: 'thumb', style: `background:${gradient(l.id)}` }, driveImg('', l.id, l.thumb, 480), isDone(l.id) ? el('span', { class: 'tick', title: 'Concluída' }, '✓') : null),
    el('div', { class: 'meta' }, el('b', {}, l.name), el('small', {}, (sub ?? c.name) + mod)));
}
function continueItems() {
  return cache.courses.map(c => {
    const l = c.lessons.find(x => x.id === progress.last[c.id]);
    return l && { c, l, at: progress.lastAt[c.id] || 0 };
  }).filter(Boolean).sort((a, b) => b.at - a.at);
}

/* ---------- views ---------- */
function emptyState() {
  return el('div', { class: 'empty' }, el('h1', {}, 'Nenhum curso ainda'),
    el('p', {}, 'Configure o Client ID e a pasta raiz do Drive para começar.'),
    el('button', { class: 'primary', type: 'button', onclick: openSettings }, 'Configurar'));
}
function viewHome() {
  app.replaceChildren();
  if (!cache.courses.length) return app.append(emptyState());
  const q = $('#search').value.trim().toLowerCase();
  if (q) {
    const hits = cache.courses.flatMap(c => c.lessons.filter(l => (l.name + ' ' + l.module + ' ' + c.name).toLowerCase().includes(q)).map(l => ({ c, l }))).slice(0, 80);
    app.append(el('h1', {}, `Resultados (${hits.length})`));
    return app.append(hits.length ? el('div', { class: 'grid' }, hits.map(({ c, l }) => lessonCard(c, l))) : el('p', { class: 'empty' }, 'Nada encontrado.'));
  }
  const all = cache.courses.flatMap(c => c.lessons), st = stats(all);
  app.append(el('div', { class: 'summary' },
    el('div', { class: 'stat' }, el('b', {}, `${st.pct}%`), el('span', {}, 'Progresso geral')),
    el('div', { class: 'stat' }, el('b', {}, `${st.done}/${st.total}`), el('span', {}, 'Aulas concluídas')),
    el('div', { class: 'stat' }, el('b', {}, `${cache.courses.filter(c => stats(c.lessons).pct === 100).length}/${cache.courses.length}`), el('span', {}, 'Cursos finalizados'))));

  cache.courses.forEach(c => {
    const s = stats(c.lessons);
    app.append(el('section', { class: 'section' },
      el('div', { class: 'section-head' }, el('h2', {}, cache.courses.length > 1 ? c.name : 'Módulos'), el('small', {}, `${s.pct}% concluído` + (s.remainMs ? ` · faltam ${fmtDur(s.remainMs)}` : ''))),
      el('div', { class: 'rail' }, modulesOf(c).map(m => moduleCard(c, m)))));
  });
  const cont = continueItems().slice(0, 8);
  if (cont.length) app.append(el('section', { class: 'section' },
    el('div', { class: 'section-head' }, el('h2', {}, 'Continuar assistindo'), el('a', { href: '#/continuar', class: 'hint' }, 'ver tudo')),
    el('div', { class: 'rail' }, cont.map(({ c, l }) => lessonCard(c, l)))));
}
function viewContinue() {
  app.replaceChildren(el('h1', {}, 'Continuar assistindo'));
  const items = continueItems();
  app.append(items.length ? el('div', { class: 'grid' }, items.map(({ c, l }) => lessonCard(c, l))) : el('p', { class: 'empty' }, 'Você ainda não assistiu nenhuma aula.'));
}

/* player */
function buildSide(c, cur) {
  const q = $('#search').value.trim().toLowerCase(), s = stats(c.lessons);
  const side = el('aside', { class: 'side' });
  side.append(el('div', { class: 'side-head' },
    el('div', { class: 't' }, el('b', {}, 'Aulas'), el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Fechar lista', onclick: () => togglePanel(false) }, '✕')),
    el('div', { class: 'mini' }, el('i', { style: `width:${s.pct}%` })),
    el('small', { class: 'hint' }, `${s.done}/${s.total} concluídas · ${s.pct}%` + (s.remainMs ? ` · faltam ${fmtDur(s.remainMs)}` : '')),
    el('label', { class: 'check', style: 'font-weight:400;font-size:.88rem' },
      el('input', { type: 'checkbox', checked: hideDone, onchange: e => { hideDone = e.target.checked; refreshCourse(); } }), 'Ocultar concluídas')));
  modulesOf(c).forEach(m => {
    const items = m.lessons.filter(l => (!hideDone || !isDone(l.id) || l.id === cur.id) && (!q || (l.name + ' ' + m.key).toLowerCase().includes(q)));
    if (!items.length) return;
    const id = c.id + '|' + m.key, md = m.lessons.filter(l => isDone(l.id)).length;
    const det = el('details', { open: !!q || openMods.has(id) }, el('summary', {}, el('span', {}, m.key === 'Geral' ? 'Aulas' : m.key), el('small', {}, `${md}/${m.lessons.length}`)));
    det.addEventListener('toggle', () => { if (det.open) openMods.add(id); else openMods.delete(id); });
    items.forEach(l => {
      const cb = el('input', { type: 'checkbox', checked: isDone(l.id), 'aria-label': 'Concluída: ' + l.name });
      cb.addEventListener('change', () => { setDone(l.id, cb.checked); refreshCourse(); });
      det.append(el('div', { class: 'lesson' + (l.id === cur.id ? ' current' : '') + (isDone(l.id) ? ' done' : '') }, cb,
        el('a', { class: 'th', href: lessonHref(c, l), style: `background:${gradient(l.id)}`, tabindex: '-1', 'aria-hidden': 'true' }, driveImg('', l.id, l.thumb, 220), isDone(l.id) ? pbar(100) : null),
        el('a', { href: lessonHref(c, l) }, l.name)));
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
function viewCourse(cid, lid) {
  const c = cache.courses.find(x => x.id === cid);
  if (!c) { location.hash = '#/'; return; }
  const idx = Math.max(0, c.lessons.findIndex(l => l.id === lid)), cur = c.lessons[idx];
  progress.last[c.id] = cur.id; progress.lastAt[c.id] = Date.now(); progress.lastOpened = { courseId: c.id, lessonId: cur.id }; save(LS.progress, progress);
  openMods.add(c.id + '|' + cur.module);
  ctx = { c, cur };

  const prev = c.lessons[idx - 1], next = c.lessons[idx + 1], go = l => () => { location.hash = lessonHref(c, l); };
  const chk = el('input', { type: 'checkbox', id: 'curDone', checked: isDone(cur.id) });
  chk.addEventListener('change', () => { setDone(cur.id, chk.checked); refreshCourse(); });
  const modName = cur.module === 'Geral' ? c.name : cur.module;

  const player = el('section', { class: 'player' },
    el('div', { class: 'backbar' }, el('a', { href: '#/', 'aria-label': 'Voltar', title: 'Voltar' }, '←'), el('span', {}, c.name)),
    el('div', { class: 'frame' }, el('iframe', { src: `https://drive.google.com/file/d/${cur.id}/preview`, allow: 'autoplay; fullscreen', allowfullscreen: true, title: cur.name })),
    el('div', { class: 'info' },
      el('div', { class: 'kicker' }, `${modName} · aula ${idx + 1} de ${c.lessons.length}` + (cur.dur ? ` · ${fmtDur(cur.dur)}` : '')),
      el('h2', {}, cur.name),
      el('div', { class: 'controls' },
        el('label', { class: 'check', for: 'curDone' }, chk, 'Aula concluída'),
        el('span', { class: 'grow' }),
        el('button', { type: 'button', id: 'btnPanel', hidden: panelOpen, onclick: () => togglePanel(true) }, '☰ Aulas'),
        el('button', { type: 'button', disabled: !prev, onclick: prev && go(prev) }, '‹ Anterior'),
        el('button', { type: 'button', disabled: !next, onclick: next && go(next) }, 'Próxima ›'),
        el('button', { type: 'button', class: 'primary', onclick: () => { setDone(cur.id, true); next ? go(next)() : refreshCourse(); } }, next ? 'Concluir e próxima' : 'Concluir'))));
  app.replaceChildren(el('div', { class: 'watch' + (panelOpen ? '' : ' nopanel') }, player, buildSide(c, cur)));
  const s = $('.side'); if (s) s.hidden = !panelOpen;
  $('.side .current')?.scrollIntoView({ block: 'center' });
}
// atualiza só a lista lateral e o checkbox, sem recarregar o vídeo
function refreshCourse() {
  if (!ctx || !$('.side')) return render();
  const old = $('.side'), top = old.scrollTop, ns = buildSide(ctx.c, ctx.cur);
  ns.hidden = !panelOpen; old.replaceWith(ns); ns.scrollTop = top;
  const cb = $('#curDone'); if (cb) cb.checked = isDone(ctx.cur.id);
}

/* ---------- fornecedores (IndexedDB) ---------- */
let suppliers = [], supState = { q: '', niche: '' }, dbp = null;
function db() {
  return dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open('cursos-db', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('suppliers', { keyPath: 'id' });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function dbDo(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction('suppliers', mode), req = fn(t.objectStore('suppliers'));
    t.oncomplete = () => res(req?.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  });
}
const supAll = () => dbDo('readonly', s => s.getAll());
const supPut = r => dbDo('readwrite', s => s.put(r));
const supDel = id => dbDo('readwrite', s => s.delete(id));
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
/* formulário */
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
  closeNav(); ctx = null;
  if (route === 'curso' && cid) viewCourse(cid, lid);
  else if (route === 'continuar') viewContinue();
  else if (route === 'fornecedores') viewSuppliers();
  else viewHome();
  if (route !== 'curso') window.scrollTo(0, 0);
}
window.addEventListener('hashchange', render);
$('#search').addEventListener('input', () => (ctx ? refreshCourse() : render()));

/* ---------- menu lateral ---------- */
const openNav = () => { document.body.classList.add('nav-open'); $('#scrim').hidden = false; };
function closeNav() { document.body.classList.remove('nav-open'); $('#scrim').hidden = true; }
$('#btnMenu').onclick = openNav; $('#scrim').onclick = closeNav;
if (load(LS.collapsed, false)) document.body.classList.add('collapsed');
$('#btnCollapse').onclick = () => { const c = document.body.classList.toggle('collapsed'); save(LS.collapsed, c); };
function paintUser() {
  $('#userName').textContent = user?.name || 'Não conectado';
  const av = $('#avatar'); av.replaceChildren();
  if (user?.photo) { const i = el('img', { alt: '', referrerpolicy: 'no-referrer', src: user.photo }); i.onerror = () => { i.remove(); av.textContent = initials(); }; av.append(i); }
  else av.textContent = initials();
}
const initials = () => (user?.name || '?').split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();

/* ---------- diálogos: config / backup ---------- */
const dlgS = $('#dlgSettings'), dlgB = $('#dlgBackup');
function openSettings() { $('#inClient').value = settings.clientId; $('#inRoot').value = settings.rootId; dlgS.showModal(); }
$('#btnSettings').onclick = openSettings;
$('#btnCancelSettings').onclick = () => dlgS.close();
$('#formSettings').addEventListener('submit', () => {
  settings = { clientId: $('#inClient').value.trim(), rootId: parseFolderId($('#inRoot').value) };
  save(LS.settings, settings); token = null; sync();
});
$('#btnSync').onclick = sync;
$('#btnBackup').onclick = () => dlgB.showModal();
$('#btnCloseBackup').onclick = () => dlgB.close();

const blobToB64 = b => new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result.split(',')[1]); f.readAsDataURL(b); });
const b64ToBlob = (b64, type) => { const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Blob([u], { type }); };

$('#btnExport').onclick = async () => {
  const sup = await Promise.all(suppliers.map(async s => ({ ...s, pdf: undefined, pdfBase64: s.pdf ? await blobToB64(s.pdf) : null })));
  const blob = new Blob([JSON.stringify({ version: 2, progress, suppliers: sup })], { type: 'application/json' });
  openBlob(blob, `backup-cursos-${new Date().toISOString().slice(0, 10)}.json`, true);
};
$('#fileImport').addEventListener('change', async e => {
  try {
    const j = JSON.parse(await e.target.files[0].text());
    const p = j.progress || (j.done ? j : null);
    if (!p && !j.suppliers) throw new Error('formato');
    if (p) { progress = { done: p.done || {}, last: p.last || {}, lastAt: p.lastAt || {}, lastOpened: p.lastOpened || null }; save(LS.progress, progress); }
    for (const s of j.suppliers || []) {
      const { pdfBase64, ...rec } = s;
      rec.pdf = pdfBase64 ? b64ToBlob(pdfBase64, 'application/pdf') : null;
      await supPut(rec);
    }
    await loadSuppliers(); dlgB.close(); render(); setStatus('Backup importado.', false, 2500);
  } catch { setStatus('Arquivo de backup inválido.', true); }
  e.target.value = '';
});

/* ---------- início ---------- */
paintUser();
render();
loadSuppliers().then(() => { if (location.hash.startsWith('#/fornecedores')) viewSuppliers(); });
