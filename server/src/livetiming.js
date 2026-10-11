// Client für das offizielle F1-Live-Timing (SignalR Core, ohne Login nutzbar).
// Hält den zusammengeführten Zustand aller abonnierten Topics im Speicher.
import WebSocket from 'ws';

const BASE = 'https://livetiming.formula1.com';
const RS = '\x1e';
const TOPICS = [
  'Heartbeat', 'SessionInfo', 'SessionStatus', 'LapCount', 'TrackStatus', 'ExtrapolatedClock',
  'WeatherData', 'DriverList', 'TimingData', 'TimingAppData', 'TimingStats', 'TopThree',
  'RaceControlMessages', 'TeamRadio',
  // Boxengassenzeiten: 81 Byte, haelt je Fahrer den letzten Stopp. TyreStintSeries
  // und CurrentTyres waeren zusammen 4 KB und doppeln nur, was TimingAppData.Stints
  // ohnehin liefert, deshalb bleiben sie draussen.
  'PitLaneTimeCollection',
];

export const live = {
  data: {},
  version: 0,
  connected: false,
  lastMessage: 0,
};

let ws = null;
let pingTimer = null;
let watchdog = null;
let retry = 0;

const log = (...a) => console.log(new Date().toISOString(), '[livetiming]', ...a);

// F1 schickt Deltas: Objekte werden rekursiv gemischt, Objekte mit Zahlen-Schlüsseln patchen Arrays
function merge(target, patch) {
  if (patch === null || typeof patch !== 'object') return patch;
  if (Array.isArray(patch)) return patch;
  if (Array.isArray(target)) {
    const out = target.slice();
    for (const [k, v] of Object.entries(patch)) {
      if (k === '_deleted') continue;
      const i = Number(k);
      if (Number.isInteger(i)) out[i] = merge(out[i], v);
    }
    return out;
  }
  const out = target && typeof target === 'object' ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (k === '_deleted') { for (const d of [].concat(v)) delete out[d]; continue; }
    out[k] = merge(out[k], v);
  }
  return out;
}

// PitLaneTimeCollection ist ein Benachrichtigungsstrom, kein Archiv: F1 meldet einen
// Stopp und loescht den Eintrag kurz darauf wieder per _deleted. Wer nur den aktuellen
// Stand durchreicht, zeigt deshalb fast immer eine leere Liste. Hier werden die Stopps
// mitgeschrieben, solange die Session laeuft.
export const pitStops = {};

function notePitTimes(payload) {
  for (const [num, p] of Object.entries(payload?.PitTimes || {})) {
    if (!p || p.Duration == null) continue;
    const list = pitStops[num] || (pitStops[num] = []);
    if (!list.some(x => x.lap === p.Lap && x.duration === p.Duration)) {
      list.push({ lap: p.Lap, duration: p.Duration });
    }
  }
}

function apply(topic, payload) {
  if (topic === 'PitLaneTimeCollection') notePitTimes(payload);
  const before = live.data.SessionInfo?.Key;
  live.data[topic] = merge(live.data[topic], payload);
  live.version++;
  // Neue Session: frisch verbinden, damit keine Zeilen der alten Session übrig bleiben
  if (topic === 'SessionInfo' && before && payload?.Key && payload.Key !== before) {
    for (const k of Object.keys(pitStops)) delete pitStops[k];
    log('new session', payload.Key, '- reconnecting for a fresh snapshot');
    reconnect(1000);
  }
}

async function negotiate() {
  const r = await fetch(`${BASE}/signalrcore/negotiate?negotiateVersion=1`, { method: 'POST' });
  if (!r.ok) throw new Error(`negotiate HTTP ${r.status}`);
  const body = await r.json();
  const cookies = (r.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
  return { token: body.connectionToken, cookies };
}

async function connect() {
  clearTimers();
  try {
    const { token, cookies } = await negotiate();
    ws = new WebSocket(`wss://livetiming.formula1.com/signalrcore?id=${encodeURIComponent(token)}`, {
      headers: { Cookie: cookies, 'User-Agent': 'BestHTTP' },
    });
  } catch (err) {
    log('negotiate failed:', err.message);
    return reconnect();
  }
  ws.on('open', () => {
    ws.send(JSON.stringify({ protocol: 'json', version: 1 }) + RS);
    ws.send(JSON.stringify({ type: 1, invocationId: '0', target: 'Subscribe', arguments: [TOPICS] }) + RS);
    live.connected = true;
    retry = 0;
    log('connected');
    pingTimer = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: 6 }) + RS), 15000);
    // Ohne jede Nachricht (auch kein Heartbeat) ist die Verbindung tot
    watchdog = setInterval(() => { if (Date.now() - live.lastMessage > 90000) { log('no data for 90s'); reconnect(1000); } }, 30000);
  });
  ws.on('message', raw => {
    live.lastMessage = Date.now();
    for (const part of raw.toString().split(RS)) {
      if (!part) continue;
      let msg;
      try { msg = JSON.parse(part); } catch { continue; }
      if (msg.type === 3 && msg.result) {
        live.data = {};
        for (const [topic, val] of Object.entries(msg.result)) {
          if (topic === 'PitLaneTimeCollection') notePitTimes(val);
          live.data[topic] = val;
        }
        live.version++;
        log('snapshot for', live.data.SessionInfo?.Meeting?.Name, live.data.SessionInfo?.Name);
      } else if (msg.type === 1 && msg.target === 'feed') {
        const [topic, payload] = msg.arguments || [];
        if (topic) apply(topic, payload);
      } else if (msg.type === 7) {
        log('server closed connection', msg.error || '');
      }
    }
  });
  ws.on('close', () => { live.connected = false; reconnect(); });
  ws.on('error', err => log('socket error:', err.message));
}

function clearTimers() {
  clearInterval(pingTimer);
  clearInterval(watchdog);
}

let reconnectTimer = null;
function reconnect(delay) {
  clearTimers();
  live.connected = false;
  if (ws) { ws.removeAllListeners('close'); try { ws.terminate(); } catch {} ws = null; }
  clearTimeout(reconnectTimer);
  const wait = delay ?? Math.min(60000, 2000 * 2 ** retry++);
  reconnectTimer = setTimeout(connect, wait);
}

export function startLiveTiming() {
  live.lastMessage = Date.now();
  connect();
}

// Kompakter Zustand für die App
export function liveSnapshot() {
  const d = live.data;
  const info = d.SessionInfo || {};
  const archive = info.ArchiveStatus?.Status;
  const rcm = d.RaceControlMessages?.Messages;
  const radio = d.TeamRadio?.Captures;
  const list = x => (Array.isArray(x) ? x : x ? Object.values(x) : []);
  return {
    connected: live.connected,
    // Eine Session gilt als aktiv, solange F1 ihr Archiv noch nicht abgeschlossen hat
    active: Boolean(info.Key) && archive !== 'Complete',
    version: live.version,
    updated: live.lastMessage,
    staticBase: info.Path ? `${BASE}/static/${info.Path}` : null,
    data: {
      SessionInfo: d.SessionInfo, SessionStatus: d.SessionStatus, LapCount: d.LapCount,
      TrackStatus: d.TrackStatus, ExtrapolatedClock: d.ExtrapolatedClock, WeatherData: d.WeatherData,
      DriverList: d.DriverList, TimingData: d.TimingData, TimingAppData: d.TimingAppData,
      TimingStats: d.TimingStats, PitStops: pitStops,
      RaceControlMessages: list(rcm).slice(-60),
      TeamRadio: list(radio).slice(-30),
    },
  };
}
