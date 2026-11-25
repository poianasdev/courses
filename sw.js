/* GRG Cursos — Service Worker
 * Faz a ponte entre o <video> e a API do Google Drive: o <video> não consegue enviar
 * o cabeçalho Authorization, então ele pede /stream/<id>?t=<token>… e este worker busca
 * o arquivo no Drive (com Range) já autenticado. Nada é armazenado nem enviado a terceiros. */
const API = 'https://www.googleapis.com/drive/v3';
const CHUNK = 8 * 1024 * 1024;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  const m = u.origin === self.location.origin && u.pathname.match(/\/stream\/([\w-]+)$/);
  if (m) e.respondWith(stream(e.request, m[1], u.searchParams));
});

async function stream(req, id, qs) {
  const token = qs.get('t'), size = Number(qs.get('s')) || 0, mime = qs.get('m') || 'video/mp4', base = qs.get('b') || API;
  if (!token) return new Response('token ausente', { status: 401 });
  const url = `${base}/files/${id}?alt=media&supportsAllDrives=true`;
  const headers = { Authorization: 'Bearer ' + token };
  const rg = (req.headers.get('range') || '').match(/^bytes=(\d*)-(\d*)$/);

  if (!rg || !size) {
    const r = await fetch(url, { headers });
    return new Response(r.body, { status: r.status, headers: { 'Content-Type': mime, 'Accept-Ranges': 'bytes', ...(size && r.ok ? { 'Content-Length': String(size) } : {}) } });
  }
  let start, end;
  if (rg[1] === '') { start = Math.max(0, size - Number(rg[2])); end = size - 1; }      // bytes=-N
  else { start = Number(rg[1]); end = rg[2] === '' ? size - 1 : Math.min(Number(rg[2]), size - 1); }
  if (start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  end = Math.min(end, start + CHUNK - 1);                                                 // resposta em blocos

  const r = await fetch(url, { headers: { ...headers, Range: `bytes=${start}-${end}` } });
  if (!r.ok && r.status !== 206) return new Response(r.body, { status: r.status });
  return new Response(r.body, {
    status: 206,
    headers: { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) },
  });
}
