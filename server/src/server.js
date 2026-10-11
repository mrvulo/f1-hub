// F1 Hub Server: liefert die App im Heimnetz aus und stellt Live-Timing, News und Erinnerungen bereit
import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { startLiveTiming, liveSnapshot } from './livetiming.js';
import { startNews, newsSnapshot } from './news.js';
import { startReminders, remindersStatus, postWebhook } from './reminders.js';

const PORT = Number(process.env.PORT || 8790);
const PUBLIC = '/app/public';
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  // Chrome fragt bei Zugriffen aufs Heimnetz extra nach
  'Access-Control-Allow-Private-Network': 'true',
};

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(s);
}

function serveStatic(req, res, pathname) {
  let file = normalize(join(PUBLIC, decodeURIComponent(pathname)));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  try {
    if (statSync(file).isDirectory()) file = join(file, 'index.html');
    statSync(file);
  } catch { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  try {
    if (p === '/api/health') return json(res, 200, { ok: true, live: liveSnapshot().connected, uptime: process.uptime() });
    if (p === '/api/live') {
      const snap = liveSnapshot();
      // Nichts Neues seit der letzten Abfrage: leere Antwort spart Bandbreite
      if (url.searchParams.get('v') === String(snap.version)) { res.writeHead(204, CORS); return res.end(); }
      return json(res, 200, snap);
    }
    if (p === '/api/live/status') {
      const s = liveSnapshot();
      const i = s.data.SessionInfo || {};
      return json(res, 200, { connected: s.connected, active: s.active, meeting: i.Meeting?.Name, session: i.Name, type: i.Type, status: s.data.SessionStatus?.Status });
    }
    if (p === '/api/news') return json(res, 200, newsSnapshot());
    if (p === '/api/reminders') return json(res, 200, remindersStatus());
    if (p === '/api/test-webhook' && req.method === 'POST') {
      await postWebhook({ content: '✅ F1 Hub reminders are set up. You will get a message 30 minutes before every Qualifying, Sprint and Race, plus the podium after each race.' });
      return json(res, 200, { ok: true });
    }
    if (p.startsWith('/api/')) return json(res, 404, { error: 'not found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, p);
  } catch (err) {
    console.error(err);
    return json(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => console.log(new Date().toISOString(), `[server] listening on ${PORT}`));
startLiveTiming();
startNews();
startReminders();
