'use strict';
// Live-Timing und News – beides kommt vom F1-Hub-Server auf dem N100

const SERVER = (() => {
  try { const o = localStorage.getItem('f1:server'); if (o) return o.replace(/\/$/, ''); } catch {}
  // Eine https-Seite (GitHub Pages) darf keinen http-Server im Heimnetz abfragen
  if (location.protocol === 'https:') return null;
  if (location.protocol.startsWith('http') && !['localhost', '127.0.0.1'].includes(location.hostname)) return location.origin;
  return 'http://192.168.178.72:8790';
})();

const noServerNote = what => `<div class="note">${what} läuft über deinen F1-Hub-Server auf dem N100 und funktioniert nur im Heimnetz.
  Öffne dafür <a href="http://192.168.178.72:8790/#/${state.route}">http://192.168.178.72:8790</a>.</div>`;
const serverDown = () => `<div class="error">Der F1-Hub-Server (${esc(SERVER)}) ist gerade nicht erreichbar. Ist der N100 an und bist du im Heimnetz?</div>`;

async function api(path) {
  const r = await fetch(SERVER + path, { cache: 'no-store' });
  if (r.status === 204) return null;
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

function ago(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'gerade eben';
  if (s < 3600) return `vor ${Math.floor(s / 60)} Min.`;
  if (s < 86400) return `vor ${Math.floor(s / 3600)} Std.`;
  return `vor ${Math.floor(s / 86400)} Tg.`;
}

// ---------------------------------------------------------------- Live-Status im Menü
let lastStatus = null;
async function statusLoop() {
  try { lastStatus = await api('/api/live/status'); } catch { lastStatus = null; }
  const on = Boolean(lastStatus?.active && lastStatus.connected);
  const nav = $('#nav-live');
  nav.classList.toggle('hidden', !on);
  nav.title = on ? `${lastStatus.meeting} – ${lastStatus.session}` : '';
  banner();
}
function banner() {
  $('#live-banner')?.remove();
  const s = lastStatus;
  if (!s?.active || !s.connected || state.route !== 'overview') return;
  $('#view').insertAdjacentHTML('afterbegin', `<a id="live-banner" class="live-banner" href="#/live">
    <span class="live-dot"></span><b>LIVE:</b> ${esc(s.meeting)} – ${esc(SESSION_DE[s.session] || s.session)} <span class="muted">· Live-Timing öffnen →</span></a>`);
}
// Banner nach jedem Aufbau der Übersicht wieder einsetzen
const overviewAfter = views.overview.after;
views.overview.after = (...a) => { overviewAfter?.(...a); banner(); };

// ---------------------------------------------------------------- Live-Timing
const TRACK = {
  1: ['Grün', '#3ddc84'], 2: ['Gelb', '#ffd12e'], 4: ['Safety Car', '#ffb300'], 5: ['Rote Flagge', '#ff3b3b'],
  6: ['Virtual Safety Car', '#ffb300'], 7: ['VSC endet', '#ffd12e'],
};
const SESSION_STATUS = { Inactive: 'Noch nicht gestartet', Started: 'Läuft', Aborted: 'Unterbrochen', Finished: 'Beendet', Finalised: 'Abgeschlossen', Ends: 'Beendet' };
const SESSION_DE = { Race: 'Rennen', Qualifying: 'Qualifying', 'Sprint Qualifying': 'Sprint-Qualifying', Sprint: 'Sprint', 'Practice 1': '1. Training', 'Practice 2': '2. Training', 'Practice 3': '3. Training' };
const TYRE_LETTER = { SOFT: 'S', MEDIUM: 'M', HARD: 'H', INTERMEDIATE: 'I', WET: 'W' };

// Mini-Sektoren: 24 Segmente pro Runde, 8 je Sektor. Die Status-Codes sind
// undokumentiert und wurden gegen den Live-Feed gemessen. Vor dem Start traten
// nur 2048 und 2064 auf (Outlap: [2064,2064,2064,2048,2048,...]), unter grüner
// Flagge kamen 2049 und 2051 dazu. Das Verhältnis bestätigt die Zuordnung:
// 2049 x2164 gegen 2051 x82, Lila ist also rund 26-mal seltener als Grün,
// genau wie es für "schnellste Zeit aller Fahrer" sein muss.
// Unbekannte Codes bleiben absichtlich grau statt falsch eingefärbt.
const SEGMENT = {
  0: '',             // noch nicht befahren
  2048: 'm-yellow',  // Segment absolviert
  2049: 'm-green',   // persönliche Bestzeit
  2051: 'm-purple',  // Bestzeit aller Fahrer
  2064: 'm-blue',    // Boxengasse / Outlap
};

const vals = x => (Array.isArray(x) ? x : x ? Object.values(x) : []);
const timeCls = o => (o?.OverallFastest ? 'purple' : o?.PersonalFastest ? 'green' : '');

let liveData = null;

views.live = async () => {
  if (!SERVER) return `<h1>Live-Timing</h1>${noServerNote('Das Live-Timing')}`;
  return `<div id="live-root">${loading('Verbinde mit dem Live-Timing …')}</div>`;
};
views.live.after = () => {
  if (!SERVER) return;
  let version = null;
  const token = render.token;
  const poll = async () => {
    try {
      const snap = await api(`/api/live${version != null ? `?v=${version}` : ''}`);
      if (stale(token)) return;
      if (snap) { version = snap.version; liveData = snap; drawLive(); }
    } catch {
      if (!stale(token)) $('#live-root').innerHTML = serverDown();
    }
  };
  poll();
  state.timers.push(setInterval(poll, 2000));
  state.timers.push(setInterval(tickClock, 1000));
};

function remaining() {
  const c = liveData?.data.ExtrapolatedClock;
  if (!c?.Remaining) return '';
  const [h, m, s] = c.Remaining.split(':').map(Number);
  let sec = h * 3600 + m * 60 + s;
  if (c.Extrapolating) sec -= (Date.now() - Date.parse(c.Utc)) / 1000;
  sec = Math.max(0, Math.round(sec));
  return `${Math.floor(sec / 3600)}:${String(Math.floor(sec / 60) % 60).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}
function tickClock() { const el = $('#live-clock'); if (el) el.textContent = remaining(); }

// WeatherData liefert sieben Felder – bisher wurden drei davon angezeigt
const COMPASS = ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'];
function weatherStrip(w) {
  if (!w || w.AirTemp == null) return '';
  const cell = (label, value, unit, cls = '') =>
    `<div class="${cls}"><span>${label}</span><b>${esc(value)}</b>${unit ? `<u>${unit}</u>` : ''}</div>`;
  const wet = w.Rainfall && w.Rainfall !== '0';
  return `<div class="wx">
    ${cell('Luft', w.AirTemp, '°C')}
    ${cell('Strecke', w.TrackTemp, '°C')}
    ${cell('Luftfeuchte', w.Humidity, '%')}
    ${cell('Wind', w.WindSpeed, `m/s ${COMPASS[Math.round(((+w.WindDirection || 0) % 360) / 45) % 8]}`)}
    ${cell('Druck', w.Pressure, 'hPa')}
    ${cell('Regen', wet ? 'Ja' : 'Nein', '', wet ? 'wet' : '')}
  </div>`;
}

// Eine Tabellenzeile je Fahrer. Aus drawLive ausgelagert, damit der Zeilenbau
// ohne DOM getestet werden kann und drawLive wieder lesbar bleibt.
function timingRows(d, isRace, isQuali) {
  const drivers = d.DriverList || {};
  const timing = d.TimingData?.Lines || {};
  const app = d.TimingAppData?.Lines || {};
  const part = d.TimingData?.SessionPart;
  return Object.entries(timing)
    .map(([num, t]) => ({ num, t, drv: drivers[num] || {}, app: app[num] || {} }))
    .sort((a, b) => (+a.t.Position || +a.t.Line || 99) - (+b.t.Position || +b.t.Line || 99))
    .map(({ num, t, drv, app: ta }) => {
      const col = '#' + (drv.TeamColour || '888888');
      const stints = vals(ta.Stints);
      const cur = stints.at(-1) || {};
      const tyre = cur.Compound ? `<span class="tyre t-${esc(cur.Compound)}" title="${esc(cur.Compound)}${cur.New === 'false' ? ' (gebraucht)' : ''}">${TYRE_LETTER[cur.Compound] || '?'}</span><span class="muted small">${cur.TotalLaps ?? ''}</span>` : '';
      const flags = t.Retired ? '<span class="badge">AUS</span>' : t.Stopped ? '<span class="badge">STOPP</span>' : t.InPit ? '<span class="badge sprint">BOX</span>' : t.PitOut ? '<span class="badge">OUT</span>' : t.KnockedOut ? '<span class="badge">RAUS</span>' : '';
      let gap, interval;
      if (isQuali) {
        const best = vals(t.BestLapTimes)[(part || 1) - 1]?.Value || t.BestLapTime?.Value || '';
        gap = esc(best);
        interval = esc(vals(t.Stats)[(part || 1) - 1]?.TimeDiffToFastest || t.TimeDiffToFastest || '');
      } else if (isRace) {
        gap = esc(t.GapToLeader || '');
        interval = esc(t.IntervalToPositionAhead?.Value || '');
      } else {
        gap = esc(t.BestLapTime?.Value || '');
        interval = esc(t.TimeDiffToFastest || '');
      }
      const secList = vals(t.Sectors);
      const sectors = secList.map(s => `<td class="sec hide-md ${timeCls(s)}">${esc(s.Value || '')}</td>`).join('');
      const mini = secList.map((s, i) => {
        const segs = vals(s.Segments).map(g => `<i class="${SEGMENT[g.Status] || ''}"></i>`).join('');
        return `<div class="g" title="Sektor ${i + 1}${s.Value ? ` – ${esc(s.Value)}` : ''}">${segs}</div>`;
      }).join('');
      return `<tr class="${t.Retired || t.KnockedOut ? 'out' : ''}">
        <td class="pos">${esc(t.Position || '')}</td>
        <td><span class="teambar" style="background:${col}"></span><b>${esc(drv.Tla || num)}</b> <span class="muted small hide-sm">${esc(drv.LastName || '')}</span> ${flags}</td>
        <td class="num">${gap}</td><td class="num">${interval}</td>
        <td class="num ${timeCls(t.LastLapTime)}">${esc(t.LastLapTime?.Value || '')}</td>
        ${isRace ? `<td class="num ${timeCls(t.BestLapTime)}">${esc(t.BestLapTime?.Value || '')}</td>` : ''}
        <td><div class="ms">${mini}</div></td>
        ${sectors}
        <td class="nowrap">${tyre}</td>
        ${isRace ? `<td class="num">${t.NumberOfPitStops ?? ''}</td>` : `<td class="num">${t.NumberOfLaps ?? ''}</td>`}
      </tr>`;
    }).join('');
}

function drawLive() {
  const root = $('#live-root');
  if (!root || !liveData) return;
  const { data: d, active, connected, staticBase } = liveData;
  const info = d.SessionInfo || {};
  if (!info.Key) { root.innerHTML = `<h1>Live-Timing</h1><p class="muted">Noch keine Daten vom Live-Timing.</p>`; return; }
  const type = info.Type;
  const isRace = type === 'Race';
  const isQuali = type === 'Qualifying';
  const ts = TRACK[d.TrackStatus?.Status] || [d.TrackStatus?.Message || '–', 'var(--muted)'];
  const st = d.SessionStatus?.Status;
  const w = d.WeatherData || {};
  const drivers = d.DriverList || {};
  const rows = timingRows(d, isRace, isQuali);

  const rcm = [...(d.RaceControlMessages || [])].reverse().map(m => {
    const fc = { GREEN: '#3ddc84', YELLOW: '#ffd12e', 'DOUBLE YELLOW': '#ffd12e', RED: '#ff3b3b', BLUE: '#2f8cff', CHEQUERED: '#fff', CLEAR: '#3ddc84' }[m.Flag] || 'var(--muted)';
    return `<div><span class="muted small">${m.Lap ? 'R' + m.Lap + ' · ' : ''}${new Date(m.Utc + (m.Utc.endsWith('Z') ? '' : 'Z')).toLocaleTimeString('de-DE')}</span><br>
      <span class="rc-flag" style="color:${fc}">${esc(m.Flag || m.Category || '')}</span> ${esc(m.Message)}</div>`;
  }).join('');

  const radio = staticBase ? [...(d.TeamRadio || [])].reverse().slice(0, 15).map(r => {
    const drv = drivers[r.RacingNumber] || {};
    return `<div class="radio"><span class="teambar" style="background:#${esc(drv.TeamColour || '888')}"></span><b>${esc(drv.Tla || r.RacingNumber)}</b>
      <span class="muted small">${new Date(r.Utc).toLocaleTimeString('de-DE')}</span>
      <audio controls preload="none" src="${esc(staticBase + r.Path)}"></audio></div>`;
  }).join('') : '';

  const lap = d.LapCount ? `Runde <b>${d.LapCount.CurrentLap}</b> / ${d.LapCount.TotalLaps}` : '';
  root.innerHTML = `
    <div class="live-head">
      <div>
        <div class="kicker">${active ? '<span class="live-dot"></span>Live' : 'Letzte Session'} · ${esc(info.Meeting?.Name || '')}</div>
        <h1>${esc(SESSION_DE[info.Name] || info.Name || '')}</h1>
        <div class="muted small">${esc(info.Meeting?.Circuit?.ShortName || '')} · ${esc(SESSION_STATUS[st] || st || '')}${connected ? '' : ' · <span style="color:#ff5a5a">Verbindung zum F1-Server getrennt</span>'}</div>
      </div>
      <div class="live-chips">
        <div class="chip" style="border-color:${ts[1]};color:${ts[1]}">⚑ ${esc(ts[0])}</div>
        ${lap ? `<div class="chip">${lap}</div>` : ''}
        ${d.ExtrapolatedClock ? `<div class="chip">⏱ <b id="live-clock">${remaining()}</b></div>` : ''}
      </div>
    </div>
    ${weatherStrip(w)}
    ${active ? '' : `<p class="note">Gerade läuft keine Session. Angezeigt wird der letzte Stand von ${esc(info.Meeting?.Name || '')} – ${esc(SESSION_DE[info.Name] || info.Name || '')}. Sobald die nächste Session startet, erscheint oben im Menü „● Live“.</p>`}
    <div class="card table-wrap"><table class="tower"><thead><tr>
        <th>Pos</th><th>Fahrer</th>
        <th class="num">${isRace ? 'Abstand' : 'Beste'}</th><th class="num">${isRace ? 'Intervall' : 'Rückstand'}</th>
        <th class="num">Letzte</th>${isRace ? '<th class="num">Beste</th>' : ''}
        <th class="ms-h">Mini-Sektoren</th>
        <th class="hide-md">S1</th><th class="hide-md">S2</th><th class="hide-md">S3</th>
        <th>Reifen</th><th class="num">${isRace ? 'Stopps' : 'Runden'}</th>
      </tr></thead><tbody>${rows}</tbody></table>
      <p class="small muted" style="margin:8px 0 0"><span class="purple">Lila</span> = schnellste Zeit aller Fahrer, <span class="green">Grün</span> = persönliche Bestzeit. Daten: offizielles F1-Live-Timing.</p></div>
    <div class="grid live-side">
      <div class="card"><h2>Rennleitung</h2><div class="rc-list">${rcm || '<span class="muted">Keine Meldungen.</span>'}</div></div>
      ${radio ? `<div class="card"><h2>Boxenfunk</h2><div class="radio-list">${radio}</div></div>` : ''}
    </div>`;
}

// ---------------------------------------------------------------- News
// Mehrere Quellen syndizieren denselben Text – Motorsport.com DE und Formel1.de
// liefern regelmäßig wortgleiche Artikel. Gleiche Links und gleiche Titel fliegen
// raus. Fast gleiche Titel nur dann, wenn sich die beiden Wortmengen nicht in einem
// unterscheidenden Begriff trennen: "Samstag-Zeitplan" und "Sonntag-Zeitplan" sind
// zu 83 % wortgleich und trotzdem zwei verschiedene Artikel.
const NEWS_DISCRIM = new Set(`monday tuesday wednesday thursday friday saturday sunday
  montag dienstag mittwoch donnerstag freitag samstag sonntag
  sprint qualifying quali race rennen grid startaufstellung results ergebnisse
  preview review vorschau rückblick fp1 fp2 fp3 practice training
  1 2 3 one two three erste zweite dritte`.split(/\s+/).filter(Boolean));

const newsKey = t => (t || '').toLowerCase()
  .replace(/[‘’“”'"`]/g, '')
  .replace(/[^a-z0-9äöüß]+/g, ' ')
  .trim();

// Bei zwei Fassungen gewinnt die inhaltsreichere – Bild und längerer Teaser
const newsRich = x => (x.image ? 1 : 0) + (x.summary || '').length;

function dedupeNews(items) {
  const kept = [], byLink = new Map(), byKey = new Map();
  for (const it of items) {
    const key = newsKey(it.title);
    const words = new Set(key.split(' ').filter(Boolean));
    let twin = (it.link && byLink.get(it.link)) || (key && byKey.get(key)) || null;
    if (!twin && words.size) {
      for (const k of kept) {
        if (k.it.lang !== it.lang) continue;
        let both = 0;
        for (const w of words) if (k.words.has(w)) both++;
        if (both / (words.size + k.words.size - both) < 0.8) continue;
        let split = false;
        for (const w of words) if (!k.words.has(w) && NEWS_DISCRIM.has(w)) split = true;
        for (const w of k.words) if (!words.has(w) && NEWS_DISCRIM.has(w)) split = true;
        if (!split) { twin = k.it; break; }
      }
    }
    if (twin) {
      if (newsRich(it) > newsRich(twin)) Object.assign(twin, it);
      continue;
    }
    kept.push({ it, words });
    if (it.link) byLink.set(it.link, it);
    if (key) byKey.set(key, it);
  }
  return kept.map(k => k.it);
}

let newsFilter = (() => { try { return localStorage.getItem('f1:newslang') || 'all'; } catch { return 'all'; } })();
views.news = async () => {
  if (!SERVER) return `<h1>News</h1>${noServerNote('Der News-Bereich')}`;
  let n;
  try { n = await api('/api/news'); } catch { return `<h1>News</h1>${serverDown()}`; }
  if (!n || !Array.isArray(n.items)) return `<h1>News</h1>${serverDown()}`;
  const unique = dedupeNews(n.items);
  const removed = n.items.length - unique.length;
  const items = unique.filter(x => newsFilter === 'all' || x.lang === newsFilter);
  const cards = items.map(x => `<a class="card news-card click" href="${esc(x.link)}" target="_blank" rel="noopener">
      ${x.image ? `<div class="news-img" style="background-image:url('${esc(x.image).replace(/'/g, '%27')}')"></div>` : ''}
      <div class="small muted">${esc(x.source)} · ${ago(x.date)}</div>
      <h3>${esc(x.title)}</h3>
      ${x.summary ? `<p class="small muted">${esc(x.summary)}</p>` : ''}</a>`).join('');
  const btn = (k, l) => `<button data-lang="${k}" class="${newsFilter === k ? 'active' : ''}">${l}</button>`;
  return `<h1>News</h1><p class="sub">${(n.sources || []).map(s => esc(s.name)).join(' · ')} · aktualisiert ${ago(n.updated)}${removed ? ` · ${removed} Doppelte ausgeblendet` : ''}</p>
    <div class="tabs">${btn('all', 'Alle')}${btn('de', 'Deutsch')}${btn('en', 'Englisch')}</div>
    <div class="grid g3">${cards || '<p class="muted">Keine Artikel.</p>'}</div>`;
};
views.news.after = view => {
  $$('.tabs button', view).forEach(b => (b.onclick = () => {
    newsFilter = b.dataset.lang;
    try { localStorage.setItem('f1:newslang', newsFilter); } catch {}
    render();
  }));
  state.timers.push(setInterval(() => render(), 10 * 60 * 1000));
};

document.addEventListener('DOMContentLoaded', () => {
  if (!SERVER) { $('#nav-news').classList.add('hidden'); return; }
  statusLoop();
  setInterval(statusLoop, 60 * 1000);
});
